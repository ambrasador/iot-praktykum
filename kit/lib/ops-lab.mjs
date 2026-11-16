// Лабораторія ПР8: бюджет помилок, правило тиші, сценарії promtool, мутанти правил, перевірка Compose.
// promtool запускається з образу prom/prometheus (Docker), як у підручнику (npm run test:rules).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP, appRequire } from './app.mjs';

const YAML = appRequire('yaml');
export const PROM_IMAGE = 'prom/prometheus:v3.16.0';

// ---------------------------------------------------------------- арифметика (підручник, 7.9.1, 7.11)
// Три пари «вікно — швидкість витрати»: довге вікно W (год), коротке вікно (хв)
export const PAIRS = [
  { id: 'fast', alert: 'ApiBudgetFastBurn', k: 14.4, longH: 1, shortMin: 5, severity: 'page' },
  { id: 'slow', alert: 'ApiBudgetSlowBurn', k: 6, longH: 6, shortMin: 30, severity: 'page' },
  { id: 'ticket', alert: 'ApiBudgetTicket', k: 1, longH: 72, shortMin: 360, severity: 'ticket' },
];
export const STEP_OPTIONS = [[60, 15], [30, 10], [15, 5]];       // (крок обчислення правил, крок збору метрик), с
export const WINDOW_DAYS = 30;
const r = (x, d) => Number(x.toFixed(d));

export function slo(P) {
  const b = r(1 - P.ops.slo.target / 100, 9);
  const thr = Object.fromEntries(PAIRS.map((p) => [p.id, r(p.k * b, 9)]));
  const rows = [];
  for (const pr of PAIRS) for (const e of P.ops.slo.errors) {
    const fires = e > thr[pr.id];
    rows.push({ pair: pr.id, e, t_min: fires ? r(pr.k * b * pr.longH / e * 60, 2) : null });
  }
  return { b, budget_min: r(WINDOW_DAYS * 1440 * b, 4), thr, rows };
}

export function silence(P) {
  const { N, m, T } = P.load;
  const threshold = 5 * T;
  const dOf = ([ev, sc]) => threshold + ev + sc;
  const def = STEP_OPTIONS[0];
  const target = P.ops.silenceMaxS;
  const pick = STEP_OPTIONS.find((o) => dOf(o) <= target) ?? null;
  const lambda = N * m / T;
  return { threshold_s: threshold, lambda: r(lambda, 4), lost_default: Math.round(lambda * dOf(def)), d_max_s: dOf(def), ratio: r(dOf(def) / T, 2), target_s: target,
    steps: pick ? { evalS: pick[0], scrapeS: pick[1] } : null,
    d_max_new_s: pick ? dOf(pick) : null, lost_new: pick ? Math.round(lambda * dOf(pick)) : null };
}

// ---------------------------------------------------------------- файли студента
export const opsFiles = (P) => { const c = P.code.toLowerCase(); return {
  rules: `ops/alerts.${c}.rules.yml`, tests: `ops/alerts.${c}.test.yml`, compose: `compose.${c}.yaml`,
  adr: 'pr08/adr-008.md', runbook: 'pr08/runbook.md', rtEnv: 'pr03/rt.env' }; };

// ---------------------------------------------------------------- файл правил «ідеального студента»
export const RULES_REF = () => path.join(APP, 'ops', 'alerts.rules.yml');
export const fmtNum = (x) => String(r(x, 9));

// Числа домену підставляються в еталонний файл підручника
export function genRules(P, steps) {
  const b = fmtNum(slo(P).b);
  const T5 = 5 * P.load.T;
  let s = fs.readFileSync(RULES_REF(), 'utf8');
  const sub = (from, to) => { if (!s.includes(from)) throw new Error(`в еталонному alerts.rules.yml немає «${from.slice(0, 40)}»`); s = s.split(from).join(to); };
  sub('14.4 * 0.001', `14.4 * ${b}`);
  sub('6 * 0.001', `6 * ${b}`);
  sub('> 0.001', `> ${b}`);
  sub('> 300\n', `> ${T5}\n`);
  sub('  - name: greenhouse-ingest\n    rules:', `  - name: greenhouse-ingest\n    interval: ${steps.evalS}s            # крок обчислення правил, обраний у ПР8\n    rules:`);
  sub('Тиша довше за 5 періодів звітування (теплиця, T = 60 с)', `Тиша довше за 5 періодів звітування (домен «${P.title}», T = ${P.load.T} с)`);
  sub('"Жодного показання понад 5 хв"', `"Жодного показання понад ${T5} с"`);
  sub('# SLO 99,9 % → бюджет помилок 0,001', `# SLO ${String(P.ops.slo.target).replace('.', ',')} % → бюджет помилок ${b.replace('.', ',')}`);
  return s;
}

export function rulesInfo(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const g of doc.groups ?? []) for (const rule of g.rules ?? []) if (rule.alert) out[rule.alert] = { labels: rule.labels ?? {}, annotations: rule.annotations ?? {}, expr: rule.expr, for: rule.for, group: g.name, interval: g.interval };
  return out;
}

// ---------------------------------------------------------------- сценарії promtool
const gridUp = (sec, step) => Math.floor(sec / step) * step + step;     // найменше кратне step, строго більше sec
const gridDown = (sec, step) => Math.floor(sec / step) * step;          // найбільше кратне step, не більше sec
const dur = (sec) => (sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);
const INST = 'backend:3000';
export const NEED = ['NoReadings', 'BrokerDisconnected', 'ApiBudgetFastBurn', 'ApiBudgetSlowBurn', 'ApiBudgetTicket'];

function builders(P, info, steps) {
  const { evalS, scrapeS } = steps; const T = P.load.T; const S = slo(P);
  const fire = (name, at, extra = {}) => ({ eval_time: dur(at), alertname: name, exp_alerts: [{ exp_labels: { ...info[name].labels, ...extra }, exp_annotations: { ...info[name].annotations } }] });
  const quiet = (name, at) => ({ eval_time: dur(at), alertname: name, exp_alerts: [] });
  const horizon = (s) => Math.ceil(s / scrapeS);

  const restart = () => {
    const start = 12 * T; const n = horizon(start + 5 * T + 4 * evalS);
    return { name: 'тиша після перезапуску відліковується від старту процесу', interval: `${scrapeS}s`,
      input_series: [
        { series: `process_start_time_seconds{instance="${INST}"}`, values: `${start}x${n}` },
        { series: `greenhouse_last_reading_timestamp_seconds{instance="${INST}"}`, values: `0x${n}` }],
      alert_rule_test: [quiet('NoReadings', gridDown(start + 5 * T, evalS)), fire('NoReadings', gridUp(start + 5 * T, evalS), { instance: INST })] };
  };
  const stops = () => {
    const k = Math.ceil(600 / scrapeS); const last = k * scrapeS; const n = horizon(last + 5 * T + 4 * evalS);
    return { name: 'показання йдуть, потім припиняються', interval: `${scrapeS}s`,
      input_series: [
        { series: `process_start_time_seconds{instance="${INST}"}`, values: `0x${n}` },
        { series: `greenhouse_last_reading_timestamp_seconds{instance="${INST}"}`, values: `0+${scrapeS}x${k} ${last}x${n - k}` }],
      alert_rule_test: [quiet('NoReadings', gridDown(last + 5 * T, evalS)), fire('NoReadings', gridUp(last + 5 * T, evalS), { instance: INST })] };
  };
  const broker = () => ({ name: 'розрив з брокером: сповіщення після двох хвилин', interval: '15s',
    input_series: [{ series: 'greenhouse_broker_connected', values: '1x39 0x19 1x60' }],
    alert_rule_test: [quiet('BrokerDisconnected', 660), fire('BrokerDisconnected', 840), quiet('BrokerDisconnected', 1020)] });

  // Помилки із часткою e після PRE хвилин норми; перевіряються лише пари, потрібні сценарію
  const burn = (e, PRE, pairs) => {
    const rows = S.rows.filter((x) => x.e === e && pairs.includes(x.pair));
    const maxT = Math.max(0, ...rows.map((x) => x.t_min ?? 0));
    const H = Math.ceil(maxT * 1.25 + 8);
    const ok = r(100 * (1 - e), 6); const bad = r(100 * e, 6);
    const q = (min, up) => (up ? gridUp : gridDown)(Math.round(min * 60), evalS);
    const checks = [];
    for (const row of rows) {
      const pr = PAIRS.find((p) => p.id === row.pair);
      if (row.t_min === null) checks.push(quiet(pr.alert, q(PRE + H - 1, false)));
      else { checks.push(quiet(pr.alert, q(PRE + row.t_min * 0.8, false))); checks.push(fire(pr.alert, q(PRE + row.t_min * 1.25 + 3, true))); }
    }
    return { name: `${r(e * 100, 3)} % помилок після ${PRE / 60} год норми`.replace('.', ','), interval: '1m',
      input_series: [
        { series: 'greenhouse_http_request_seconds_count{status="200"}', values: `0+100x${PRE} ${r(100 * PRE + ok, 6)}+${ok}x${H - 1}` },
        { series: 'greenhouse_http_request_seconds_count{status="500"}', values: `0x${PRE} ${bad}+${bad}x${H - 1}` }],
      alert_rule_test: checks };
  };
  // Помилки припинилися: швидке сповіщення знімається коротким вікном
  const recovery = (PRE) => {
    const e = Math.max(...P.ops.slo.errors); const tf = S.rows.find((x) => x.pair === 'fast' && x.e === e).t_min;
    const D = Math.ceil(tf) + 5; const tail = 40;
    const ok = r(100 * (1 - e), 6); const bad = r(100 * e, 6); const okEnd = r(100 * PRE + ok * D, 6); const badEnd = r(bad * D, 6);
    const q = (min, up) => (up ? gridUp : gridDown)(Math.round(min * 60), evalS);
    return { name: 'помилки припинилися: швидке сповіщення знімається', interval: '1m',
      input_series: [
        { series: 'greenhouse_http_request_seconds_count{status="200"}', values: `0+100x${PRE} ${r(100 * PRE + ok, 6)}+${ok}x${D - 1} ${r(okEnd + 100, 6)}+100x${tail - 1}` },
        { series: 'greenhouse_http_request_seconds_count{status="500"}', values: `0x${PRE} ${bad}+${bad}x${D - 1} ${badEnd}x${tail - 1}` }],
      alert_rule_test: [fire('ApiBudgetFastBurn', q(PRE + D, true)), quiet('ApiBudgetFastBurn', q(PRE + D + 12, true))] };
  };
  return { restart, stops, broker, burn, recovery };
}

const emit = (rulesName, evalS, tests) => YAML.stringify({ rule_files: [rulesName], evaluation_interval: `${evalS}s`, tests }, { lineWidth: 0 });

// Прихований оракул: два файли (тиша й брокер — з кроком evalS; бюджет — з кроком 1 хв), доба норми 72 год
export function genOracle(P, info, steps, rulesName) {
  const b = builders(P, info, steps); const [e1, e2] = P.ops.slo.errors;
  return {
    'oracle-ingest.yml': emit(rulesName, steps.evalS, [b.restart(), b.stops(), b.broker()]),
    'oracle-budget.yml': emit(rulesName, 60, [b.burn(e1, 72 * 60, ['fast', 'slow', 'ticket']), b.burn(e2, 72 * 60, ['fast', 'slow', 'ticket']), b.recovery(72 * 60)]),
  };
}

// Власний файл тестів «ідеального студента»: один файл, 6 год норми, без пари 3 доби
export function genStudentTests(P, info, steps, rulesName) {
  const b = builders(P, info, steps); const [e1, e2] = P.ops.slo.errors;
  return emit(rulesName, steps.evalS, [b.restart(), b.stops(), b.broker(), b.burn(e1, 6 * 60, ['fast', 'slow']), b.burn(e2, 6 * 60, ['fast', 'slow']), b.recovery(6 * 60)]);
}

// ---------------------------------------------------------------- запуск promtool
export function promtool(dir, args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const ch = spawn('docker', ['run', '--rm', '-v', `${dir}:/ops:ro`, '--entrypoint', 'promtool', PROM_IMAGE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e.message) }); });
    ch.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/^WARNING: .*\n/gm, '') }); });
  });
}

// Тимчасовий каталог із копією ops/ та підміною файлів: { 'a.yml': 'текст' }
export async function inTmpOps(opsDir, overrides, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  fs.chmodSync(dir, 0o755);
  try {
    if (opsDir && fs.existsSync(opsDir)) for (const f of fs.readdirSync(opsDir)) if (/\.ya?ml$/.test(f)) fs.copyFileSync(path.join(opsDir, f), path.join(dir, f));
    for (const [n, text] of Object.entries(overrides)) fs.writeFileSync(path.join(dir, n), text);
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
    return await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const short = (out) => out.split('\n').filter((l) => l.trim()).slice(0, 14).join('\n');

// Синтаксис правил + прихований оракул проти файла правил студента
export async function runOracle(P, rulesPath, steps) {
  const rn = path.basename(rulesPath);
  const info = rulesInfo(rulesPath);
  const miss = NEED.filter((n) => !info[n]);
  if (miss.length) return { ok: false, problem: `у файлі правил немає сповіщень: ${miss.join(', ')}` };
  const files = genOracle(P, info, steps, rn);
  return inTmpOps(null, { [rn]: fs.readFileSync(rulesPath, 'utf8'), ...files }, async (dir) => {
    const chk = await promtool(dir, ['check', 'rules', `/ops/${rn}`]);
    if (chk.code !== 0) return { ok: false, problem: `promtool check rules: ${short(chk.out)}` };
    const [a, c] = await Promise.all(Object.keys(files).map((f) => promtool(dir, ['test', 'rules', `/ops/${f}`])));
    const bad = [['тиша й брокер', a], ['бюджет помилок', c]].filter(([, x]) => x.code !== 0);
    if (bad.length) return { ok: false, problem: `сценарії «${bad[0][0]}» провалені:\n${short(bad[0][1].out)}` };
    return { ok: true };
  });
}

// Власні тести студента проти його ж правил
export async function runOwn(opsDir, rulesName, testName) {
  return inTmpOps(opsDir, {}, async (dir) => {
    if (!fs.existsSync(path.join(dir, rulesName))) return { ok: false, problem: `немає ${rulesName}` };
    if (!fs.existsSync(path.join(dir, testName))) return { ok: false, problem: `немає ${testName}` };
    const t = await promtool(dir, ['test', 'rules', `/ops/${testName}`]);
    return t.code === 0 ? { ok: true } : { ok: false, problem: short(t.out) };
  });
}

// ---------------------------------------------------------------- мутанти файла правил студента
export function ruleMutants(P) {
  const T5 = 5 * P.load.T;
  const mk = (id, title, fn) => ({ id, title, apply: fn });
  const sub = (re, to) => (s) => (re.test(s) ? s.replace(re, to) : null);
  return [
    mk('silence.late', `NoReadings: поріг ${T5} с збільшено на 20 %`, sub(new RegExp(`>\\s*${T5}\\b`), `> ${Math.round(T5 * 1.2)}`)),
    mk('silence.early', `NoReadings: поріг ${T5} с зменшено на 20 %`, sub(new RegExp(`>\\s*${T5}\\b`), `> ${Math.round(T5 * 0.8)}`)),
    mk('fast.k', 'ApiBudgetFastBurn: швидкість витрати 14,4 замінено на 3', (s) => (/14\.4\s*\*/.test(s) ? s.replace(/14\.4(\s*\*)/g, '3$1') : null)),
    mk('broker.for', 'BrokerDisconnected: вилучено витримку for: 2m', (s) => (/\n\s*for:\s*2m\s*\n/.test(s) ? s.replace(/\n(\s*)for:\s*2m\s*\n/, '\n') : null)),
    mk('slow.k', 'ApiBudgetSlowBurn: швидкість витрати 6 замінено на 1,5', (s) => (/>\s*6\s*\*/.test(s) ? s.replace(/>\s*6(\s*\*)/g, '> 1.5$1') : null)),
    mk('fast.short', 'ApiBudgetFastBurn: вилучено умову короткого вікна 5 хв', (s) => (/\n\s*and\s+greenhouse:http_errors:ratio_rate5m[^\n]*/.test(s) ? s.replace(/\n\s*and\s+greenhouse:http_errors:ratio_rate5m[^\n]*/, '') : null)),
    mk('silence.start', 'NoReadings: відлік від старту процесу вилучено', (s) => (/\(greenhouse_last_reading_timestamp\|process_start_time\)_seconds/.test(s) ? s.replace('(greenhouse_last_reading_timestamp|process_start_time)_seconds', 'greenhouse_last_reading_timestamp_seconds') : null)),
  ];
}
export const M_L4 = ['silence.late', 'silence.early', 'fast.k', 'broker.for'];
export const M_L5 = ['slow.k', 'fast.short', 'silence.start'];

// {status: killed|survived|not_applied, out}
export async function runRuleMutant(opsDir, rulesName, testName, mutant) {
  const text = fs.readFileSync(path.join(opsDir, rulesName), 'utf8');
  const mutated = mutant.apply(text);
  if (mutated === null) return { status: 'not_applied', out: 'у файлі правил немає фрагмента, який змінює цей мутант: запишіть число явно, у вигляді як в еталонному файлі (наприклад, «> 225», «14.4 * 0.005»)' };
  return inTmpOps(opsDir, { [rulesName]: mutated }, async (dir) => {
    const chk = await promtool(dir, ['check', 'rules', `/ops/${rulesName}`]);
    if (chk.code !== 0) return { status: 'not_applied', out: short(chk.out) };
    const t = await promtool(dir, ['test', 'rules', `/ops/${testName}`]);
    return { status: t.code === 0 ? 'survived' : 'killed', out: short(t.out) };
  });
}

// ---------------------------------------------------------------- Compose
export function composeSeconds(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
const sec = composeSeconds;

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// Межі, у яких студент обирає параметри (виведено з паспорта й журналу ПР6)
export function composeWindow(P, flushS) {
  const d = P.ops.probe;
  return { detectS: d.detectS, startS: d.startS, graceMin: Math.max(10, Math.ceil(flushS) + 2), intervalMin: 5, retriesMin: 2, timeoutMin: 3, startIntervalMax: 2 };
}

export function genCompose(P, flushS) {
  const w = composeWindow(P, flushS);
  const retries = 3; const timeout = 3;
  const interval = Math.max(w.intervalMin, Math.floor((w.detectS - timeout) / retries));
  let s = fs.readFileSync(path.join(APP, 'compose.yaml'), 'utf8');
  const from = '    env_file: .env\n    environment:\n      MQTT_URL: mqtt://mosquitto:1883\n';
  if (!s.includes(from)) throw new Error('в еталонному compose.yaml немає блока env_file/environment');
  const startPeriod = Math.ceil(w.startS) + 4;
  s = s.replace(from, () => `    env_file:\n      - .env\n      - ../pr03/rt.env\n    environment:\n      MQTT_URL: mqtt://mosquitto:1883\n    # порядок зупинки: черга обмеження частоти (ПР6) встигає спорожніти до SIGKILL\n    stop_grace_period: ${w.graceMin}s\n    healthcheck:\n      test: [CMD, node, healthcheck.js]\n      interval: ${interval}s\n      timeout: ${timeout}s\n      retries: ${retries}\n      start_period: ${startPeriod}s\n      start_interval: 1s\n`);
  return { text: s, interval, retries, timeout, startPeriod, grace: w.graceMin };
}

export function composeCheck(P, file, flushS, rtEnv) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  const sv = doc.services ?? {};
  const probs = [];
  for (const n of ['mosquitto', 'backend', 'web']) {
    if (!sv[n]) probs.push(`немає служби ${n}`); else if (sv[n].restart !== 'unless-stopped') probs.push(`${n}: restart має бути unless-stopped`);
  }
  if (probs.length) return { probs };
  const b = sv.backend;
  if (b.init !== true) probs.push('backend: init: true (сигнали доходять до процесу, підручник 7.5.2)');
  if (b.ports) probs.push('backend: порт 3000 не публікують назовні (підручник 7.5.2)');
  if (sv.web.depends_on?.backend?.condition !== 'service_healthy') probs.push('web: depends_on.backend.condition має бути service_healthy');
  if (b.depends_on?.mosquitto?.condition !== 'service_healthy') probs.push('backend: depends_on.mosquitto.condition має бути service_healthy');
  const w = composeWindow(P, flushS);
  const grace = sec(b.stop_grace_period);
  if (!(grace >= w.graceMin)) probs.push(`backend: stop_grace_period ${b.stop_grace_period ?? 'не задано'}: черга обмеження з ПР6 спорожнюється за ${flushS} с, потрібно щонайменше ${w.graceMin} с (більше з 10 с за замовчуванням і flush_s, округленого вгору, плюс 2)`);
  const h = b.healthcheck ?? {};
  const iv = sec(h.interval); const to = sec(h.timeout); const rt = Number(h.retries); const sp = sec(h.start_period); const si = sec(h.start_interval);
  if (![iv, to, rt, sp, si].every(Number.isFinite)) probs.push('backend.healthcheck: потрібні interval, timeout, retries, start_period, start_interval');
  else {
    if (iv < w.intervalMin) probs.push(`healthcheck.interval ${iv} с: частіше ніж раз на ${w.intervalMin} с проба завантажує процес`);
    if (rt < w.retriesMin) probs.push(`healthcheck.retries ${rt}: одна невдача не має робити контейнер unhealthy (потрібно щонайменше ${w.retriesMin})`);
    if (to < w.timeoutMin || to >= iv) probs.push(`healthcheck.timeout ${to} с: не менше ${w.timeoutMin} с (healthcheck.js чекає 2 с) і менше за interval`);
    if (iv * rt + to > w.detectS) probs.push(`виявлення збою: interval · retries + timeout = ${iv * rt + to} с, у паспорті — не більше ${w.detectS} с`);
    if (sp < w.startS) probs.push(`healthcheck.start_period ${sp} с менший за час старту ${w.startS} с (паспорт)`);
    if (si > w.startIntervalMax) probs.push(`healthcheck.start_interval ${si} с: у період старту перевіряйте не рідше ніж раз на ${w.startIntervalMax} с`);
  }
  const envFiles = [].concat(b.env_file ?? []).map((x) => (typeof x === 'string' ? x : x.path));
  const envInline = Array.isArray(b.environment) ? Object.fromEntries(b.environment.map((x) => x.split(/=(.*)/s).slice(0, 2))) : (b.environment ?? {});
  // файл змінних лежить у корені практикуму, а compose-файл — у greenhouse-monitor/, тож шлях від нього: ../pr03/rt.env
  const viaFile = envFiles.some((f) => path.normalize(f) === path.normalize('../pr03/rt.env'));
  for (const [key, val] of Object.entries(rtEnv)) if (!viaFile && String(envInline[key]) !== String(val)) probs.push(`backend: змінна ${key}=${val} з pr03/rt.env не передана (env_file: ../pr03/rt.env — шлях від каталогу compose-файла, або environment)`);
  return { probs, values: { detect_s: iv * rt + to, start_period_s: sp, grace_s: grace } };
}

export function composeSyntax(file) {
  const dir = path.dirname(file);
  const stubs = [];                                   // [файл, перший створений каталог]
  let doc = {};
  try { doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* синтаксичну помилку покаже docker compose */ }
  const wanted = new Set(['.env']);
  for (const sv of Object.values(doc.services ?? {})) for (const e of [].concat(sv?.env_file ?? [])) wanted.add(typeof e === 'string' ? e : e?.path);
  // відсутні файли змінних замінює порожня заглушка: перевіряється синтаксис, а не секрети
  for (const f of wanted) {
    if (!f) continue;
    const p = path.resolve(dir, f);
    if (fs.existsSync(p)) continue;
    try { const first = fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); stubs.push([p, first]); } catch { /* compose повідомить сам */ }
  }
  return new Promise((resolve) => {
    const ch = spawn('docker', ['compose', '-f', file, 'config', '-q'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    const done = (code, o) => { for (const [p, first] of stubs) { fs.rmSync(p, { force: true }); if (first) fs.rmSync(first, { recursive: true, force: true }); } resolve({ code, out: o }); };
    ch.on('error', (e) => done(127, e.message));
    ch.on('close', (code) => done(code, out));
  });
}
