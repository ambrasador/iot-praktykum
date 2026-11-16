// Формули підручника, потрібні практикуму. Нумерація — за розділами підручника.
// Усі функції чисті: ті самі аргументи дають той самий результат.

export const SECONDS_PER_YEAR = 31_536_000;            // 365 діб
export const ROW_BYTES = 97.2;                         // розмір рядка telemetry разом з індексом, байт (п. 1.3)
export const HEADROOM = 3;                             // запас: λ_peak ≤ λ_max / 3 (формула 1.4)

// (1.1) середня інтенсивність, рядків за секунду
export const lambdaAvg = (N, m, T) => (N * m) / T;

// Піковий квантиль Пуассона: найменше k, для якого P(X ≤ k) ≥ p (п. 1.3, пристрої звітують у випадкові миті).
// Для λ > 200 точну суму замінює розклад Корніша — Фішера (похибка не більша за одиницю)
const Z999 = 3.0902323061678132;
export function poissonQuantile(lambda, p = 0.999) {
  if (lambda > 200) {
    const z = Math.abs(p - 0.999) < 1e-12 ? Z999 : Math.sqrt(2) * erfinv(2 * p - 1);
    return Math.ceil(lambda + z * Math.sqrt(lambda) + (z * z - 1) / 6);
  }
  let k = 0;
  let pmf = Math.exp(-lambda);
  let cdf = pmf;
  while (cdf < p) { k += 1; pmf *= lambda / k; cdf += pmf; }
  return k;
}
function erfinv(x) {                       // наближення Вінітцкі, достатнє для квантилів
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
}

// Піковий режим: частка f пристроїв надсилає по b рядків протягом τ секунд, решта звітує рівномірно
export const burstPeak = ({ N, m, T, f, tau, b }) =>
  (f * N * b) / tau + (1 - f) * lambdaAvg(N, m, T);

// λ_peak за паспортом навантаження
export function lambdaPeak(load) {
  const avg = lambdaAvg(load.N, load.m, load.T);
  if (load.model === 'poisson') return poissonQuantile(avg, 0.999);
  if (load.model === 'burst') return burstPeak(load);
  throw new Error(`невідома модель навантаження: ${load.model}`);
}

// (1.3) річний обсяг: рядків і гігабайт (1 ГБ = 10^9 байт)
export const rowsPerYear = (avg) => avg * SECONDS_PER_YEAR;
export const gbPerYear = (avg, rowBytes = ROW_BYTES) => (rowsPerYear(avg) * rowBytes) / 1e9;

// Виміряна пропускна здатність бази (табл. 1.1, рядків за секунду): s = 1 та s = 500
// і коефіцієнт повного конвеєра брокер → застосунок → SQLite (виміряно 2 600 і 9 800)
export const MODES = {
  'wal-full':   { label: 'WAL + synchronous=FULL',   l1: 3300,  l500: 27000, pipe1: 2600, durable: true },
  'wal-normal': { label: 'WAL + synchronous=NORMAL', l1: 14000, l500: 28000, pipe1: 9800, durable: false },
};

// Модель λ(s) = s / (c + s·u) (формула 1.5): c і u знаходять із двох точок s = 1 та s = 500
export function fitCU(l1, l500) {
  const t1 = 1 / l1;                       // c + u, с
  const t500 = 500 / l500;                 // c + 500·u, с
  const u = (t500 - t1) / 499;
  return { c: t1 - u, u };
}
export const throughput = ({ c, u }, s) => s / (c + s * u);

// Ємність конвеєра в рядках за секунду для транзакції з s рядків
export function pipelineCapacity(modeId, s = 1) {
  const m = MODES[modeId];
  const eta = m.pipe1 / m.l1;              // частка, яку лишає розбір MQTT і JSON
  return eta * throughput(fitCU(m.l1, m.l500), s);
}

export const allowedPeak = (capacity) => capacity / HEADROOM;
export const headroomShare = (peak, capacity) => peak / allowedPeak(capacity);   // < 1 — умова виконана

// Час до переповнення черги брокера: t = Q / (λ_peak − λ_max) (п. 1.4.5); Infinity, якщо черга не росте
export const overflowSeconds = (peak, lmax, queueLimit = 1000) =>
  peak > lmax ? queueLimit / (peak - lmax) : Infinity;

// Мінімальне вікно розсіювання звітів τ', за якого пік вкладається в запас
export function minJitterWindow({ N, m, T, f, b }, capacity) {
  const free = allowedPeak(capacity) - (1 - f) * lambdaAvg(N, m, T);
  return free > 0 ? (f * N * b) / free : Infinity;
}

// Найбільше N, за якого умова запасу ще виконується (пошук навпіл за формулою піка)
export function maxDevices(load, capacity) {
  const limit = allowedPeak(capacity);
  let lo = 1, hi = 1;
  while (lambdaPeak({ ...load, N: hi }) <= limit && hi < 1e9) hi *= 2;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (lambdaPeak({ ...load, N: mid }) <= limit) lo = mid; else hi = mid;
  }
  return lo;
}

// (1.9) опитування проти push: R_poll = U / p; допустимо, якщо R_poll ≤ R_read / 3
export const R_READ = 4000;
export const pollRate = (U, p) => U / p;
export const pollShare = (U, p, rRead = R_READ) => pollRate(U, p) / (rRead / HEADROOM);

// Округлення для друку
export const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------- ПР3: канал реального часу (розділ 3) ----------------
// Сталі виміряні в розділі 3 (табл. 3.1, п. 3.7, п. 3.8) на машині з двома vCPU
export const RT = {
  eta: 0.5,                                     // частка ядра для розсилання (формула 3.2)
  C: 400,                                       // робоча швидкість прийому підключень, 1/с (п. 3.7.6)
  g: { sio: 17.6, sse: 25.8 },                  // мкс на пару «кадр — отримувач» (1 000 отримувачів)
  m: { sio: 15, sse: 17 },                      // КБ резидентної пам'яті на з'єднання (1 МБ = 1024 КБ, як у прикладі підручника)
  idle61: { sio: 20, sse: 104 },                // байтів за 61 с простою
  frame: { sio: (w) => 61 + 68.5 * w, sse: (w) => 142.5 * w },   // байтів на кадр із w вимірюваннями
  poll: { empty: 762, perReading: 123 },        // порожній запит; байтів на вимірювання у відповіді
  defaults: { b: 1, c: 30, sseRetry: 3 },       // типова політика: контролер (client/backoff.js) і retry SSE за замовчуванням
};
const DAY_S = 86400;

// Кадрів за секунду на одного клієнта: n пристроїв у кімнаті звітують раз на T секунд, кадр = звіт одного пристрою
export const frameRate = (n, T) => n / T;

// Трафік клієнта за добу, байтів (усталений режим без обривів)
export function bytesPerDay({ n, m, T, L }, transport) {
  const frames = DAY_S * frameRate(n, T);
  const readings = frames * m;
  if (transport === 'poll') return (DAY_S / (L / 1000)) * RT.poll.empty + readings * RT.poll.perReading;
  return frames * RT.frame[transport](m) + (DAY_S / 61) * RT.idle61[transport];
}

// (3.2) ємність за процесором: клієнтів, що встигає обслужити частка η ядра
export const uCpu = (Fcl, transport) => (RT.eta * 1e6) / (Fcl * RT.g[transport]);
// (3.3) ємність за пам'яттю: M у МБ, m у КБ
export const uMem = (M, transport) => (M * 1024) / RT.m[transport];
// (3.4) частка клієнтів, що підключаються за секунду: Socket.IO / контролер з параметрами b, c (с)
export const stormShare = (b, c) => Math.max(Math.min(1, 1.5 / b), 2 / c);
export const uStormSio = (b, c) => RT.C / stormShare(b, c);
// SSE: роль b виконує retry (с): пік U/retry (п. 3.7.6)
export const uStormSse = (retry) => RT.C * retry;
export const uStorm = (transport, p) => (transport === 'sio' ? uStormSio(p.b, p.c) : uStormSse(p.retry));

// Правило п. 3.7.6: початкова стеля b ≥ 1,5·U/C, межа c ≥ 2·U/C; для SSE retry ≥ U/C
export const ruleB = (U) => (1.5 * U) / RT.C;
export const ruleC = (U) => (2 * U) / RT.C;
export const ruleRetry = (U) => U / RT.C;

// Найбільший розмір кімнати, за якого процесор ще встигає: n ≤ η·10^6·T / (g·U)
export const roomMax = (T, U, transport) => Math.floor((RT.eta * 1e6 * T) / (RT.g[transport] * U));
// Затримка розсилання однієї події на k отримувачів: k·g (мкс → мс); найбільше k за бюджетом (мс)
export const fanOutMs = (k, transport) => (k * RT.g[transport]) / 1000;
export const kMax = (budgetMs, transport) => Math.floor((budgetMs * 1000) / RT.g[transport]);
// Розвантаження екземпляра під час розгортання: не більш як (N−1)·C/2 клієнтів за секунду (п. 3.8.2)
export const drainRate = (N) => ((N - 1) * RT.C) / 2;
export const drainSeconds = (U, N) => (N < 2 ? Infinity : U / N / drainRate(N));

// ---------------- ПР4: дашборд (розділ 4) ----------------
export const UI = {
  deviceKB: 0.4,            // тіло відповіді /devices/{id}, КБ (п. 4.9)
  pollShareMax: 0.5,        // частка порога R_read / 3, яку картки опитування не мають перевищувати
  rawMin: 24,               // найменше сирих точок у початковому діапазоні (тренд помітний)
  rangeSec: { '1h': 3600, '24h': 86400, '3d': 259200, '7d': 604800, '14d': 1209600, '30d': 2592000 },
  textMin: 4.5, graphMin: 3,
};
export const pFalse = (p, k) => p ** k;                                          // формула 4.1
export const falsePerCardDay = (T, p, k) => (86400 / T) * (1 - p) * p ** k;
export const feasibleK = ({ T, p, cards, falsePerDayMax, silenceMaxS }) => {
  const out = [];
  for (let k = 2; k <= 12; k += 1) {
    if (k * T > silenceMaxS) break;
    if (falsePerCardDay(T, p, k) * cards <= falsePerDayMax) out.push(k);
  }
  return out;
};
export const pollBoundK = (k, T, deltaS) => (k - 1) * T - deltaS;                // P < …  (формула 4.2)
export const pollBoundAge = (T, deltaS, ageMaxS) => ageMaxS - T - deltaS;        // вік здорового показання T + P + δ ≤ ageMax
export function pollBest({ k, T, deltaS, ageMaxS }) {
  const bk = Math.round(pollBoundK(k, T, deltaS) * 1e6) / 1e6;
  const ba = Math.round(pollBoundAge(T, deltaS, ageMaxS) * 1e6) / 1e6;
  return Math.min(Number.isInteger(bk) ? bk - 1 : Math.floor(bk), Math.floor(ba));
}
export const pollLoad = (U, n, P) => (U * n) / P;                                // запитів за секунду
export const pollShareUi = (load) => load / (R_READ / HEADROOM);
export const nMaxPoll = (U, P) => Math.floor((R_READ * P) / (HEADROOM * U));     // формула 4.8
export const trafficMBDay = (n, P) => ((86400 / P) * n * UI.deviceKB) / 1000;
export function pollMode({ U, n, P, trafficMax }) {
  const dev = pollShareUi(pollLoad(U, n, P));
  const grp = pollShareUi(pollLoad(U, 1, P));
  const tr = trafficMBDay(n, P);
  if (dev <= UI.pollShareMax && tr <= trafficMax) return 'per_device';
  if (grp <= UI.pollShareMax && tr <= trafficMax) return 'group';
  return 'stream';
}
// Контраст за WCAG 2.2 (формула 4.3): незалежна від client/color.js реалізація
const lin = (c8) => { const c = c8 / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((u, v) => v - u); return (x + 0.05) / (y + 0.05); };
// Вигляд за класом метрики (таблиця 4.x): агрегат запиту й вигляд на графіку
export const VIEWS = {
  gauge: { agg: 'avg,min,max', chart: 'line+band' },
  state: { agg: 'avg', chart: 'intervals' },
  counter: { agg: 'delta', chart: 'bars' },
  delta: { agg: 'sum', chart: 'bars' },
};

// ---------------- ПР5: мобільний клієнт (розділ 5) ----------------
export const MOB = { writeOverhead: 2, attOverhead: 3, retryM: 10, expirySettingsS: 86400, quotaBaseS: 60, quotaCapS: 32 * 60, baseS: 1, capS: 32, maxAttempts: 5 };
export const bleWrites = (L, mtu) => Math.ceil((L + MOB.writeOverhead) / (mtu - MOB.attOverhead));             // формула 5.3
export const provDeadline = (wifiS, T) => wifiS + T;                                                              // формула 5.4 при найгіршому t_перше = T
export const clockMargin = ({ k, T, P, deltaS }) => k * T - (T + P + deltaS);                                     // запас до хибного «Немає даних»
export const clockBehind = ({ k, T, silenceMaxS }) => silenceMaxS - k * T;                                        // запас запізнення виявлення мовчання
export const clockEps = (rttMs) => 0.5 + rttMs / 2000;                                                            // формула 5.2: |ε| ≤ 0,5 с + RTT / 2
// Q(z): хвіст стандартного нормального розподілу (erfc за Numerical Recipes, відносна похибка ≈ 1,2·10^-7)
export function erfc(x) {
  const z = Math.abs(x); const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
export const Q = (z) => 0.5 * erfc(z / Math.SQRT2);
export function qInv(p) { let lo = 0; let hi = 10; for (let i = 0; i < 80; i += 1) { const mid = (lo + hi) / 2; if (Q(mid) > p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
export const pushAlertsPerDay = (N, h, sigma) => (sigma > 0 ? 1 + N / (2 + 1 / Q(h / sigma)) : 1);              // формула 5.5
export const dupRows = (N, q, m = MOB.retryM) => (N * (1 - q ** m)) / (1 - q);                                    // формула 5.7
export const dupSd = (N, q) => (Math.sqrt(N) * Math.sqrt(q)) / (1 - q);
// Скільки повторів після відмови FCM вміщається в TTL (диспетчер push): пауза 1, 2, 4 … с (429: 60, 120, 240 … с) із джитером [0,5; 1]
export function retriesInTtl(ttlS, quota, jitter) {
  const base = quota ? MOB.quotaBaseS : MOB.baseS; const cap = quota ? MOB.quotaCapS : MOB.capS;
  let t = 0; let n = 0;
  for (let attempt = 1; attempt < MOB.maxAttempts; attempt += 1) {
    const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
    let wait = ceiling * (jitter === 'min' ? 0.5 : 1);
    if (quota) wait = Math.max(wait, MOB.quotaBaseS);
    if (t + wait > ttlS) break;
    t += wait; n += 1;
  }
  return { n, wait_s: t };
}

// ---- ПР5, доповнення: вибір гістерезису за допустимою кількістю повторів, вікно прив'язки, опитування мобільного клієнта ----
const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const readingsPerDay = (T) => Math.floor(86400 / T);
// Умова A ≤ 1 + R: N / (2 + 1/Q) ≤ R ⇒ Q(k) ≤ R / (N − 2R). При R = 1 це 1 / (N − 2), формула 5.8 підручника
export const kMult = (N, R) => qInv(R / (N - 2 * R));
export const hMin = (N, R, sigma) => kMult(N, R) * sigma;
// Вікно прив'язки: за замовчуванням 60 с (20 пауз по 3 с); якщо потрібно більше, але користувач готовий чекати, — збільшене; інакше асинхронно
export function provPlan({ wifiS, T, maxWaitS }) {
  const need = wifiS + T;
  const mode = need <= 60 ? 'default' : need <= maxWaitS ? 'extended' : 'async';
  const deadline = mode === 'default' ? 60 : mode === 'extended' ? need : null;
  return { need, mode, deadline, polls: deadline === null ? null : Math.floor(deadline / 3) + 1 };
}
export const bleLastWrite = (L, mtu) => (L + MOB.writeOverhead) - (bleWrites(L, mtu) - 1) * (mtu - MOB.attOverhead);
export const BLE_EVENT_MS = 30;                           // припущення підручника: один запис на подію зв'язку з інтервалом 30 мс
export function clockVerdict({ skewS, margin, behind }) {
  if (skewS > 0) return skewS > margin ? 'false_gray' : 'ok';       // телефон спішить: вік завищено
  if (skewS < 0) return -skewS > behind ? 'late' : 'ok';             // телефон відстає: мовчання помітне пізніше
  return 'ok';
}
// Найбільший період опитування, що лишає запас годинника: запас ≥ ε, не більше за P з ПР4
export const pollMob = ({ k, T, deltaS, ageMaxS, eps }) => Math.min(
  pollBest({ k, T, deltaS, ageMaxS }),
  Math.floor(r6((k - 1) * T - deltaS - eps)));

// ---------------- ПР6: безпека застосунку (розділ 6) ----------------
// Набори scrypt, яких OWASP вважає рівноцінними за стійкістю, і виміряний час одного хешу (таблиця 6.2 підручника, 2 vCPU)
export const SCRYPT = [
  { id: 'n17', N: 2 ** 17, r: 8, p: 1, tMs: 368.5 },
  { id: 'n16', N: 2 ** 16, r: 8, p: 2, tMs: 332.5 },
  { id: 'n15', N: 2 ** 15, r: 8, p: 3, tMs: 222.8 },
  { id: 'n14', N: 2 ** 14, r: 8, p: 5, tMs: 180.7 },
  { id: 'n13', N: 2 ** 13, r: 8, p: 10, tMs: 169.8 },
];
export const SEC = { refreshRowB: 305, graceDays: 7, hookEntryB: 117.5, pruneRowsPerS: 540_000, pruneBatch: 5000, exchangePerCoreS: 4990, login: { userBurstMin: 3 } };
const MIB = 2 ** 20;
export const scryptMemMiB = (N, r) => (128 * N * r) / MIB;                       // формула 6.1
export const gateCapacity = (C, tMs) => C / (tMs / 1000);                         // формула 6.2: входів за секунду
export const loginBurstS = (U, C, tMs) => U / gateCapacity(C, tMs);               // час, за який вхід пропустить усіх
export const queueWaitS = (Q, C, tMs) => Q / gateCapacity(C, tMs);
// Найбільша пам'ять серед наборів, що вміщаються в бюджет (C одночасних хешів) і в строк входу всіх екранів
export function pwChoice({ C, memBudgetMiB, burstMaxS, U }) {
  const fits = SCRYPT.filter((s) => C * scryptMemMiB(s.N, s.r) <= memBudgetMiB && loginBurstS(U, C, s.tMs) <= burstMaxS);
  return fits.sort((a, b) => scryptMemMiB(b.N, b.r) - scryptMemMiB(a.N, a.r))[0] ?? null;
}
export const loginAttemptsPerDay = (b, r) => b + r * 86400;                       // формула 6.3
// Скільки діб переберуть topN паролів проти одного імені (A спроб на добу)
export const bruteDays = (topN, A) => topN / A;

// Вікна лімітів входу: A = b + r·86400 спроб на добу з одного ключа (формула 6.3)
//  ім'я: нижня межа — законні входи, верхня — час перебору топ-списку паролів проти одного облікового запису
//  адреса: нижня межа — працівники за одним NAT, верхня — час розпилення «кілька паролів × усі акаунти» з однієї адреси
export function loginWindow(lg) {
  return {
    user: { aMin: lg.legitPerDay, aMax: Math.floor(lg.topN / lg.minDays), bMin: SEC.login.userBurstMin },
    ip: { aMin: lg.natUsers * lg.triesPerUserDay, aMax: Math.floor((lg.sprayTop * lg.accounts) / lg.sprayMinDays), bMin: lg.natUsers },
  };
}
export const spraySize = (lg) => lg.sprayTop * lg.accounts;                       // спроб у розпиленні

// Ліміт запитів користувача (кошик токенів): сталий потік двох клієнтів, відкриття застосунку, повторне надсилання черги
export const RATE_MARGIN = 1.5;
export const reqPerPoll = (mode, n) => (mode === 'per_device' ? n : mode === 'group' ? 1 : 0);
export const userRps = ({ q, o, P04, Pmob }) => (q + o) / P04 + (q + o) / Pmob;
export function userLimit({ q, o, P04, Pmob, queueN, flushMaxS, burstCap, U }) {
  const rho = userRps({ q, o, P04, Pmob });
  return {
    rho, rateMin: RATE_MARGIN * rho, rateMax: R_READ / U,
    burstMin: (rate) => Math.max(q + o, Math.ceil(queueN + q + o - rate * flushMaxS)), burstMax: burstCap,
    flushS: (rate, burst) => Math.max(0, queueN + q + o - burst) / rate,
  };
}

// Токени: access живе accessS; refresh — days діб; рядок refresh_tokens триває ще graceDays після спливання
export const TOKEN_TTLS = [300, 600, 900, 1800, 3600];
export const REFRESH_DAYS = [7, 14, 30, 60, 90];
export const refreshDays = ({ offlineMaxDays, absMaxDays }) => REFRESH_DAYS.find((d) => d >= offlineMaxDays && d <= absMaxDays) ?? null;
export const refreshRowsPerUser = (accessS, days) => ((days + SEC.graceDays) * 86400) / accessS;
export const refreshMiB = (users, accessS, days) => (users * refreshRowsPerUser(accessS, days) * SEC.refreshRowB) / MIB;
export function tokenChoice({ users, storageMiB, accessMaxS, offlineMaxDays, absMaxDays }) {
  const days = refreshDays({ offlineMaxDays, absMaxDays });
  const access = days == null ? null : (TOKEN_TTLS.find((t) => t <= accessMaxS && refreshMiB(users, t, days) <= storageMiB) ?? null);
  return { days, access, rows: access && refreshRowsPerUser(access, days), miB: access && refreshMiB(users, access, days) };
}

// Вебхук: допуск, кеш повторів, розмір пакета події (одна доставка = B подій)
export const HOOK_B = [1, 10, 50, 100, 500];
export const hookTol = (skewS, delayS) => Math.min(900, Math.max(30, Math.ceil((skewS + delayS) / 30) * 30));
export const hookEntries = (rho, tolS, skewS) => rho * (2 * tolS + skewS);
export const hookMB = (entries) => (entries * SEC.hookEntryB) / 1e6;
export function hookChoice({ lambda, skewS, delayS, memMB }) {
  const tol = hookTol(skewS, delayS);
  const rows = HOOK_B.map((b) => { const entries = hookEntries(lambda / b, tol, skewS); return { b, rho: lambda / b, entries, mb: hookMB(entries) }; });
  return { tol, rows, b: rows.find((x) => x.mb <= memMB)?.b ?? null };
}

// Строки зберігання: найбільший зі стандартного ряду, що вміщується в частку диска й у межу політики
export const RET_DAYS = [7, 14, 30, 60, 90, 180, 365, 730];
export const rowsDayMB = (lambda, bytesPerRow) => (lambda * 86400 * bytesPerRow) / 1e6;
export const diskDays = ({ lambda, bytesPerRow, diskGB, diskShare }) => Math.floor((diskShare * diskGB * 1e9) / (lambda * 86400 * bytesPerRow));
export function retentionDays({ lambda, bytesPerRow, diskGB, diskShare, telemetryMaxDays }) {
  const byDisk = diskDays({ lambda, bytesPerRow, diskGB, diskShare });
  const cap = Math.min(telemetryMaxDays, byDisk);
  return { byDisk, cap, days: RET_DAYS.filter((d) => d <= cap).at(-1) ?? null };
}

// Комірка сітки координат: кратна 0,005°, довжина меридіанної сторони в [minKm; maxKm]
export const KM_PER_DEG = (6371.0088 * Math.PI) / 180;
export function geoCell({ minCellKm, maxCellKm }) {
  for (let i = 1; i <= 200; i += 1) {
    const deg = Number((i * 0.005).toFixed(3)); const km = deg * KM_PER_DEG;
    if (km >= minCellKm) return km <= maxCellKm ? { deg, km } : null;
  }
  return null;
}

// Базова політика еталона (розділ 6, таблиця дій): від неї відраховують перевизначення варіанта
export const BASE_ACTIONS = {
  'self:read': ['viewer', 'operator', 'admin'], 'push:write': ['viewer', 'operator', 'admin'],
  'device:read': ['viewer', 'operator', 'admin'], 'telemetry:read': ['viewer', 'operator', 'admin'],
  'stream:read': ['viewer', 'operator', 'admin'], 'settings:read': ['viewer', 'operator', 'admin'],
  'settings:write': ['operator', 'admin'], 'command:create': ['operator', 'admin'], 'command:read': ['operator', 'admin'],
  'device:claim': ['operator', 'admin'], 'audit:read': ['admin'], 'ingest:write': [],
};
export const policyExpected = (overrides) => ({ ...BASE_ACTIONS, ...overrides });
export const policyChanged = (overrides) => Object.keys(overrides).filter((a) => JSON.stringify(overrides[a]) !== JSON.stringify(BASE_ACTIONS[a])).sort();

// Форма слова «доба» після числа: родовий відмінок («не менше 1 доби», «до 3 діб», «до 0,02 доби») і знахідний («за 1 добу», «за 3 доби»)
const uaNum = (n) => String(n).replace('.', ',');
export function dobG(n) {
  if (!Number.isInteger(n)) return `${uaNum(n)} доби`;
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'доби' : 'діб'}`;
}
export function dobA(n) {
  if (!Number.isInteger(n)) return `${uaNum(n)} доби`;
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? 'добу' : [2, 3, 4].includes(m10) && ![12, 13, 14].includes(m100) ? 'доби' : 'діб'}`;
}
