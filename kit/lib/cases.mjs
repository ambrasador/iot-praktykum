// Набори допустимих і недопустимих значень за описом параметрів у паспорті (команди, налаштування)
const mid = (lo, hi, int) => (int ? Math.floor((lo + hi) / 2) : Math.round(((lo + hi) / 2) * 100) / 100);

function validValues(spec) {
  if (spec.type === 'bool') return [true, false];
  if (spec.type === 'enum') return [...spec.values];
  const int = spec.type === 'int';
  return [...new Set([spec.min, mid(spec.min, spec.max, int), spec.max])];
}
function invalidValues(spec) {
  if (spec.type === 'bool') return [['«yes»', 'yes'], ['число 1', 1]];
  if (spec.type === 'enum') return [['невідоме значення', 'unknown_value']];
  const out = [[`нижче межі (${spec.min - 1})`, spec.min - 1], [`вище межі (${spec.max + 1})`, spec.max + 1], ['рядок замість числа', String(spec.min)]];
  if (spec.type === 'int') out.push(['дробове', spec.min + 0.5]);
  return out;
}

// Команди: усі параметри «базові» (середні), по одному відхиленню
export function commandCases(cmd) {
  const base = Object.fromEntries(cmd.params.map((s) => [s.key, s.example ?? validValues(s)[Math.min(1, validValues(s).length - 1)]]));
  const valid = [];
  for (const s of cmd.params) for (const v of validValues(s)) valid.push({ name: cmd.name, params: { ...base, [s.key]: v }, why: `${s.key} = ${JSON.stringify(v)}` });
  const invalid = [];
  for (const s of cmd.params) {
    for (const [why, v] of invalidValues(s)) invalid.push({ name: cmd.name, params: { ...base, [s.key]: v }, why: `${s.key}: ${why}` });
    const { [s.key]: _drop, ...rest } = base;
    invalid.push({ name: cmd.name, params: rest, why: `немає параметра ${s.key}` });
  }
  invalid.push({ name: cmd.name, params: { ...base, extra: 1 }, why: 'зайве поле params.extra' });
  invalid.push({ name: cmd.name, params: [], why: 'params — масив' });
  invalid.push({ name: `${cmd.name}_x`, params: base, why: 'невідома команда' });
  if (cmd.rule === 'on_min != off_min') invalid.push({ name: cmd.name, params: { on_min: 600, off_min: 600 }, why: 'on_min = off_min' });
  return { valid, invalid };
}

// Налаштування: окремі ключі
export function settingCases(settings) {
  const valid = settings.map((s) => ({ body: { [s.key]: validValues(s)[Math.min(1, validValues(s).length - 1)] }, why: s.key }));
  const invalid = [];
  for (const s of settings) for (const [why, v] of invalidValues(s)) invalid.push({ body: { [s.key]: v }, why: `${s.key}: ${why}` });
  invalid.push({ body: { no_such_setting: 1 }, why: 'невідомий ключ' });
  return { valid, invalid };
}
