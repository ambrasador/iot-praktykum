// Еталонний класифікатор приймання, незалежний від коду застосунку.
// Порядок перевірок і межі — ті самі, що в core.js (підручник, п. 1.4): так ми дізнаємося,
// чи правильно студент перенес предметні правила свого домену.
import { metricTable } from './passport.mjs';

const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function checkReading(r, now, table) {
  if (typeof r.deviceId !== 'string' || !r.deviceId) return 'bad_device';
  const m = table.get(r.metric);
  if (!m) return 'unknown_metric';
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return 'bad_value';
  if (r.value < m.range[0] || r.value > m.range[1]) return 'out_of_range';
  if (typeof r.ts !== 'string' || !TS_RE.test(r.ts)) return 'bad_ts';
  const t = Date.parse(r.ts);
  const iso = Number.isNaN(t) ? '' : new Date(t).toISOString();
  if (iso.slice(0, 19) !== r.ts.slice(0, 19)) return 'bad_ts';
  if (t > now + MAX_FUTURE_MS) return 'ts_in_future';
  if (t < now - MAX_AGE_MS) return 'ts_too_old';
  return null;
}

const TOPIC_RE = (root) => new RegExp(`^${root}/([A-Za-z0-9_-]{1,32})/telemetry$`);

// Розбір повідомлення потоку так, як це робить decode() адаптера: 'bad_topic' / 'bad_json' / читання
export function decodeMessage(msg, root) {
  const m = TOPIC_RE(root).exec(msg.topic);
  if (!m) return { reject: 'bad_topic' };
  let p;
  try { p = JSON.parse(msg.payload); } catch { return { reject: 'bad_json' }; }
  if (p === null || typeof p !== 'object') return { reject: 'bad_json' };
  return { reading: { deviceId: m[1], metric: p.metric, value: p.value, ts: p.ts } };
}

// Підсумок для потоку: скільки збережено, дублікатів і відхилено за кожною причиною
export function classifyStream(messages, now, passport) {
  const table = metricTable(passport);
  const seen = new Set();
  const out = { total: 0, stored: 0, duplicate: 0, rejected: 0, reasons: {} };
  const bump = (r) => { out.rejected += 1; out.reasons[r] = (out.reasons[r] ?? 0) + 1; };
  for (const msg of messages) {
    out.total += 1;
    const d = decodeMessage(msg, passport.topicRoot);
    if (d.reject) { bump(d.reject); continue; }
    const bad = checkReading(d.reading, now, table);
    if (bad) { bump(bad); continue; }
    const key = `${d.reading.deviceId}|${d.reading.metric}|${new Date(d.reading.ts).toISOString()}`;
    if (seen.has(key)) { out.duplicate += 1; continue; }
    seen.add(key);
    out.stored += 1;
  }
  return out;
}

export const NOW_ISO = '2026-10-15T12:00:00.000Z';
