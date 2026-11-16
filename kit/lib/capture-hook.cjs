'use strict';
// Передзавантаження для main.js студента (node -r): записує параметри, з якими створено служби безпеки.
// Так перевірка бачить справжнє підключення профілю, а не лише вміст profile.js
const Module = require('node:module');
const fs = require('node:fs');

const OUT = process.env.SEC_CAPTURE_FILE;
const KEYS = {
  './passwords': { createPasswordService: ['params', 'concurrency', 'maxQueue'] },
  './tokens': { createTokens: ['accessTtlSec', 'ticketTtlSec'] },
  './refresh': { createRefresh: ['ttlSec', 'leewaySec'] },
  './auth': { createAuth: ['limits', 'slots', 'policy'] },
  './webhook-sign': { createVerifier: ['toleranceSec', 'replay'] },
  './server': { createServer: ['limits'] },
};
const pick = (opts, keys) => Object.fromEntries(keys.filter((k) => opts && opts[k] !== undefined).map((k) => [k, opts[k]]));

const load = Module._load;
Module._load = function patched(request, parent) {
  const exp = load.apply(this, arguments);
  const spec = KEYS[request];
  if (spec && OUT && parent && /[\\/]main\.js$/.test(parent.filename ?? '') && !Object.hasOwn(exp, '__captured')) {
    Object.defineProperty(exp, '__captured', { value: true });
    for (const [name, keys] of Object.entries(spec)) {
      const original = exp[name];
      exp[name] = function wrapped(...args) {
        try { fs.appendFileSync(OUT, `${JSON.stringify({ fn: name, opts: pick(args[0], keys) })}\n`); } catch { /* журнал недоступний */ }
        return original.apply(this, args);
      };
    }
  }
  return exp;
};
