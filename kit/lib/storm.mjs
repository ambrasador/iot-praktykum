// Імітація шторму перепідключень (п. 3.7.6). Усі U клієнтів втрачають зв'язок у момент t = 0;
// сервер знову слухає з моменту D. Затримки беруться з реалізації застосунку (client/backoff.js),
// невдала спроба «безкоштовна», черги на сервері немає: імітація показує, коли клієнти звертаються,
// а не коли отримують відповідь.
import { pathToFileURL } from 'node:url';
import { appPath } from './app.mjs';
import { rng, seedFor } from './rng.mjs';

export const GRID = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 300];   // тривалості збою D, с
const MAX_ATTEMPTS = 1_000_000;

export async function loadDelay() {
  const mod = await import(pathToFileURL(appPath('client', 'backoff.js')).href);
  return mod.delay;
}

// policy: { kind: 'sio', b, c } (секунди; контролер і Socket.IO) або { kind: 'sse', retry } (секунди; поле retry сервера)
export function simulate({ U, policy, down, seed, delay }) {
  const up = down * 1000;
  const times = new Float64Array(U);
  for (let i = 0; i < U; i++) {
    const rnd = rng(seedFor(0, seed, Math.round(down * 1000) * 7 + i * 131 + 1));
    let t = 0;
    if (policy.kind === 'sse') {
      const r = policy.retry * 1000;
      const mine = r + Math.floor(rnd() * r);               // сервер надсилає retry від r до 2r (sse.js)
      t = mine;
      let k = 1;
      while (t < up && k++ < MAX_ATTEMPTS) t += mine;       // retry не зростає
    } else {
      const opts = { base: policy.b * 1000, cap: policy.c * 1000, rnd };
      let attempt = 1;
      t = Math.max(1, delay(attempt, opts));
      while (t < up && attempt < MAX_ATTEMPTS) { attempt += 1; t += Math.max(1, delay(attempt, opts)); }
    }
    times[i] = t;
  }
  // підключення за секунду відліком від моменту, коли сервер знову слухає
  const buckets = new Map();
  const back = Array.from(times, (t) => (t - up) / 1000).sort((a, b) => a - b);
  for (const s of back) buckets.set(Math.floor(s), (buckets.get(Math.floor(s)) ?? 0) + 1);
  const peak = Math.max(...buckets.values());
  const q = (p) => back[Math.min(U - 1, Math.floor(p * U))];
  return { down, peak, share: peak / U, median: q(0.5), p95: q(0.95), max: back[U - 1] };
}

export function sweep({ U, policy, seed, delay, grid = GRID }) {
  const rows = grid.map((down) => simulate({ U, policy, down, seed, delay }));
  const worst = rows.reduce((a, r) => (r.peak > a.peak ? r : a));
  return { rows, worst, median0: rows[0].median };
}
