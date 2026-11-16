// Лабораторія ПР5: шум датчика, правила push під керуванням tracker студента, повідомлення FCM, TTL і повтори,
// дублі черги дій. Усі прогони відтворювані: випадкові числа беруться із зерна студента.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { appRequire, APP } from './app.mjs';
import { metricTable } from './passport.mjs';
import { buildHistory, deviceList, truth, NOW_MS } from './series.mjs';
import { rng, seedFor } from './rng.mjs';
import { commandCases } from './cases.mjs';
import { call } from './http.mjs';
import * as F from './formulas.mjs';

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
export const LEVEL_TEXT = { warning: 'попередження', critical: 'критично' };
export const FCM_MAX_BYTES = 4096;

// ---------------- правила домену ----------------
export const cardsWithRule = (P) => P.ui.cards.filter((c) => c.rule);
export const opOf = (direction) => (direction === 'below' ? 'lt' : 'gt');
export const ruleOf = (card, hysteresis) => ({
  op: opOf(card.rule.direction), warn: card.rule.warn, crit: card.rule.crit, hysteresis,
  label: card.label, unit: card.unit, decimals: card.decimals,
});
// Нормальний рівень метрики: для метрики сповіщення — базова лінія з паспорта, для решти — середнє генератора
export function baselineOf(P, metric) {
  if (metric === P.alert.metric) return P.alert.baseline.mean;
  const g = metricTable(P).get(metric)?.gen ?? {};
  return g.bernoulli !== undefined ? 1 : g.mean;
}
export const roomOf = (rule, baseline) => (rule.op === 'lt' ? baseline - rule.warn : rule.warn - baseline);

// ---------------- шум датчика ----------------
const sdOf = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// σ за різницями сусідніх показань (формула 5.7): на всьому ряді й на спокійній ділянці без підкладених подій ±1 год
export function noise(variant, P, seed, metric, hist = buildHistory(variant, P, seed)) {
  const T = P.load.T;
  const dev = deviceList(variant, P).find((d) => d.metrics.includes(metric));
  if (!dev) throw new Error(`жоден пристрій домену не надсилає ${metric}`);
  const rows = hist.devices.find((d) => d.id === dev.id).rows[metric];
  const wins = [];
  for (const e of hist.planted ?? []) {
    if (e.name === 'tz') {
      if (dev.id === hist.tzDevice && metric === P.tzEvent.metric) wins.push({ name: 'перехід доби', from: e.atMs - HOUR, to: e.atMs + HOUR });
    } else if (dev.id === hist.alertDevice && metric === P.alert.metric) {
      wins.push({ name: e.name, from: e.startMs - HOUR, to: e.startMs + e.len * T * 1000 + HOUR });
    }
  }
  const inWin = (t) => wins.some((w) => t >= w.from && t <= w.to);
  const all = []; const calm = [];
  for (let i = 1; i < rows.v.length; i += 1) {
    if (rows.ms[i] - rows.ms[i - 1] !== T * 1000) continue;
    const d = rows.v[i] - rows.v[i - 1];
    all.push(d);
    if (!inWin(rows.ms[i]) && !inWin(rows.ms[i - 1])) calm.push(d);
  }
  return {
    device: dev.id, metric, pairs_all: all.length, pairs_calm: calm.length,
    sigma_all: sdOf(all) / Math.SQRT2, sigma_calm: sdOf(calm) / Math.SQRT2,
    excluded: wins.map((w) => ({ name: w.name, from: iso(w.from), to: iso(w.to) })),
  };
}

// ---------------- еталонний автомат рівнів (незалежний від push.js) ----------------
const LV = { normal: 0, warning: 1, critical: 2 };
export function oracleLevel(cur, v, r) {
  const lt = r.op === 'lt';
  const beyond = (x) => (lt ? v < x : v > x);
  const clear = (x) => (lt ? v >= x + r.hysteresis : v <= x - r.hysteresis);
  if (beyond(r.crit)) return 'critical';
  if (cur === 'critical' && !clear(r.crit)) return 'critical';
  if (beyond(r.warn)) return 'warning';
  if (cur !== 'normal' && !clear(r.warn)) return 'warning';
  return 'normal';
}
// Сповіщення — кожне підвищення рівня (cooldown і вік події вимкнено)
export function oracleAlerts(values, rule) {
  let cur = 'normal'; const out = [];
  for (const v of values) {
    const next = oracleLevel(cur, v, rule);
    if (LV[next] > LV[cur]) out.push(next);
    cur = next;
  }
  return out;
}

// Спад без шуму: норма → попередження → критично; для стану (warn = crit) — одразу критично
export function dipSequence(rule, baseline) {
  const dir = rule.op === 'lt' ? -1 : 1;
  const gap = Math.abs(rule.warn - rule.crit);
  const eps = gap > 0 ? gap / 4 : 1;
  const seq = [baseline, baseline];
  if (baseline !== rule.warn) seq.push((baseline + rule.warn) / 2);
  seq.push(rule.warn + dir * eps);
  if (gap > 0) seq.push((rule.warn + rule.crit) / 2);
  seq.push(rule.crit + dir * eps, rule.crit + dir * eps);
  return seq;
}
// Два спади з поверненням до норми між ними
export const twoDips = (rule, baseline) => [...dipSequence(rule, baseline), ...Array(6).fill(baseline), ...dipSequence(rule, baseline)];

// ---------------- прогін правил через tracker студента ----------------
export function runTracker(push, rules, metric, values, T, { cooldownMs = 0, maxAgeMs = 1e12, device = 'lab-1' } = {}) {
  let now = 0;
  const tr = push.createAlertTracker({ rules, cooldownMs, maxAgeMs, clock: () => now });
  const t0 = NOW_MS - 30 * 86_400_000;
  const levels = [];
  values.forEach((value, i) => {
    now = t0 + i * T * 1000;
    const a = tr.evaluate({ device, metric, ts: iso(now), value });
    if (a) levels.push(a.level);
  });
  return levels;
}

// Шум біля порога тривоги: середнє стоїть на crit, показання = crit + σ·z. Дні незалежні, tracker на кожен день новий
export function chatter(push, studentRules, variant, P, seed, card, sigma, days = 30) {
  const T = P.load.T; const N = F.readingsPerDay(T); const R = P.mob.repeatsPerDayMax;
  const rand = rng(seedFor(variant, seed, 50));
  const ref = { ...ruleOf(card, F.hMin(N, R, sigma)) };
  let refSum = 0; let stuSum = 0;
  for (let d = 0; d < days; d += 1) {
    const vals = Array.from({ length: N }, () => card.rule.crit + sigma * rand.normal());
    refSum += oracleAlerts(vals, ref).length;
    stuSum += runTracker(push, studentRules, card.metric, vals, T).length;
  }
  const refMean = refSum / days; const stuMean = stuSum / days;
  return { days, per_day: N, ref_mean: refMean, student_mean: stuMean, limit: refMean * 1.25 + 1 };
}

// Спад і повернення: очікувані послідовності рівнів (еталонний автомат з нульовим гістерезисом)
export function declineExpected(rule, baseline) {
  const r0 = { ...rule, hysteresis: 0 };
  return { once: oracleAlerts(dipSequence(r0, baseline), r0), twice: oracleAlerts(twoDips(r0, baseline), r0) };
}
export function declineRun(push, rules, card, baseline, T) {
  const rule = ruleOf(card, 0);
  const exp = declineExpected(rule, baseline);
  return {
    expected: exp,
    once: runTracker(push, rules, card.metric, dipSequence(rule, baseline), T),
    twice: runTracker(push, rules, card.metric, twoDips(rule, baseline), T),
  };
}

// ---------------- повідомлення FCM ----------------
const fmt = (v, d) => v.toFixed(d).replace('.', ',');
export function expectedMessageText(card, alert, name) {
  const unit = card.unit ? ` ${card.unit}` : '';
  return { title: `${card.label}: ${LEVEL_TEXT[alert.level]}`, body: `${name}: ${fmt(alert.value, card.decimals)}${unit}` };
}
// Значення «за критичною межею» для зразкового сповіщення; для стану 0/1 — нуль
export function sampleValue(P, card) {
  const m = metricTable(P).get(card.metric);
  if (m && m.range[1] - m.range[0] <= 1) return m.range[0];
  return card.rule.crit + (card.rule.direction === 'below' ? -1.2345 : 1.2345);
}
export const deviceFor = (variant, P, metric) => deviceList(variant, P).find((d) => d.metrics.includes(metric)).id;
export const deviceName = (id) => `Вузол ${id}`;

export function sampleAlertForAlertMetric(variant, P, seed, hist) {
  const tr = truth(variant, P, hist);
  return { device: hist.alertDevice, metric: P.alert.metric, level: 'critical', value: tr.longest.extreme, ts: iso(NOW_MS) };
}
// Розмір зразкового запиту (адреса виду fid), байти UTF-8
export function messageSizes(push, rules, alert, name, ttlSec) {
  const body = push.buildMessage({ kind: 'fid', id: 'fid-0123456789abcdef' }, alert, { name, ttlSec, nowMs: NOW_MS, rules });
  const m = body.message;
  const total = Buffer.byteLength(JSON.stringify(body));
  const data = Buffer.byteLength(JSON.stringify(m.data));
  const nd = Buffer.byteLength(JSON.stringify({ n: m.notification, d: m.data }));
  return {
    total_b: total, data_b: data, nd_b: nd, share_pct: (100 * nd) / FCM_MAX_BYTES,
    collapse_b: Buffer.byteLength(m.apns.headers['apns-collapse-id']), message: m,
    chars_vs_bytes: { body_chars: m.notification.body.length, body_bytes: Buffer.byteLength(m.notification.body) },
  };
}

// ---------------- диспетчер проти імітації FCM ----------------
export async function dispatchBed(push, { rules, ttlSec, clock, sleep, rnd = () => 1, maxAttempts, devices }) {
  const { makeMobileDb } = appRequire('./mobile-kit');
  const { addDevice } = appRequire('./testkit');
  const { createFakeFcm } = appRequire('./fake-fcm');
  const db = makeMobileDb();
  for (const id of devices) {
    addDevice(db, id);
    db.prepare("INSERT INTO device_owner VALUES (?, 'u1', ?)").run(id, iso(NOW_MS));
  }
  const fake = createFakeFcm();
  const port = await fake.listen();
  const token = 'fid-live-0000000000000001';
  db.prepare(`INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at)
              VALUES (?, 'fid', 'u1', 'android', ?, ?)`).run(token, iso(NOW_MS), iso(NOW_MS));
  fake.validTokens.add(token);
  const fcm = push.createFcmClient({ baseUrl: `http://127.0.0.1:${port}`, project: fake.project, getAccessToken: async () => 'access', timeoutMs: 3000 });
  const sleeps = []; const logs = [];
  const d = push.createDispatcher({
    db, fcm, clock, rnd, ttlSec, rules, maxAttempts,
    sleep: async (ms) => { sleeps.push(ms); sleep?.(ms); }, log: (...a) => logs.push(a),
  });
  return { db, fake, d, sleeps, logs, close: () => fake.close() };
}

// Доставка тривоги за кожним правилом домену: заголовок, тіло, дані, відсутність відхилень імітації
export async function deliveryRun(push, rules, variant, P) {
  const cards = cardsWithRule(P);
  const devices = [...new Set(cards.map((c) => deviceFor(variant, P, c.metric)))];
  const now = NOW_MS;
  const bed = await dispatchBed(push, { rules, clock: () => now, devices });
  const rows = [];
  try {
    for (const card of cards) {
      for (const level of ['warning', 'critical']) {
        const alert = { device: deviceFor(variant, P, card.metric), metric: card.metric, level, value: sampleValue(P, card), ts: iso(now) };
        const before = bed.fake.delivered.length;
        let res; let error = null;
        try { res = await bed.d.deliver(alert); } catch (e) { error = e.message; }
        const got = bed.fake.delivered.length > before ? bed.fake.delivered[before] : null;
        const exp = expectedMessageText(card, alert, deviceName(alert.device));
        rows.push({ metric: card.metric, level, result: res?.[0] ?? null, error, exp, alert,
          got: got ? { title: got.notification.title, body: got.notification.body, data: got.data, tag: got.android?.notification?.tag } : null,
          delivered: got !== null });
      }
    }
    return { rows, rejected: bed.fake.rejected.map((r) => r.reason), stats: { ...bed.d.stats } };
  } finally { await bed.close(); }
}

// TTL і вік події: tracker не має пропускати тривогу, яку диспетчер відкине; свіжа тривога несе залишок строку
export async function ttlRun(push, rules, { variant, P, ttlS, maxAgeS }) {
  const card = cardsWithRule(P)[0];
  const rule = rules.get(card.metric);
  const dev = deviceFor(variant, P, card.metric);
  const now = NOW_MS;
  const v = sampleValue(P, card);
  const tr = push.createAlertTracker({ rules, cooldownMs: 0, maxAgeMs: maxAgeS * 1000, clock: () => now });
  const oldAge = ttlS + 5;
  const stale = tr.evaluate({ device: dev, metric: card.metric, ts: iso(now - oldAge * 1000), value: v });
  const freshAge = 5;
  const fresh = tr.evaluate({ device: `${dev}-b`, metric: card.metric, ts: iso(now - freshAge * 1000), value: v });
  const out = { oldAge, freshAge, stale_pushed: Boolean(stale), fresh_pushed: Boolean(fresh), rule_ok: Boolean(rule), delivered: null };
  if (fresh) {
    const bed = await dispatchBed(push, { rules, ttlSec: ttlS, clock: () => now, devices: [`${dev}-b`] });
    try {
      const res = await bed.d.deliver(fresh);
      const m = bed.fake.delivered.at(-1);
      out.delivered = { result: res[0], ttl: m?.android?.ttl, expiration: m?.apns?.headers?.['apns-expiration'],
        want_ttl: `${ttlS - freshAge}s`, want_expiration: String(Math.floor(now / 1000) + ttlS - freshAge) };
    } finally { await bed.close(); }
  }
  if (stale) {
    // що б зробив диспетчер із такою тривогою
    const bed = await dispatchBed(push, { rules, ttlSec: ttlS, clock: () => now, devices: [dev] });
    try { out.stale_result = (await bed.d.deliver(stale))[0]; } finally { await bed.close(); }
  }
  return out;
}

// Повтори FCM у межах TTL: постійні 503 і 429 при найбільшому та найменшому джитері
export async function retriesRun(push, rules, { variant, P, ttlS }) {
  const card = cardsWithRule(P)[0];
  const dev = deviceFor(variant, P, card.metric);
  const out = {};
  for (const [code, status, fcmCode] of [['r503', 503, 'UNAVAILABLE'], ['r429', 429, 'QUOTA_EXCEEDED']]) {
    out[code] = {};
    for (const jitter of ['max', 'min']) {
      let now = NOW_MS;
      const bed = await dispatchBed(push, { rules, ttlSec: ttlS, clock: () => now, sleep: (ms) => { now += ms; }, rnd: () => (jitter === 'max' ? 1 : 0), devices: [dev] });
      try {
        for (let i = 0; i < 8; i += 1) bed.fake.script.push({ status, code: fcmCode });
        const alert = { device: dev, metric: card.metric, level: 'critical', value: sampleValue(P, card), ts: iso(NOW_MS) };
        const res = await bed.d.deliver(alert);
        const wait = bed.sleeps.reduce((s, x) => s + x, 0) / 1000;
        out[code][jitter] = { n: bed.sleeps.length, wait_s: wait, outcome: res[0], sleeps_s: bed.sleeps.map((x) => x / 1000), stats: { ...bed.d.stats } };
      } finally { await bed.close(); }
    }
  }
  return out;
}

// ---------------- черга дій: дублі при втраті відповіді ----------------
export async function queueSim(variant, P, seed) {
  const { makeDb, addDevice } = appRequire('./testkit');
  const { createServer } = appRequire('./server');
  const N = P.mob.queueN; const qLossPct = P.mob.qLossPct;
  const q = qLossPct / 100; const m = F.MOB.retryM;
  const db = makeDb();
  const devs = deviceList(variant, P);
  for (const d of devs) addDevice(db, d.id, 'A');
  const ids = devs.filter((d) => !d.id.endsWith('-04')).slice(0, 3).map((d) => d.id);
  const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, sink: { async send() {} },
    limits: { rate: 1e9, burst: 1e9, ingest: { rate: 1e9, burst: 1e9 } } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = commandCases(P.commands[0]);
  const body = { name: cases.valid[0].name, params: cases.valid[0].params };
  const other = cases.valid.find((c) => JSON.stringify(c.params) !== JSON.stringify(body.params));
  try {
    // скільки спроб потребує кожна дія: перша завжди, далі — поки відповідь губиться, але не більше m
    const rand = rng(seedFor(variant, seed, 60));
    const attempts = Array.from({ length: N }, () => { let a = 1; while (a < m && rand() < q) a += 1; return a; });
    const requests = attempts.reduce((s, x) => s + x, 0);
    const rows = {}; const statuses = {};
    const post = (id, headers) => call(base, 'POST', `/api/v1/devices/${id}/commands`, { body, headers });
    const run = async (mode, id) => {
      const st = {};
      for (let i = 0; i < N; i += 1) {
        for (let a = 1; a <= attempts[i]; a += 1) {
          const headers = mode === 'none' ? {}
            : { 'Idempotency-Key': mode === 'attempt' ? `try-${String(i).padStart(4, '0')}-${a}-${seed}` : `act-${String(i).padStart(4, '0')}-${seed}` };
          const r = await post(id, headers);
          st[r.status] = (st[r.status] ?? 0) + 1;
        }
      }
      statuses[mode] = st;
      rows[mode] = db.prepare('SELECT count(*) AS n FROM commands WHERE device_id = ?').get(id).n;
    };
    await run('none', ids[0]);
    await run('attempt', ids[1]);
    await run('action', ids[2]);
    // той самий ключ з іншим тілом
    let reuse = null;
    if (other) {
      const r = await call(base, 'POST', `/api/v1/devices/${ids[2]}/commands`, { body: { name: other.name, params: other.params }, headers: { 'Idempotency-Key': `act-${String(0).padStart(4, '0')}-${seed}` } });
      reuse = { status: r.status, type: r.body?.type ?? null, code: r.body?.code ?? null };
    }
    return { n: N, q_pct: qLossPct, m, requests, rows, theory: F.dupRows(N, q, m), sd: F.dupSd(N, q), statuses, reuse, command: body, devices: ids };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------- мутація: чи ловлять тести студента зміну правила ----------------
const SKIP = new Set(['node_modules', 'mobile', 'results', 'wire-dist', 'ops', 'jest', 'examples', 'bench4', 'calc4-verify', '.git']);
export function testsRun(files = ['push.test.js'], { mutate } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr05-'));
  try {
    for (const e of fs.readdirSync(APP, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.endsWith('.db') || e.name.includes('.db-')) continue;
      const src = path.join(APP, e.name);
      if (e.isDirectory()) fs.cpSync(src, path.join(tmp, e.name), { recursive: true, filter: (s) => !s.includes('node_modules') });
      else fs.copyFileSync(src, path.join(tmp, e.name));
    }
    fs.symlinkSync(path.join(APP, 'node_modules'), path.join(tmp, 'node_modules'));
    if (mutate) fs.appendFileSync(path.join(tmp, 'push.js'), `\n;(function () { ${mutate} })();\n`);
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: tmp, encoding: 'utf8', timeout: 180_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return {
      ok: r.status === 0, pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? 0),
      failed: [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]), out,
    };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export const mutationJs = (code, metric, field, delta) =>
  `const r = module.exports[${JSON.stringify(`RULES_${code}`)}].get(${JSON.stringify(metric)}); r.${field} += ${delta};`;
