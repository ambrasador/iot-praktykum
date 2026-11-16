#!/usr/bin/env node
// Імітація шторму перепідключень: скільки клієнтів підключаються за одну секунду після збою сервера.
//   node kit/tools/storm-sim.mjs --u 3200 --b 12 --c 16            (Socket.IO / контролер, секунди)
//   node kit/tools/storm-sim.mjs --u 1800 --retry 5                (SSE: retry сервера, секунди)
// Додатково: --down 4 (один збій замість розгортки), --seed N (за замовчуванням — з track.json), --json
import fs from 'node:fs';
import { TRACK } from '../lib/track.mjs';
import { GRID, loadDelay, simulate, sweep } from '../lib/storm.mjs';
import { RT } from '../lib/formulas.mjs';

const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const U = num('u');
if (!(U > 0)) { console.error('Потрібне --u (кількість клієнтів) та --b і --c (або --retry для SSE).'); process.exit(2); }
let seed = num('seed');
if (seed === undefined) {
  try { seed = JSON.parse(fs.readFileSync(TRACK, 'utf8')).seed; } catch { /* немає журналу */ }
}
if (!Number.isInteger(seed)) { console.error('Немає track.json — вкажіть --seed.'); process.exit(2); }
const sse = argv.includes('--retry');
const policy = sse ? { kind: 'sse', retry: num('retry') } : { kind: 'sio', b: num('b', RT.defaults.b), c: num('c', RT.defaults.c) };
if (sse ? !(policy.retry > 0) : !(policy.b > 0 && policy.c > 0)) { console.error('Параметри політики мають бути додатними.'); process.exit(2); }
const delay = await loadDelay();
const fmt = (x, d = 1) => x.toFixed(d).replace('.', ',');
const comma = (x) => String(x).replace('.', ',');

const down = num('down');
const result = down === undefined ? sweep({ U, policy, seed, delay }) : (() => { const r = simulate({ U, policy, down, seed, delay }); return { rows: [r], worst: r, median0: r.median }; })();
const limit = RT.C;
if (argv.includes('--json')) {
  console.log(JSON.stringify({ U, policy, seed, C: limit, worst: result.worst, median0: result.median0, rows: result.rows }));
  process.exit(0);
}
console.log(`Шторм перепідключень: U = ${U} клієнтів, ${sse ? `SSE, retry = ${comma(policy.retry)} с (сервер надсилає від ${comma(policy.retry)} до ${comma(2 * policy.retry)} с)` : `контролер: b = ${comma(policy.b)} с, c = ${comma(policy.c)} с (повний джитер)`}, зерно ${seed}`);
console.log('Збій D, с | пік, підкл./с | пік, % від U | повернення, с: медіана / p95 / останній');
for (const r of result.rows) {
  console.log(`${String(r.down).padStart(9)} | ${String(r.peak).padStart(13)} | ${fmt(r.share * 100).padStart(12)} | ${fmt(r.median).padStart(6)} / ${fmt(r.p95).padStart(6)} / ${fmt(r.max).padStart(7)}`);
}
const w = result.worst;
console.log(`Найгірший пік: ${w.peak} підкл./с (${fmt(w.share * 100)} % від U) при D = ${w.down} с; межа C = ${limit} підкл./с → ${w.peak <= limit ? 'у межах' : `ПЕРЕВИЩЕНО в ${fmt(w.peak / limit, 2)} раза`}`);
console.log(`Медіана повернення після негайного перезапуску (D = 0): ${fmt(result.median0)} с`);
