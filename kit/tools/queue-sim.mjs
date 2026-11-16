#!/usr/bin/env node
// Черга дій мобільного клієнта: повтор запиту, коли відповідь загубилась. Скільки рядків з’явиться в таблиці команд
// без ключа ідемпотентності, з ключем на кожну спробу й з ключем на дію.
//   node kit/tools/queue-sim.mjs [--json]
// Сервер — createServer із вашого застосунку; N, q і m беруться з паспорта варіанта й підручника (m = 10).
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import * as L from '../lib/mob-lab.mjs';

const t = readTrack(); const P = loadPassport(t.variant);
const s = await L.queueSim(t.variant, P, t.seed);
const fmt = (x, d = 1) => x.toFixed(d).replace('.', ',');
if (process.argv.includes('--json')) { console.log(JSON.stringify(s)); process.exit(0); }
console.log(`Черга дій — варіант ${t.variant} («${P.title}»): N = ${s.n} дій, відповідь губиться з імовірністю q = ${s.q_pct} %, до m = ${s.m} спроб; команда ${s.command.name}`);
console.log('Режим                | запитів | рядків у commands | зайвих | статуси відповідей');
const names = { none: 'без ключа', attempt: 'ключ на спробу', action: 'ключ на дію' };
for (const k of ['none', 'attempt', 'action']) {
  const st = Object.entries(s.statuses[k]).map(([c, n]) => `${c}×${n}`).join(' ');
  console.log(`${names[k].padEnd(20)} | ${String(s.requests).padStart(7)} | ${String(s.rows[k]).padStart(17)} | ${String(s.rows[k] - s.n).padStart(6)} | ${st}`);
}
console.log(`\nТеорія (формула 5.7): R = N · (1 − q^m) / (1 − q) = ${fmt(s.theory)} рядків (стандартне відхилення ≈ ${fmt(s.sd)}) — для режимів без ключа дії`);
if (s.reuse) console.log(`Той самий ключ з іншим тілом запиту: ${s.reuse.status}${s.reuse.type ? ` (${s.reuse.type})` : ''}`);
