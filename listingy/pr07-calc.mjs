// pr07/calc.mjs: розрахунки ПР7 (підрозділи 7.1.1, 7.2.1, 7.4.1, 7.4.3)
// Запуск з кореня практикуму: node pr07/calc.mjs [рівень], типово 3
const level = Number(process.argv[2] ?? 3);
const P = {                        // дані: node kit/tools/qa-inputs.mjs
  metrics: 4, rules: 2,            // метрики; правила RULES_<код>
  cmdRows: [4], setRows: [4],      // рядків: число 4, bool 3, enum 2
  budgetS: 7, e2eMs: 1200,
  e2e: ['Картка вологості показує свіже значення',
    'Критична вологість фарбує картку в червоний',
    'Перемикач діапазону 1 год / 24 год / 7 діб',
    'Експорт CSV за 24 год', 'Вхід і вихід користувача'],
  p: 0.05, target: 0.01,           // частка збоїв тесту; ціль
  redMax: 0.03,                    // рівень 5: допуск червоних прогонів
  suite: [['опитування лотка через брокер', 0.04],
    ['повтор команди irrigate', 0.02],
    ['перемальовування графіка', 0.015],
    ['розбір CSV із локаллю', 0.005]],
};
const COST = { unit: 27, db: 72, net: 101 };   // мс на тест (табл. 7.2)
const EPISODES = 6, NET = 4, RULE_ROWS = 8;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const c = (x, d = 2) => x.toFixed(d).replace('.', ',');

// 1. План межових рядків (7.2.1): діапазони йдуть до бази, решта — юніт
const range = 4 * P.metrics, commands = sum(P.cmdRows);
const settings = sum(P.setRows), rules = RULE_ROWS * P.rules;
const db = range, unit = commands + settings + rules + EPISODES;
console.log(`діапазони ${range}, команди ${commands}, налаштування`,
  `${settings}, правила ${rules}, епізоди ${EPISODES}`);
console.log(`з базою ${db}, модульних ${unit}, через брокер ${NET}`);

// 2. Бюджет піраміди (7.1.1, 7.4.1)
const base = db * COST.db + unit * COST.unit + NET * COST.net;
const left = P.budgetS * 1000 - base;
const e2eMax = Math.max(0, Math.floor(left / P.e2eMs));
console.log(`нижні рівні ${base} мс, залишок ${left} мс,`,
  `наскрізних сценаріїв ${e2eMax}`);
P.e2e.slice(0, e2eMax)
  .forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

// 3. Нестабільний тест (7.4.3): n >= ln(1 - conf) / ln(1 - p)
const runs = (p, conf) =>
  Math.ceil(Math.log(1 - conf) / Math.log(1 - p));
const nFix = runs(P.target, 0.95);
console.log(`виявлення: 95 % → ${runs(P.p, 0.95)} прогонів,`,
  `99 % → ${runs(P.p, 0.99)}`);
console.log(
  `підтвердження виправлення до ${P.target}: ${nFix} прогонів;`,
  `дефект p = ${P.p} уникне їх з імовірністю`,
  `${((1 - P.p) ** nFix * 1e6).toPrecision(2)} ppm`);

if (level >= 5) {                        // 4. Карантин за журналом CI
  const share = (ps) => 1 - ps.reduce((a, p) => a * (1 - p), 1);
  const order = [...P.suite].sort((a, b) => b[1] - a[1]);
  for (let k = 0; k < order.length; k++) {
    const pct = 100 * share(order.slice(k).map((t) => t[1]));
    console.log(`у карантині ${k}: червоних ${c(pct)} %`);
    if (pct <= 100 * P.redMax) {
      const names = order.slice(0, k).map((t) => t[0]);
      console.log('карантин:', names.join('; '));
      break;
    }
  }
}
