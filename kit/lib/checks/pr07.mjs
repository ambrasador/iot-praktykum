import fs from 'node:fs';
import path from 'node:path';
import { getPath } from '../track.mjs';
import { exists, read, all } from '../verify-core.mjs';
import { APP, appRequire } from '../app.mjs';
import { pr07 as expect07 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import * as Q from '../qa-lab.mjs';

const exact = (t, key, expected, hint = '') => {
  const v = getPath(t, key);
  return JSON.stringify(v) === JSON.stringify(expected) ? true : `${key} = ${JSON.stringify(v)}, очікується ${JSON.stringify(expected)}${hint ? `. ${hint}` : ''}`;
};
const close = (t, key, expected, tol, hint = '') => {
  const v = getPath(t, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${key}: очікується число, у журналі ${JSON.stringify(v)}`;
  return Math.abs(v - expected) <= tol * Math.max(Math.abs(expected), 1e-9) ? true : `${key} = ${v}: розбіжність із очікуваним більша за ${Math.round(tol * 100)} %${hint ? `. ${hint}` : ''}`;
};
const inApp = (f) => fs.existsSync(path.join(APP, f));
const fmt = (m) => `${m.title} [${m.id}]`;
const norm = (s) => s.replace(/(\d)[\s ](?=\d{3}\b)/g, '$1');

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const F = Q.studentFiles(P.code);
  let X = null;
  const ex = async () => (X ??= await expect07(t.variant, P, t.seed));
  const groups = new Map();
  const group = (name) => { if (!groups.has(name)) groups.set(name, Q.runGroup(P, name)); return groups.get(name); };
  // Усі мутанти групи вбито; інакше — перший із тих, що вижили
  const killedAll = async (name, label) => {
    const r = await group(name);
    if (r.problem) return r.problem;
    if (r.survivors.length) return `${label}: вбито ${r.killed} із ${r.total}; вижив ${fmt(r.survivors[0])}${r.survivors.length > 1 ? ` (і ще ${r.survivors.length - 1})` : ''}. Додайте рядок, на якому ця помилка стає видимою`;
    return true;
  };
  const adr = () => (exists('pr07', 'adr-007.md') ? read('pr07', 'adr-007.md') : '');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: код домену з ПР1–ПР6 на місці (діапазони метрик, RULES_<код> у push.js, профіль безпеки)', run: async () => {
      const miss = [];
      if (!Array.isArray(getPath(t, 'pr06.policy.changed'))) miss.push('pr06.policy.changed у track.json (ПР6)');
      if (!inApp('profile.js')) miss.push('profile.js (ПР6)');
      let push = null;
      try { push = appRequire('./push'); } catch (e) { miss.push(`push.js не завантажується: ${e.message}`); }
      if (push && !push[`RULES_${P.code}`]) miss.push(`експорт RULES_${P.code} у push.js (ПР5)`);
      const core = inApp('core.js') ? fs.readFileSync(path.join(APP, 'core.js'), 'utf8') : '';
      for (const m of P.metrics) if (!new RegExp(`\\['${m.id}'\\s*,\\s*\\[`).test(core)) miss.push(`діапазон метрики ${m.id} у core.js (ПР1)`);
      return miss.length ? `Бракує: ${miss.join('; ')}. Завершіть попередні роботи` : true;
    } },
    { level: 3, text: 'План межових рядків за правилом підрахунку: діапазони, команди, налаштування, правила рівнів, епізоди', run: async () => {
      const x = await ex(); const r = x.rows;
      return all(
        exact(t, 'pr07.rows.range', r.range, '4 рядки на кожну метрику, що її надсилають пристрої домену'),
        exact(t, 'pr07.rows.commands', r.commands, 'числовий параметр — 4 рядки, булевий — 3, перелік — 2'),
        exact(t, 'pr07.rows.settings', r.settings, 'ті самі правила підрахунку, що й для параметрів команд'),
        exact(t, 'pr07.rows.rules', r.rules, '8 рядків на кожне правило з RULES_<код>'),
        exact(t, 'pr07.rows.episodes', r.episodes),
        exact(t, 'pr07.rows.db', r.db, 'рядки діапазонів виконуються на рівні «з базою»'),
        exact(t, 'pr07.rows.unit', r.unit, 'команди + налаштування + правила + епізоди'));
    } },
    { level: 3, text: 'Бюджет піраміди: час нижніх рівнів, залишок, кількість наскрізних сценаріїв і їхній перелік за пріоритетом', run: async () => {
      const x = await ex(); const p = x.pyr;
      return all(
        exact(t, 'pr07.pyramid.base_ms', p.base_ms, `${p.rows.db} · ${x.cost.db} + ${p.rows.unit} · ${x.cost.unit} + ${p.rows.net} · ${x.cost.net}, мс`),
        exact(t, 'pr07.pyramid.left_ms', p.left_ms, `бюджет ${P.qa.ciBudgetS} с мінус час нижніх рівнів`),
        exact(t, 'pr07.pyramid.e2e_max', p.e2e_max, `залишок / ${P.qa.e2eMs} мс, ціла частина`),
        exact(t, 'pr07.pyramid.e2e', p.e2e, 'перші за пріоритетом сценарії, що вміщаються, у порядку пріоритету, текст як у паспорті'));
    } },
    { level: 3, text: 'Нестабільний тест: прогони для виявлення (95 і 99 %) і для підтвердження виправлення, лабораторний прогін зі своїм зерном', run: async () => {
      const f = (await ex()).fl;
      return all(
        exact(t, 'pr07.flaky.p', f.p),
        exact(t, 'pr07.flaky.n95', f.n95, 'n ≥ ln 0,05 / ln(1 − p), ціле вгору'),
        exact(t, 'pr07.flaky.n99', f.n99, 'n ≥ ln 0,01 / ln(1 − p), ціле вгору'),
        exact(t, 'pr07.flaky.n_fix', f.n_fix, `скільки зелених прогонів поспіль потрібно, щоб при цілі p < ${f.target} збій лишився б непоміченим не частіше за 5 %`),
        close(t, 'pr07.flaky.miss_ppm', f.miss_ppm, 0.05, 'імовірність n_fix зелених прогонів поспіль, якщо дефект із часткою p не усунуто, у мільйонних частках (ppm); дві значущі цифри'),
        exact(t, 'pr07.flaky.lab_failures', f.lab_failures, '100 прогонів: node kit/tools/flaky.mjs'),
        exact(t, 'pr07.flaky.lab_first', f.lab_first, 'номер першого збійного прогону'));
    } },
    { level: 3, text: `Межові тести команд і налаштувань: ${F.unitDomain} зелений і вбиває всі мутанти меж`, run: async () => {
      const x = await ex();
      const r = await killedAll('cmdset', 'команди й налаштування');
      if (r !== true) return r;
      return exact(t, 'pr07.mutants.cmdset', { total: x.counts.cmdset, killed: x.counts.cmdset }, 'підсумок node kit/tools/qa-mutants.mjs data (рядок «команди й налаштування»)');
    } },
    { level: 3, text: `Межові тести діапазонів метрик: ${F.dbRange} зелений і вбиває всі мутанти меж`, run: async () => {
      const x = await ex();
      const r = await killedAll('range', 'діапазони метрик');
      if (r !== true) return r;
      return exact(t, 'pr07.mutants.range', { total: x.counts.range, killed: x.counts.range }, 'підсумок node kit/tools/qa-mutants.mjs data (рядок «діапазони метрик»)');
    } },
    // ---------- рівень 4 ----------
    { level: 4, text: `Правила рівнів: ${F.unitRules} бере пороги з RULES_<код> і вбиває всі мутанти порогів, гістерезису й напряму`, run: async () => {
      const x = await ex();
      if (!inApp(F.unitRules)) return `немає ${F.unitRules}`;
      const src = fs.readFileSync(path.join(APP, F.unitRules), 'utf8');
      if (!src.includes(`RULES_${P.code}`)) return `${F.unitRules} не звертається до RULES_${P.code}: тест має брати правила вашого домену, а не теплиці`;
      for (const c of Q.ruleCards(P)) for (const n of [c.rule.warn, c.rule.crit]) if (!new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}(?![\\d])`).test(src)) return `у ${F.unitRules} немає порога ${n} правила ${c.metric}: рядки таблиці мають містити числа вашого домену`;
      const r = await killedAll('rules', 'пороги, гістерезис, напрям');
      if (r !== true) return r;
      return exact(t, 'pr07.mutants.rules', { total: x.counts.rules, killed: x.counts.rules });
    } },
    { level: 4, text: 'Епізоди й рівні: дев’ять мутантів підрозділу 7.2.2 (nextLevel, findViolations) убито', run: async () => {
      const x = await ex();
      const r = await killedAll('logic', 'логіка nextLevel і findViolations');
      if (r !== true) return r;
      return exact(t, 'pr07.mutants.logic', { total: x.counts.logic, killed: x.counts.logic });
    } },
    { level: 4, text: `Інтеграційний тест: ${F.netDomain} (брокер Aedes, корінь «${P.topicRoot}») зелений і вбиває три мутанти шляху`, run: async () => {
      const x = await ex();
      const r = await killedAll('net', 'шлях через брокер');
      if (r !== true) return r;
      return exact(t, 'pr07.mutants.net', { total: x.counts.net, killed: x.counts.net });
    } },
    // ---------- рівень 5 ----------
    { level: 5, text: 'Карантин нестабільних тестів: мінімальний набір, після якого частка червоних прогонів не перевищує допуск', run: async () => {
      const q = (await ex()).qr;
      return all(
        exact(t, 'pr07.quarantine.set', q.set, 'тести з найбільшою часткою збоїв, за спаданням; назви як у журналі CI'),
        close(t, 'pr07.quarantine.before_pct', q.before_pct, 0.02, '1 − ∏(1 − p) за всім журналом, у відсотках'),
        close(t, 'pr07.quarantine.after_pct', q.after_pct, 0.02, 'те саме для тестів, що лишилися поза карантином'));
    } },
    { level: 5, text: 'Матриця «мутант × набір тестів»: 12 мутантів проти Jest unit, Jest integration і node:test; жоден не лишається непоміченим', run: async () => {
      const { matrix } = await import('../qa-matrix.mjs');
      const m = await matrix(P);
      if (m.error) return m.error;
      const lost = m.rows.filter((r) => !r.unit && !r.integration && !r.legacy);
      if (lost.length) return `жоден набір не помічає ${fmt(lost[0])}${lost.length > 1 ? ` (і ще ${lost.length - 1})` : ''}`;
      const have = getPath(t, 'pr07.matrix.rows');
      if (!Array.isArray(have) || have.length !== m.rows.length) return `pr07.matrix.rows: очікується ${m.rows.length} рядків (node kit/tools/qa-mutants.mjs matrix), у журналі ${Array.isArray(have) ? have.length : JSON.stringify(have)}`;
      for (const r of m.rows) {
        const h = have.find((x) => x.id === r.id);
        if (!h) return `pr07.matrix.rows: немає мутанта ${r.id}`;
        for (const l of ['unit', 'integration', 'legacy']) if (Boolean(h[l]) !== Boolean(r[l])) return `pr07.matrix.rows: ${r.id}, набір ${l}: у журналі ${Boolean(h[l])}, виміряно ${Boolean(r[l])}`;
      }
      const tot = { unit: m.rows.filter((r) => r.unit).length, integration: m.rows.filter((r) => r.integration).length, legacy: m.rows.filter((r) => r.legacy).length };
      return exact(t, 'pr07.matrix.totals', tot, 'скільки мутантів вбиває кожен набір');
    } },
    { level: 5, text: 'ADR-007: розділи й числа (e2e_max, n_fix, кількість тестів у карантині)', run: async () => {
      const x = await ex();
      const s = norm(adr());
      if (!s) return 'немає pr07/adr-007.md';
      const need = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки'];
      const miss = need.filter((h) => !new RegExp(`^#{1,3}\\s*${h}`, 'mi').test(s));
      if (miss.length) return `в ADR-007 бракує розділів: ${miss.join(', ')}`;
      const nums = [[x.pyr.e2e_max, 'кількість наскрізних сценаріїв'], [x.fl.n_fix, 'кількість зелених прогонів для підтвердження виправлення'],
        [x.qr.set.length, 'кількість тестів у карантині']];
      for (const [n, what] of nums) if (!new RegExp(`(?<![\\d.,])${n}(?![\\d])`).test(s)) return `в ADR-007 не названо число ${n} (${what})`;
      if (!/карантин/i.test(s)) return 'в ADR-007 не сказано про карантин (власник, дата повернення)';
      return true;
    } },
  ];
}
