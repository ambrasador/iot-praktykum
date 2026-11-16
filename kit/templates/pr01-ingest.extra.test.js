'use strict';
// ПР1, рівень «5»: власні тести меж предметних правил вашого домену.
// Запуск: node --test pr01/ingest.extra.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = process.env.GM_APP || path.join(__dirname, '..', 'greenhouse-monitor');
const { makeDb } = require(path.join(APP, 'testkit'));
const { createIngest } = require(path.join(APP, 'core'));

const NOW = Date.parse('2026-10-15T12:00:00Z');
const ingest = () => createIngest(makeDb(), () => NOW);
const reading = (metric, value, ts = '2026-10-15T11:59:00Z') => ({ deviceId: 'dev-1', metric, value, ts });

test('нижня межа діапазону приймається', () => {
  // TODO: підставте метрику вашого варіанта й її нижню межу з паспорта
  assert.equal(ingest().accept(reading('temperature', -40)), 'stored');
});

// TODO: другий тест — значення поза верхньою межею на найменший крок має дати 'out_of_range'
// TODO: третій тест — повтор тієї самої миті з іншим записом мілісекунд має дати 'duplicate'
