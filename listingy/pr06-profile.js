'use strict';
// Профіль безпеки домену D0: усі числа розділу 6 в одному місці.
// Служби читають їх через securityOptions, тести охороняють кожне число
const { ACTIONS } = require('./policy');

const PROFILE_D0 = {
  password: { N: 32768, r: 8, p: 3, concurrency: 2 },
  login: {
    user: { rate: 0.00584, burst: 5 },
    ip: { rate: 0.0579, burst: 8 },
  },
  // нижче - значення еталона, їх замінюють кроки 9-11 і 13
  limit: { rate: 1, burst: 10, ingest: { rate: 100, burst: 200 } },
  tokens: { accessTtlSec: 900, refreshTtlSec: 2592000 },
  hook: { toleranceSec: 300, batch: 1 },
  retention: {
    telemetry: 365, audit_log: 365, rejected: 30, push_tokens: 60,
  },
  policy: {                                  // лише змінені дії
    'device:claim': ['admin'],
  },
};

const active = () => PROFILE_D0;

function securityOptions(profile = active()) {
  const { password: pw, login, limit, tokens, hook, policy } = profile;
  return {
    passwords: {
      params: { N: pw.N, r: pw.r, p: pw.p },
      concurrency: pw.concurrency,
    },
    tokens: { accessTtlSec: tokens.accessTtlSec },
    refresh: { ttlSec: tokens.refreshTtlSec },
    auth: { limits: login, policy: { ...ACTIONS, ...policy } },
    verifier: { toleranceSec: hook.toleranceSec },
    api: { limits: limit },
  };
}

module.exports = { PROFILE_D0, active, securityOptions };
