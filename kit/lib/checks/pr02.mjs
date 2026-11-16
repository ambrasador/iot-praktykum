import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../paths.mjs';
import { appRequire, appPath } from '../app.mjs';
import { getPath } from '../track.mjs';
import { exists, read, number, rel, all } from '../verify-core.mjs';
import { pr02 as expect02 } from '../expect.mjs';
import { loadPassport, DEVICE_KINDS } from '../passport.mjs';
import { commandCases, settingCases } from '../cases.mjs';
import { NOW_MS, DAY, MAX_ROWS } from '../series.mjs';
import { call, qs } from '../http.mjs';
import { getBed, stopBed } from '../bed-proc.mjs';

export const cleanup = stopBed;
const problemCode = (r) => (r.body?.type ?? '').split('/').pop();
const shortList = (xs, n = 3) => xs.slice(0, n).join('; ') + (xs.length > n ? `; … (ще ${xs.length - n})` : '');

export function checks(track) {
  const P = loadPassport(track.variant);
  const X = expect02(track.variant, P, track.seed);
  const t = track;
  const A = P.alert;
  const T = P.load.T;
  const dev0 = X.hist.devices[0].id;
  const bed = () => getBed(track);
  const api = async (method, p, opts) => { const b = await bed(); return call(b.url, method, `/api/v1${p}`, opts); };
  const toDay = Math.floor(NOW_MS / DAY) * DAY;
  const win = (days) => ({ from: new Date(toDay - days * DAY).toISOString(), to: new Date(toDay).toISOString() });
  const nums = (s) => [...s.matchAll(/\d[\d  ]*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')));
  const sameInstant = (a, b) => typeof a === 'string' && Date.parse(a) === Date.parse(b);

  async function ready() {
    const b = await bed();
    if (b.error) return `стенд не запустився: ${b.error}`;
    return null;
  }

  // ---- сценарій команд ----
  async function commandScenario(extraKey) {
    const problems = [];
    for (const cmd of P.commands) {
      const { valid, invalid } = commandCases(cmd);
      for (const c of valid) {
        const r = await api('POST', `/devices/${dev0}/commands`, { body: { name: c.name, params: c.params }, headers: extraKey ? { 'Idempotency-Key': `k-${Math.random().toString(36).slice(2, 12)}` } : {} });
        if (r.status !== 202) problems.push(`допустиму команду відхилено (${r.status}): ${c.name} ${c.why}`);
      }
      const accepted = [];
      for (const c of invalid) {
        const r = await api('POST', `/devices/${dev0}/commands`, { body: { name: c.name, params: c.params } });
        if (r.status !== 400) accepted.push(`${c.why} → ${r.status}`);
      }
      if (accepted.length) problems.push(`недопустимі виклики не відхилено: ${shortList(accepted)}`);
    }
    // команди теплиці з підручника лишаються чинними
    const old = await api('POST', `/devices/${dev0}/commands`, { body: { name: 'irrigate', params: { duration_sec: 30 } } });
    if (old.status !== 202) problems.push(`команда irrigate з еталона перестала працювати (${old.status})`);
    return problems;
  }

  // ---- сценарій налаштувань ----
  async function settingsScenario() {
    const problems = [];
    const { valid, invalid } = settingCases(P.settings);
    let g = await api('GET', `/devices/${dev0}/settings`);
    if (g.status !== 200) return [`GET settings → ${g.status}`];
    let etag = g.headers.etag;
    for (const c of valid) {
      const r = await api('PUT', `/devices/${dev0}/settings`, { body: c.body, headers: { 'If-Match': etag } });
      if (r.status !== 200) { problems.push(`допустиме значення відхилено (${r.status}): ${JSON.stringify(c.body)}`); continue; }
      etag = r.headers.etag ?? etag;
    }
    const wrong = [];
    for (const c of invalid) {
      const r = await api('PUT', `/devices/${dev0}/settings`, { body: c.body, headers: { 'If-Match': etag } });
      if (r.status !== 400) wrong.push(`${c.why} → ${r.status}`);
    }
    if (wrong.length) problems.push(`недопустимі значення прийнято: ${shortList(wrong)}`);
    const body = valid[0].body;
    const noMatch = await api('PUT', `/devices/${dev0}/settings`, { body });
    if (noMatch.status !== 428) problems.push(`PUT без If-Match має давати 428, дав ${noMatch.status}`);
    const stale = await api('PUT', `/devices/${dev0}/settings`, { body, headers: { 'If-Match': '"0"' } });
    if (stale.status !== 412) problems.push(`PUT із застарілим If-Match має давати 412, дав ${stale.status}`);
    return problems;
  }

  // ---- межі вікна для метрики ----
  async function windowProbe(metric, deviceId) {
    const W = Math.floor((MAX_ROWS.agg * T) / 86400);
    const q = (days) => `/telemetry?${qs({ device: deviceId, metric, ...win(days), agg: 'count', interval: '1mo' })}`;
    const [a, b] = [await api('GET', q(W)), await api('GET', q(W + 1))];
    return { ok: a.status === 200 && b.status === 400 && problemCode(b) === 'window-too-large', a: a.status, b: b.status, rows: b.body?.estimated_rows };
  }

  const alertQuery = (h, d, extra = {}) => `/alerts?${qs({ device: X.hist.alertDevice, metric: A.metric, from: new Date(X.hist.startMs).toISOString(), to: new Date(NOW_MS).toISOString(), op: A.op, threshold: A.threshold, hysteresis: h, min_duration: d, ...extra })}`;

  const adr2 = () => (exists('pr02', 'adr-002.md') ? read('pr02', 'adr-002.md') : '');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: ПР1 виконано (є рішення про режим приймання й ADR-001)', run: () => {
      const opt = getPath(t, 'pr01.option');
      if (!['A', 'B', 'C', 'D'].includes(opt)) return 'у track.json немає pr01.option: завершіть ПР1';
      return exists('pr01', 'adr-001.md') ? true : 'немає pr01/adr-001.md: завершіть ПР1';
    } },
    { level: 3, text: 'Стенд піднято, історію варіанта прийнято повністю (метрики й діапазони з ПР1)', run: async () => {
      const e = await ready(); if (e) return e;
      const b = await bed();
      if (b.rejected === 0 && b.stored > 1000) return true;
      const hint = { unknown_metric: 'метрику не додано до RANGE в core.js', out_of_range: 'діапазон у RANGE вужчий за паспорт', bad_device: 'ідентифікатор пристрою' };
      return `відхилено ${b.rejected} із ${b.stored + b.rejected}: ${Object.entries(b.reasons).map(([k, v]) => `${k} ${v}${hint[k] ? ` (${hint[k]})` : ''}`).join(', ')}`;
    } },
    { level: 3, text: 'Каталог метрик: periodSec кожної метрики пристроїв дорівнює T із паспорта', run: async () => {
      const e = await ready(); if (e) return e;
      const metrics = [...new Set(Object.values(DEVICE_KINDS[t.variant]).flat())];
      const bad = [];
      for (const m of metrics) {
        const d = X.hist.devices.find((x) => x.rows[m]);
        const r = await windowProbe(m, d.id);
        if (!r.ok) bad.push(`${m} (на межі ${Math.floor((MAX_ROWS.agg * T) / 86400)} діб → ${r.a}, на межі+1 → ${r.b})`);
      }
      return bad.length ? `periodSec у metrics.js не збігається з T = ${T} с для: ${shortList(bad, 4)}` : true;
    } },
    { level: 3, text: 'Сирі дані вікна з паспорта: кількість рядків і сторінок при limit = 200', run: () => all(number(t, 'pr02.n_rows', X.raw.n_rows, 0, `вікно ${X.raw.from} … ${X.raw.to}, пристрій ${X.hist.alertDevice}, метрика ${A.metric}`),
      number(t, 'pr02.pages', X.raw.pages, 0, 'pages — кількість запитів, поки у відповіді є next')) },
    { level: 3, text: `Сповіщення за параметрами паспорта (${A.op === 'lt' ? '<' : '>'} ${A.threshold}, гістерезис ${A.hysteresis}, ${A.minDurationSec} с): кількість епізодів`, run: () => number(t, 'pr02.episodes', X.eps.length, 0, 'подивіться на поле data у відповіді /alerts і на ended_by') },
    { level: 3, text: 'Найдовший епізод: початок, тривалість у хвилинах, екстремум', run: () => {
      const L = X.longest;
      if (!sameInstant(getPath(t, 'pr02.longest_start'), L.start)) return `pr02.longest_start = ${JSON.stringify(getPath(t, 'pr02.longest_start'))}; найдовший епізод має інший початок`;
      const m = number(t, 'pr02.longest_min', L.duration_sec / 60, 0.01, 'тривалість у хвилинах = duration_sec / 60');
      if (m !== true) return m;
      return number(t, 'pr02.longest_extreme', L.extreme, 0.001);
    } },
    { level: 3, text: `Команда ${P.commands.map((c) => c.name).join(', ')}: допустимі виклики дають 202, недопустимі — 400`, run: async () => {
      const e = await ready(); if (e) return e;
      const p = await commandScenario(false);
      return p.length ? shortList(p) : true;
    } },
    { level: 3, text: 'Файл pr02/requests.http: GET /telemetry, GET /alerts і POST …/commands із вашими параметрами', run: () => {
      if (!exists('pr02', 'requests.http')) return 'немає pr02/requests.http';
      const s = read('pr02', 'requests.http');
      const miss = [];
      if (!new RegExp(`GET\\s+\\S*/telemetry\\?[^\\s]*device=${X.hist.alertDevice}[^\\s]*metric=${A.metric}|GET\\s+\\S*/telemetry\\?[^\\s]*metric=${A.metric}[^\\s]*device=${X.hist.alertDevice}`).test(s)) miss.push(`GET /telemetry для ${X.hist.alertDevice} і ${A.metric}`);
      if (!/GET\s+\S*\/alerts\?\S*threshold=/.test(s)) miss.push('GET /alerts із threshold');
      if (!/POST\s+\S*\/devices\/[\w-]+\/commands/.test(s)) miss.push('POST /devices/<id>/commands');
      return miss.length ? `У requests.http бракує: ${miss.join('; ')}` : true;
    } },

    // ---------- рівень 4 ----------
    { level: 4, text: 'Підібрані hysteresis і min_duration дають ті самі 5 епізодів: без розколу й без дрібних викидів', run: () => {
      const h = getPath(t, 'pr02.hysteresis'); const d = getPath(t, 'pr02.min_duration');
      if (!(typeof h === 'number' && typeof d === 'number')) return 'потрібні числа pr02.hysteresis і pr02.min_duration (секунди)';
      if (X.pairOk(h, d)) return true;
      const eps = X.pairOk(0, d) ? '' : (X.pairOk(h, 0) ? '' : '');
      return `пара (${h}, ${d}) дає інший набір епізодів, ніж потрібно (${X.eps.length}). Перевірте: чи не розколює гістерезис ${h} довгий епізод і чи відсікає ${d} с дрібні викиди ${eps}`;
    } },
    { level: 4, text: 'Добові агрегати у двох зонах: до якої доби потрапила подія (UTC і Europe/Kyiv)', run: () => {
      const z = X.tz;
      return all(
        sameInstant(getPath(t, 'pr02.tz.utc_start'), z.utc_start) ? true : `pr02.tz.utc_start має бути початком бакета з подією для tz=UTC (${z.utc_start})`,
        sameInstant(getPath(t, 'pr02.tz.kyiv_start'), z.kyiv_start) ? true : `pr02.tz.kyiv_start має бути початком бакета з подією для tz=Europe/Kyiv, у форматі відповіді API (UTC)`,
        getPath(t, 'pr02.tz.kyiv_day') === z.kyiv_day ? true : `pr02.tz.kyiv_day = ${JSON.stringify(getPath(t, 'pr02.tz.kyiv_day'))}: це місцева дата бакета (за київським календарем)`,
        number(t, 'pr02.tz.utc_value', z.utc_value, 0.001, `${z.agg} за бакет`),
        number(t, 'pr02.tz.kyiv_value', z.kyiv_value, 0.001));
    } },
    { level: 4, text: 'Межі вікна: W_agg і W_alerts у добах, розрахункова кількість рядків із відповіді 400, кількість запитів на 730 діб', run: () => all(
      number(t, 'pr02.w_agg_days', X.w_agg_days, 0, 'W = ⌊500 000 · T / 86 400⌋'),
      number(t, 'pr02.w_alerts_days', X.w_alerts_days, 0, 'W = ⌊60 000 · T / 86 400⌋'),
      number(t, 'pr02.est_rows_agg', X.est_rows_agg, 0.001, 'estimated_rows з відповіді на вікно на добу ширше за межу'),
      number(t, 'pr02.chunks_730', X.chunks_730, 0, '⌈730 / W_agg⌉')) },
    { level: 4, text: 'Інтервал агрегації для графіка (діб і точок з паспорта): найменший допустимий і кількість точок у відповіді', run: async () => {
      const e = await ready(); if (e) return e;
      if (getPath(t, 'pr02.interval') !== X.interval) return `pr02.interval = ${JSON.stringify(getPath(t, 'pr02.interval'))}; найменший допустимий інтервал, що дає не більш як ${P.chart.points} точок за ${P.chart.days} діб, інший (допустимі: 1–30m з дільників 60, 1–12h з дільників 24, 1d)`;
      const r = await api('GET', `/telemetry?${qs({ device: X.hist.alertDevice, metric: A.metric, ...win(P.chart.days), agg: 'avg', interval: X.interval })}`);
      if (r.status !== 200) return `GET /telemetry з interval=${X.interval} → ${r.status}`;
      const n = r.body.data.length;
      if (getPath(t, 'pr02.points') !== n) return `pr02.points = ${JSON.stringify(getPath(t, 'pr02.points'))}; у відповіді API ${n} бакетів`;
      return true;
    } },
    { level: 4, text: 'Налаштування пристрою: доменні ключі приймаються, значення поза межами — 400; без If-Match — 428; застарілий — 412', run: async () => {
      const e = await ready(); if (e) return e;
      const p = await settingsScenario();
      return p.length ? shortList(p) : true;
    } },
    { level: 4, text: 'Коди сценарію умовного запису записано (pr02.settings_codes: 428, 412, 200)', run: () => {
      const c = getPath(t, 'pr02.settings_codes');
      return c && c.no_if_match === 428 && c.stale === 412 && c.ok === 200 ? true : 'pr02.settings_codes має бути {"no_if_match": 428, "stale": 412, "ok": 200}: виконайте три запити з curl';
    } },

    // ---------- рівень 5 ----------
    { level: 5, text: 'Пара (hysteresis, min_duration) стійка: зміна кожного значення на ±20 % не змінює набір епізодів', run: () => {
      const h = getPath(t, 'pr02.hysteresis'); const d = getPath(t, 'pr02.min_duration');
      if (!(typeof h === 'number' && typeof d === 'number')) return 'спершу заповніть pr02.hysteresis і pr02.min_duration';
      return X.robust(h, d) ? true : `за ±20 % пара (${h}, ${d}) перестає давати правильний набір: оберіть значення ближче до середини допустимої області`;
    } },
    { level: 5, text: 'max_gap, за якого розколений розривом інцидент зливається в один епізод', run: () => number(t, 'pr02.max_gap_s', X.merge_gap_s, 0, 'max_gap у секундах; розрив між двома сусідніми вимірюваннями = (пропущені + 1)·T') },
    { level: 5, text: 'Ідемпотентність: той самий ключ і тіло повертають ту саму команду; інше тіло з тим самим ключем — 422', run: async () => {
      const e = await ready(); if (e) return e;
      const cmd = P.commands[0];
      const { valid } = commandCases(cmd);
      const [a, b] = [valid[0], valid.find((v) => JSON.stringify(v.params) !== JSON.stringify(valid[0].params))];
      const key = `idem-${Math.random().toString(36).slice(2, 12)}`;
      const post = (c) => api('POST', `/devices/${dev0}/commands`, { body: { name: c.name, params: c.params }, headers: { 'Idempotency-Key': key } });
      const r1 = await post(a); const r2 = await post(a); const r3 = await post(b);
      const codes = getPath(t, 'pr02.idem');
      const problems = [];
      if (!(r1.status === 202 && r2.status === 202 && r1.body?.id === r2.body?.id)) problems.push(`повтор має повертати ту саму команду (${r1.status}/${r2.status})`);
      if (r3.status !== 422) problems.push(`інше тіло з тим самим ключем має давати 422, дало ${r3.status}`);
      if (problems.length) return problems.join('; ');
      return codes && codes.first === 202 && codes.repeat === 202 && codes.other_body === 422 && codes.same_id === true ? true
        : 'pr02.idem має бути {"first": 202, "repeat": 202, "same_id": true, "other_body": 422}';
    } },
    { level: 5, text: 'openapi.yaml: CommandRequest описує доменні команди з межами параметрів; contract.test.js проходить', run: () => {
      const YAML = appRequire('yaml'); const Ajv2020 = appRequire('ajv/dist/2020'); const addFormats = appRequire('ajv-formats');
      const doc = YAML.parse(fs.readFileSync(appPath('openapi.yaml'), 'utf8'));
      const schema = doc.components?.schemas?.CommandRequest;
      if (!schema) return 'у openapi.yaml немає components.schemas.CommandRequest';
      const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
      const validate = ajv.compile(schema);
      const problems = [];
      for (const cmd of P.commands) {
        const { valid, invalid } = commandCases(cmd);
        const bad = valid.filter((c) => !validate({ name: c.name, params: c.params }));
        if (bad.length) problems.push(`схема відхиляє допустиме: ${bad[0].name} ${bad[0].why}`);
        const loose = invalid.filter((c) => c.why !== 'on_min = off_min' && validate({ name: c.name, params: c.params }));
        if (loose.length) problems.push(`схема приймає недопустиме: ${shortList(loose.map((c) => c.why), 2)}`);
      }
      if (!validate({ name: 'irrigate', params: { duration_sec: 30 } })) problems.push('схема більше не описує команду irrigate');
      if (problems.length) return shortList(problems);
      const r = spawnSync(process.execPath, ['--test', 'contract.test.js'], { cwd: appPath(), encoding: 'utf8' });
      return r.status === 0 ? true : `contract.test.js не проходить: ${(r.stdout.match(/not ok[^\n]*/g) ?? [r.stderr.split('\n')[0]]).slice(0, 2).join(' | ')}`;
    } },
    { level: 5, text: 'Розмір відповіді: байтів на рядок сирої сторінки (limit = 1000) і скільки рядків вміщує відповідь у 100 КіБ', run: async () => {
      const e = await ready(); if (e) return e;
      const r = await api('GET', `/telemetry?${qs({ device: X.hist.alertDevice, metric: A.metric, ...win(X.raw.days), limit: 1000 })}`);
      const rows = r.body.data.length;
      const per = Buffer.byteLength(r.text) / rows;
      const k = number(t, 'pr02.bytes_per_row', per, 0.04, 'довжина тіла відповіді в байтах, поділена на кількість рядків');
      return k === true ? number(t, 'pr02.rows_per_100kib', 102400 / per, 0.05, '102 400 байтів / байтів на рядок') : k;
    } },
    { level: 5, text: 'ADR-002 (контракт читання): межі вікна, інтервал, пара (hysteresis, min_duration), тригер перегляду', run: () => {
      const a = adr2();
      if (!a) return 'немає pr02/adr-002.md (шаблон: kit/templates/adr.md)';
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки', 'Тригер'].filter((h) => !new RegExp(`^#+\\s*${h}`, 'mi').test(a));
      if (miss.length) return `У ADR-002 бракує розділів: ${miss.join(', ')}`;
      const all = nums(a);
      const need = [['W_agg', X.w_agg_days], ['min_duration', getPath(t, 'pr02.min_duration')]].filter(([, v]) => Number.isFinite(v));
      const lost = need.filter(([, v]) => !all.some((x) => rel(x, v, 0.001)));
      return lost.length ? `У ADR-002 немає чисел: ${lost.map(([n, v]) => `${n} = ${v}`).join(', ')}` : true;
    } },
  ];
}
