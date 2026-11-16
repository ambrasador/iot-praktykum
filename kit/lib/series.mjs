// Відтворювана історія стенду: чотири пристрої, сім (V3 — сорок) діб вимірювань із підкладеними подіями.
// Зерно студента й номер варіанта визначають фази пристроїв, шум і розташування подій у часі.
// Істина (truth) обчислюється з згенерованих точок незалежним пошуком епізодів (episodes.mjs).
import { rng, seedFor } from './rng.mjs';
import { metricTable, DEVICE_KINDS } from './passport.mjs';
import { NOW_ISO } from './oracle.mjs';
import { episodes } from './episodes.mjs';

export const NOW_MS = Date.parse(NOW_ISO);
export const DAY = 86_400_000;
export const MAX_ROWS = { agg: 500_000, alerts: 60_000 };

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// Пристрої стенду: види чергуються за порядком у DEVICE_KINDS
export function deviceList(variant, p) {
  const kinds = Object.entries(DEVICE_KINDS[variant]);
  const seen = {};
  return Array.from({ length: p.history.devices }, (_, i) => {
    const [kind, metrics] = kinds[i % kinds.length];
    seen[kind] = (seen[kind] ?? 0) + 1;
    return { id: `${kind}-${String(seen[kind]).padStart(2, '0')}`, kind, metrics };
  });
}

export const historyStart = (p) => Math.floor((NOW_MS - p.history.days * DAY) / DAY) * DAY;

// Правила епізоду з паспорта для L3 (задані параметри)
export const specRule = (p) => ({
  op: p.alert.op, threshold: p.alert.threshold, hysteresis: p.alert.hysteresis,
  minDurationMs: p.alert.minDurationSec * 1000, maxGapMs: 3 * p.load.T * 1000,
});

export function buildHistory(variant, p, seed) {
  const T = p.load.T;
  const table = metricTable(p);
  const startMs = historyStart(p);
  const devs = deviceList(variant, p);
  const A = p.alert;
  const alertDev = devs.find((d) => d.metrics.includes(A.metric));
  const tzDev = devs.find((d) => d.metrics.includes(p.tzEvent.metric));
  const sgn = A.op === 'lt' ? -1 : 1;

  const history = { variant, seed, startMs, endMs: NOW_MS, T, devices: [], alertDevice: alertDev.id, tzDevice: tzDev.id };
  const planted = [];

  devs.forEach((dev, di) => {
    const rand = rng(seedFor(variant, seed, 20 + di));
    const phase = rand.int(0, T - 1) * 1000;
    const n = Math.floor((NOW_MS - 1 - startMs - phase) / (T * 1000)) + 1;
    const ms = Array.from({ length: n }, (_, i) => startMs + phase + i * T * 1000);
    const rows = {};

    for (const mid of dev.metrics) {
      const m = table.get(mid);
      const [lo, hi] = m.range;
      const dec = m.decimals ?? 1;
      const isAlert = mid === A.metric;
      const g = isAlert ? { ...m.gen, ...A.baseline } : (m.gen ?? {});
      const v = new Array(n);
      if (g.counter !== undefined) {                               // лічильник: монотонний приріст
        let c = 100 + Math.floor(rand() * 4000);
        for (let i = 0; i < n; i++) { c += Math.max(0, g.counter * (1 + 0.25 * rand.normal())); v[i] = round(c, dec); }
      } else if (g.bernoulli !== undefined) {
        for (let i = 0; i < n; i++) {
          if (mid === 'lamp_on') { const h = new Date(ms[i]).getUTCHours(); v[i] = h >= 16 || h < 4 ? 1 : 0; }
          else if (mid === 'mains_present') v[i] = 1;
          else v[i] = rand() < g.bernoulli ? 1 : 0;
        }
      } else {
        const rho = mid === 'lat' || mid === 'lon' ? 0.995 : 0;     // координати змінюються плавно
        const sd = g.sd ?? 1;
        const bandLo = isAlert ? g.mean - 4 * sd : lo;
        const bandHi = isAlert ? g.mean + 4 * sd : hi;
        let x = g.mean;
        for (let i = 0; i < n; i++) {
          x = g.mean + rho * (x - g.mean) + Math.sqrt(1 - rho * rho) * sd * rand.normal();
          v[i] = round(clip(x, Math.max(lo, g.min ?? bandLo, bandLo), Math.min(hi, g.max ?? bandHi, bandHi)), dec);
        }
      }
      rows[mid] = { ms: ms.slice(), v, dec };
    }

    // ---- подія переходу доби (tz): сплеск або стрибок лічильника ----
    if (dev.id === tzDev.id) {
      const E = p.tzEvent;
      const r = rows[E.metric];
      const at = Date.parse(E.at);
      const i0 = Math.round((at - r.ms[0]) / (T * 1000));
      if (E.kind === 'spike') {
        const cap = E.value - Math.max(1, 0.05 * Math.abs(E.value));
        for (let i = 0; i < r.v.length; i++) r.v[i] = Math.min(r.v[i], round(cap, r.dec));
        for (const k of [-1, 0, 1]) r.v[i0 + k] = round(E.value - Math.abs(k) * 0.3, r.dec);
        r.v[i0] = E.value;
      } else {                                                      // jump: лічильник стрибає й далі росте від нової бази
        for (let i = i0; i < r.v.length; i++) r.v[i] = round(r.v[i] + E.value, r.dec);
      }
      planted.push({ name: 'tz', device: dev.id, metric: E.metric, atMs: r.ms[i0], index: i0 });
    }

    // ---- інциденти на метриці сповіщення (лише на першому пристрої з цією метрикою) ----
    let drop = null;
    if (dev.id === alertDev.id) {
      const r = rows[A.metric];
      const d = A.minDurationSec;
      const kBlip = Math.max(1, Math.floor((0.4 * d) / T));
      const kPiece = Math.max(1, Math.round((0.5 * d) / T));
      const L1 = Math.ceil((2 * d) / T) + 1;
      const Lc = 6 * kPiece + 5;
      const Lg = Math.ceil((1.6 * d) / T) + 1;
      const G = 5;
      const L4 = Math.ceil((2.5 * d) / T) + 1;
      const wiggle = A.threshold - sgn * 0.5 * A.hysteresis;       // усередині смуги гістерезису
      const plateau = () => clip(A.deep + A.deepSd * rand.normal(), -Infinity, Infinity);
      const deepSide = (x) => (sgn > 0 ? Math.max(x, A.threshold + 0.4 * (A.deep - A.threshold)) : Math.min(x, A.threshold - 0.4 * (A.threshold - A.deep)));
      const put = (i0, len) => { for (let k = 0; k < len; k++) r.v[i0 + k] = round(deepSide(plateau()), r.dec); };
      // розкладка: E1, B1, E2, E3, B2 рівномірно по ряду з розкидом, E4 — наприкінці ряду
      const tzIdx = tzDev.id === dev.id && p.tzEvent.metric === A.metric ? planted.find((e) => e.name === 'tz').index : -1e9;
      const sizes = { E1: L1, B1: kBlip, E2: Lc, E3: 2 * Lg + G, B2: kBlip };
      const order = ['E1', 'B1', 'E2', 'E3', 'B2'];
      const body = n - L4 - 10;
      const used = order.reduce((s, k) => s + sizes[k], 0);
      const slack = body - used - 20;
      let cursor = 10 + Math.floor(slack * 0.05);
      const slot = slack / (order.length + 1);
      for (const k of order) {
        const jitter = Math.floor((rand() - 0.5) * 0.5 * slot);
        let i0 = Math.max(cursor, cursor + Math.floor(slot) + jitter);
        if (Math.abs(i0 + sizes[k] / 2 - tzIdx) < 90 * 60 / T + sizes[k]) i0 += Math.ceil((180 * 60) / T) + sizes[k];   // не накладати на подію tz
        planted.push({ name: k, index: i0, len: sizes[k], startMs: r.ms[i0] });
        cursor = i0 + sizes[k] + 3;
        if (k === 'E1') put(i0, L1);
        if (k === 'B1' || k === 'B2') put(i0, kBlip);
        if (k === 'E2') {
          for (let piece = 0; piece < 6; piece++) {
            put(i0 + piece * (kPiece + 1), kPiece);
            if (piece < 5) r.v[i0 + piece * (kPiece + 1) + kPiece] = round(wiggle, r.dec);
          }
        }
        if (k === 'E3') {
          put(i0, Lg);
          drop = new Set(Array.from({ length: G }, (_, j) => i0 + Lg + j));
          put(i0 + Lg + G, Lg);
        }
      }
      const i4 = n - L4;
      put(i4, L4);
      planted.push({ name: 'E4', index: i4, len: L4, startMs: r.ms[i4] });
      history.planted = planted;
      if (cursor > i4 - 3) throw new Error('події не поміщаються в ряд: збільште history.days');
      // пропуск даних усередині E3 (прибираємо точки)
      const keep = r.ms.map((_, i) => !drop.has(i));
      r.ms = r.ms.filter((_, i) => keep[i]);
      r.v = r.v.filter((_, i) => keep[i]);
    }
    history.devices.push({ id: dev.id, kind: dev.kind, rows });
  });

  history.planted = planted;
  return history;
}

// Точки метрики пристрою у форматі { ms, value }
export const pointsOf = (h, deviceId, metric) => {
  const r = h.devices.find((d) => d.id === deviceId).rows[metric];
  return r.ms.map((ms, i) => ({ ms, value: r.v[i] }));
};

// Усі вимірювання в хронологічному порядку (для запису в базу застосунку)
export function* readings(h) {
  const all = [];
  for (const d of h.devices) for (const [metric, r] of Object.entries(d.rows)) for (let i = 0; i < r.ms.length; i++) all.push([r.ms[i], d.id, metric, r.v[i]]);
  all.sort((a, b) => a[0] - b[0]);
  for (const [ms, deviceId, metric, value] of all) yield { ms, deviceId, metric, value, ts: new Date(ms).toISOString() };
}

// ---------- істина для перевірок ----------
export function truth(variant, p, h) {
  const A = p.alert;
  const pts = pointsOf(h, h.alertDevice, A.metric);
  const spec = specRule(p);
  const eps = episodes(pts, spec);
  const longest = eps.reduce((a, b) => (b.duration_sec > a.duration_sec ? b : a));
  const T = p.load.T;
  // сирі дані: вікно в сповіщеннях — уся історія до NOW
  const rawDays = Math.ceil((1400 * T) / 86400);
  const rawTo = Math.floor(NOW_MS / DAY) * DAY;
  const rawFrom = rawTo - rawDays * DAY;
  const nRows = pts.filter((q) => q.ms >= rawFrom && q.ms < rawTo).length;
  return { eps, longest, spec, raw: { from: new Date(rawFrom).toISOString(), to: new Date(rawTo).toISOString(), days: rawDays, n_rows: nRows, pages: Math.max(1, Math.ceil(nRows / 200)) } };
}
