'use strict';
// Межові значення команд і налаштувань домену D0 (ПР7, рівень «3»).
// Числовий параметр: перше недопустиме знизу, мінімум, максимум, перше
// недопустиме зверху; крок — розрізнення параметра (для цілого — 1).
const { COMMANDS } = require('../../commands');
const { validateSettings } = require('../../settings');

// Змінюється один параметр, решта лишається допустимою (base)
const vary = (base, key, rows) =>
  rows.map(([v, ok]) => [{ ...base, [key]: v }, ok]);

describe('команда set_fan', () => {
  const base = { speed_pct: 50 };
  test.each([
    ...vary(base, 'speed_pct', [[-1, false], [0, true],
      [100, true], [101, false]]),
  ])('%j → %s', (params, ok) => {
    expect(Boolean(COMMANDS.set_fan(params))).toBe(ok);
  });
});

describe('налаштування ec_max', () => {
  test.each([[0.4, false], [0.5, true], [8, true], [8.1, false]])(
    'ec_max %f → допустимо: %s', (ec_max, ok) => {
      expect(validateSettings({ ec_max })).toHaveLength(ok ? 0 : 1);
    });
});
