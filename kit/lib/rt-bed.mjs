// Стенд ПР3: справжній main.js студента, брокер Aedes, пристрої-імітатори та клієнти Socket.IO й SSE.
// Посередині прогону застосунок перезапускають (як під час розгортання); після нього клієнти
// узгоджують ряд через REST. Результат: пропуски, зайві точки, кадри на звіт, затримка, retry SSE, команда через брокер.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, appRequire } from './app.mjs';
import { loadPassport, metricTable } from './passport.mjs';
import { deviceList } from './series.mjs';
import { commandCases } from './cases.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// GET з окремою локальною адресою клієнта (127.0.0.x): ліміт запитів застосунку рахується за IP,
// тож кожен «користувач» має власне відро. На 429 чекаємо Retry-After, як це робить контролер
function getJson(base, p, { from = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, localAddress: from }, (r) => {
      let text = ''; r.setEncoding('utf8');
      r.on('data', (c) => { text += c; });
      r.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* не JSON */ }
        resolve({ status: r.statusCode, body, retryAfter: Number(r.headers['retry-after'] ?? 0) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
async function getJsonPatient(base, p, opts) {
  for (let i = 0; i < 10; i++) {
    const r = await getJson(base, p, opts);
    if (r.status !== 429) return r;
    await sleep(Math.max(300, (r.retryAfter || 1) * 1000));
  }
  return { status: 429, body: null };
}

// Параметри прогону. period — інтервал між звітами, повинен бути більшим за spread + window
export function plan(P, rtEnv) {
  const spread = P.rt.spreadMs;
  const windowMs = Number(rtEnv.RT_WINDOW_MS ?? 100);
  return { spread, windowMs, period: Math.max(700, spread + windowMs + 350), reports: 12, restartAt: 5 };
}

export async function runSmoke({ variant, rtEnv = {}, log = () => {} }) {
  const P = loadPassport(variant);
  const root = P.topicRoot;
  const table = metricTable(P);
  const devices = deviceList(variant, P);
  const pl = plan(P, rtEnv);
  const res = { plan: pl, errors: [], logTail: [], env: rtEnv };

  const mqtt = appRequire('mqtt');
  const { Aedes } = appRequire('aedes');
  const Database = appRequire('better-sqlite3');
  const { io: ioClient } = appRequire('socket.io-client');
  const { setupSchema } = appRequire('./migrate');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-smoke-'));
  const dbFile = path.join(tmp, 'rt.db');
  const dbw = new Database(dbFile);
  dbw.pragma('journal_mode = WAL');
  setupSchema(dbw, ['schema.sql', 'schema-api.sql'], { log: () => {} });
  const addDev = dbw.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)');
  for (const d of devices) addDev.run(d.id, `Вузол ${d.id}`, 'Z1', '2026-01-01T00:00:00.000Z');
  dbw.close();

  const aedes = await Aedes.createBroker();
  const tcp = net.createServer(aedes.handle);
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  const mqttUrl = `mqtt://127.0.0.1:${tcp.address().port}`;
  const httpPort = await freePort();
  const base = `http://127.0.0.1:${httpPort}`;

  let child = null;
  const spawnApp = () => new Promise((resolve) => {
    const env = { ...process.env, MQTT_URL: mqttUrl, DB_FILE: dbFile, PORT: String(httpPort), AUTH_DISABLED: '1', LOG_LEVEL: 'info', ...rtEnv };
    const c = spawn(process.execPath, ['main.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    const push = (d) => { res.logTail.push(...String(d).split('\n').filter(Boolean)); res.logTail = res.logTail.slice(-25); };
    c.stdout.on('data', push); c.stderr.on('data', push);
    let done = false;
    c.once('exit', (code) => { if (!done) { done = true; resolve({ ok: false, why: `main.js завершився з кодом ${code}` }); } });
    (async () => {
      const t0 = Date.now();
      while (!done && Date.now() - t0 < 25_000) {
        try { const r = await fetch(`${base}/readyz`); if (r.status === 200) { done = true; return resolve({ ok: true, ms: Date.now() - t0 }); } } catch { /* ще не слухає */ }
        await sleep(150);
      }
      if (!done) { done = true; resolve({ ok: false, why: 'main.js не став готовим за 25 с (/readyz)' }); }
    })();
  });
  const stopApp = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });

  const clients = [];
  let device = null;
  const cleanup = async () => {
    for (const c of clients) { try { c.stop(); } catch { /* закрито */ } }
    try { device?.end(true); } catch { /* закрито */ }
    await stopApp();
    await new Promise((r) => aedes.close(r)).catch(() => {});
    tcp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    const boot = await spawnApp();
    if (!boot.ok) { res.errors.push(`запуск main.js: ${boot.why}`); res.fatal = true; return res; }
    res.boot_ms = boot.ms;

    // ---- спостереження за доставкою ----
    const pubAt = new Map();        // ключ → мс публікації
    const reportOf = new Map();     // ключ → номер звіту
    const key = (d, m, ts) => `${d}|${m}|${ts}`;
    const t0 = Date.now();
    const runFrom = new Date(t0 - 1000).toISOString();

    async function resync(rec, devs) {
      const from = rec.ip;
      const to = new Date(Date.now() + 60_000).toISOString();
      for (const dev of devs) for (const metric of dev.metrics) {
        let cursor = null;
        for (let page = 0; page < 20; page++) {
          const q = `/api/v1/telemetry?device=${dev.id}&metric=${metric}&from=${encodeURIComponent(rec.cut.get(`${dev.id}|${metric}`) ?? runFrom)}&to=${encodeURIComponent(to)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          let r;
          try { r = await getJsonPatient(base, q, { from }); } catch { return false; }
          if (r.status !== 200) { rec.restErrors += 1; break; }
          for (const row of r.body.data) rec.add(key(dev.id, metric, row.ts), 'rest');
          cursor = r.body.next;
          if (!cursor) break;
        }
      }
      return true;
    }
    let ipCounter = 0;
    const newRec = (name, devs) => {
      const rec = { name, devs, ip: `127.0.0.${10 + (ipCounter++)}`, keys: new Set(), dups: 0, frames: [], reconnects: 0, restErrors: 0, resets: 0, retry: [], connected: false,
        last: new Map(), cut: new Map(),
        add(k, via) {
          if (this.keys.has(k)) this.dups += 1; else this.keys.add(k);
          const [d, m, ts] = k.split('|');
          if (!this.last.has(`${d}|${m}`) || ts > this.last.get(`${d}|${m}`)) this.last.set(`${d}|${m}`, ts);
        } };
      return rec;
    };

    // Socket.IO: кімната зони, узгодження після кожного (пере)підключення
    for (let i = 0; i < 4; i++) {
      const rec = newRec(`sio-${i}`, devices);
      const socket = ioClient(base, { transports: ['websocket'], localAddress: rec.ip, reconnectionDelay: 200, reconnectionDelayMax: 800, randomizationFactor: 0.2 });
      rec.stop = () => socket.close();
      socket.on('connect', () => {
        rec.connected = false;
        socket.emit('subscribe', { zone: 'Z1' }, async (ack) => {
          if (!ack?.ok) { rec.errors = (rec.errors ?? 0) + 1; return; }
          await resync(rec, devices);
          rec.connected = true;
        });
      });
      socket.on('disconnect', () => { rec.connected = false; rec.reconnects += 1; rec.cut = new Map(rec.last); });
      socket.on('telemetry:update', ({ device: d, readings }) => {
        const at = Date.now();
        rec.frames.push({ at, device: d, n: readings.length, first: key(d, readings[0].metric, readings[0].ts) });
        for (const r of readings) { rec.add(key(d, r.metric, r.ts), 'live'); rec.lat ??= []; const k = key(d, r.metric, r.ts); const p = pubAt.get(k); const rn = reportOf.get(k); if (p && rn >= 1 && rn < pl.restartAt) rec.lat.push(at - p); }
      });
      clients.push(rec);
    }

    // SSE: по одному потоку на пристрій; повтор із Last-Event-ID
    for (const dev of devices) {
      const rec = newRec(`sse-${dev.id}`, [dev]);
      let lastId = null; let stopped = false; let req = null; let retryMs = 3000;
      const retryLater = () => { if (rec.waiting || stopped) return; rec.waiting = true; rec.cut = new Map(rec.last); rec.connected = false; rec.reconnects += 1; setTimeout(() => { rec.waiting = false; connect(); }, Math.min(retryMs, 800)); };
      const handle = (block) => {
        const f = { data: [] };
        for (const line of block.split('\n')) {
          const m = /^(\w+):\s?(.*)$/.exec(line);
          if (!m) continue;
          if (m[1] === 'data') f.data.push(m[2]); else f[m[1]] = m[2];
        }
        if (f.retry !== undefined) { retryMs = Number(f.retry); rec.retry.push(retryMs); }
        if (f.event === 'ready') rec.connected = true;
        if (f.event === 'reset') { rec.resets += 1; resync(rec, [dev]); }
        if (f.event === 'telemetry') {
          lastId = f.id ?? lastId;
          const r = JSON.parse(f.data.join('\n'));
          rec.add(key(r.device, r.metric, r.ts), 'live');
        }
      };
      function connect() {
        req = http.get(`${base}/api/v1/devices/${dev.id}/stream`, { localAddress: rec.ip, headers: lastId ? { 'Last-Event-ID': lastId } : {} }, (r) => {
          if (r.statusCode !== 200) { r.resume(); return retryLater(); }
          let buf = ''; r.setEncoding('utf8');
          r.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); } });
          r.on('end', retryLater);
          r.on('error', retryLater);
        });
        req.on('error', retryLater);
      }
      rec.stop = () => { stopped = true; req?.destroy(); };
      connect();
      clients.push(rec);
    }

    // ---- пристрої: публікація звітів ----
    device = mqtt.connect(mqttUrl, { clientId: 'sim-devices' });
    await new Promise((r) => device.once('connect', r));
    const acked = [];
    device.subscribe(`${root}/+/commands`, { qos: 1 });
    device.on('message', (topic, payload) => {
      const m = new RegExp(`^${root}/([\\w-]+)/commands$`).exec(topic);
      if (!m) return;
      const cmd = JSON.parse(payload.toString());
      acked.push({ device: m[1], id: cmd.id, name: cmd.name });
      device.publish(`${root}/${m[1]}/acks`, JSON.stringify({ id: cmd.id, ok: true }), { qos: 1 });
    });
    const publish = (topic, body) => new Promise((resolve) => device.publish(topic, JSON.stringify(body), { qos: 1 }, () => resolve()));
    const valueOf = (id, r) => {
      const m = table.get(id); const [lo, hi] = m.range; const dec = m.decimals ?? 1;
      const base0 = Math.min(hi, Math.max(lo, m.gen?.mean ?? (lo + hi) / 2));
      const v = base0 + (r % 3) * 10 ** -dec;
      return Math.round(Math.min(hi, v) * 10 ** dec) / 10 ** dec;
    };
    await sleep(600);                                        // клієнти підключилися й узгодили ряд
    const tStart = Date.now();
    let restart = null;
    let published = 0;
    const killAt = [];
    for (let r = 0; r < pl.reports; r++) {
      const slot = tStart + r * pl.period;
      if (r === pl.restartAt) {
        killAt.push(Date.now());
        restart = (async () => { await stopApp(); await sleep(1200); const t = Date.now(); const b = await spawnApp(); res.restart_ms = Date.now() - t; return b; })();
      }
      await Promise.all(devices.map(async (dev) => {
        const step = dev.metrics.length > 1 ? pl.spread / (dev.metrics.length - 1) : 0;
        for (let i = 0; i < dev.metrics.length; i++) {
          const wait = slot + i * step - Date.now();
          if (wait > 0) await sleep(wait);
          const id = dev.metrics[i];
          const ts = new Date().toISOString();
          const k = key(dev.id, id, ts);
          pubAt.set(k, Date.now()); reportOf.set(k, r);
          published += 1;
          await publish(`${root}/${dev.id}/telemetry`, { metric: id, value: valueOf(id, r), ts });
        }
      }));
      const rest = slot + pl.period - Date.now();
      if (rest > 0) await sleep(rest);
    }
    res.published = published;
    const b2 = await restart;
    if (!b2?.ok) { res.errors.push(`повторний запуск main.js: ${b2?.why}`); res.fatal = true; return res; }

    // ---- команда через брокер домену ----
    if (P.commands?.length) {
      const c = commandCases(P.commands[0]).valid[0];
      const r = await fetch(`${base}/api/v1/devices/${devices[0].id}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: c.name, params: c.params }) });
      const body = await r.json().catch(() => null);
      let final = body?.status ?? null;
      const tc = Date.now();
      while (r.status === 202 && final !== 'acked' && Date.now() - tc < 5000) {
        await sleep(200);
        const g = await getJsonPatient(base, `/api/v1/commands/${body.id}`);
        final = g.body?.status ?? final;
      }
      res.command = { http: r.status, final, delivered: acked.length > 0, name: c.name, ms: Date.now() - tc };
    }

    // ---- дочекатися завершення й порівняти з базою ----
    const tw = Date.now();
    while (Date.now() - tw < 12_000 && !clients.every((c) => c.connected)) await sleep(200);
    await sleep(2500);
    res.clients_connected = clients.filter((c) => c.connected).length;
    const dbr = new Database(dbFile, { readonly: true });
    const truthRows = dbr.prepare('SELECT device_id, metric, ts FROM telemetry').all();
    res.rejected = dbr.prepare('SELECT reason, count(*) AS n FROM rejected GROUP BY reason').all();
    dbr.close();
    const truth = new Set(truthRows.map((x) => key(x.device_id, x.metric, x.ts)));
    res.stored = truth.size;

    const summarize = (recs) => {
      let gaps = 0; let extras = 0; let dups = 0; let reconnects = 0; let resets = 0; let restErrors = 0;
      for (const rec of recs) {
        const want = new Set([...truth].filter((k) => rec.devs.some((d) => k.startsWith(`${d.id}|`))));
        for (const k of want) if (!rec.keys.has(k)) gaps += 1;
        for (const k of rec.keys) if (!truth.has(k)) extras += 1;
        dups += rec.dups; reconnects += rec.reconnects; resets += rec.resets; restErrors += rec.restErrors;
      }
      return { clients: recs.length, gaps, extras, dups, reconnects, resets, rest_errors: restErrors };
    };
    const sio = clients.filter((c) => c.name.startsWith('sio'));
    const sse = clients.filter((c) => c.name.startsWith('sse'));
    res.sio = summarize(sio);
    res.sse = { ...summarize(sse), retry_ms: [...new Set(sse.flatMap((c) => c.retry))] };

    // кадри на звіт: звіти 1…restartAt−2 (до зупинки, з уже усталеним вікном)
    const lo = 1; const hi = pl.restartAt - 2;
    const framesIn = sio[0].frames.filter((f) => { const r = reportOf.get(f.first); return r >= lo && r <= hi; });
    res.frames_per_report = framesIn.length / (devices.length * (hi - lo + 1));
    res.latency_p95_ms = quantile(sio.flatMap((c) => c.lat ?? []), 0.95);
    res.latency_p50_ms = quantile(sio.flatMap((c) => c.lat ?? []), 0.5);
    res.devices = devices.map((d) => d.id);
    return res;
  } catch (e) {
    res.errors.push(`стенд: ${e.stack ?? e.message}`);
    res.fatal = true;
    return res;
  } finally {
    await cleanup();
  }
}
