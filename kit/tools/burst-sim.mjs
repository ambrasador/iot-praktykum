#!/usr/bin/env node
// Імітація потоку повідомлень посекундно: пристрої з випадковими фазами звітують раз на T секунд,
// а частка f пристроїв у момент сплеску надсилає по b рядків протягом τ секунд.
// Черга брокера має ліміт Q; обслуговування — μ рядків за секунду.
// node kit/tools/burst-sim.mjs --N 48000 --m 1 --T 900 --f 0.8 --tau 12 --b 1 --mu 2600 --queue 1000 --seed 7 [--out pr01/sim.json]
import fs from 'node:fs';
import { rng, seedFor } from '../lib/rng.mjs';
import * as F from '../lib/formulas.mjs';

const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const out = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null; })();
const p = { N: num('N'), m: num('m', 1), T: num('T'), f: num('f', 0), tau: num('tau', 1), b: num('b', 0),
  mu: num('mu', 2600), queue: num('queue', 1000), seed: num('seed', 1), horizon: num('horizon', 0) };
if (!(p.N > 0 && p.T > 0)) { console.error('Потрібні --N і --T (і за потреби --f --tau --b --mu --queue --seed --horizon).'); process.exit(2); }
const H = p.horizon || Math.max(3600, Math.ceil(3 * p.T));              // тривалість моделі, с
const burstAt = Math.floor(H / 2);                                      // сплеск посередині
const rand = rng(seedFor(0, p.seed, 7));

const arr = new Float64Array(H);
const periodic = (n, rate) => {                                         // n пристроїв, кожен надсилає rate рядків за період
  for (let d = 0; d < n; d++) {
    const phase = rand() * p.T;
    for (let t = phase; t < H; t += p.T) arr[Math.floor(t)] += rate;
  }
};
const nBurst = Math.round(p.f * p.N);
periodic(p.N - nBurst, p.m);                                            // решта звітує рівномірно
// пристрої зі сплеску: звітують і в звичайному режимі, але поза вікном сплеску
for (let d = 0; d < nBurst; d++) {
  const phase = rand() * p.T;
  for (let t = phase; t < H; t += p.T) {
    const s = Math.floor(t);
    if (s < burstAt || s >= burstAt + p.tau) arr[s] += p.m;
  }
  for (let k = 0; k < p.b; k++) arr[burstAt + Math.min(p.tau - 1, Math.floor(rand() * p.tau))] += 1;
}

// статистика: фон — секунди до сплеску (після розігріву), сплеск — вікно τ
const bg = Array.from(arr.slice(Math.ceil(p.T) > burstAt ? 0 : Math.ceil(p.T), burstAt)).sort((a, b) => a - b);
const burstWin = Array.from(arr.slice(burstAt, burstAt + p.tau));
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const q = (a, pr) => a[Math.min(a.length - 1, Math.floor(pr * a.length))];

// черга: щосекунди надходить arr[t], обслуговується до μ
let queued = 0, dropped = 0, maxQ = 0, firstDrop = null;
for (let t = 0; t < H; t++) {
  queued += arr[t];
  queued -= Math.min(queued, p.mu);
  if (queued > p.queue) { dropped += queued - p.queue; queued = p.queue; if (firstDrop === null) firstDrop = t - burstAt; }
  maxQ = Math.max(maxQ, queued);
}
const model = { N: p.N, m: p.m, T: p.T, f: p.f, tau: p.tau, b: p.b };
const analyticPeak = p.f > 0 && p.b > 0 ? F.burstPeak(model) : F.poissonQuantile(F.lambdaAvg(p.N, p.m, p.T));
const res = {
  params: p, horizon_s: H,
  background: { mean: +mean(bg).toFixed(2), p999: q(bg, 0.999), max: bg.at(-1) },
  burst: { mean_per_s: +mean(burstWin).toFixed(1), max_per_s: Math.max(...burstWin) },
  analytic: { lambda_avg: +F.lambdaAvg(p.N, p.m, p.T).toFixed(2), lambda_peak: +analyticPeak.toFixed(1) },
  queue: { max: Math.round(maxQ), dropped: Math.round(dropped), first_drop_after_burst_s: firstDrop },
};
const row = (a, b) => console.log(`  ${a.padEnd(46)} ${b}`);
console.log(`Модель: ${H} с, сплеск на ${burstAt}-й секунді; μ = ${p.mu} рядків/с, черга ≤ ${p.queue}`);
row('фон: середнє за секунду', res.background.mean);
row('фон: квантиль 99,9 %', res.background.p999);
row('фон: максимум за секунду', res.background.max);
row('сплеск: середнє за секунду вікна τ', res.burst.mean_per_s);
row('сплеск: максимум за секунду', res.burst.max_per_s);
row('за формулою: λ_avg / λ_peak', `${res.analytic.lambda_avg} / ${res.analytic.lambda_peak}`);
row('черга: максимальна довжина', res.queue.max);
row('черга: втрачено рядків', res.queue.dropped);
row('черга: перша втрата, с від початку сплеску', firstDrop === null ? 'немає' : firstDrop);
if (out) { fs.mkdirSync(new URL('.', `file://${process.cwd()}/${out}`).pathname, { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n'); console.log(`Звіт: ${out}`); }
