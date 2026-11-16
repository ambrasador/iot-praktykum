#!/usr/bin/env node
// Генератор «брудного» потоку MQTT-повідомлень для варіанта студента (відтворюваний: зерно + варіант).
// node kit/tools/gen-stream.mjs --variant 2 --seed 7 [--count 6000] [--out pr01/stream.ndjson]
import fs from 'node:fs';
import path from 'node:path';
import { rng, seedFor } from '../lib/rng.mjs';
import { loadPassport, metricTable, DEVICE_KINDS } from '../lib/passport.mjs';
import { NOW_ISO } from '../lib/oracle.mjs';
import { ROOT } from '../lib/paths.mjs';
import { readTrack } from '../lib/track.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const t = args.variant === undefined ? readTrack() : {};
const variant = Number(args.variant ?? t.variant);
const seed = Number(args.seed ?? t.seed);
const count = Number(args.count ?? 6000);
const out = path.resolve(args.out ?? path.join(ROOT, 'pr01', 'stream.ndjson'));
const P = loadPassport(variant);
const table = metricTable(P);
const kinds = DEVICE_KINDS[variant];
const rand = rng(seedFor(variant, seed, 1));
const NOW = Date.parse(NOW_ISO);
const root = P.topicRoot;
const code = (P.code === 'D0' ? 'd0' : P.code.toLowerCase());
const pad = (n) => String(n).padStart(3, '0');
const iso = (ms) => new Date(ms).toISOString();

// Профіль браку: частка від кількості коректних повідомлень, що припадає на кожен клас
const PROFILES = {
  0: { duplicate: .04, bad_topic: .004, bad_json: .003, unknown_metric: .006, bad_value: .005, out_of_range: .012, bad_ts: .008, ts_in_future: .004, ts_too_old: .003, late: .01 },
  1: { duplicate: .03, bad_topic: .004, bad_json: .004, unknown_metric: .006, bad_value: .006, out_of_range: .035, bad_ts: .008, ts_in_future: .004, ts_too_old: .004, late: .01 },
  2: { duplicate: .09, bad_topic: .006, bad_json: .004, unknown_metric: .020, bad_value: .006, out_of_range: .010, bad_ts: .010, ts_in_future: .004, ts_too_old: .003, late: .01 },
  3: { duplicate: .05, bad_topic: .004, bad_json: .004, unknown_metric: .005, bad_value: .006, out_of_range: .008, bad_ts: .030, ts_in_future: .028, ts_too_old: .004, late: .01 },
  4: { duplicate: .04, bad_topic: .004, bad_json: .005, unknown_metric: .005, bad_value: .006, out_of_range: .030, bad_ts: .008, ts_in_future: .012, ts_too_old: .004, late: .02 },
  5: { duplicate: .07, bad_topic: .004, bad_json: .004, unknown_metric: .005, bad_value: .005, out_of_range: .010, bad_ts: .008, ts_in_future: .004, ts_too_old: .030, late: .08 },
};
const prof = PROFILES[variant];

// ---- пристрої ----
const kindNames = Object.keys(kinds);
const devices = Array.from({ length: 36 }, (_, i) => ({
  id: `${code}-${pad(i + 1)}`, kind: kindNames[i % kindNames.length],
}));

// ---- значення ----
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const counterBase = new Map();
function valueFor(m, dev, tsMs) {
  const [lo, hi] = m.range;
  const g = m.gen ?? {};
  if (g.bernoulli !== undefined) return rand() < g.bernoulli ? 1 : 0;
  if (g.counter !== undefined) {                                    // лічильник зростає разом із часом
    const key = `${dev.id}|${m.id}`;
    if (!counterBase.has(key)) counterBase.set(key, 100 + Math.floor(rand() * 4000));
    const perSec = g.counter / (m.periodSec ?? 900);
    return round(counterBase.get(key) + perSec * (tsMs - T0) / 1000 * 0.05, m.decimals ?? 3);
  }
  const v = g.mean + g.sd * rand.normal();
  return round(clip(v, Math.max(lo, g.min ?? lo), Math.min(hi, g.max ?? hi)), m.decimals ?? 1);
}

// ---- коректні повідомлення ----
const messages = [];                       // { order, topic, payload, tag }
const used = new Set();
const topicOf = (d) => `${root}/${d.id}/telemetry`;
const payload = (metric, value, ts) => JSON.stringify({ metric, value, ts });
const nValid = Math.round(count / (1 + Object.values(prof).reduce((a, b) => a + b, 0) + 0.02));
const SPAN_MS = 6 * 3600 * 1000;
let guard = 0;
while (messages.filter((x) => x.tag === 'valid').length < nValid && guard++ < nValid * 20) {
  const dev = rand.pick(devices);
  const metric = rand.pick(kinds[dev.kind]);
  const m = table.get(metric);
  const tsMs = NOW - 60_000 - Math.floor(rand() * SPAN_MS / 1000) * 1000;
  const key = `${dev.id}|${metric}|${tsMs}`;
  if (used.has(key)) continue;
  used.add(key);
  messages.push({ order: tsMs, topic: topicOf(dev), tag: 'valid', dev, metric,
    payload: payload(metric, valueFor(m, dev, tsMs), iso(tsMs)) });
}
messages.sort((a, b) => a.order - b.order);
const valid = messages.slice();
const n = (k) => Math.max(1, Math.round(nValid * prof[k]));

// ---- класи браку ----
const extra = [];                           // { after: індекс у valid, topic, payload, tag }
const place = (obj) => extra.push({ ...obj, pos: Math.floor(rand() * valid.length) });
const anyDev = () => rand.pick(devices);
const anyMetric = (dev) => table.get(rand.pick(kinds[dev.kind]));
const goodTs = () => iso(NOW - 120_000 - Math.floor(rand() * 3600) * 1000);

for (let i = 0; i < n('late'); i++) {        // коректні, але старі (до 29 діб): мають бути прийняті
  const dev = anyDev(); const m = anyMetric(dev);
  const tsMs = NOW - (1 + Math.floor(rand() * 28)) * 86_400_000 - Math.floor(rand() * 86_400) * 1000;
  const key = `${dev.id}|${m.id}|${tsMs}`;
  if (used.has(key)) continue; used.add(key);
  place({ topic: topicOf(dev), payload: payload(m.id, valueFor(m, dev, tsMs), iso(tsMs)), tag: 'late' });
}
// межі діапазонів: рівно lo і hi приймаються, поза ними на найменший крок — відхиляються
for (const m of table.values()) {
  if (!kinds && !m) continue;
  const owner = devices.find((d) => kinds[d.kind].includes(m.id));
  if (!owner) continue;
  const step = 10 ** -(m.decimals ?? 1);
  const mk = (value) => place({ topic: topicOf(owner), payload: payload(m.id, value, goodTs()), tag: 'range' });
  mk(m.range[0]); mk(m.range[1]);
  mk(round(m.range[0] - Math.max(step, 0.001), 6)); mk(round(m.range[1] + Math.max(step, 0.001), 6));
}
// межі часу: +300 с і −30 діб +1 с приймаються; +301 с і −30 діб −1 с — ні
for (const [off, tag] of [[300_000, 'time'], [301_000, 'time'], [-(30 * 86_400_000) + 1000, 'time'], [-(30 * 86_400_000) - 1000, 'time']]) {
  const dev = anyDev(); const m = anyMetric(dev);
  place({ topic: topicOf(dev), payload: payload(m.id, valueFor(m, dev, NOW), iso(NOW + off)), tag });
}
for (let i = 0; i < n('duplicate'); i++) {   // повтор того, що вже було: QoS 1 після обриву
  const src = rand.pick(valid);
  let pl = src.payload;
  if (rand() < 0.5) {                        // той самий момент в іншому записі мілісекунд
    const o = JSON.parse(pl); o.ts = o.ts.replace('.000Z', 'Z'); pl = JSON.stringify(o);
  }
  extra.push({ topic: src.topic, payload: pl, tag: 'duplicate',
    pos: Math.min(valid.length - 1, valid.indexOf(src) + 1 + Math.floor(rand() * 200)) });
}
for (let i = 0; i < n('bad_topic'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const t = rand.pick([`${root}/${d.id}/telemetry/extra`, `other/${d.id}/telemetry`, `${root}//telemetry`,
    `${root}/${d.id}/status`, `${root.toUpperCase()}/${d.id}/telemetry`, `${root}/${d.id}-${'x'.repeat(33)}/telemetry`]);
  place({ topic: t, payload: payload(m.id, valueFor(m, d, NOW), goodTs()), tag: 'bad_topic' });
}
for (let i = 0; i < n('bad_json'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const pl = rand.pick([`{"metric":"${m.id}","value":`, 'null', '"21,5"', '42', 'not json', '']);
  place({ topic: topicOf(d), payload: pl, tag: 'bad_json' });
}
for (let i = 0; i < n('unknown_metric'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const name = rand.pick(['pressure', m.id.toUpperCase(), 'constructor', '', `${m.id} `, '__proto__']);
  const pl = rand() < 0.15 ? '[1,2]' : payload(name, 1, goodTs());
  place({ topic: topicOf(d), payload: pl, tag: 'unknown_metric' });
}
for (let i = 0; i < n('bad_value'); i++) {
  const d = anyDev(); const m = anyMetric(d); const ts = goodTs();
  const body = rand.pick([`"value":"21,5"`, `"value":null`, `"value":true`, `"value":[20]`, `"value":1e999`, `"value":"NaN"`]);
  place({ topic: topicOf(d), payload: `{"metric":"${m.id}",${body},"ts":"${ts}"}`, tag: 'bad_value' });
}
for (let i = 0; i < n('out_of_range'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const [lo, hi] = m.range;
  const v = rand.pick([hi + (hi - lo) * 0.5 + 1, lo - (hi - lo) * 0.5 - 1, hi * 10 + 7, -127, 9999].filter((x) => x < lo || x > hi));
  place({ topic: topicOf(d), payload: payload(m.id, round(v, 3), goodTs()), tag: 'out_of_range' });
}
for (let i = 0; i < n('bad_ts'); i++) {
  const d = anyDev(); const m = anyMetric(d); const v = valueFor(m, d, NOW);
  const day = iso(NOW - 3600_000).slice(0, 10);
  const ts = rand.pick([`${day} 11:00:00`, `${day}T11:00:00+02:00`, `${day}T11:00:00`, '2026-02-30T10:00:00Z',
    '2026-13-01T00:00:00Z', `${day}T11:00:00.1234Z`]);
  const pl = rand() < 0.15 ? `{"metric":"${m.id}","value":${v},"ts":${Math.floor((NOW - 3600_000) / 1000)}}` : payload(m.id, v, ts);
  place({ topic: topicOf(d), payload: pl, tag: 'bad_ts' });
}
for (let i = 0; i < n('ts_in_future'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const off = rand.pick([6 * 60_000, 45 * 60_000, 3600_000, 2 * 3600_000 + 5000, 24 * 3600_000]);   // типово: годинник пристрою без NTP або зсув пояса
  place({ topic: topicOf(d), payload: payload(m.id, valueFor(m, d, NOW), iso(NOW + off)), tag: 'ts_in_future' });
}
for (let i = 0; i < n('ts_too_old'); i++) {
  const d = anyDev(); const m = anyMetric(d);
  const off = rand.pick([31 * 86_400_000, 90 * 86_400_000, 400 * 86_400_000]);
  const ts = rand() < 0.2 ? '1970-01-01T00:00:05Z' : iso(NOW - off);
  place({ topic: topicOf(d), payload: payload(m.id, valueFor(m, d, NOW), ts), tag: 'ts_too_old' });
}

// ---- склеювання ----
const stream = valid.map((v) => ({ topic: v.topic, payload: v.payload }));
const order = extra.map((e, i) => ({ ...e, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
const merged = [];
let vi = 0;
for (const e of order) {
  while (vi <= e.pos && vi < stream.length) merged.push(stream[vi++]);
  merged.push({ topic: e.topic, payload: e.payload });
}
while (vi < stream.length) merged.push(stream[vi++]);

fs.mkdirSync(path.dirname(out), { recursive: true });
const meta = { _meta: { variant, seed, now: NOW_ISO, root, messages: merged.length } };
fs.writeFileSync(out, [meta, ...merged].map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`Потік записано: ${path.relative(process.cwd(), out)} — ${merged.length} повідомлень (варіант ${variant}, зерно ${seed}, now = ${NOW_ISO}).`);
