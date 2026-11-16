#!/usr/bin/env node
// Прогін правил push вашого застосунку через createAlertTracker: спад до критичного рівня, повернення до норми
// і шум біля порога тривоги (30 діб, показання = поріг + σ · z).
//   node kit/tools/push-replay.mjs                 правила з RULES_<код> у push.js
//   node kit/tools/push-replay.mjs --h 2.4         підставити гістерезис метрики сповіщення (решта правил — за паспортом)
//   node kit/tools/push-replay.mjs --sweep         сповіщень на добу для кількох h: вимірювання й формула 5.5
//   node kit/tools/push-replay.mjs --days 60 --json
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { appRequire } from '../lib/app.mjs';
import * as L from '../lib/mob-lab.mjs';
import * as F from '../lib/formulas.mjs';

const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(String(argv[i + 1]).replace(',', '.')) : d; };
const t = readTrack(); const P = loadPassport(t.variant);
const T = P.load.T; const N = F.readingsPerDay(T); const R = P.mob.repeatsPerDayMax;
const push = appRequire('./push');
const cards = L.cardsWithRule(P);
const alertCard = cards[0];
const nz = L.noise(t.variant, P, t.seed, alertCard.metric);
const sigma = nz.sigma_calm;
const days = num('days', 30);
const fmt = (x, d = 2) => x.toFixed(d).replace('.', ',');
const rulesWith = (h) => new Map(cards.map((c, i) => [c.metric, L.ruleOf(c, i === 0 ? h : (P.mob.hys?.[c.metric] ?? 0))]));

const hArg = num('h');
let rules; let source;
if (hArg !== undefined) { rules = rulesWith(hArg); source = `паспорт варіанта, h метрики ${alertCard.metric} = ${fmt(hArg)}`; }
else {
  rules = push[`RULES_${P.code}`];
  if (!(rules instanceof Map)) { console.error(`push.js не експортує RULES_${P.code}. Додайте карту правил домену або запустіть із --h <значення>.`); process.exit(2); }
  source = `RULES_${P.code} з push.js`;
}
const out = { source, sigma, sigma_all: nz.sigma_all, N, R, days, decline: [], chatter: null, sweep: null };

for (const c of cards) {
  const r = rules.get(c.metric);
  if (!r) { out.decline.push({ metric: c.metric, error: 'правила немає' }); continue; }
  const d = L.declineRun(push, rules, c, L.baselineOf(P, c.metric), T);
  out.decline.push({ metric: c.metric, hysteresis: r.hysteresis, baseline: L.baselineOf(P, c.metric), once: d.once, twice: d.twice,
    expected_once: d.expected.once, expected_twice: d.expected.twice,
    ok: JSON.stringify(d.once) === JSON.stringify(d.expected.once) && JSON.stringify(d.twice) === JSON.stringify(d.expected.twice) });
}
out.chatter = L.chatter(push, rules, t.variant, P, t.seed, alertCard, sigma, days);
out.h_min = F.hMin(N, R, sigma);
if (argv.includes('--sweep')) {
  const grid = [...new Set([0, 1, 2, 2.5, 3, F.kMult(N, R), 3.5, 4].map((k) => Math.round(k * sigma * 100) / 100))].sort((a, b) => a - b);
  out.sweep = grid.map((h) => ({ h, k: h / sigma, formula: F.pushAlertsPerDay(N, h, sigma), measured: L.chatter(push, rulesWith(h), t.variant, P, t.seed, alertCard, sigma, days).student_mean }));
}
if (argv.includes('--json')) { console.log(JSON.stringify(out)); process.exit(0); }

console.log(`Прогін правил push — варіант ${t.variant} («${P.title}»), правила: ${source}`);
console.log(`Метрика сповіщення ${alertCard.metric}: σ (спокійна ділянка) = ${fmt(sigma)}, N = ${N} показань за добу, допустимо повторних R = ${R}, h_min = k · σ = ${fmt(out.h_min)}`);
console.log('\nСпад без шуму й повернення до норми (послідовності рівнів сповіщень)');
console.log('Метрика                         h        спад              спад → норма → спад');
for (const d of out.decline) {
  if (d.error) { console.log(`${d.metric.padEnd(30)}  ${d.error}`); continue; }
  const row = `${d.metric.padEnd(30)}  ${fmt(d.hysteresis).padStart(6)}   ${d.once.join(' → ').padEnd(16)}  ${d.twice.join(' → ')}`;
  console.log(d.ok ? row : `${row}\n${' '.repeat(40)}✗ очікується: ${d.expected_once.join(' → ')}  |  ${d.expected_twice.join(' → ')}${d.hysteresis > L.roomOf(L.ruleOf(cards.find((c) => c.metric === d.metric), 0), d.baseline) ? '  (h більший за запас між нормою й порогом попередження: рівень не знімається)' : ''}`);
}
const c = out.chatter;
console.log(`\nШум біля порога ${alertCard.rule.crit} (σ = ${fmt(sigma)}), ${c.days} діб по ${c.per_day} показань`);
console.log(`  ваші правила: ${fmt(c.student_mean, 1)} сповіщень на добу; еталон при h_min: ${fmt(c.ref_mean, 1)}; межа ${fmt(c.limit, 1)} → ${c.student_mean <= c.limit ? 'у межах' : 'ПЕРЕВИЩЕНО: збільште h'}`);
if (out.sweep) {
  console.log('\nh        k = h / σ   сповіщень на добу: вимірювання | формула 5.5');
  for (const s of out.sweep) console.log(`${fmt(s.h).padStart(6)}   ${fmt(s.k).padStart(8)}   ${fmt(s.measured, 1).padStart(21)} | ${fmt(s.formula, 1)}`);
}
