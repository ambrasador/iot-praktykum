#!/usr/bin/env node
// promtool у контейнері prom/prometheus. node kit/tools/promtool.mjs check | test | mutants
import path from 'node:path';
import { readTrack, getPath } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { APP } from '../lib/app.mjs';
import * as O from '../lib/ops-lab.mjs';

const cmd = process.argv[2];
const t = readTrack();
const P = loadPassport(t.variant);
const F = O.opsFiles(P);
const rn = path.basename(F.rules); const tn = path.basename(F.tests);
const opsDir = path.join(APP, 'ops');
if (!['check', 'test', 'mutants'].includes(cmd)) { console.error('Використання: promtool.mjs check | test | mutants'); process.exit(2); }

const withDir = (fn) => O.inTmpOps(opsDir, {}, fn);
if (cmd === 'check') {
  const r = await withDir((d) => O.promtool(d, ['check', 'rules', `/ops/${rn}`]));
  process.stdout.write(r.out); process.exit(r.code);
}
if (cmd === 'test') {
  const r = await withDir((d) => O.promtool(d, ['test', 'rules', `/ops/${tn}`]));
  process.stdout.write(r.out); process.exit(r.code);
}
const own = await O.runOwn(opsDir, rn, tn);
if (!own.ok) { console.error(`Власні тести не проходять на ваших правилах:\n${own.problem}`); process.exit(1); }
let killed = 0; const ms = O.ruleMutants(P);
for (const m of ms) {
  const r = await O.runRuleMutant(opsDir, rn, tn, m);
  if (r.status === 'killed') killed += 1;
  console.log(`${r.status === 'killed' ? '✓ вбито ' : r.status === 'survived' ? '✗ вижив ' : '? не застосовано'} ${m.id.padEnd(13)} ${m.title}${r.status === 'not_applied' ? `\n    ${r.out}` : ''}`);
}
console.log(`\nВбито ${killed} із ${ms.length}. У журнал: pr08.mutants.core = {total: ${O.M_L4.length}, killed: …} для чотирьох перших, pr08.mutants.extra = {total: ${O.M_L5.length}, killed: …} для трьох останніх`);
void getPath;
