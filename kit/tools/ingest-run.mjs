#!/usr/bin/env node
// Пропускає потік повідомлень через справжнє ядро приймання застосунку (decode → createApp → createIngest)
// і друкує, скільки повідомлень збережено, скільки дублікатів і скільки відхилено за кожною причиною.
// node kit/tools/ingest-run.mjs [pr01/stream.ndjson] [--report pr01/ingest-report.json]
import fs from 'node:fs';
import path from 'node:path';
import { appRequire, ROOT } from '../lib/app.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = path.resolve(argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? path.join(ROOT, 'pr01', 'stream.ndjson'));
const reportFile = path.resolve(flag('report') ?? path.join(path.dirname(file), 'ingest-report.json'));

if (!fs.existsSync(file)) { console.error(`Немає файла ${file}. Спершу: node kit/tools/gen-stream.mjs`); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = lines.shift()._meta;
const NOW = Date.parse(meta.now);

const { createApp } = appRequire('./app');
const { createFakeSource } = appRequire('./fake-source');
const { decode } = appRequire('./mqtt-source');
const { makeDb } = appRequire('./testkit');

const db = makeDb();
const source = createFakeSource();
const app = createApp({ db, source, clock: () => NOW });     // годинник стоїть: «зараз» = now із потоку

for (const msg of lines) {
  try {
    source.push(decode(msg.topic, Buffer.from(msg.payload)));
  } catch (e) {
    if (e.constructor.name !== 'DecodeError') throw e;       // збій бази не маскуємо
    source.pushBad(e.message, `${msg.topic} ${msg.payload}`);
  }
}

const reasons = Object.fromEntries(db.prepare(
  'SELECT reason, count(*) AS n FROM rejected GROUP BY reason ORDER BY n DESC, reason').all().map((r) => [r.reason, r.n]));
const { stored, duplicate, rejected } = app.stats;
const report = { stream: path.basename(file), variant: meta.variant, seed: meta.seed, total: lines.length, stored, duplicate, rejected, reasons };
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');

const pad = (s, n) => String(s).padEnd(n);
console.log(`Потік ${path.basename(file)}: ${lines.length} повідомлень, now = ${meta.now}`);
console.log(`  ${pad('збережено (stored)', 24)} ${stored}`);
console.log(`  ${pad('дублікатів (duplicate)', 24)} ${duplicate}`);
console.log(`  ${pad('відхилено (rejected)', 24)} ${rejected}`);
for (const [r, n] of Object.entries(reasons)) console.log(`    ${pad(r, 22)} ${n}`);
console.log(`Звіт: ${path.relative(process.cwd(), reportFile)}`);
