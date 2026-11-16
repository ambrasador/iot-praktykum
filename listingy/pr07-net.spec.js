'use strict';
// Шлях «пристрій → брокер Aedes → приймання → API» для домену D0
// (ПР7, рівень «4»): збережено, відхилено, дублікат QoS 1,
// відмова брокера.
const request = require('supertest');
const mqtt = require('mqtt');
const { makeDb, addDevice } = require('../../testkit');
const { createApp } = require('../../app');
const { createMqttSource } = require('../../mqtt-source');
const { createServer } = require('../../server');
const { createHealthState, trackBroker } = require('../../health');
const { createOpsMetrics } = require('../../ops-metrics');
const { startBroker } = require('../helpers/broker');
const { waitFor } = require('../helpers/wait');

const DEV = 'dev-01';
const ROOT = 'greenhouse';                      // корінь топіка домену
const TOPIC = `${ROOT}/${DEV}/telemetry`;
const state = createHealthState();
let broker; let db; let ingest; let api; let device;

beforeAll(async () => {
  broker = await startBroker();
  db = makeDb();
  addDevice(db, DEV, 'north');
  const ops = createOpsMetrics({ state, defaults: false });
  const source = createMqttSource({ url: broker.url,
    clientId: 'ingest-d0', filter: `${ROOT}/+/telemetry` });
  ingest = createApp({ db, source, observe: ops.recordIngest });
  await ingest.start();
  trackBroker(source.client, state);
  const open = { rate: 1e4, burst: 1e4 };       // ліміти не заважають
  api = createServer({ db, state, ops, sink: { async send() {} },
    limits: { ...open, ingest: open } });
  device = mqtt.connect(broker.url, { clientId: 'sim-d0' });
  await new Promise((resolve) => device.once('connect', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => device.end(false, {}, resolve));
  await ingest.stop();
  await broker.stop();
  db.close();
});

beforeEach(() => {
  for (const t of ['telemetry', 'latest', 'rejected']) {
    db.exec(`DELETE FROM ${t}`);
  }
  Object.assign(ingest.stats,
    { stored: 0, duplicate: 0, rejected: 0 });
});

const publish = (body) => new Promise((resolve, reject) =>
  device.publish(TOPIC, JSON.stringify(body), { qos: 1 },
    (e) => (e ? reject(e) : resolve())));
const latest = async () => (await request(api)
  .get(`/api/v1/devices/${DEV}`).expect(200)).body.latest;

test('temperature 22.5 через брокер видно в API', async () => {
  const ts = new Date().toISOString();
  await publish({ metric: 'temperature', value: 22.5, ts });
  await waitFor(async () => (await latest()).length === 1,
    { what: 'показання в latest' });
  expect((await latest())[0]).toMatchObject(
    { metric: 'temperature', ts, value: 22.5 });
});

test('ec 10.01 (межа 10 + крок 0.01) відхиляється', async () => {
  const ts = new Date().toISOString();
  await publish({ metric: 'ec', value: 10.01, ts });
  await waitFor(() => ingest.stats.rejected === 1,
    { what: 'відхилення' });
  expect(await latest()).toEqual([]);
  expect(db.prepare('SELECT reason FROM rejected').all())
    .toEqual([{ reason: 'out_of_range' }]);
});

test('повтор QoS 1 не створює другого рядка', async () => {
  const body = { metric: 'temperature', value: 22.5,
    ts: new Date().toISOString() };
  await publish(body);
  await publish(body);
  await waitFor(() => ingest.stats.duplicate === 1,
    { what: 'дублікат' });
  const count = db.prepare('SELECT count(*) AS n FROM telemetry');
  expect(count.get().n).toBe(1);
});

test('падіння брокера: /readyz дає 503, потім знову 200', async () => {
  const readyz = async () =>
    (await request(api).get('/readyz')).status;
  expect(await readyz()).toBe(200);
  const { port } = broker;
  await broker.stop();
  await waitFor(async () => (await readyz()) === 503,
    { what: '503 після зупинки брокера' });
  broker = await startBroker(port);
  await waitFor(async () => (await readyz()) === 200,
    { timeoutMs: 8000, what: 'повернення готовності' });
});
