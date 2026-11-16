// Очікувані значення практикуму: з них складається ключ викладача, і з ними звіряє verify.mjs.
// Усі величини виводяться з паспорта формулами підручника (lib/formulas.mjs).
import * as F from './formulas.mjs';

export const OPTIONS = {
  A: { label: 'WAL + FULL, один рядок у транзакції (налаштування за замовчуванням)', mode: 'wal-full', rows: () => 1 },
  B: { label: 'Пакетування на пристрої: кілька рядків в одному повідомленні, WAL + FULL', mode: 'wal-full', rows: (p) => p.requirements.deviceBatch },
  C: { label: 'WAL + NORMAL, один рядок у транзакції (довговічність втрачено)', mode: 'wal-normal', rows: () => 1 },
  D: { label: 'Довговічна черга й запис пакетами по 500 рядків', mode: 'wal-full', rows: () => 500 },
};

export function pr01(p) {
  const L = p.load;
  const avg = F.lambdaAvg(L.N, L.m, L.T);
  const peak = F.lambdaPeak(L);
  const options = {};
  for (const [id, o] of Object.entries(OPTIONS)) {
    const s = o.rows(p);
    const cap = F.pipelineCapacity(o.mode, s);
    const available = !(id === 'B' && s <= 1);
    options[id] = { rows_per_tx: s, capacity: cap, allowed: F.allowedPeak(cap), share_pct: F.headroomShare(peak, cap) * 100,
      available, durable: o.mode !== 'wal-normal', ok: available && peak <= F.allowedPeak(cap) && (!p.requirements.durable || o.mode !== 'wal-normal') };
  }
  const minimal = ['A', 'B', 'C', 'D'].find((id) => options[id].ok);
  const capA = options.A.capacity;
  const out = {
    lambda_avg: avg, lambda_peak: peak, k: peak / avg,
    rows_year_mln: F.rowsPerYear(avg) / 1e6, gb_year: F.gbPerYear(avg),
    options, minimal,
    overflow_s: F.overflowSeconds(peak, capA),
    tau_min_s: L.model === 'burst' ? F.minJitterWindow(L, capA) : null,
    n_max: {},
    poll: { r_poll: F.pollRate(p.dashboard.U, p.dashboard.p), share_pct: F.pollShare(p.dashboard.U, p.dashboard.p) * 100,
      way: F.pollRate(p.dashboard.U, p.dashboard.p) <= F.R_READ / F.HEADROOM ? 'poll' : 'push',
      r_push: p.dashboard.U / p.dashboard.F },
  };
  for (const id of Object.keys(options)) out.n_max[id] = F.maxDevices(L, options[id].capacity);
  return out;
}

// ---------------- ПР2 ----------------
import { buildHistory, truth, pointsOf, NOW_MS, DAY, MAX_ROWS } from './series.mjs';
import { episodes } from './episodes.mjs';

const tzOffsetMs = (tz, ms) => {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(ms).find((x) => x.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(s);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};
const localDay = (tz, ms) => new Date(ms + tzOffsetMs(tz, ms)).toISOString().slice(0, 10);
const localMidnightMs = (tz, day) => {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
};

// Дозволені інтервали агрегації (parseInterval у timeq.js): хвилини й години — дільники 60 і 24
export const INTERVALS = [
  ...[1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30].map((n) => [`${n}m`, n * 60]),
  ...[1, 2, 3, 4, 6, 8, 12].map((n) => [`${n}h`, n * 3600]),
  ['1d', 86400],
];

const sameStarts = (a, b) => a.length === b.length && a.every((e, i) => e.start === b[i].start);

export function pr02(variant, p, seed) {
  const hist = buildHistory(variant, p, seed);
  const tr = truth(variant, p, hist);
  const A = p.alert; const T = p.load.T; const E = p.tzEvent;
  const pts = pointsOf(hist, hist.alertDevice, A.metric);
  const base = { op: A.op, threshold: A.threshold, maxGapMs: 3 * T * 1000 };
  const run = (h, d, gap = 3 * T * 1000) => episodes(pts, { ...base, maxGapMs: gap, hysteresis: h, minDurationMs: d * 1000 });
  const pairOk = (h, d) => sameStarts(run(h, d), tr.eps);
  const robust = (h, d) => [[0.8, 0.8], [0.8, 1.2], [1.2, 0.8], [1.2, 1.2]].every(([a, b]) => pairOk(h * a, d * b));
  // найменший max_gap (с), за якого розколений інцидент зливається в один епізод
  let merge = null;
  for (let g = T; g <= 12 * T; g += 1) if (run(A.hysteresis, A.minDurationSec, g * 1000).length === tr.eps.length - 1) { merge = g; break; }

  // добова подія: бакети UTC і Києва
  const r = hist.devices.find((d) => d.id === hist.tzDevice).rows[E.metric];
  const at = Date.parse(E.at);
  const dayValue = (s, e) => {
    const idx = r.ms.map((m, i) => (m >= s && m < e ? i : -1)).filter((i) => i >= 0);
    if (E.kind === 'spike') return Math.max(...idx.map((i) => r.v[i]));
    const before = r.ms.map((m, i) => (m < s ? i : -1)).filter((i) => i >= 0).at(-1);
    return r.v[idx.at(-1)] - r.v[before];
  };
  const utcStart = Math.floor(at / DAY) * DAY;
  const kDay = localDay('Europe/Kyiv', at);
  const kStart = localMidnightMs('Europe/Kyiv', kDay);
  const tz = {
    agg: E.kind === 'spike' ? 'max' : 'delta',
    utc_start: new Date(utcStart).toISOString(), utc_value: dayValue(utcStart, utcStart + DAY),
    kyiv_day: kDay, kyiv_start: new Date(kStart).toISOString(), kyiv_value: dayValue(kStart, localMidnightMs('Europe/Kyiv', localDay('Europe/Kyiv', kStart + 36 * 3600_000))),
  };

  const W = { agg: Math.floor((MAX_ROWS.agg * T) / 86400), alerts: Math.floor((MAX_ROWS.alerts * T) / 86400) };
  const chartSec = p.chart.days * 86400;
  const chosen = INTERVALS.find(([, s]) => chartSec / s <= p.chart.points);
  return {
    hist, ...tr, pairOk, robust, merge_gap_s: merge,
    tz, w_agg_days: W.agg, w_alerts_days: W.alerts,
    est_rows_agg: Math.round(((W.agg + 1) * 86400) / T), chunks_730: Math.ceil(730 / W.agg),
    interval: chosen[0], interval_points: chartSec / chosen[1],
  };
}

// ---------------- ПР3 ----------------
export function pr03(variant, p) {
  const rt = p.rt; const L = p.load; const U = rt.clients; const n = rt.room.n; const T = L.T; const m = L.m;
  const Fcl = F.frameRate(n, T);
  const bytes = {};
  for (const tr of ['poll', 'sse', 'sio']) bytes[tr] = F.bytesPerDay({ n, m, T, L: rt.latencyMs }, tr) / 1e6;
  const allowed = ['sio', 'sse'].filter((tr) => (tr === 'sio' ? !rt.wsBlocked : !rt.duplex));
  const transport = allowed.sort((a, b) => bytes[a] - bytes[b])[0];
  const why = rt.wsBlocked ? 'WebSocket заблоковано проксі → лише SSE' : rt.duplex ? 'потрібен зворотний напрям на тому самому каналі → Socket.IO' : 'обидва можливі → дешевший за трафіком';
  const dflt = transport === 'sio' ? { b: F.RT.defaults.b, c: F.RT.defaults.c } : { retry: F.RT.defaults.sseRetry };
  const cap = {
    u_cpu: F.uCpu(Fcl, transport), u_mem: F.uMem(rt.memMB, transport), u_storm: F.uStorm(transport, dflt),
  };
  cap.u_max = Math.min(cap.u_cpu, cap.u_mem, cap.u_storm);
  cap.binding = cap.u_max === cap.u_storm ? 'storm' : cap.u_max === cap.u_mem ? 'mem' : 'cpu';
  const rule = { b: F.ruleB(U), c: F.ruleC(U), retry: F.ruleRetry(U) };
  const nMax = F.roomMax(T, U, transport);
  const frameB = F.RT.frame[transport](m);
  // L5
  const kMax = F.kMax(rt.fanMs, transport);
  let instances = 2;
  while (F.drainSeconds(U, instances) > rt.deployS) instances += 1;
  const queue = transport === 'sio'
    ? { unit: 'пакетів', lo: Math.ceil(Fcl * rt.stallS), hi: Math.floor((rt.queueKB * 1000) / frameB), default: 500, env: 'RT_MAX_QUEUE' }
    : { unit: 'байт', lo: Math.ceil(Fcl * rt.stallS * frameB), hi: rt.queueKB * 1000, default: 1048576, env: 'RT_SSE_MAX_BUFFERED' };
  return {
    U, Fcl, bytes, transport, why, cap, fits_default: U <= cap.u_max, rule,
    window: { lo: m > 1 ? rt.spreadMs : 0, hi: Math.floor(rt.latencyMs / 2) },
    room_max: nMax, room_split: Math.max(1, Math.ceil(n / nMax)), mem_need: Math.max(rt.memMB, Math.ceil((U * F.RT.m[transport]) / 1024)),
    k_max: kMax, rooms_hot: Math.ceil(rt.room.hot / kMax),
    instances, drain_s: F.drainSeconds(U, instances), queue, frame_bytes: frameB,
  };
}

// Параметри політики, знайдені перебором (для ключа й «ідеального студента»): c = 30 с, b з кроком 0,5 с
export async function pr03Tuned(variant, p, seed) {
  const { loadDelay, sweep } = await import('./storm.mjs');
  const delay = await loadDelay();
  const X = pr03(variant, p);
  const U = X.U;
  if (X.transport === 'sse') {
    for (let r = Math.max(0.5, Math.ceil(X.rule.retry * 2) / 2); r < 200; r += 0.5) {
      const s = sweep({ U, policy: { kind: 'sse', retry: r }, seed, delay });
      if (s.worst.peak <= F.RT.C) return { policy: { kind: 'sse', retry: r }, sweep: s };
    }
  } else {
    const c = 30;
    for (let b = Math.max(0.5, Math.ceil(X.rule.b * 2) / 2); b < 200; b += 0.5) {
      const s = sweep({ U, policy: { kind: 'sio', b, c }, seed, delay });
      if (s.worst.peak <= F.RT.C) return { policy: { kind: 'sio', b, c }, sweep: s };
    }
  }
  throw new Error('не знайдено політики, що вкладається в C');
}

// ---------------- ПР4 ----------------
export async function pr04(variant, p, seed) {
  const ui = p.ui; const T = p.load.T; const n = p.rt.room.n; const U = p.dashboard.U;
  const lossP = ui.lossPct / 100; const deltaS = ui.deltaMs / 1000;
  const cardsTotal = n * ui.cards.length;
  const ks = F.feasibleK({ T, p: lossP, cards: cardsTotal, falsePerDayMax: ui.falsePerDayMax, silenceMaxS: ui.silenceMaxS });
  const X2 = pr02(variant, p, seed);
  const B = p.chart.points;
  // контраст стану
  const contrast = {};
  for (const [s, c] of Object.entries(ui.palette)) {
    const white = F.cr(c, '#FFFFFF'); const black = F.cr(c, '#000000');
    contrast[s] = { white, black, text: white >= black ? 'white' : 'black', best: Math.max(white, black), ok: Math.max(white, black) >= F.UI.textMin };
  }
  // діапазони
  const ranges = ui.ranges.map((name) => {
    const R = F.UI.rangeSec[name]; const raw = R / T;
    const found = raw <= B ? null : INTERVALS.find(([, s]) => s >= T && R / s <= B);
    const interval = found ? found[0] : null;
    return { range: name, raw, interval, points: interval ? R / found[1] : raw, plus: Boolean(interval) };
  });
  const defaultRange = ranges.find((r) => r.raw >= F.UI.rawMin)?.range ?? ranges.at(-1).range;
  const { chartLab } = await import('./chart-lab.mjs');
  const lab = await chartLab(variant, p, seed, X2.interval);
  const forK = (k) => {
    const P = F.pollBest({ k, T, deltaS, ageMaxS: ui.ageMaxS });
    const load = F.pollLoad(U, n, P);
    return {
      k, bound_k: F.pollBoundK(k, T, deltaS), bound_age: F.pollBoundAge(T, deltaS, ui.ageMaxS), P,
      load, share_pct: F.pollShareUi(load) * 100, n_max: F.nMaxPoll(U, P), traffic: F.trafficMBDay(n, P),
      mode: F.pollMode({ U, n, P, trafficMax: ui.trafficMBDayMax }),
    };
  };
  const views = ui.views.map((v) => ({ metric: v.metric, cls: v.cls, ...F.VIEWS[v.cls] }));
  return { ui, T, n, U, B, cardsTotal, feasibleK: ks, k: ks[0], forK, contrast, ranges, defaultRange, lab, views, pr02interval: X2.interval };
}

// ---------------- ПР5 ----------------
export async function pr05(variant, p, seed) {
  const L = await import('./mob-lab.mjs');
  const mob = p.mob; const ui = p.ui; const T = p.load.T;
  const deltaS = ui.deltaMs / 1000; const n = p.rt.room.n; const U = p.dashboard.U;
  const ks = F.feasibleK({ T, p: ui.lossPct / 100, cards: n * ui.cards.length, falsePerDayMax: ui.falsePerDayMax, silenceMaxS: ui.silenceMaxS });
  const eps = F.clockEps(mob.rttMs);
  // Годинник: залежить від k, обраного в ПР4
  const forK = (k) => {
    const P04 = F.pollBest({ k, T, deltaS, ageMaxS: ui.ageMaxS });
    const margin = F.clockMargin({ k, T, P: P04, deltaS });
    const behind = F.clockBehind({ k, T, silenceMaxS: ui.silenceMaxS });
    const poll = F.pollMob({ k, T, deltaS, ageMaxS: ui.ageMaxS, eps });
    const load = F.pollLoad(U, n, poll);
    return { k, P04, eps, margin, behind, uncorrected: F.clockVerdict({ skewS: mob.skewS, margin, behind }),
      corrected_ok: eps <= margin && eps <= behind, poll_s: poll, margin_mob: F.clockMargin({ k, T, P: poll, deltaS }),
      load, share_pct: F.pollShareUi(load) * 100 };
  };
  // BLE і прив'язка
  const writes = F.bleWrites(mob.ble.messageBytes, mob.ble.mtu);
  const ble = { L: mob.ble.messageBytes, mtu: mob.ble.mtu, writes, last_bytes: F.bleLastWrite(mob.ble.messageBytes, mob.ble.mtu), time_ms: writes * F.BLE_EVENT_MS };
  const prov = F.provPlan({ wifiS: mob.wifiS, T, maxWaitS: mob.maxWaitS });
  // Шум і гістерезис метрики сповіщення (перша картка з правилом)
  const hist = buildHistory(variant, p, seed);
  const cards = L.cardsWithRule(p);
  const first = cards[0];
  const nz = L.noise(variant, p, seed, first.metric, hist);
  const N = F.readingsPerDay(T); const R = mob.repeatsPerDayMax;
  const kRule = F.kMult(N, R);
  const baseline = L.baselineOf(p, first.metric);
  const hMin = kRule * nz.sigma_calm;
  const pow = 10 ** first.decimals;
  const noise = { ...nz, N, R, k: kRule, h_min: hMin, h_ideal: Math.ceil(hMin * pow - 1e-9) / pow, baseline, room: L.roomOf(L.ruleOf(first, 0), baseline), card: first,
    alertsAt: (h) => F.pushAlertsPerDay(N, h, nz.sigma_calm) };
  const rules = cards.map((c, i) => ({ metric: c.metric, card: c, derived: i === 0, hysteresis: i === 0 ? null : (mob.hys?.[c.metric] ?? 0), baseline: L.baselineOf(p, c.metric) }));
  // Push: строк актуальності, дублі черги, повтори
  const ttl = mob.alertStaleS;
  const pushCfg = { ttl_s: ttl, max_age_lo: 10, max_age_hi: ttl, max_age_ideal: ttl - 5 };
  const dups = { n: mob.queueN, q_pct: mob.qLossPct, m: F.MOB.retryM, theory: F.dupRows(mob.queueN, mob.qLossPct / 100, F.MOB.retryM), sd: F.dupSd(mob.queueN, mob.qLossPct / 100) };
  const retries = { ttl_s: ttl, r503: { max: F.retriesInTtl(ttl, false, 'max'), min: F.retriesInTtl(ttl, false, 'min') }, r429: { max: F.retriesInTtl(ttl, true, 'max'), min: F.retriesInTtl(ttl, true, 'min') } };
  const lostOn429 = retries.r429.max.n === 0;
  return { mob, ui, T, N, R, n, U, deltaS, eps, ks, k0: ks[0], forK, ble, prov, noise, rules, cards, push: pushCfg, dups, retries, lostOn429, hist, lab: L };
}

// ---------------- ПР6 ----------------
// Очікувані числа безпеки. Те, що залежить від попередніх ПР (періоди опитування, режим, байти на рядок),
// береться з журналу студента через chainFor(…), решта — з паспорта.
export async function pr06(variant, p, seed) {
  const S = p.sec; const ui = p.ui; const mob = p.mob; const T = p.load.T;
  const n = p.rt.room.n; const U = p.dashboard.U; const deltaS = ui.deltaMs / 1000;
  const lambda = F.lambdaAvg(p.load.N, p.load.m, T);
  const ks = F.feasibleK({ T, p: ui.lossPct / 100, cards: n * ui.cards.length, falsePerDayMax: ui.falsePerDayMax, silenceMaxS: ui.silenceMaxS });
  const eps = F.clockEps(mob.rttMs);
  const chainFor = ({ k, bytesPerRow }) => {
    const P04 = F.pollBest({ k, T, deltaS, ageMaxS: ui.ageMaxS });
    const Pmob = F.pollMob({ k, T, deltaS, ageMaxS: ui.ageMaxS, eps });
    const mode = F.pollMode({ U, n, P: P04, trafficMax: ui.trafficMBDayMax });
    const q = F.reqPerPoll(mode, n); const o = S.limit.other;
    const lim = F.userLimit({ q, o, P04, Pmob, queueN: mob.queueN, flushMaxS: S.limit.flushMaxS, burstCap: S.limit.burstCap, U });
    const ret = F.retentionDays({ lambda, bytesPerRow, diskGB: p.diskGB, diskShare: S.retention.diskShare, telemetryMaxDays: S.retention.telemetryMaxDays });
    return { k, P04, Pmob, mode, q, o, limit: lim, retention: { ...ret, mb_day: F.rowsDayMB(lambda, bytesPerRow), bytesPerRow } };
  };
  const pwRows = F.SCRYPT.map((s) => ({ ...s, memMiB: F.scryptMemMiB(s.N, s.r), totalMiB: S.pw.C * F.scryptMemMiB(s.N, s.r), burstS: F.loginBurstS(U, S.pw.C, s.tMs) }))
    .map((s) => ({ ...s, fitsMem: s.totalMiB <= S.pw.memBudgetMiB, fitsTime: s.burstS <= S.pw.burstMaxS }));
  const pwPick = F.pwChoice({ C: S.pw.C, memBudgetMiB: S.pw.memBudgetMiB, burstMaxS: S.pw.burstMaxS, U });
  const overrides = S.policy.overrides;
  return {
    S, T, n, U, lambda, ks, k0: ks[0], eps, chainFor,
    pw: { C: S.pw.C, rows: pwRows, pick: pwPick && { ...pwPick, memMiB: F.scryptMemMiB(pwPick.N, pwPick.r), burstS: F.loginBurstS(U, S.pw.C, pwPick.tMs) } },
    login: { window: F.loginWindow(S.login), spray: F.spraySize(S.login) },
    policy: { text: S.policy.text, overrides, expected: F.policyExpected(overrides), changed: F.policyChanged(overrides) },
    tokens: F.tokenChoice({ users: S.login.accounts, ...S.tokens }),
    hook: { ...F.hookChoice({ lambda, ...S.hook }), skewS: S.hook.skewS, delayS: S.hook.delayS, memMB: S.hook.memMB },
    geo: S.geo ? F.geoCell(S.geo) : null,
  };
}

// ---------------- ПР7 ----------------
export async function pr07(variant, p, seed) {
  const Q = await import('./qa-lab.mjs');
  const pyr = Q.pyramid(p);
  const fl = Q.flakyPlan(p, seed);
  const qr = Q.quarantine(p);
  const counts = { range: Q.dataMutants(p).filter((m) => m.group === 'range').length,
    cmdset: Q.dataMutants(p).filter((m) => m.group !== 'range').length, rules: Q.ruleMutants(p).length, logic: Q.LOGIC.length, net: Q.netMutants(p).length, matrix: Q.matrixMutants(p).length };
  return { pyr, rows: pyr.rows, fl, qr, counts, metrics: Q.usedMetrics(p), cost: Q.COST };
}

// ---------------- ПР8 ----------------
export async function pr08(variant, p) {
  const O = await import('./ops-lab.mjs');
  return { slo: O.slo(p), silence: O.silence(p), files: O.opsFiles(p), pairs: O.PAIRS, steps: O.STEP_OPTIONS };
}
