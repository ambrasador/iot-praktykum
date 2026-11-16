import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../paths.mjs';
import { getPath } from '../track.mjs';
import { exists, read, number, rel, all } from '../verify-core.mjs';
import { pr01 as expect01, OPTIONS } from '../expect.mjs';
import { classifyStream } from '../oracle.mjs';
import { loadPassport } from '../passport.mjs';
import * as F from '../formulas.mjs';

// точка перевірки моделі λ(s): розмір пакета пристрою, якщо він малий; інакше чотири рядки, як у підручнику
export const stestRows = (p) => (p.requirements.deviceBatch >= 2 && p.requirements.deviceBatch <= 8 ? p.requirements.deviceBatch : 4);

const node = (args, env = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
const KIT = path.resolve(import.meta.dirname, '..', '..');

export function checks(track) {
  const P = loadPassport(track.variant);
  const E = expect01(P);
  const t = track;
  const opt = getPath(t, 'pr01.option');
  const chosen = E.options[opt];
  const noneOr = (key, exp, tol = 0.05) => {
    const v = getPath(t, key);
    if (!Number.isFinite(exp)) return (v === 'none' || v === null) ? true : `${key}: за цими даними черга не переповнюється; очікується "none", у журналі ${JSON.stringify(v)}`;
    return number(t, key, exp, tol);
  };
  const adr = () => (exists('pr01', 'adr-001.md') ? read('pr01', 'adr-001.md') : '');
  // Частка в відсотках буває дуже малою (сотні частки відсотка): округлення до двох знаків після коми допустиме
  const shareCheck = () => {
    const v = getPath(t, 'pr01.poll_share_pct'); const e = E.poll.share_pct;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `pr01.poll_share_pct: очікується число, у журналі ${JSON.stringify(v)}`;
    return rel(v, e, 0.03) || Math.abs(v - e) <= 0.0051 ? true
      : `pr01.poll_share_pct = ${v}: розбіжність із очікуваним. Частка = R_poll / (R_read / 3), R_read = 4 000, у відсотках (допустиме округлення до двох знаків після коми)`;
  };
  const nums = (s) => [...s.matchAll(/\d[\d  ]*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')));

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'λ_avg записано й збігається з розрахунком за паспортом', run: () => number(t, 'pr01.lambda_avg', E.lambda_avg, 0.02, 'λ_avg = N·m/T, одиниці — рядків за секунду') },
    { level: 3, text: 'λ_peak записано й збігається з розрахунком', run: () => {
      const v = getPath(t, 'pr01.lambda_peak');
      if (P.load.model === 'poisson') return Math.abs(v - E.lambda_peak) <= 1 ? true : `pr01.lambda_peak = ${v}: для пристроїв із випадковими фазами беруть квантиль Пуассона 99,9 % від λ_avg`;
      return number(t, 'pr01.lambda_peak', E.lambda_peak, 0.02, 'модель сплеску: f·N·b/τ + (1 − f)·λ_avg');
    } },
    { level: 3, text: 'Річний обсяг: мільйонів рядків і гігабайт', run: () => all(number(t, 'pr01.rows_year_mln', E.rows_year_mln, 0.02, 'рядків за рік = λ_avg · 31 536 000'),
      number(t, 'pr01.gb_year', E.gb_year, 0.02, 'V = рядків · 97,2 байта, 1 ГБ = 10⁹ байт')) },
    { level: 3, text: 'Обрано допустимий режим приймання (A, B, C або D)', run: () => {
      if (!chosen) return `pr01.option має бути одним із A, B, C, D, у журналі ${JSON.stringify(opt)}`;
      if (!chosen.available) return `Варіант ${opt} недоступний для цього об'єкта (пристрій не пакетує)`;
      if (P.requirements.durable && !chosen.durable) return `Варіант ${opt} знімає довговічність, а за паспортом дані мають бути довговічними`;
      if (!chosen.ok) return `Варіант ${opt} не дає запасу: λ_peak = ${F.round(E.lambda_peak, 0)} при допустимих ${F.round(chosen.allowed, 0)}`;
      return true;
    } },
    { level: 3, text: 'Запас обраного режиму: частка допустимого піка, %', run: () => (chosen && Math.abs(getPath(t, 'pr01.share_pct') - chosen.share_pct) <= 2 ? true
      : `pr01.share_pct має дорівнювати λ_peak / (λ_max / 3) · 100 для обраного режиму (≈ ${chosen ? F.round(chosen.share_pct, 0) : '?'} %)`) },
    { level: 3, text: 'Потік брудних повідомлень приймається так, як визначає паспорт (звірка з еталонним підсумком)', run: () => {
      if (!exists('pr01', 'stream.ndjson')) return 'немає pr01/stream.ndjson: node kit/tools/gen-stream.mjs';
      const lines = read('pr01', 'stream.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const meta = lines.shift()._meta;
      if (meta.variant !== t.variant || meta.seed !== t.seed) return `pr01/stream.ndjson створено для іншого варіанта чи зерна (${meta.variant}/${meta.seed}); згенеруйте заново`;
      const exp = classifyStream(lines, Date.parse(meta.now), P);
      const rep = path.join(ROOT, 'pr01', 'ingest-report.json');
      const r = node([path.join(KIT, 'tools', 'ingest-run.mjs'), path.join(ROOT, 'pr01', 'stream.ndjson'), '--report', rep]);
      if (r.status !== 0) return `ingest-run завершився з помилкою: ${(r.stderr || r.stdout).split('\n')[0]}`;
      const got = JSON.parse(fs.readFileSync(rep, 'utf8'));
      const diffs = [];
      for (const k of ['stored', 'duplicate', 'rejected']) if (got[k] !== exp[k]) diffs.push(`${k}: у застосунку ${got[k]}, очікується ${exp[k]}`);
      for (const k of new Set([...Object.keys(exp.reasons), ...Object.keys(got.reasons)])) if ((got.reasons[k] ?? 0) !== (exp.reasons[k] ?? 0)) diffs.push(`${k}: ${got.reasons[k] ?? 0} замість ${exp.reasons[k] ?? 0}`);
      if (!diffs.length) return true;
      const d = (k) => (got.reasons[k] ?? 0) !== (exp.reasons[k] ?? 0);
      const hints = [];
      if (d('bad_topic')) hints.push('регулярний вираз TOPIC у mqtt-source.js має приймати корінь топіка вашого домену');
      if (d('unknown_metric')) hints.push('метрики домену додано не всі: RANGE у core.js');
      if (d('out_of_range')) hints.push('межі діапазонів у RANGE не збігаються з паспортом');
      if (!hints.length && got.duplicate > exp.duplicate) hints.push('ідентифікатор пристрою береться не з топіка: після зміни регулярного виразу група з коренем має бути незахоплювальною — (?:…)');
      return `Розбіжності: ${diffs.slice(0, 4).join('; ')}. ${hints.join('; ')}`;
    } },
    { level: 3, text: 'ADR-001 має розділи «Контекст», «Рішення», «Альтернативи», «Наслідки»', run: () => {
      const a = adr();
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки'].filter((h) => !new RegExp(`^#+\\s*${h}`, 'mi').test(a));
      if (!a) return 'немає pr01/adr-001.md (шаблон: kit/templates/adr.md)';
      return miss.length ? `У ADR-001 бракує розділів: ${miss.join(', ')}` : (a.length < 500 ? 'ADR-001 надто короткий: потрібні числа розрахунку й обґрунтування' : true);
    } },
    { level: 3, text: 'Скрипт розрахунку pr01/calc.mjs додано', run: () => (exists('pr01', 'calc.mjs') ? true : 'немає pr01/calc.mjs') },

    // ---------- рівень 4 ----------
    { level: 4, text: 'Виміряно λ для s = 1 і s = 500 (WAL + FULL); пакет швидший', run: () => {
      const a = getPath(t, 'pr01.lmax_wal_full_1'); const b = getPath(t, 'pr01.lmax_wal_full_500');
      if (!(a > 0 && b > 0)) return 'потрібні числа pr01.lmax_wal_full_1 і pr01.lmax_wal_full_500 (медіани bench-ingest)';
      return b > 2 * a ? true : 'пакет із 500 рядків має бути щонайменше вдвічі швидший за однорядкові транзакції: перевірте вимірювання';
    } },
    { level: 4, text: 'Параметри моделі c і u знайдено з двох вимірювань', run: () => {
      const a = getPath(t, 'pr01.lmax_wal_full_1'); const b = getPath(t, 'pr01.lmax_wal_full_500');
      const { c, u } = F.fitCU(a, b);
      return all(number(t, 'pr01.c_ms', c * 1000, 0.05, 'c + u = 1/λ(1); c + 500·u = 500/λ(500); одиниці — мілісекунди'),
        number(t, 'pr01.u_ms', u * 1000, 0.05));
    } },
    { level: 4, text: 'Передбачення λ(s) збігається з виміром для вашої кількості рядків у транзакції', run: () => {
      const s = stestRows(P);
      const a = getPath(t, 'pr01.lmax_wal_full_1'); const b = getPath(t, 'pr01.lmax_wal_full_500');
      const pred = F.throughput(F.fitCU(a, b), s);
      const r1 = number(t, 'pr01.pred_rows_s', pred, 0.03, `s = ${s} рядків у транзакції; λ(s) = s / (c + s·u)`);
      if (r1 !== true) return r1;
      const meas = getPath(t, 'pr01.meas_rows_s');
      if (!(meas > 0)) return 'потрібне виміряне значення pr01.meas_rows_s (bench-ingest --size ' + s + ')';
      return Math.abs(pred - meas) / meas <= 0.35 ? true : `передбачення ${F.round(pred, 0)} і вимір ${meas} розходяться більш ніж на 35 %: повторіть вимірювання або перевірте c і u`;
    } },
    { level: 4, text: 'Час до переповнення черги брокера для режиму A', run: () => noneOr('pr01.overflow_s', E.overflow_s) },
    { level: 4, text: 'Мінімальне вікно розсіювання звітів τ′', run: () => noneOr('pr01.tau_min_s', E.tau_min_s ?? Infinity) },
    { level: 4, text: 'Найбільше N, за якого обраний режим тримає запас', run: () => (chosen ? number(t, 'pr01.n_max', E.n_max[opt], 0.03, 'λ_peak(N) ≤ λ_max / 3, λ_peak лінійно залежить від N') : 'спершу оберіть режим') },
    { level: 4, text: 'Опитування чи push для дашборда: R_poll, частка порога, рішення', run: () => all(number(t, 'pr01.poll_rate', E.poll.r_poll, 0.02, 'R_poll = U / p'),
      shareCheck(),
      getPath(t, 'pr01.poll_way') === E.poll.way ? true : `pr01.poll_way = ${JSON.stringify(getPath(t, 'pr01.poll_way'))}; за критерієм очікується "${E.poll.way}"`) },
    { level: 4, text: 'Докази вимірювань: pr01/bench.txt', run: () => (exists('pr01', 'bench.txt') ? true : 'немає pr01/bench.txt (вставте виводи bench-ingest)') },

    // ---------- рівень 5 ----------
    { level: 5, text: 'Імітація сплеску виконана з параметрами паспорта (pr01/sim.json)', run: () => {
      if (!exists('pr01', 'sim.json')) return 'немає pr01/sim.json: node kit/tools/burst-sim.mjs ... --out pr01/sim.json';
      const s = JSON.parse(read('pr01', 'sim.json')).params; const L = P.load;
      const bad = ['N', 'm', 'T'].filter((k) => s[k] !== L[k]);
      if (L.model === 'burst') for (const k of ['f', 'tau', 'b']) if (s[k] !== L[k]) bad.push(k);
      return bad.length ? `Параметри імітації відрізняються від паспорта: ${bad.join(', ')}` : true;
    } },
    { level: 5, text: 'Результат імітації узгоджений із формулою піка', run: () => {
      const r = JSON.parse(read('pr01', 'sim.json'));
      if (P.load.model === 'burst') return rel(r.burst.mean_per_s, E.lambda_peak, 0.06) ? true : `середнє за вікном сплеску ${r.burst.mean_per_s} далеке від λ_peak = ${F.round(E.lambda_peak, 0)}`;
      return Math.abs(r.background.p999 - E.lambda_peak) <= Math.max(4, 0.25 * E.lambda_peak) ? true : `квантиль 99,9 % у імітації (${r.background.p999}) далекий від ${E.lambda_peak}`;
    } },
    { level: 5, text: 'Втрати черги з sim.json перенесено в журнал (pr01.sim_dropped, pr01.sim_mu)', run: () => {
      const r = JSON.parse(read('pr01', 'sim.json'));
      return getPath(t, 'pr01.sim_dropped') === r.queue.dropped && getPath(t, 'pr01.sim_mu') === r.params.mu ? true
        : `У журналі pr01.sim_dropped має дорівнювати ${r.queue.dropped}, pr01.sim_mu — ${r.params.mu}`;
    } },
    { level: 5, text: 'Власні тести меж: щонайменше три, усі проходять', run: () => {
      if (!exists('pr01', 'ingest.extra.test.js')) return 'немає pr01/ingest.extra.test.js (заготовка: kit/templates/pr01-ingest.extra.test.js)';
      const r = node(['--test', path.join(ROOT, 'pr01', 'ingest.extra.test.js')], { GM_APP: process.env.GM_APP ?? '' });
      const m = /# pass (\d+)/.exec(r.stdout); const f = /# fail (\d+)/.exec(r.stdout);
      const pass = m ? Number(m[1]) : 0; const fail = f ? Number(f[1]) : 1;
      return pass >= 3 && fail === 0 ? true : `Пройшло ${pass}, не пройшло ${fail}; потрібно ≥ 3 і 0`;
    } },
    { level: 5, text: 'ADR-001 містить тригер перегляду з числом N_max', run: () => {
      const a = adr();
      if (!/тригер/i.test(a)) return 'У ADR-001 немає розділу «Тригер перегляду»';
      const target = chosen ? E.n_max[opt] : 0;
      return nums(a).some((x) => rel(x, target, 0.03)) ? true : `У ADR-001 немає числа, близького до N_max (≈ ${target})`;
    } },
  ];
}
