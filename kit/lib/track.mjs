// Журнал наскрізного проєкту track.json: числа й рішення кожної практичної роботи
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

export const TRACK = path.join(ROOT, 'track.json');

export function readTrack() {
  if (!fs.existsSync(TRACK)) {
    console.error(`Немає ${TRACK}. Спершу: node kit/tools/init.mjs --variant <1-5> --seed <номер у журналі> --level <3|4|5>`);
    process.exit(2);
  }
  try { return JSON.parse(fs.readFileSync(TRACK, 'utf8')); }
  catch (e) { console.error(`track.json не розбирається як JSON: ${e.message}`); process.exit(2); }
}

export const writeTrack = (t) => fs.writeFileSync(TRACK, JSON.stringify(t, null, 2) + '\n');

export function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, p, value) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  o[keys.at(-1)] = value;
}
