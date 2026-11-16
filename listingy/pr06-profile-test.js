'use strict';
// Вимоги ПР6 як твердження: число в profile.js, що їх порушує, зупиняє тест
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILE_D0: P } = require('./profile');

const REQ = {                                // дані варіанта: додатки А, Б
  U: 20, C: 2, memBudgetMiB: 100, burstMaxS: 5,           // пароль
  topN: 1000, minDays: 1, legitPerDay: 20,                // вхід за ім'ям
  natUsers: 4, tries: 5,                                  // за адресою
  sprayTotal: 200, sprayMinDays: 0.02,
};
// Рівноцінні набори scrypt (табл. 6.2): N -> { r, p, мс на хеш }
const SETS = {
  131072: { r: 8, p: 1, t: 368.5 }, 65536: { r: 8, p: 2, t: 332.5 },
  32768: { r: 8, p: 3, t: 222.8 }, 16384: { r: 8, p: 5, t: 180.7 },
  8192: { r: 8, p: 10, t: 169.8 },
};
const perDay = (limit) => limit.burst + limit.rate * 86400;

test('пароль: набір з таблиці, пам\'ять і час входу всіх у межах', () => {
  const set = SETS[P.password.N];
  assert.ok(set && set.r === P.password.r && set.p === P.password.p,
    'N, r, p не збігаються з жодним набором таблиці');
  assert.equal(P.password.concurrency, REQ.C);
  const memMiB = (REQ.C * 128 * P.password.N * P.password.r) / 2 ** 20;
  assert.ok(memMiB <= REQ.memBudgetMiB, `пам'ять ${memMiB} МіБ`);
  const burstS = REQ.U / (REQ.C / (set.t / 1000));
  assert.ok(burstS <= REQ.burstMaxS, `вхід усіх за ${burstS.toFixed(1)} с`);
});

test('ліміти входу: спроб на добу між потребою і стійкістю', () => {
  const user = perDay(P.login.user), ip = perDay(P.login.ip);
  assert.ok(user >= REQ.legitPerDay && user <= REQ.topN / REQ.minDays);
  assert.ok(P.login.user.burst >= 3);
  assert.ok(ip >= REQ.natUsers * REQ.tries);
  assert.ok(ip <= REQ.sprayTotal / REQ.sprayMinDays);
  assert.ok(P.login.ip.burst >= REQ.natUsers);
});

// ---------------- рівень «4» ----------------
Object.assign(REQ, {
  rho: 0.966292, q: 40, o: 3, queueN: 50, flushMaxS: 30,  // ліміт запитів
  burstCap: 200, readMax: 4000,
  accounts: 20, storageMiB: 50, accessMaxS: 900,          // токени
  offlineMaxDays: 20, absMaxDays: 90,
  skewS: 60, delayS: 120, lambda: 13.33, hookMemMB: 2,    // вебхук
});

test('ліміт запитів: потік, відкриття застосунку, черга дій', () => {
  const { rate, burst } = P.limit;
  assert.ok(rate >= 1.5 * REQ.rho, `rate ${rate} менший за 1,5 * rho`);
  assert.ok(rate <= REQ.readMax / REQ.U);
  assert.ok(burst >= REQ.q + REQ.o && burst <= REQ.burstCap);
  const left = Math.max(0, REQ.queueN + REQ.q + REQ.o - burst);
  assert.ok(left / rate <= REQ.flushMaxS, 'черга не встигає');
});

test('токени: access, refresh і таблиця refresh_tokens у межах', () => {
  const { accessTtlSec: a, refreshTtlSec: r } = P.tokens;
  assert.ok(a <= REQ.accessMaxS);
  assert.ok(r >= REQ.offlineMaxDays * 86400 && r <= REQ.absMaxDays * 86400);
  const rows = ((r / 86400 + 7) * 86400) / a;
  assert.ok((REQ.accounts * rows * 305) / 2 ** 20 <= REQ.storageMiB);
});

test('вебхук: допуск покриває розсинхрон і затримку, кеш у бюджеті', () => {
  const { toleranceSec: tol, batch } = P.hook;
  assert.ok(tol >= REQ.skewS + REQ.delayS, 'допуск замалий');
  assert.ok(tol % 30 === 0 && tol >= 30 && tol <= 900);
  const entries = (REQ.lambda / batch) * (2 * tol + REQ.skewS);
  assert.ok((entries * 117.5) / 1e6 <= REQ.hookMemMB, 'кеш понад бюджет');
});

// ---------------- рівень «5» ----------------
Object.assign(REQ, {
  telemetryMaxDays: 365, byDisk: 1110, auditDays: 365, rejectedDays: 30,
});

test('строки зберігання: telemetry у межах політики й диска', () => {
  const d = P.retention;
  assert.ok(d.telemetry <= REQ.telemetryMaxDays);
  assert.ok(d.telemetry <= REQ.byDisk, 'не вміщується на диск');
  assert.equal(d.audit_log, REQ.auditDays);
  assert.equal(d.rejected, REQ.rejectedDays);
  assert.ok(d.push_tokens <= P.tokens.refreshTtlSec / 86400);
});
