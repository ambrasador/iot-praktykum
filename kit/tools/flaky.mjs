#!/usr/bin/env node
// Лабораторія нестабільного тесту: node kit/tools/flaky.mjs [--runs 100]
// Тест падає у випадковій частці прогонів; послідовність відтворювана й залежить від вашого зерна в track.json.
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { flakyRun } from '../lib/qa-lab.mjs';

const t = readTrack();
const P = loadPassport(t.variant);
const i = process.argv.indexOf('--runs');
const runs = i > 0 ? Number(process.argv[i + 1]) : 100;
if (!(runs >= 1)) { console.error('Використання: flaky.mjs [--runs N]'); process.exit(2); }
const r = flakyRun(P, t.seed, runs);
console.log(`Лабораторний тест «${P.title}», зерно ${t.seed}`);
console.log(`Прогонів: ${r.runs}; збоїв: ${r.failures}; перший збій — прогін №${r.first ?? '—'}`);
if (r.failures) console.log(`Номери збійних прогонів: ${r.failed.slice(0, 20).join(', ')}${r.failed.length > 20 ? ', …' : ''}`);
else console.log('Жодного збою: пам’ятайте, що це ще не доводить відсутності дефекту (формула 7.4.3).');
