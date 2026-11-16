import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getPath } from '../track.mjs';
import { exists, read, all } from '../verify-core.mjs';
import { APP, ROOT } from '../app.mjs';
import { pr08 as expect08 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import * as O from '../ops-lab.mjs';

const exact = (t, key, expected, hint = '') => {
  const v = getPath(t, key);
  return JSON.stringify(v) === JSON.stringify(expected) ? true : `${key} = ${JSON.stringify(v)}, очікується ${JSON.stringify(expected)}${hint ? `. ${hint}` : ''}`;
};
const close = (t, key, expected, tol, hint = '') => {
  const v = getPath(t, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${key}: очікується число, у журналі ${JSON.stringify(v)}`;
  return Math.abs(v - expected) <= tol * Math.max(Math.abs(expected), 1e-12) ? true : `${key} = ${v}: розбіжність із очікуваним більша за ${Number((tol * 100).toPrecision(2))} %${hint ? `. ${hint}` : ''}`;
};
const inApp = (f) => fs.existsSync(path.join(APP, f));
const norm = (s) => s.replace(/(\d)[\s ](?=\d{3}\b)/g, '$1');
// число в тексті з десятковою комою або крапкою, не частина довшого числа
const numRe = (x) => new RegExp(`(?<![\\d.,])${String(x).replace('.', '[.,]')}(?![\\d]|[.,]\\d)`);
const secOf = (v) => { const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : (/^(\d+)m$/.test(String(v ?? '').trim()) ? Number(String(v).trim().slice(0, -1)) * 60 : NaN); };

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const F = O.opsFiles(P);
  const opsDir = path.join(APP, 'ops');
  const rn = path.basename(F.rules); const tn = path.basename(F.tests);
  let X = null;
  const ex = async () => (X ??= await expect08(t.variant, P));
  // Кроки з журналу ПР8 (вибір студента); допустимі лише пари з таблиці
  const stepsOf = () => {
    const e = getPath(t, 'pr08.silence.evalS'); const s = getPath(t, 'pr08.silence.scrapeS');
    return O.STEP_OPTIONS.some(([a, b]) => a === e && b === s) ? { evalS: e, scrapeS: s } : null;
  };
  const mut = new Map();
  const mutant = async (id) => {
    if (!mut.has(id)) mut.set(id, O.runRuleMutant(opsDir, rn, tn, O.ruleMutants(P).find((m) => m.id === id)));
    return mut.get(id);
  };
  const killed = async (ids, label) => {
    if (!inApp(F.rules)) return `немає ${F.rules}`;
    if (!inApp(F.tests)) return `немає ${F.tests}`;
    const own = await O.runOwn(opsDir, rn, tn);
    if (!own.ok) return `власні тести не проходять на ваших правилах:\n${own.problem}`;
    const res = [];
    for (const id of ids) res.push([id, await mutant(id)]);
    const bad = res.filter(([, r]) => r.status !== 'killed');
    if (bad.length) {
      const [id, r] = bad[0];
      const m = O.ruleMutants(P).find((x) => x.id === id);
      return `${label}: вбито ${res.length - bad.length} із ${res.length}; ${r.status === 'survived' ? 'вижив' : 'не застосовано'} «${m.title}» [${id}]${bad.length > 1 ? ` (і ще ${bad.length - 1})` : ''}. ${r.status === 'survived' ? 'Додайте сценарій, у якому ця зміна стає видимою: час перевірки має лежати по різні боки від межі' : r.out}`;
    }
    return true;
  };

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: журнал ПР7, еталонні правила й Compose на місці, Docker доступний; для рівня «4» і вище — ще журнал ПР6 (flush_s) і pr03/rt.env', run: async () => {
      const miss = [];
      // flush_s (ПР6) і змінні rt.env (ПР3) потрібні лише для Compose рівня «4»; ліміт черги в rt.env з’являється в ПР3 на рівні «5»
      if (Number(t.level) >= 4) {
        const fl = getPath(t, 'pr06.limit.flush_s');
        if (typeof fl !== 'number' || !Number.isFinite(fl)) miss.push('pr06.limit.flush_s у track.json (ПР6: час спорожнення черги обмеження частоти)');
        if (!exists('pr03', 'rt.env')) miss.push('pr03/rt.env (ПР3)');
        else {
          const e = O.readEnvFile(path.join(ROOT, F.rtEnv));
          for (const k of ['TOPIC_ROOT', 'RT_WINDOW_MS']) if (!(k in e)) miss.push(`${k} у pr03/rt.env`);
          if (Number(t.level) >= 5 && !('RT_MAX_QUEUE' in e) && !('RT_SSE_MAX_BUFFERED' in e)) miss.push('ліміт черги (RT_MAX_QUEUE для Socket.IO або RT_SSE_MAX_BUFFERED для SSE) у pr03/rt.env');
        }
      }
      if (typeof getPath(t, 'pr07.pyramid.e2e_max') !== 'number') miss.push('pr07.pyramid.e2e_max у track.json (ПР7)');
      for (const f of ['ops/alerts.rules.yml', 'compose.yaml', 'healthcheck.js']) if (!inApp(f)) miss.push(f);
      const d = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
      if (d.status !== 0) miss.push('Docker (promtool запускається в контейнері prom/prometheus; docker version не відповів)');
      return miss.length ? `Бракує: ${miss.join('; ')}` : true;
    } },
    { level: 3, text: 'Бюджет помилок: частка b, хвилини повної відмови за 30 діб, пороги трьох пар «вікно — швидкість витрати»', run: async () => {
      const x = await ex(); const S = x.slo;
      return all(
        close(t, 'pr08.slo.b', S.b, 1e-6, 'b = 1 − SLO / 100'),
        close(t, 'pr08.slo.budget_min', S.budget_min, 1e-6, 'b · 30 діб · 1440 хв'),
        close(t, 'pr08.slo.thr.fast', S.thr.fast, 1e-6, '14,4 · b'),
        close(t, 'pr08.slo.thr.slow', S.thr.slow, 1e-6, '6 · b'),
        close(t, 'pr08.slo.thr.ticket', S.thr.ticket, 1e-6, '1 · b'));
    } },
    { level: 3, text: 'Час спрацювання t = k · b · W / e для двох рівнів помилок домену; «немає» там, де e не перевищує поріг пари', run: async () => {
      const rows = (await ex()).slo.rows;
      const have = getPath(t, 'pr08.tfire');
      if (!Array.isArray(have) || have.length !== rows.length) return `pr08.tfire: очікується ${rows.length} рядків (пара, e, t_min), у журналі ${Array.isArray(have) ? have.length : JSON.stringify(have)}`;
      for (const r of rows) {
        const h = have.find((y) => y.pair === r.pair && Math.abs(y.e - r.e) < 1e-12);
        if (!h) return `pr08.tfire: немає рядка для пари ${r.pair} і e = ${r.e}`;
        if (r.t_min === null) { if (h.t_min !== null) return `pr08.tfire: пара ${r.pair}, e = ${r.e}: e не перевищує поріг пари, сповіщення не спрацює, у журналі має бути null`; }
        else if (typeof h.t_min !== 'number' || Math.abs(h.t_min - r.t_min) > 0.01 * r.t_min) return `pr08.tfire: пара ${r.pair}, e = ${r.e}: t_min = ${JSON.stringify(h.t_min)}, очікується близько ${r.t_min} хв (t = k · b · W / e, W у хвилинах)`;
      }
      return true;
    } },
    { level: 3, text: 'Правило тиші: поріг 5T, найгірша затримка, крок обчислення й збору, втрачені показання', run: async () => {
      const Z = (await ex()).silence;
      const st = stepsOf();
      if (!st) return `pr08.silence.evalS / scrapeS: оберіть пару з таблиці (${O.STEP_OPTIONS.map(([a, b]) => `${a}/${b} с`).join(', ')})`;
      const dNew = Z.threshold_s + st.evalS + st.scrapeS;
      const lambda = P.load.N * P.load.m / P.load.T;
      if (dNew > Z.target_s) return `pr08.silence: пара ${st.evalS}/${st.scrapeS} с дає затримку ${dNew} с, вимога паспорта — не більше ${Z.target_s} с`;
      return all(
        exact(t, 'pr08.silence.threshold_s', Z.threshold_s, '5T'),
        exact(t, 'pr08.silence.d_max_s', Z.d_max_s, 'поріг + 60 с обчислення + 15 с збору (початкові кроки)'),
        exact(t, 'pr08.silence.d_max_new_s', dNew, 'поріг + крок обчислення + крок збору для обраної пари'),
        close(t, 'pr08.silence.lost', Math.round(lambda * dNew), 0.01, 'λ · d_max для обраної пари, λ = N · m / T'));
    } },
    { level: 3, text: `Файл правил ${F.rules}: promtool приймає синтаксис, пороги й вікна домену, а сценарії прихованого набору (перезапуск, тиша, брокер, бюджет, відновлення) проходять`, run: async () => {
      if (!inApp(F.rules)) return `немає ${F.rules}`;
      const st = stepsOf();
      if (!st) return 'спершу заповніть pr08.silence (обрана пара кроків)';
      let info;
      try { info = O.rulesInfo(path.join(APP, F.rules)); } catch (e) { return `${F.rules} не розбирається як YAML: ${e.message.split('\n')[0]}. Перевірте командою promtool check rules: node kit/tools/promtool.mjs check`; }
      const iv = secOf(info.NoReadings?.interval);
      if (iv !== st.evalS) return `група з NoReadings: interval = ${info.NoReadings?.interval ?? 'не задано'}, очікується ${st.evalS}s (крок обчислення з pr08.silence.evalS)`;
      const r = await O.runOracle(P, path.join(APP, F.rules), st);
      return r.ok ? true : r.problem;
    } },
    // ---------- рівень 4 ----------
    { level: 4, text: `Compose ${F.compose}: порядок зупинки з ПР6, проба працездатності з паспорта, змінні каналу реального часу з ПР3`, run: async () => {
      if (!inApp(F.compose)) return `немає ${F.compose}`;
      const syn = await O.composeSyntax(path.join(APP, F.compose));
      if (syn.code !== 0) return `docker compose config: ${syn.out.trim().split('\n').slice(0, 4).join(' | ')}`;
      const flush = getPath(t, 'pr06.limit.flush_s');
      if (typeof flush !== 'number' || !Number.isFinite(flush)) return 'у журналі немає pr06.limit.flush_s (час спорожнення черги з ПР6): без нього не порахувати stop_grace_period';
      const rt = O.readEnvFile(path.join(ROOT, F.rtEnv));
      const c = O.composeCheck(P, path.join(APP, F.compose), flush, rt);
      if (c.probs.length) return c.probs[0] + (c.probs.length > 1 ? ` (і ще ${c.probs.length - 1})` : '');
      return all(
        exact(t, 'pr08.compose.grace_s', c.values.grace_s, 'stop_grace_period у секундах'),
        exact(t, 'pr08.compose.detect_s', c.values.detect_s, 'interval · retries + timeout у секундах'),
        exact(t, 'pr08.compose.start_period_s', c.values.start_period_s, 'start_period у секундах'));
    } },
    { level: 4, text: `Власні тести ${F.tests}: проходять на ваших правилах і вбивають чотири мутанти (поріг тиші ±20 %, швидкість витрати 14,4, витримка брокера)`, run: async () => {
      const r = await killed(O.M_L4, 'мутанти правил');
      if (r !== true) return r;
      return exact(t, 'pr08.mutants.core', { total: O.M_L4.length, killed: O.M_L4.length }, 'підсумок node kit/tools/promtool.mjs mutants');
    } },
    // ---------- рівень 5 ----------
    { level: 5, text: 'Ще три мутанти: швидкість витрати повільної пари, коротке вікно швидкої пари, відлік тиші від старту процесу', run: async () => {
      const r = await killed(O.M_L5, 'мутанти правил');
      if (r !== true) return r;
      return exact(t, 'pr08.mutants.extra', { total: O.M_L5.length, killed: O.M_L5.length });
    } },
    { level: 5, text: 'ADR-008 і runbook: рішення з числами та дії черговому для трьох сповіщень', run: async () => {
      const x = await ex();
      if (!exists('pr08', 'adr-008.md')) return 'немає pr08/adr-008.md';
      const adr = norm(read('pr08', 'adr-008.md'));
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки'].filter((h) => !new RegExp(`^#{1,3}\\s*${h}`, 'mi').test(adr));
      if (miss.length) return `в ADR-008 бракує розділів: ${miss.join(', ')}`;
      const st = stepsOf();
      const fast = x.slo.rows.find((r) => r.pair === 'fast' && r.t_min !== null);
      const nums = [[x.slo.b, 'частка бюджету помилок b'], [x.slo.budget_min, 'хвилини бюджету за 30 діб'], [fast.t_min, `час спрацювання швидкої пари для e = ${fast.e}`],
        [x.silence.threshold_s + st.evalS + st.scrapeS, 'найгірша затримка тиші, с'], [getPath(t, 'pr08.compose.grace_s'), 'stop_grace_period, с'], [getPath(t, 'pr08.compose.detect_s'), 'час виявлення збою пробою, с']];
      for (const [n, what] of nums) if (!numRe(n).test(adr)) return `в ADR-008 не названо число ${String(n).replace('.', ',')} (${what})`;
      if (!/бюджет/i.test(adr)) return 'в ADR-008 не сказано про бюджет помилок';
      if (!exists('pr08', 'runbook.md')) return 'немає pr08/runbook.md';
      const rb = norm(read('pr08', 'runbook.md'));
      for (const name of ['NoReadings', 'BrokerDisconnected', 'ApiBudgetFastBurn']) {
        const m = new RegExp(`^#{2,3}\\s*[^\\n]*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3}\\s|$(?![\\s\\S]))`, 'm').exec(rb);
        if (!m) return `у runbook немає розділу про ${name} (заголовок другого рівня з назвою сповіщення)`;
        for (const w of ['Перевірка', 'Дія']) if (!new RegExp(w, 'i').test(m[1])) return `runbook, ${name}: немає пункту «${w}»`;
        if (!/`[^`\n]*(docker|curl|npm|promtool)[^`\n]*`/i.test(m[1])) return `runbook, ${name}: перевірка без команди — додайте команду в зворотних лапках (docker …, curl …)`;
      }
      return true;
    } },
  ];
}
