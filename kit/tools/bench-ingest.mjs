#!/usr/bin/env node
// Вимірює пропускну здатність шляху до бази (справжній createIngest + schema.sql) для заданих режимів.
// node kit/tools/bench-ingest.mjs --journal WAL --sync FULL --size 1 --rows 5000 [--runs 3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRequire, appPath } from '../lib/app.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const journal = opt('journal', 'WAL').toUpperCase();
const sync = opt('sync', 'FULL').toUpperCase();
const size = Number(opt('size', 1));
const rows = Number(opt('rows', 5000));
const runs = Number(opt('runs', 3));
if (!['WAL', 'DELETE'].includes(journal) || !['FULL', 'NORMAL'].includes(sync) || !(size >= 1) || !(rows >= size)) {
  console.error('Використання: --journal WAL|DELETE --sync FULL|NORMAL --size <рядків у транзакції> --rows <усього рядків> [--runs 3]');
  process.exit(2);
}
const Database = appRequire('better-sqlite3');
const { createIngest } = appRequire('./core');
const schema = fs.readFileSync(appPath('schema.sql'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
const BASE = Date.now() - 3600e3;

const results = [];
for (let r = 0; r < runs; r++) {
  const file = path.join(dir, `b${r}.db`);
  const db = new Database(file);
  db.pragma(`journal_mode = ${journal}`);
  db.pragma(`synchronous = ${sync}`);
  db.exec(schema);
  const ing = createIngest(db);
  const reading = (i) => ({ deviceId: `gh1-s${i % 2000}`, metric: 'temperature', value: 15 + (i % 100) / 10, ts: new Date(BASE + r * 1e7 + i).toISOString() });
  const tx = db.transaction((from, to) => { for (let i = from; i < to; i++) ing.accept(reading(i)); });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rows; i += size) tx(i, Math.min(i + size, rows));
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  db.close();
  results.push(rows / sec);
}
fs.rmSync(dir, { recursive: true, force: true });
results.sort((a, b) => a - b);
const median = results[Math.floor(results.length / 2)];
console.log(`journal=${journal} synchronous=${sync} рядків у транзакції=${size} рядків=${rows} прогонів=${runs}`);
console.log(`прогони, рядків/с: ${results.map((x) => Math.round(x)).join(', ')}`);
console.log(`медіана: ${Math.round(median)} рядків/с`);
