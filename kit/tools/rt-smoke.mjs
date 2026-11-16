#!/usr/bin/env node
// Наскрізна перевірка каналу реального часу на вашому застосунку (main.js) з налаштуваннями pr03/rt.env.
// Посередині прогону застосунок перезапускається; клієнти Socket.IO й SSE узгоджують ряд через REST.
//   node kit/tools/rt-smoke.mjs [--env pr03/rt.env] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { runSmoke, parseEnv } from '../lib/rt-bed.mjs';

const argv = process.argv.slice(2);
const ei = argv.indexOf('--env');
const envFile = path.resolve(ROOT, ei >= 0 ? argv[ei + 1] : path.join('pr03', 'rt.env'));
const t = readTrack();
const P = loadPassport(t.variant);
const rtEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
rtEnv.TOPIC_ROOT ??= P.topicRoot;
if (!fs.existsSync(envFile)) console.error(`Увага: немає ${envFile}; використано лише TOPIC_ROOT=${rtEnv.TOPIC_ROOT}.`);
const r = await runSmoke({ variant: t.variant, rtEnv });
if (argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.fatal ? 1 : 0); }
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '—');
console.log(`Стенд ПР3 — варіант ${t.variant} («${P.title}»), корінь топіків «${rtEnv.TOPIC_ROOT}»`);
console.log(`Налаштування: ${Object.entries(rtEnv).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (r.fatal) {
  console.log(`Стенд не відпрацював: ${r.errors.join('; ')}`);
  if (r.logTail.length) console.log(`Останні рядки журналу main.js:\n  ${r.logTail.slice(-8).join('\n  ')}`);
  process.exit(1);
}
console.log(`Запуск main.js: ${r.boot_ms} мс; повторний після зупинки: ${r.restart_ms} мс`);
console.log(`Опубліковано вимірювань: ${r.published}, у базі: ${r.stored}${r.rejected.length ? `; відхилено: ${r.rejected.map((x) => `${x.reason} ${x.n}`).join(', ')}` : ''}`);
console.log(`Socket.IO (клієнтів: ${r.sio.clients}): пропусків ${r.sio.gaps}, зайвих ${r.sio.extras}, дублікатів відкинуто ${r.sio.dups}, перепідключень ${r.sio.reconnects}`);
console.log(`SSE (потоків: ${r.sse.clients}): пропусків ${r.sse.gaps}, зайвих ${r.sse.extras}, дублікатів відкинуто ${r.sse.dups}, перепідключень ${r.sse.reconnects}; retry від сервера: ${r.sse.retry_ms.join(', ') || '—'} мс`);
console.log(`Кадрів на звіт пристрою: ${f(r.frames_per_report, 2)} (очікується 1,00)`);
console.log(`Затримка від публікації до клієнта: p50 ${f(r.latency_p50_ms, 0)} мс, p95 ${f(r.latency_p95_ms, 0)} мс (вимога паспорта: ${loadPassport(t.variant).rt.latencyMs} мс)`);
if (r.command) console.log(`Команда «${r.command.name}»: HTTP ${r.command.http}, стан ${r.command.final}, пристрій отримав: ${r.command.delivered ? 'так' : 'ні'} (${r.command.ms} мс)`);
if (r.errors.length) console.log(`Зауваження: ${r.errors.join('; ')}`);
