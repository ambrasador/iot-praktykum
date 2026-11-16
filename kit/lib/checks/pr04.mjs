import { getPath } from '../track.mjs';
import { exists, read, number, rel, all, runClientTests } from '../verify-core.mjs';
import { pr04 as expect04 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import { probeDomain, paletteProblems } from '../dash-probe.mjs';
import * as F from '../formulas.mjs';

const nums = (s) => [...s.matchAll(/\d[\d  ]*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')));
const exact = (t, key, expected, hint = '') => {
  const v = getPath(t, key);
  return v === expected ? true : `${key} = ${JSON.stringify(v)}, очікується ${JSON.stringify(expected)}${hint ? `. ${hint}` : ''}`;
};
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const ui = P.ui; const T = P.load.T;
  let X = null;
  const ex = async () => (X ??= await expect04(t.variant, P, t.seed));
  const kStudent = () => getPath(t, 'pr04.k');
  const adr = () => (exists('pr04', 'adr-004.md') ? read('pr04', 'adr-004.md') : '');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: ПР2 (епізоди сповіщень) і ПР3 (канал реального часу) виконано', run: () => {
      if (typeof getPath(t, 'pr02.episodes') !== 'number') return 'у track.json немає pr02.episodes: завершіть ПР2';
      if (!['sio', 'sse'].includes(getPath(t, 'pr03.transport'))) return 'у track.json немає pr03.transport: завершіть ПР3';
      if (t.level >= 4 && typeof getPath(t, 'pr02.interval') !== 'string') return 'для рівня «4» і вище потрібен pr02.interval (інтервал агрегації для графіка з ПР2)';
      return true;
    } },
    { level: 3, text: 'Число періодів k до «Немає даних»: хибні перемикання за формулою 4.1 і межа за мовчанням', run: async () => {
      const x = await ex(); const k = kStudent();
      if (!x.feasibleK.includes(k)) return `pr04.k = ${JSON.stringify(k)}: потрібне k, за якого хибних перемикань на екрані за добу ≤ ${ui.falsePerDayMax} і k · T ≤ ${ui.silenceMaxS} с. Допустимі k перебирайте від 2`;
      const p = ui.lossPct / 100;
      return all(
        number(t, 'pr04.p_false_pct', 100 * F.pFalse(p, k), 0.02, 'P = p^k, у відсотках'),
        number(t, 'pr04.false_per_card_day', F.falsePerCardDay(T, p, k), 0.02, '(86 400 / T) · (1 − p) · p^k'),
        number(t, 'pr04.false_per_day', F.falsePerCardDay(T, p, k) * x.cardsTotal, 0.02, `помножте на кількість карток екрана: ${x.n} пристроїв × ${ui.cards.length} метрики`));
    } },
    { level: 3, text: 'Період опитування карток P: межа за k (формула 4.2) і за віком показання, найбільше ціле P', run: async () => {
      const x = await ex(); const k = kStudent();
      if (!x.feasibleK.includes(k)) return 'спершу виправте pr04.k (попередній пункт)';
      const f = x.forK(k);
      return all(
        number(t, 'pr04.poll_max_s', f.bound_k, 0.005, 'P < (k − 1) · T − δ'),
        number(t, 'pr04.poll_age_s', f.bound_age, 0.005, 'вік здорового показання T + P + δ не більший за ui.ageMaxS'),
        exact(t, 'pr04.poll_s', f.P, 'найбільше ціле P, що задовольняє обидві межі: строго менше за першу, не більше за другу'));
    } },
    { level: 3, text: 'Конфігурація домену й статуси: client/domain.js, STALE_PERIODS у client/status.js, зонд kit/tools/dash-probe.mjs', run: async () => {
      const x = await ex(); const k = kStudent();
      if (!x.feasibleK.includes(k)) return 'спершу виправте pr04.k';
      const r = await probeDomain(t.variant, { k });
      if (r.problems.length) return r.problems.slice(0, 4).join('\n      ');
      const tests = runClientTests(['client/status.test.js', 'client/cards.test.js', 'client/history.test.js']);
      return tests.ok ? true : `тести клієнта червоні (${tests.fail}): ${tests.failed.slice(0, 2).join('; ')}. Після зміни STALE_PERIODS оновіть тест межі «Немає даних» під k = ${k}`;
    } },
    { level: 3, text: 'Палітра й контраст: змінні client/dashboard.css, текст позначок ≥ 4,5 : 1, числа контрасту в журналі', run: async () => {
      const x = await ex();
      const p = paletteProblems(t.variant);
      if (p.length) return p.slice(0, 4).join('\n      ');
      const bad = [];
      for (const [s, c] of Object.entries(x.contrast)) {
        const rec = getPath(t, `pr04.contrast.${s}`) ?? {};
        for (const col of ['white', 'black']) if (!Number.isFinite(rec[col]) || Math.abs(rec[col] - c[col]) > 0.03) bad.push(`${s}.${col} = ${JSON.stringify(rec[col])} (очікується ≈ ${c[col].toFixed(2)})`);
        if (rec.text !== c.text) bad.push(`${s}.text = ${JSON.stringify(rec.text)}, очікується "${c.text}" — той колір тексту, що дає вищий контраст`);
      }
      return bad.length ? `pr04.contrast: ${bad.slice(0, 4).join('; ')}` : true;
    } },

    // ---------- рівень 4 ----------
    { level: 4, text: 'Інтервали й початковий діапазон за бюджетом точок (формула 4.4); інтервал діапазону графіка збігається з ПР2', run: async () => {
      const x = await ex();
      const rows = getPath(t, 'pr04.ranges');
      if (!Array.isArray(rows)) return 'pr04.ranges: масив рядків { range, raw, interval, points } для кожного діапазону з ui.ranges';
      const miss = [];
      for (const e of x.ranges) {
        const r = rows.find((q) => q.range === e.range);
        if (!r) { miss.push(`немає діапазону ${e.range}`); continue; }
        if (r.raw !== e.raw) miss.push(`${e.range}: raw = ${r.raw}, очікується ${e.raw} (R / T)`);
        else if ((r.interval ?? null) !== e.interval) miss.push(`${e.range}: interval = ${JSON.stringify(r.interval ?? null)}, очікується ${JSON.stringify(e.interval)}${e.interval ? '' : ' (null: сирих точок не більше за B)'}`);
        else if (!(e.interval ? [e.points, e.points + 1].includes(r.points) : r.points === e.points)) miss.push(`${e.range}: points = ${r.points}, очікується ${e.points}${e.interval ? ' або на одну більше (останній інтервал неповний)' : ''}`);
      }
      if (miss.length) return miss.slice(0, 4).join('; ');
      const chartRow = x.ranges.find((r) => r.range === `${P.chart.days}d`);
      if (chartRow && chartRow.interval !== x.pr02interval) return `інтервал для ${chartRow.range} (${chartRow.interval}) має збігатися з pr02.interval = ${x.pr02interval}`;
      return exact(t, 'pr04.default_range', x.defaultRange, `найкоротший діапазон, у якому не менше ${F.UI.rawMin} сирих точок`);
    } },
    { level: 4, text: 'Середнє ховає пік: видимі епізоди ПР2 за середнім і за краєм смуги (лабораторія, частина А)', run: async () => {
      const L = (await ex()).lab;
      const rec = getPath(t, 'pr04.peak') ?? {};
      const bad = [];
      if (rec.interval !== L.interval.name) bad.push(`interval = ${JSON.stringify(rec.interval)}, очікується ${L.interval.name} (pr02.interval)`);
      if (rec.episodes !== L.episodes) bad.push(`episodes = ${rec.episodes}, очікується ${L.episodes}`);
      if (rec.avg_visible !== L.interval.avg_visible) bad.push(`avg_visible = ${rec.avg_visible}, очікується ${L.interval.avg_visible}`);
      if (rec.band_visible !== L.interval.band_visible) bad.push(`band_visible = ${rec.band_visible}, очікується ${L.interval.band_visible}`);
      if (rec.edge !== L.edge) bad.push(`edge = ${JSON.stringify(rec.edge)}, очікується "${L.edge}": небезпечний край смуги залежить від напрямку порога (${P.alert.op === 'gt' ? 'вище за поріг — максимум' : 'нижче за поріг — мінімум'})`);
      return bad.length ? `pr04.peak: ${bad.join('; ')}` : true;
    } },
    { level: 4, text: 'Проріджування сирого ряду до бюджету: метод зберігає екстремум і всі епізоди; відхилені методи названо (лабораторія, частина Б)', run: async () => {
      const L = (await ex()).lab;
      const rec = getPath(t, 'pr04.downsample') ?? {};
      if (!L.acceptable.includes(rec.method)) return `pr04.downsample.method = ${JSON.stringify(rec.method)}: метод має зберігати крайнє значення (втрата 0) і показувати всі ${L.episodes} епізодів у межах бюджету B = ${L.budget}; допустимі методи — з таблиці лабораторії`;
      const m = L.methods[rec.method];
      const bad = [];
      if (Math.abs(rec.points - m.points) > 1) bad.push(`points = ${rec.points}, очікується ${m.points}`);
      if (!Number.isFinite(rec.loss) || Math.abs(rec.loss - m.loss) > 0.05) bad.push(`loss = ${rec.loss}, очікується ${m.loss}`);
      if (rec.visible !== m.visible) bad.push(`visible = ${rec.visible}, очікується ${m.visible}`);
      if (!sameSet(rec.rejected, L.rejected)) bad.push(`rejected = ${JSON.stringify(rec.rejected)}, очікується набір ${JSON.stringify(L.rejected)}: відхиліть кожен метод, що губить екстремум, епізод або перевищує бюджет`);
      return bad.length ? `pr04.downsample: ${bad.join('; ')}` : true;
    } },

    // ---------- рівень 5 ----------
    { level: 5, text: 'Ємність опитування карток: U · n / P проти R_read / 3 (формула 4.8), трафік екрана, режим карток', run: async () => {
      const x = await ex(); const k = kStudent();
      if (!x.feasibleK.includes(k)) return 'спершу виправте pr04.k';
      const f = x.forK(k);
      const rec = getPath(t, 'pr04.poll') ?? {};
      return all(
        number(t, 'pr04.poll.load_rps', f.load, 0.02, `U · n / P: U = ${x.U} екранів (ПР1), n = ${x.n} пристроїв на екрані (кімната ПР3), P = pr04.poll_s`),
        number(t, 'pr04.poll.share_pct', f.share_pct, 0.02, 'частка від R_read / 3 = 1 333 запитів за секунду'),
        number(t, 'pr04.poll.n_max', f.n_max, 0.02, 'n_max = R_read · P / (3 · U), ціла частина'),
        number(t, 'pr04.poll.traffic_mb_day', f.traffic, 0.03, '(86 400 / P) · n · 0,4 КБ на екран'),
        rec.mode === f.mode ? true : `pr04.poll.mode = ${JSON.stringify(rec.mode)}, очікується "${f.mode}" (per_device: частка ≤ 50 % і трафік ≤ ${ui.trafficMBDayMax} МБ/добу; group: те саме для одного запиту на групу; інакше stream)`);
    } },
    { level: 5, text: 'Агрегат і вигляд за класом метрики: gauge, state, counter (таблиця вибору)', run: async () => {
      const x = await ex();
      const rec = getPath(t, 'pr04.views') ?? {};
      const bad = [];
      for (const v of x.views) {
        const r = rec[v.metric] ?? {};
        if (r.agg !== v.agg) bad.push(`${v.metric}: agg = ${JSON.stringify(r.agg)}, очікується "${v.agg}"`);
        if (r.chart !== v.chart) bad.push(`${v.metric}: chart = ${JSON.stringify(r.chart)}, очікується "${v.chart}"`);
      }
      return bad.length ? `pr04.views: ${bad.slice(0, 4).join('; ')}` : true;
    } },
    { level: 5, text: 'ADR-004 (дашборд домену): k, період опитування, бюджет і метод, режим карток, тригер перегляду', run: async () => {
      const x = await ex();
      const a = adr();
      if (!a) return 'немає pr04/adr-004.md (шаблон: kit/templates/adr.md)';
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки', 'Тригер'].filter((h) => !new RegExp(`^#+\\s*${h}`, 'mi').test(a));
      if (miss.length) return `У ADR-004 бракує розділів: ${miss.join(', ')}`;
      const have = nums(a);
      const need = [['k', kStudent()], ['poll_s', getPath(t, 'pr04.poll_s')], ['B', x.B]].filter(([, v]) => Number.isFinite(v));
      const lost = need.filter(([, v]) => !have.some((q) => rel(q, v, 0.001)));
      if (lost.length) return `У ADR-004 немає чисел: ${lost.map(([n, v]) => `${n} = ${v}`).join(', ')}`;
      const method = getPath(t, 'pr04.downsample.method'); const mode = getPath(t, 'pr04.poll.mode');
      const words = [method, mode, x.defaultRange].filter(Boolean).filter((w) => !a.toLowerCase().includes(String(w).toLowerCase()));
      return words.length ? `У ADR-004 не згадано: ${words.join(', ')}` : true;
    } },
  ];
}
