#!/usr/bin/env node
// node kit/tools/track.mjs show | get <шлях> | set <шлях> <значення>
import { readTrack, writeTrack, getPath, setPath } from '../lib/track.mjs';

const [cmd, key, ...rest] = process.argv.slice(2);
const t = readTrack();
if (cmd === 'show') console.log(JSON.stringify(t, null, 2));
else if (cmd === 'get' && key) console.log(JSON.stringify(getPath(t, key)));
else if (cmd === 'set' && key && rest.length) {
  const raw = rest.join(' ');
  let v;
  try { v = JSON.parse(raw); } catch { v = raw; }           // 45, true, [1,2], "текст"
  setPath(t, key, v);
  writeTrack(t);
  console.log(`${key} = ${JSON.stringify(v)}`);
} else {
  console.error('Використання: track.mjs show | get <шлях> | set <шлях> <значення>');
  process.exit(2);
}
