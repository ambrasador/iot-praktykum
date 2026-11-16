// pr06/calc.mjs: розрахунки ПР6 (формули 6.1-6.3 і розділ 6 підручника)
// Запуск з кореня практикуму: node pr06/calc.mjs [рівень], типово 3
import { readFileSync } from 'node:fs';

const J = JSON.parse(readFileSync('track.json', 'utf8'));
const level = Number(process.argv[2] ?? 3);
const P = {                                   // дані варіанта: додатки А, Б
  C: 2, memMiB: 100, burstMaxS: 5, U: 20,     // пароль
  topN: 1000, minDays: 1, legit: 20,          // вхід за ім'ям
  nat: 4, tries: 5, accounts: 20,             // вхід за адресою
  sprayTop: 10, sprayMinDays: 0.02,
  user: { b: 5, r: 0.00584 },                 // вибрані ліміти входу
  ip: { b: 8, r: 0.0579 },
  q: 40, o: 3, queueN: 50, flushMaxS: 30,     // рівень 4: ліміт запитів
  burstCap: 200, limit: { rate: 2, burst: 48 },
  accessMaxS: 900, storageMiB: 50,            // токени
  offlineDays: 20, absDays: 90,
  skewS: 60, delayS: 120, hookMB: 2,          // вебхук
  diskGB: 120, diskShare: 0.5, maxDays: 365,  // рівень 5: зберігання
  geoKm: null,                                // { min, max } для геоданих
};
const P04 = J.pr04.poll_s, Pmob = J.pr05.clock.poll_s;
const lambda = J.pr01.lambda_avg, bpr = J.pr02?.bytes_per_row;
const c = (x, d = 1) => x.toFixed(d).replace('.', ',');
const g = (x) => String(Number(x.toPrecision(3))).replace('.', ',');
const MIB = 2 ** 20;

// Пароль: пам'ять C·M, M = 128·N·r (6.1); вхід усіх U: U·t/C (6.2)
const sets = [[17, 1, 368.5], [16, 2, 332.5], [15, 3, 222.8],
  [14, 5, 180.7], [13, 10, 169.8]];           // log2 N, p, мс (табл. 6.2)
for (const [e, p, t] of sets) {
  const mem = (P.C * 128 * 2 ** e * 8) / MIB;
  const burst = (P.U * t) / 1000 / P.C;
  const ok = mem <= P.memMiB && burst <= P.burstMaxS;
  console.log(`n${e}: N=2^${e} r=8 p=${p}: ${c(mem, 0)} МіБ,`,
    `вхід ${c(burst, 2)} с`, ok ? 'підходить' : 'ні');
}
// Вхід (6.3): A = b + r·86400 спроб на добу
const A = ({ b, r }) => b + r * 86400;
const spray = P.sprayTop * P.accounts;
const win = (lo, hi, b) => `A від ${lo} до ${hi}, b не менше ${b}`;
console.log(`Ім'я: ${win(P.legit, P.topN / P.minDays, 3)}`);
const sprayA = spray / P.sprayMinDays;
console.log(`Адреса: ${win(P.nat * P.tries, sprayA, P.nat)}`);
console.log(`A ім'я ${c(A(P.user))}, перебір ${g(P.topN / A(P.user))} діб`);
console.log(`A адреса ${c(A(P.ip))}, розпилення ${g(spray / A(P.ip))} діб`);

if (level >= 4) {
  const qo = P.q + P.o, { rate, burst } = P.limit;
  const rho = qo / P04 + qo / Pmob;           // запитів за секунду
  const bMin = Math.max(qo, Math.ceil(P.queueN + qo - rate * P.flushMaxS));
  console.log(`rho ${c(rho, 4)}; rate від ${c(1.5 * rho, 3)}`,
    `до ${4000 / P.U}; burst від ${bMin} до ${P.burstCap}`);
  console.log(`rate ${rate}, burst ${burst}: черга за`,
    `${c(Math.max(0, P.queueN + qo - burst) / rate, 2)} с`);
  const days = [7, 14, 30, 60, 90].find((d) => d >= P.offlineDays
    && d <= P.absDays);
  for (const t of [300, 600, 900, 1800, 3600]) {
    if (t > P.accessMaxS) break;
    const rows = ((days + 7) * 86400) / t;    // 7 діб до прибирання
    const mib = (P.accounts * rows * 305) / MIB;
    console.log(`access ${t} с, refresh ${days} діб: рядків ${rows},`,
      `${c(mib, 2)} МіБ`, mib <= P.storageMiB ? 'вміщується' : 'ні');
  }
  const tol = Math.ceil((P.skewS + P.delayS) / 30) * 30;
  for (const B of [1, 10, 50, 100, 500]) {
    const r = lambda / B, n = r * (2 * tol + P.skewS);
    console.log(`допуск ${tol} с, B=${B}: ${c(r, 4)} дост./с, записів`,
      `${c(n)}, ${c((n * 117.5) / 1e6, 4)} МБ`);
  }
}
if (level >= 5) {
  const perDay = lambda * 86400 * bpr;
  const byDisk = Math.floor((P.diskShare * P.diskGB * 1e9) / perDay);
  const cap = Math.min(P.maxDays, byDisk);
  const ladder = [7, 14, 30, 60, 90, 180, 365, 730];
  console.log(`диск: ${c(perDay / 1e6)} МБ на добу, ${byDisk} діб;`,
    `telemetry ${ladder.filter((d) => d <= cap).at(-1)} діб`);
  if (P.geoKm) {                              // крок сітки кратний 0,005°
    const deg = Math.ceil(P.geoKm.min / 111.195 / 0.005 - 1e-9) * 0.005;
    console.log(`комірка ${c(deg, 3)}°, ${c(deg * 111.195, 3)} км`);
  }
}
