#!/usr/bin/env node
// Створює журнал track.json і каталоги pr01…pr08
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { TRACK, writeTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const variant = Number(args.variant);
const seed = Number(args.seed);
const level = Number(args.level ?? 3);
if (!Number.isInteger(variant) || variant < 0 || variant > 5) {
  console.error('Потрібен --variant 1…5 (0 — демонстраційний приклад розділу 1).'); process.exit(2);
}
if (!Number.isInteger(seed) || seed < 1) {
  console.error('Потрібен --seed: ціле число від 1 (ваш номер у журналі групи).'); process.exit(2);
}
if (![3, 4, 5].includes(level)) { console.error('--level: 3, 4 або 5.'); process.exit(2); }
if (fs.existsSync(TRACK) && !('force' in args)) {
  console.error('track.json уже існує. Додайте --force, щоб почати спочатку (старий журнал буде втрачено).'); process.exit(2);
}
const p = loadPassport(variant);
writeTrack({ student: args.name ?? '', variant, seed, level, domain: p.title });
for (let i = 1; i <= 8; i++) fs.mkdirSync(path.join(ROOT, `pr0${i}`), { recursive: true });
console.log(`track.json створено: варіант ${variant} («${p.title}»), зерно ${seed}, рівень ${level}.`);
console.log('Каталоги pr01…pr08 створено.');
