#!/usr/bin/env node
// Зонд дашборда ПР4: node kit/tools/dash-probe.mjs [--k 4]
// Завантажує client/domain.js, client/status.js, client/cards.js вашого застосунку й показує статуси карток на межах порогів.
import { readTrack, getPath } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { probeDomain, paletteProblems } from '../lib/dash-probe.mjs';

const args = process.argv.slice(2);
const t = readTrack();
const P = loadPassport(t.variant);
const ki = args.indexOf('--k');
const k = ki >= 0 ? Number(args[ki + 1]) : getPath(t, 'pr04.k');
console.log(`ПР4 — зонд дашборда. Варіант ${t.variant} («${P.title}»), період звітування T = ${P.load.T} с, k = ${k ?? 'не задано (вік не перевіряється)'}`);
const { problems, rows } = await probeDomain(t.variant, { k });
if (rows.length) {
  console.log('\nКартка                          Випадок               Значення   Вік, с   Очікується   Отримано');
  for (const r of rows) {
    console.log(`${r.metric.padEnd(30)}  ${r.case.padEnd(20)}  ${String(r.value).padStart(8)}  ${String(r.age).padStart(7)}   ${r.expected.padEnd(11)}  ${r.got === r.expected ? r.got : `${r.got}  ✗`}`);
  }
}
const css = paletteProblems(t.variant);
console.log(`\nПалітра й контраст позначок (client/dashboard.css): ${css.length ? '' : 'узгоджено'}`);
for (const c of css) console.log(`  ✗ ${c}`);
if (problems.length) { console.log('\nЗауваження до конфігурації:'); for (const p of problems.slice(0, 12)) console.log(`  ✗ ${p}`); }
else console.log('\nКонфігурація домену узгоджена з паспортом.');
process.exit(problems.length || css.length ? 1 : 0);
