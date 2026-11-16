#!/usr/bin/env node
// Вхідні дані ПР7 з паспорта: node kit/tools/qa-inputs.mjs
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { usedMetrics, ruleCards, COST, stepFor } from '../lib/qa-lab.mjs';

// Опис параметра: тип, межі й крок розрізнення (для числових)
const spec = (s) => `${s.key}: ${s.type}${s.min !== undefined ? ` ${s.min}…${s.max}, крок ${stepFor(s)}` : s.values ? ` {${s.values.join(', ')}}` : ''}`;

const P = loadPassport(readTrack().variant);
const A = P.alert;
console.log(`Паспорт варіанта ${P.id} «${P.title}», код ${P.code}, T = ${P.load.T} с, корінь топіка «${P.topicRoot}»\n`);
console.log('Метрики, що їх надсилають пристрої домену (діапазон; знаків після коми → крок розрізнення):');
for (const m of usedMetrics(P)) console.log(`  ${m.id.padEnd(14)} [${m.range[0]}; ${m.range[1]}]  знаків ${m.decimals}  крок ${m.step}`);
console.log('\nКоманди:');
for (const c of P.commands) console.log(`  ${c.name}(${c.params.map(spec).join('; ')})`);
console.log('\nНалаштування:');
for (const s of P.settings) console.log(`  ${spec(s)}`);
console.log('\nПравила рівнів тривоги (картки з правилом, ПР4–ПР5; значення warn і crit — з паспорта, гістерезис — з вашого push.js):');
for (const c of ruleCards(P)) console.log(`  ${c.metric.padEnd(14)} ${c.rule.direction === 'below' ? 'lt' : 'gt'}  warn ${c.rule.warn}  crit ${c.rule.crit}  знаків ${c.decimals}`);
console.log(`\nПравило епізодів (ПР2): метрика ${A.metric}, ${A.op}, поріг ${A.threshold}, гістерезис ${A.hysteresis}, minDuration ${A.minDurationSec} с, maxGap = 3T = ${3 * P.load.T} с`);
console.log(`\nБюджет нових доменних тестів на етапі перевірки запиту на злиття: ${P.qa.ciBudgetS} с. Вартість одного тесту, мс: модульний ${COST.unit}, з базою ${COST.db}, з мережею ${COST.net}, наскрізний сценарій вашого дашборда ${P.qa.e2eMs}`);
console.log('Кандидати на наскрізні тести (за пріоритетом):');
for (const e of P.qa.e2e) console.log(`  ${e.priority}. ${e.path}`);
console.log(`\nНестабільний тест: частка збоїв p = ${P.qa.flaky.p}; вимога до виправлення — частка нижча за ${P.qa.flaky.target}`);
console.log(`Журнал CI (нестабільні тести й частки їхніх збоїв); дозволена частка червоних прогонів через них — ${Math.round(P.qa.redMax * 1000) / 10} %:`);
for (const t of P.qa.suite) console.log(`  ${String(t.p).padEnd(7)} ${t.test}`);
