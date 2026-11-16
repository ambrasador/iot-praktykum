// Лабораторія графіка (ПР4): що лишається від ряду метрики сповіщення після агрегації та проріджування.
// Ряд — історія стенду ПР2 (той самий пристрій і метрика, що в сповіщеннях), епізоди — істина ПР2.
import { pathToFileURL } from 'node:url';
import { appPath } from './app.mjs';
import { buildHistory, truth, pointsOf } from './series.mjs';
import { INTERVALS } from './expect.mjs';

export const METHODS = [
  ['avg', 'Середнє за кошик (B кошиків)'],
  ['nth', 'Кожна k-та точка'],
  ['lttb', 'LTTB'],
  ['minmax', 'Мінімум і максимум кошика'],
  ['m4', 'M4'],
];
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

async function clientDownsample() {
  return import(pathToFileURL(appPath('client', 'downsample.js')).href);
}

// intervalName — інтервал ПР2 (pr02.interval); seed — зерно студента
export async function chartLab(variant, p, seed, intervalName) {
  const ds = await clientDownsample();
  const hist = buildHistory(variant, p, seed);
  const tr = truth(variant, p, hist);
  const A = p.alert; const B = p.chart.points;
  const sgn = A.op === 'gt' ? 1 : -1;
  const beyond = (v) => sgn * (v - A.threshold) > 0;
  const better = (a, b) => (sgn > 0 ? Math.max(a, b) : Math.min(a, b));
  const pts = pointsOf(hist, hist.alertDevice, A.metric).map((q) => ({ t: q.ms, v: q.value }));
  const ext = (a) => a.reduce((m, q) => better(m, q.v), a[0].v);
  const rawExt = ext(pts);
  const eps = tr.eps.map((e) => [Date.parse(e.start), Date.parse(e.end)]);

  // видимість через кошики, що покривають відрізок часу
  const bucketsVisible = (buckets) => eps.filter(([s, e]) => buckets.some((b) => b.t0 <= e && b.t1 > s && beyond(b.v))).length;
  // видимість через окремі точки: точка «представляє» епізод, якщо лежить у ньому або не далі за ширину одного
  // бюджетного кошика (піксельний стовпчик) від його меж: два близькі епізоди на графіку зливаються в один провал
  const slack = (pts.at(-1).t - pts[0].t) / B;
  const pointsVisible = (series) => eps.filter(([s, e]) => series.some((q) => q.t >= s - slack && q.t <= e + slack && beyond(q.v))).length;

  // А. інтервал ПР2: середнє проти краю смуги (максимум для gt, мінімум для lt)
  const sec = INTERVALS.find(([n]) => n === intervalName)[1];
  const w = sec * 1000;
  const byBucket = new Map();
  for (const q of pts) {
    const k = Math.floor(q.t / w);
    const b = byBucket.get(k) ?? { t0: k * w, t1: (k + 1) * w, sum: 0, n: 0, edge: q.v };
    b.sum += q.v; b.n += 1; b.edge = better(b.edge, q.v);
    byBucket.set(k, b);
  }
  const agg = [...byBucket.values()];
  const interval = {
    name: intervalName, buckets: agg.length,
    avg_visible: bucketsVisible(agg.map((b) => ({ ...b, v: b.sum / b.n }))),
    band_visible: bucketsVisible(agg.map((b) => ({ ...b, v: b.edge }))),
    avg_extreme: round(agg.reduce((m, b) => better(m, b.sum / b.n), agg[0].sum / agg[0].n), 2),
  };

  // Б. проріджування сирого ряду до бюджету B
  const t0 = pts[0].t; const t1 = pts.at(-1).t; const span = (t1 - t0) / B;
  const avgBuckets = Array.from({ length: B }, (_, i) => ({ t0: t0 + i * span, t1: t0 + (i + 1) * span, sum: 0, n: 0 }));
  for (const q of pts) { const b = avgBuckets[Math.min(B - 1, Math.floor((q.t - t0) / span))]; b.sum += q.v; b.n += 1; }
  const avgSeries = avgBuckets.filter((b) => b.n).map((b) => ({ ...b, v: b.sum / b.n }));
  const nth = ds.everyNth(pts, B);
  const lttb = ds.lttb(pts, B);
  const minmax = ds.minMax(pts, Math.floor(B / 2));
  const m4 = ds.m4(pts, Math.floor(B / 4));
  const row = (points, visible, series) => ({ points, extreme: round(ext(series), 2), loss: round(sgn * (rawExt - ext(series)), 2), visible });
  const methods = {
    avg: row(avgSeries.length, bucketsVisible(avgSeries), avgSeries.map((b) => ({ v: b.v }))),
    nth: row(nth.length, pointsVisible(nth), nth),
    lttb: row(lttb.length, pointsVisible(lttb), lttb),
    minmax: row(minmax.length, pointsVisible(minmax), minmax),
    m4: row(m4.length, pointsVisible(m4), m4),
  };
  const total = eps.length;
  const acceptable = METHODS.map(([id]) => id).filter((id) => methods[id].visible === total && methods[id].loss <= 0 && methods[id].points <= B + 1);
  const rejected = METHODS.map(([id]) => id).filter((id) => !acceptable.includes(id));
  return {
    device: hist.alertDevice, metric: A.metric, op: A.op, threshold: A.threshold, budget: B, raw_points: pts.length, raw_extreme: rawExt,
    edge: sgn > 0 ? 'max' : 'min', episodes: total, interval, methods, acceptable, rejected,
  };
}
