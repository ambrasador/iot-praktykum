'use strict';
// Діапазони метрик D0 (ПР7, рівень «3»): на кожній межі — останнє
// допустиме й перше недопустиме значення; крок — 10^(−знаків).
const { makeDb, addDevice } = require('../../testkit');
const { createIngest } = require('../../core');

// [метрика, нижня, верхня межа, крок]: node kit/tools/qa-inputs.mjs
const RANGES = [
  ['temperature', -40, 85, 0.1], ['humidity', 0, 100, 0.1],
  ['soil_moisture', 0, 100, 0.1], ['ec', 0, 10, 0.01],
];
const r = (x) => Number(x.toFixed(2));      // без «хвостів» 0.1 + 0.2
const ROWS = RANGES.flatMap(([m, lo, hi, st]) => [
  [m, r(lo - st), 'out_of_range'], [m, lo, 'stored'],
  [m, hi, 'stored'], [m, r(hi + st), 'out_of_range'],
]);

const NOW = Date.parse('2026-11-12T12:00:00Z');
let db; let ingest; let n;
beforeEach(() => {
  db = makeDb(); addDevice(db, 'dev-01');
  ingest = createIngest(db, () => NOW); n = 0;
});
afterEach(() => db.close());

test.each(ROWS)('%s, значення %f → %s', (metric, value, expected) => {
  const ts = new Date(NOW - (++n) * 1000).toISOString();   // різні ts
  const got = ingest.accept({ deviceId: 'dev-01', metric, value, ts });
  expect(got).toBe(expected);
});
