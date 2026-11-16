'use strict';
// Правила домену D0 (ПР7, рівень «4»): рівні з гістерезисом і епізоди.
const { nextLevel, RULES_D0 } = require('../../push');
const { findViolations } = require('../../alerts');

// Вісім рядків на правило: [поточний рівень, значення, очікуваний]
// 1–2 межа warn; 3–4 межа crit; 5–6 вихід із warning (межа warn ± h);
// 7–8 вихід із critical: 8-й рядок знімає critical, але не warning
const TABLES = {
  soil_moisture: [                  // lt, warn 33, crit 28, h 6.5
    ['normal', 33, 'normal'], ['normal', 32.9, 'warning'],
    ['normal', 28, 'warning'], ['normal', 27.9, 'critical'],
    ['warning', 39.4, 'warning'], ['warning', 39.5, 'normal'],
    ['critical', 34.4, 'critical'], ['critical', 34.5, 'warning'],
  ],
  temperature: [                    // gt, warn 32, crit 35, h 1
    ['normal', 32, 'normal'], ['normal', 32.1, 'warning'],
    ['normal', 35, 'warning'], ['normal', 35.1, 'critical'],
    ['warning', 31.1, 'warning'], ['warning', 31, 'normal'],
    ['critical', 34.1, 'critical'], ['critical', 32, 'warning'],
  ],
};

const CASES = Object.entries(TABLES);
describe.each(CASES)('nextLevel: %s', (metric, rows) => {
  const rule = RULES_D0.get(metric);
  test.each(rows)('з рівня %s значення %f дає %s', (cur, v, want) => {
    expect(nextLevel(cur, v, rule)).toBe(want);
  });
});

// Епізоди soil_moisture: правило ПР2, період T = 60 с, maxGap = 3T
const T = 60_000;
const rule = { op: 'lt', threshold: 28, hysteresis: 2,
  minDurationMs: 900_000, maxGapMs: 3 * T };
const BAD = 27.8;                   // поріг − 2 кроки розрізнення
const GOOD = 30.2;                  // поріг + h + 2 кроки
const bad = (n) => Array.from({ length: n },
  (_, i) => ({ ms: i * T, value: BAD }));       // n показань, крок T
const at = (ms, value) => ({ ms, value });
const run = (rows) => findViolations(rows, rule);

describe('findViolations: soil_moisture', () => {
  test('епізод рівно minDuration повідомляється', () => {
    expect(run([...bad(15), at(900_000, GOOD)])).toMatchObject(
      [{ startMs: 0, durationMs: 900_000, endedBy: 'recovered' }]);
  });
  test('епізод на секунду коротший не повідомляється', () => {
    expect(run([...bad(15), at(899_000, GOOD)])).toEqual([]);
  });
  test('поріг + h закриває епізод, на крок менше — ні', () => {
    const rows = [...bad(15), at(900_000, 29.9), at(960_000, BAD),
      at(1_020_000, 30)];
    expect(run(rows)).toMatchObject(
      [{ endMs: 1_020_000, samples: 17 }]);
  });
  test('розрив рівно 3T не закриває епізод', () => {
    const rows = [...bad(15), at(1_020_000, BAD), at(1_080_000, GOOD)];
    expect(run(rows)).toMatchObject([{ startMs: 0, samples: 16 }]);
  });
  test('розрив на секунду довший закриває епізод', () => {
    const rows = [...bad(15), at(1_021_000, BAD), at(1_081_000, GOOD)];
    expect(run(rows)).toEqual([]);
  });
  test('екстремум — найгірше значення епізоду', () => {
    const rows = [...bad(15), at(900_000, 27.7), at(960_000, BAD),
      at(1_020_000, GOOD)];
    expect(run(rows)).toMatchObject([{ extreme: 27.7 }]);
  });
});
