#!/usr/bin/env node
// Шум датчика метрики сповіщення: σ за різницями сусідніх показань (формула 5.6) на всьому ряді й на спокійній ділянці.
//   node kit/tools/noise.mjs                   → метрика сповіщення вашого варіанта (ПР2)
//   node kit/tools/noise.mjs --metric <ім’я>   → інша метрика зі своєю карткою правила
//   node kit/tools/noise.mjs --json
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import * as L from '../lib/mob-lab.mjs';
import * as F from '../lib/formulas.mjs';

const argv = process.argv.slice(2);
const t = readTrack(); const P = loadPassport(t.variant);
const mi = argv.indexOf('--metric');
const metric = mi >= 0 ? argv[mi + 1] : P.alert.metric;
const nz = L.noise(t.variant, P, t.seed, metric);
const T = P.load.T; const N = F.readingsPerDay(T); const R = P.mob.repeatsPerDayMax;
const fmt = (x, d = 2) => x.toFixed(d).replace('.', ',');
if (argv.includes('--json')) { console.log(JSON.stringify({ ...nz, N, R })); process.exit(0); }
console.log(`Шум датчика: ${metric}, пристрій ${nz.device}, варіант ${t.variant}, зерно ${t.seed}`);
console.log(`Різниць сусідніх показань: усі ${nz.pairs_all}; на спокійній ділянці ${nz.pairs_calm}`);
if (nz.excluded.length) {
  console.log('Вилучено вікна ±1 год навколо подій (їхня зміна — не шум):');
  for (const w of nz.excluded) console.log(`  ${w.name}: ${w.from} … ${w.to}`);
}
console.log(`σ (усі різниці)           = ${fmt(nz.sigma_all)}`);
console.log(`σ (спокійна ділянка)      = ${fmt(nz.sigma_calm)}   ← для гістерезису`);
console.log(`Показань за добу N = ${N} (T = ${T} с); допустимо повторних сповіщень на добу R = ${R}`);
console.log(`Множник k: node kit/tools/qinv.mjs --n ${N} --r ${R}`);
