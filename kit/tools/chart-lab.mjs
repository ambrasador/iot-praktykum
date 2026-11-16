#!/usr/bin/env node
// Лабораторія графіка ПР4: node kit/tools/chart-lab.mjs
// Ряд метрики сповіщення з історії ПР2: що лишається після агрегації інтервалом ПР2 і після проріджування до бюджету B.
import { readTrack, getPath } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { chartLab, METHODS } from '../lib/chart-lab.mjs';

const t = readTrack();
const P = loadPassport(t.variant);
const interval = getPath(t, 'pr02.interval');
if (!interval) { console.error('У track.json немає pr02.interval: завершіть ПР2 (інтервал агрегації для графіка).'); process.exit(2); }
const L = await chartLab(t.variant, P, t.seed, interval);
const dir = L.op === 'gt' ? 'над' : 'під';
console.log(`ПР4 — лабораторія графіка. Варіант ${t.variant} («${P.title}»), зерно ${t.seed}`);
console.log(`Метрика сповіщення: ${L.metric}, поріг ${L.threshold} (${dir} порогом — порушення), пристрій ${L.device}`);
console.log(`Сирий ряд: ${L.raw_points} точок, крайнє значення у бік порога ${L.raw_extreme}; бюджет графіка B = ${L.budget}; епізодів сповіщення (ПР2): ${L.episodes}`);
console.log(`\nЧастина А. Агрегація інтервалом ${L.interval.name} (інтервал ПР2), кошиків ${L.interval.buckets}`);
console.log('  показ на графіку                      видимих епізодів');
console.log(`  середнє за інтервал                   ${L.interval.avg_visible} з ${L.episodes}   (найкраще середнє ${L.interval.avg_extreme})`);
console.log(`  край смуги (${L.edge === 'max' ? 'максимум' : 'мінімум'} інтервалу)          ${L.interval.band_visible} з ${L.episodes}`);
console.log(`\nЧастина Б. Проріджування сирого ряду до бюджету B = ${L.budget}`);
console.log('  метод                             точок   втрата екстремуму   видимих епізодів');
for (const [id, name] of METHODS) {
  const m = L.methods[id];
  console.log(`  ${(`${id} — ${name}`).padEnd(34)}${String(m.points).padStart(5)}   ${String(m.loss).padStart(17)}   ${String(m.visible).padStart(8)} з ${L.episodes}`);
}
console.log('\nВтрата екстремуму — на скільки крайнє значення після проріджування гірше за сире (одиниці метрики).');
console.log('Епізод видно, якщо збережена точка за порогом лежить у ньому або не далі за ширину одного кошика бюджету від його меж.');
