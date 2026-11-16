// Лабораторія ПР6: профіль безпеки студента, справжні модулі розділу 6 під керуванням віртуального годинника.
// Усі прогони відтворювані й не залежать від швидкості машини: час — віртуальний, scrypt — з параметрами студента
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appRequire, APP } from './app.mjs';
import * as F from './formulas.mjs';

const DAY_MS = 86_400_000;
const HOOK = path.resolve(import.meta.dirname, 'capture-hook.cjs');

export function fakeClock(start = Date.parse('2026-11-05T09:00:00Z')) {
  const clock = () => clock.now;
  clock.now = start;
  clock.tick = (ms) => { clock.now += ms; };
  return clock;
}

// Що зламалося й де, одним рядком: «SyntaxError: Unexpected token ')' (auth.js:26)» замість хвоста стеку
export function crashLine(text) {
  const s = String(text);
  const lines = s.split('\n');
  const head = lines.find((l) => /^\s*\w*Error\b/.test(l)) ?? lines.find((l) => l.trim()) ?? 'без повідомлення';
  const esc = APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loc = /^(?:\S*[\\/])?([\w.-]+\.js):(\d+)\s*$/m.exec(s) ?? new RegExp(`${esc}[\\\\/]((?!node_modules)[\\w./-]+\\.js):(\\d+)`).exec(s);
  return `${head.trim()}${loc ? ` (${loc[1]}:${loc[2]})` : ''}`;
}

// ---------------- профіль ----------------
export function loadProfile(code) {
  let mod;
  try { mod = appRequire('./profile'); } catch (e) {
    return { error: e.code === 'MODULE_NOT_FOUND' && /profile/.test(e.message) ? 'У каталозі застосунку немає profile.js' : `profile.js не завантажується: ${crashLine(e.stack ?? e.message)}` };
  }
  const profile = mod[`PROFILE_${code}`];
  if (!profile || typeof profile !== 'object') return { error: `profile.js не експортує PROFILE_${code}` };
  if (typeof mod.securityOptions !== 'function') return { error: 'profile.js не експортує функцію securityOptions(profile)' };
  let options;
  try { options = mod.securityOptions(profile); } catch (e) { return { error: `securityOptions кидає помилку: ${e.message}` }; }
  if (!options || typeof options !== 'object') return { error: 'securityOptions має повертати об’єкт параметрів' };
  return { mod, profile, options };
}

// ---------------- підключення в main.js ----------------
export async function captureWiring() {
  const { Aedes } = appRequire('aedes');
  const broker = await Aedes.createBroker();
  const srv = net.createServer(broker.handle);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-wire-'));
  const capture = path.join(dir, 'capture.jsonl');
  const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => 17 + i * 5)).toString('base64');
  const env = { ...process.env, MQTT_URL: `mqtt://127.0.0.1:${srv.address().port}`, DB_FILE: path.join(dir, 'wire.db'), PORT: '0',
    JWT_KEYS: `k1:${secret}`, JWT_CURRENT: 'k1', WEBHOOK_SECRETS: 'whsec-capture-0123456789abcdefghijklmnop', SEC_CAPTURE_FILE: capture, LOG_LEVEL: 'error' };
  delete env.AUTH_DISABLED;
  const child = spawn(process.execPath, ['-r', HOOK, 'main.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const read = () => (fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  while (!exited && Date.now() - t0 < 25_000 && !read().some((r) => r.fn === 'createServer')) await new Promise((r) => setTimeout(r, 50));
  const rows = read();
  await new Promise((r) => setTimeout(r, 150));
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && !exited; i += 1) await new Promise((r) => setTimeout(r, 50));
  if (!exited) child.kill('SIGKILL');
  await new Promise((r) => broker.close(r)).catch(() => {});
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (!rows.some((r) => r.fn === 'createServer')) return { error: `main.js не дійшов до створення сервера: ${crashLine(err)}` };
  return { calls: Object.fromEntries(rows.map((r) => [r.fn, r.opts])) };
}

const same = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
// Що main.js передав службам і що має передати за profile.js
export function wiringDiff(calls, o) {
  const out = [];
  const want = (fn, label, got, exp) => {
    if (exp === undefined) return;
    if (!same(got, exp)) out.push(`main.js: ${fn} ${label} = ${got === undefined ? 'не передано (діє значення модуля за замовчуванням)' : JSON.stringify(got)}, за профілем має бути ${JSON.stringify(exp)}`);
  };
  const c = (fn) => calls[fn] ?? {};
  const pw = o.passwords ?? {};
  for (const k of ['N', 'r', 'p']) want('createPasswordService', `params.${k}`, c('createPasswordService').params?.[k], pw.params?.[k]);
  want('createPasswordService', 'concurrency', c('createPasswordService').concurrency, pw.concurrency);
  want('createTokens', 'accessTtlSec', c('createTokens').accessTtlSec, o.tokens?.accessTtlSec);
  want('createRefresh', 'ttlSec', c('createRefresh').ttlSec, o.refresh?.ttlSec);
  for (const who of ['ip', 'user']) for (const k of ['rate', 'burst']) want('createAuth', `limits.${who}.${k}`, c('createAuth').limits?.[who]?.[k], o.auth?.limits?.[who]?.[k]);
  want('createVerifier', 'toleranceSec', c('createVerifier').toleranceSec, o.verifier?.toleranceSec);
  if (o.auth?.policy) {
    const got = c('createAuth').policy;
    for (const [action, roles] of Object.entries(o.auth.policy)) {
      if (JSON.stringify([...(got?.[action] ?? [])].sort()) !== JSON.stringify([...roles].sort())) out.push(`main.js: createAuth policy[${action}] = ${got ? JSON.stringify(got[action] ?? null) : 'не передано (діє політика за замовчуванням)'}, за профілем має бути ${JSON.stringify(roles)}`);
    }
  }
  for (const k of ['rate', 'burst']) want('createServer', `limits.${k}`, c('createServer').limits?.[k], o.api?.limits?.[k]);
  for (const k of ['rate', 'burst']) want('createServer', `limits.ingest.${k}`, c('createServer').limits?.ingest?.[k], o.api?.limits?.ingest?.[k]);
  return out;
}

// ---------------- пароль ----------------
export async function passwordProbe(options) {
  const { createPasswordService } = appRequire('./passwords');
  const svc = createPasswordService(options.passwords);
  const stored = await svc.hash('correct horse battery');
  const [alg, N, r, p] = stored.split('$');
  const oldN = svc.params?.N >= 2 ** 17 ? svc.params.N / 2 : (svc.params?.N ?? 2 ** 15) * 2;     // хеш за іншими параметрами
  const old = `scrypt$${oldN}$${svc.params?.r ?? 8}$${svc.params?.p ?? 3}$x$y`;
  return { alg, N: Number(N), r: Number(r), p: Number(p), params: svc.params, ok: await svc.verify('correct horse battery', stored), needsRehashOld: svc.needsRehash(old), concurrency: options.passwords?.concurrency };
}

// ---------------- ліміти входу ----------------
async function makeParts(options, { users = [], clock = fakeClock() } = {}) {
  const { makeSecurity, FAST } = appRequire('./auth-kit');
  const { makeMobileDb } = appRequire('./mobile-kit');
  const db = makeMobileDb();
  const parts = await makeSecurity({ db, clock, accessTtlSec: options.tokens?.accessTtlSec, refreshTtlSec: options.refresh?.ttlSec,
    limits: options.auth?.limits, params: FAST, users });
  return { ...parts, db, clock };
}

export async function loginDay(options) {
  const { auth, clock } = await makeParts(options);
  const day = (limiter) => { let ok = 0; for (let s = 0; s < 86_400; s += 1) { if (limiter.take('атака').ok) ok += 1; clock.tick(1000); } return ok; };
  const out = { user: day(auth.limiters.byName) };
  clock.now = fakeClock()();
  out.ip = day(auth.limiters.byIp);
  return out;
}

// ---------------- ліміт запитів користувача ----------------
export function apiLimitSim(limits, { q, o, P04, Pmob, queueN }) {
  const { createLimiter } = appRequire('./ratelimit');
  const clock = fakeClock(); const t0 = clock.now;
  // Сталий режим: година, два клієнти зі зсувом на пів періоду
  const lim = createLimiter({ rate: limits.rate, burst: limits.burst, clock });
  const ev = [];
  for (let t = 0; t < 3600; t += P04) ev.push(t);
  for (let t = Pmob / 2; t < 3600; t += Pmob) ev.push(t);
  ev.sort((a, b) => a - b);
  let denied = 0;
  for (const t of ev) { clock.now = t0 + t * 1000; for (let i = 0; i < q + o; i += 1) if (!lim.take('u').ok) denied += 1; }
  // Повторне надсилання черги після відновлення зв'язку: повний кошик, відкриття застосунку + черга
  const lim2 = createLimiter({ rate: limits.rate, burst: limits.burst, clock });
  clock.now = t0;
  let left = queueN + q + o; let elapsedMs = 0;
  while (left > 0 && elapsedMs < 600_000) { while (left > 0 && lim2.take('u').ok) left -= 1; if (left > 0) { clock.tick(100); elapsedMs += 100; } }
  return { denied, events: ev.length, flushS: elapsedMs / 1000, flushed: left === 0 };
}

// ---------------- токени ----------------
// Строки: access спливає рівно через accessTtlSec, refresh — через refreshTtlSec; число рядків refresh_tokens
// на користувача в сталому режимі (оновлення щоразу, коли спливає access; прибирання щогодини, як у main.js)
export async function tokensSim(options, { accessS, days }) {
  const clock = fakeClock();
  const parts = await makeParts(options, { users: [['sim', 'viewer', []]], clock });
  const { tokens, refresh, ids, db } = parts; const uid = ids.sim;
  const start = clock.now;
  const at = tokens.signAccess({ user_id: uid, role: 'viewer', token_version: 1 });
  const valid = (s) => { clock.now = start + s * 1000; try { tokens.verifyAccess(at); return true; } catch { return false; } };
  const out = { accessTtl: tokens.accessTtlSec, okBefore: valid(tokens.accessTtlSec - 1), okAfter: valid(tokens.accessTtlSec + 1) };
  const ttlMs = (options.refresh?.ttlSec ?? 30 * 86400) * 1000;
  clock.now = start;
  const t1 = refresh.issue(uid).token; const t2 = refresh.issue(uid).token;
  clock.now = start + ttlMs - 1000;
  out.refreshBefore = (() => { try { refresh.rotate(t1); return true; } catch { return false; } })();
  clock.now = start + ttlMs + 1000;
  out.refreshAfter = (() => { try { refresh.rotate(t2); return true; } catch (e) { return e.extra?.reason ?? e.code ?? false; } })();
  db.prepare('DELETE FROM refresh_tokens').run();
  clock.now = start;
  let token = refresh.issue(uid).token;
  const horizon = (days + F.SEC.graceDays + 3) * 86_400;
  let since = 0;
  for (let s = accessS; s <= horizon; s += accessS) {
    clock.now = start + s * 1000;
    token = refresh.rotate(token).token;
    since += accessS;
    if (since >= 3600) { refresh.purgeExpired(); since = 0; }
  }
  refresh.purgeExpired();
  out.rows = db.prepare('SELECT count(*) FROM refresh_tokens').pluck().get();
  return out;
}

// ---------------- вебхук ----------------
// Доставки з рівномірним потоком rho/с, годинник постачальника спішить на skewS; пік кешу повторів і межі допуску
export function hookSim(verifierOpts, { rho, skewS, delayS }) {
  const { createVerifier, sign } = appRequire('./webhook-sign');
  const secret = 'whsec-lab-0123456789abcdefghijklmnopqrstuv';
  const clock = fakeClock();
  const v = createVerifier({ secrets: [secret], clock, ...verifierOpts });
  const tol = verifierOpts.toleranceSec ?? 300;
  const body = (i) => Buffer.from(JSON.stringify({ i }));
  const nowSec = () => Math.floor(clock() / 1000);
  let peak = 0; let acc = 0; let n = 0; let rejected = 0;
  const horizon = 4 * tol + 120;
  for (let s = 0; s < horizon; s += 1) {
    acc += rho;
    while (acc >= 1) { acc -= 1; n += 1; const r = v(sign(secret, body(n), nowSec() + skewS), body(n)); if (r) rejected += 1; }
    peak = Math.max(peak, v.size());
    clock.tick(1000);
  }
  const probe = (offset, label) => { const raw = Buffer.from(`{"p":"${label}"}`); return v(sign(secret, raw, nowSec() + offset), raw); };
  const out = { peak, rejected, deliveries: n, tol, atTol: probe(-tol, 'at'), pastTol: probe(-tol - 1, 'past'), aheadTol: probe(tol, 'ahead'), aheadPast: probe(tol + 1, 'aheadPast') };
  // Затримана на delayS доставка від постачальника з відстаючим на skewS годинником
  out.delayed = probe(-(delayS + skewS), 'delayed');
  const raw = Buffer.from('{"r":1}'); const header = sign(secret, raw, nowSec());
  out.first = v(header, raw); out.again = v(header, raw);
  clock.tick((tol + 1) * 1000); out.afterWindow = v(header, raw);
  return out;
}

// ---------------- строки зберігання (admin-cli.js) ----------------
export function retentionRun(expectedDays) {
  const Database = appRequire('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-ret-'));
  const file = path.join(dir, 'ret.db');
  const cli = () => spawnSync(process.execPath, [path.join(APP, 'admin-cli.js'), 'retention'], { cwd: APP, env: { ...process.env, DB_FILE: file }, encoding: 'utf8', timeout: 60_000 });
  try {
    const first = cli();
    if (first.status !== 0) return { error: `admin-cli.js retention завершився з кодом ${first.status}: ${(first.stderr || first.stdout).trim().split('\n')[0]}` };
    const db = new Database(file);
    const now = Date.now(); const iso = (days) => new Date(now - days * DAY_MS).toISOString();
    const plan = { audit_log: 3, rejected: 4, push_tokens: 5, telemetry: 6 };
    const fresh = 2;
    db.prepare("INSERT INTO latest VALUES ('lab-1','temperature',?,1)").run(iso(0));
    let id = 0;
    for (const [table, old] of Object.entries(plan)) {
      const d = expectedDays[table];
      for (let i = 0; i < old + fresh; i += 1) {
        const age = i < old ? d + 1 + i * 0.01 : d - 1 - i * 0.01;
        const ts = iso(age);
        id += 1;
        if (table === 'audit_log') db.prepare("INSERT INTO audit_log (ts, action, outcome) VALUES (?, 'lab', 'ok')").run(ts);
        else if (table === 'rejected') db.prepare("INSERT INTO rejected (received_at, reason, raw) VALUES (?, 'lab', '{}')").run(ts);
        else if (table === 'push_tokens') db.prepare("INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at) VALUES (?, 'token', 'u', 'android', ?, ?)").run(`lab-${id}`, ts, ts);
        else db.prepare("INSERT INTO telemetry VALUES ('lab-1','temperature',?,?,1)").run(ts, ts);
      }
    }
    db.close();
    const run = cli();
    if (run.status !== 0) return { error: `admin-cli.js retention завершився з кодом ${run.status}: ${(run.stderr || run.stdout).trim().split('\n')[0]}` };
    return { deleted: JSON.parse(run.stdout.trim().split('\n').pop()), planned: plan, fresh };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------- координати ----------------
export function geoProbe(cellDeg) {
  const { coarsen, cellKm } = appRequire('./privacy');
  const lat = 50.4501; const lon = 30.5234;
  const c = coarsen(lat, lon, cellDeg);
  const km = cellKm(lat, cellDeg);
  return { ns_km: km.northSouth, ew_km: km.eastWest, errLat: Math.abs(c.lat - lat), errLon: Math.abs(c.lon - lon), half: cellDeg / 2 };
}

// ---------------- матриця ролей: справжній guard з політикою студента ----------------
export async function policyGuard(policy, changed, expected) {
  const { createAuth } = appRequire('./auth');
  const parts = await makeParts({}, { users: [['v', 'viewer', []], ['o', 'operator', ['*']], ['a', 'admin', []]] });
  const auth = createAuth({ db: parts.db, tokens: parts.tokens, refresh: parts.refresh, passwords: parts.passwords, audit: parts.audit,
    clock: parts.clock, limits: { ip: { rate: 1e6, burst: 1e6 }, user: { rate: 1e6, burst: 1e6 } }, policy });
  const who = { viewer: parts.ids.v, operator: parts.ids.o, admin: parts.ids.a };
  const token = (role) => parts.tokens.signAccess({ user_id: who[role], role, token_version: 1 });
  const req = (t) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${t}` : undefined), ip: '203.0.113.9', params: {}, query: {} });
  const problems = [];
  for (const action of changed) {
    for (const role of Object.keys(who)) {
      const err = await new Promise((resolve) => { try { auth.guard(action)(req(token(role)), {}, resolve); } catch (e) { resolve(e); } });
      const allowed = (expected[action] ?? []).includes(role);
      const denied = err?.status === 403;
      if (err && err.status !== 403) problems.push(`${action}: guard для ${role} повернув помилку ${err.status ?? err.message}`);
      else if (allowed && denied) problems.push(`${action}: роль ${role} має право, а guard відповів 403`);
      else if (!allowed && !denied) problems.push(`${action}: роль ${role} права не має, а guard пропустив`);
    }
  }
  if (changed.includes('stream:read')) {
    for (const role of Object.keys(who)) {
      let ok = true; try { auth.identifySocket(token(role)); } catch { ok = false; }
      if (ok !== (expected['stream:read'] ?? []).includes(role)) problems.push(`stream:read: Socket.IO для ролі ${role} ${ok ? 'пропущено' : 'відхилено'} всупереч політиці`);
    }
  }
  return problems;
}

export function actionsOf() {
  const { ACTIONS } = appRequire('./policy');
  return JSON.parse(JSON.stringify(ACTIONS));
}
