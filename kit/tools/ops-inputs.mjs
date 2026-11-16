#!/usr/bin/env node
// Вхідні дані ПР8 з паспорта й журналу: node kit/tools/ops-inputs.mjs
import path from 'node:path';
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { ROOT } from '../lib/paths.mjs';
import * as O from '../lib/ops-lab.mjs';

const t = readTrack();
const P = loadPassport(t.variant);
const F = O.opsFiles(P);
console.log(`Паспорт варіанта ${P.id} «${P.title}», код ${P.code}\n`);
console.log(`Мета доступності API (SLO): ${P.ops.slo.target} % за 30 діб`);
console.log(`Два рівні частки помилок, що їх треба розглянути: e₁ = ${P.ops.slo.errors[0]}, e₂ = ${P.ops.slo.errors[1]}`);
console.log('Пари «вікно — швидкість витрати»:');
for (const p of O.PAIRS) console.log(`  ${p.id.padEnd(7)} k = ${String(p.k).padEnd(5)} довге вікно ${p.longH} год, коротке ${p.shortMin} хв  (${p.alert}, severity ${p.severity})`);
console.log(`\nПотік показань: N = ${P.load.N}, m = ${P.load.m}, T = ${P.load.T} с`);
console.log(`Вимога до тиші: сповіщення не пізніше ніж за ${P.ops.silenceMaxS} с після останнього показання`);
console.log('Допустимі пари «крок обчислення правил / крок збору метрик», с: ' + O.STEP_OPTIONS.map(([a, b]) => `${a}/${b}`).join(', ') + '  (початкова пара — 60/15)');
console.log(`\nПроба працездатності backend: збій має бути видно не пізніше ніж за ${P.ops.probe.detectS} с; старт процесу ${P.ops.probe.startS} с`);
const fl = t.pr06?.limit?.flush_s;
console.log(`Журнал ПР6: час спорожнення черги обмеження частоти flush_s = ${fl === undefined ? 'немає (з’являється в ПР6, рівень «4»)' : `${fl} с`}`);
const env = O.readEnvFile(path.join(ROOT, 'pr03', 'rt.env'));
console.log(`Журнал ПР3 (pr03/rt.env): ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(', ') || 'немає'}`);
console.log(`\nФайли, які треба створити: ${F.rules}, ${F.tests} (рівень 4), ${F.compose} (рівень 4), ${F.adr} і ${F.runbook} (рівень 5)`);
