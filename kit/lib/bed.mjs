// Стенд API для ПР2–ПР4: застосунок студента, база з історією варіанта (засіяна через справжнє приймання)
// і «пристрої», що підтверджують команди. Усе в одному процесі, база в пам'яті.
import { appRequire } from './app.mjs';
import { loadPassport } from './passport.mjs';
import { buildHistory, readings, NOW_MS, historyStart } from './series.mjs';

export async function startBed({ variant, seed, port = 0, ackMs = 800, host = '127.0.0.1' }) {
  const P = loadPassport(variant);
  const express = appRequire('express');
  const { makeDb, addDevice } = appRequire('./testkit');
  const { createIngest } = appRequire('./core');
  const { createServer } = appRequire('./server');

  const hist = buildHistory(variant, P, seed);
  const db = makeDb();
  for (const d of hist.devices) addDevice(db, d.id, 'A');

  // Приймання історії: годинник іде разом з рядами, тож «надто старих» і «з майбутнього» вимірювань немає
  let clockMs = NOW_MS;
  const ingest = createIngest(db, () => clockMs);
  const outcome = { stored: 0, duplicate: 0, rejected: 0, reasons: {} };
  let chunk = [];
  let chunkEnd = 0;
  const flush = () => {
    if (!chunk.length) return;
    clockMs = chunkEnd;
    for (const res of ingest.batch(chunk)) {
      if (res === 'stored') outcome.stored += 1;
      else if (res === 'duplicate') outcome.duplicate += 1;
      else { outcome.rejected += 1; outcome.reasons[res] = (outcome.reasons[res] ?? 0) + 1; }
    }
    chunk = [];
  };
  for (const r of readings(hist)) {
    const bucketEnd = (Math.floor(r.ms / 3_600_000) + 1) * 3_600_000;
    if (chunk.length && bucketEnd !== chunkEnd) flush();
    chunkEnd = bucketEnd;
    chunk.push({ deviceId: r.deviceId, metric: r.metric, ts: r.ts, value: r.value });
  }
  flush();

  // «Пристрої»: підтверджують команду через ackMs; пристрій із номером 04 мовчить
  const sent = [];
  let app;
  const sink = {
    async send(deviceId, cmd) {
      sent.push({ at: new Date().toISOString(), device: deviceId, id: cmd.id, name: cmd.name, params: cmd.params });
      if (!deviceId.endsWith('-04')) setTimeout(() => app.commands.ack(cmd.id, true, deviceId), ackMs).unref();
    },
  };
  app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, sink,
    limits: { rate: 1e9, burst: 1e9, ingest: { rate: 1e9, burst: 1e9 } } });
  setInterval(() => app.commands.expireOverdue(), 1000).unref();

  const outer = express();
  outer.get('/__bed/info', (req, res) => res.json({
    variant, seed, domain: P.title,
    from: new Date(historyStart(P)).toISOString(), now: new Date(NOW_MS).toISOString(),
    devices: hist.devices.map((d) => ({ id: d.id, kind: d.kind, metrics: Object.keys(d.rows) })),
  }));
  outer.get('/__bed/sent', (req, res) => res.json(sent));
  outer.use(app);
  const server = await new Promise((resolve, reject) => {
    const s = outer.listen(port, host);
    s.once('listening', () => resolve(s));
    s.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `порт ${port} зайнятий: зупиніть попередній стенд (Ctrl+C) або вкажіть --port` : e.message)));
  });
  const url = `http://${host}:${server.address().port}`;
  return { url, server, db, hist, outcome, sent, app, close: () => new Promise((r) => server.close(r)) };
}
