#!/usr/bin/env node
// Мутаційний прогін тестів домену: node kit/tools/qa-mutants.mjs <range|cmdset|data|rules|logic|net|all|matrix> [--list] [--save]
// Мутант вносить одну помилку в копію застосунку; тест, що її помічає, «вбиває» мутанта. Ваш каталог не змінюється.
// matrix --save записує виміряну матрицю в track.json (ключ pr07.matrix).
import { loadPassport } from '../lib/passport.mjs';
import { readTrack, writeTrack, setPath } from '../lib/track.mjs';
import * as Q from '../lib/qa-lab.mjs';

const PARTS = { range: 'діапазони метрик', cmdset: 'команди й налаштування', rules: 'пороги, гістерезис, напрям',
  logic: 'логіка nextLevel і findViolations', net: 'шлях через брокер' };
const SETS = { range: ['range'], cmdset: ['cmdset'], data: ['range', 'cmdset'], rules: ['rules'], logic: ['logic'], net: ['net'] };
const [which = 'all', ...rest] = process.argv.slice(2);
const track = readTrack();
const P = loadPassport(track.variant);

if (which === 'matrix') {
  const { printMatrix } = await import('../lib/qa-matrix.mjs');
  const code = await printMatrix(P, rest.includes('--list'), rest.includes('--save') ? (m) => {
    const totals = { unit: m.rows.filter((r) => r.unit).length, integration: m.rows.filter((r) => r.integration).length, legacy: m.rows.filter((r) => r.legacy).length };
    setPath(track, 'pr07.matrix', { rows: m.rows.map((r) => ({ id: r.id, unit: r.unit, integration: r.integration, legacy: r.legacy })), totals });
    writeTrack(track);
    console.log('Матрицю записано в track.json (pr07.matrix).');
  } : null);
  process.exit(code);
}
const names = which === 'all' ? ['data', 'rules', 'logic', 'net'] : [which];
if (!names.every((n) => SETS[n])) { console.error('Групи: range, cmdset, data, rules, logic, net, all, matrix'); process.exit(2); }

let bad = 0;
for (const name of names) {
  const parts = SETS[name];
  if (rest.includes('--list')) {
    for (const m of Q.allMutants(P).filter((x) => parts.some((p) => Q.GROUP_OF[p].includes(x.group)))) console.log(`${m.id.padEnd(34)} ${m.title}`);
    continue;
  }
  console.log(`\nГрупа «${name}»`);
  for (const part of parts) {
    const r = await Q.runGroup(P, part);
    if (r.problem) { console.log(`  ✗ ${PARTS[part]}: ${r.problem}`); bad += 1; continue; }
    console.log(`  ${PARTS[part]}: мутантів ${r.total}, вбито ${r.killed}`);
    for (const m of r.survivors) console.log(`  ✗ вижив: ${m.title}  [${m.id}]`);
    if (r.survivors.length) bad += 1;
  }
}
process.exit(bad ? 1 : 0);
