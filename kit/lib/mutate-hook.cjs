'use strict';
// Мутації для перевірки тестів студента (NODE_OPTIONS=--require): після завантаження profile.js змінює числа профілю,
// після policy.js — рядки ACTIONS. Перевірка вимагає, щоб тести таку зміну помітили
const Module = require('node:module');

const spec = JSON.parse(process.env.SEC_MUTATE || '{}');
const setPath = (o, p, v) => { const keys = p.split('.'); let t = o; for (const k of keys.slice(0, -1)) t = t[k]; t[keys.at(-1)] = v; };
const load = Module._load;
Module._load = function patched(request) {
  const exp = load.apply(this, arguments);
  if (/(^|[\\/])profile(\.js)?$/.test(request) && spec.profile && !Object.hasOwn(exp, '__mutated')) {
    Object.defineProperty(exp, '__mutated', { value: true });
    const obj = exp[`PROFILE_${spec.code}`];
    for (const [p, v] of Object.entries(spec.profile)) setPath(obj, p, v);
  }
  if (/(^|[\\/])policy(\.js)?$/.test(request) && spec.policy && !Object.hasOwn(exp, '__mutated')) {
    Object.defineProperty(exp, '__mutated', { value: true });
    for (const [a, roles] of Object.entries(spec.policy)) exp.ACTIONS[a] = roles;
  }
  return exp;
};
