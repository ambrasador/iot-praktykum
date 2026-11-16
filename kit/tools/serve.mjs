#!/usr/bin/env node
// Стенд API: застосунок із вашого каталогу + історія вашого варіанта. Зупинка: Ctrl+C.
// node kit/tools/serve.mjs [--port 3100] [--variant N --seed N] [--ack-ms 800] [--json]
import { readTrack } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { startBed } from '../lib/bed.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), a === '--json' ? true : all[i + 1]] : []).filter((x) => x.length));
const t = args.variant === undefined ? readTrack() : {};
const variant = Number(args.variant ?? t.variant);
const seed = Number(args.seed ?? t.seed);
const P = loadPassport(variant);
const t0 = Date.now();
let bed;
try {
  bed = await startBed({ variant, seed, port: Number(args.port ?? 3100), ackMs: Number(args['ack-ms'] ?? 800) });
} catch (e) {
  console.error(`Стенд не запустився: ${e.message}`);
  if (/Cannot find module|SyntaxError|is not a function|Unexpected/.test(String(e.stack ?? e))) console.error('Перевірте файли застосунку, які ви змінювали: node --check commands.js settings.js metrics.js core.js');
  process.exit(1);
}
const o = bed.outcome;
if (args.json) {
  console.log(JSON.stringify({ url: bed.url, ...o, ms: Date.now() - t0 }));
} else {
  const ids = bed.hist.devices.map((d) => d.id).join(', ');
  console.log(`Стенд ПР2 — варіант ${variant} («${P.title}»), зерно ${seed}`);
  console.log(`Пристрої: ${ids}`);
  console.log(`Історія: ${new Date(bed.hist.startMs).toISOString()} … ${new Date(bed.hist.endMs).toISOString()}`);
  console.log(`Записано ${o.stored} вимірювань, дублікатів ${o.duplicate}, відхилено ${o.rejected}${o.rejected ? ` (${Object.entries(o.reasons).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}; ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  if (o.rejected) console.log('Відхилення в історії означають, що ПР1 застосунок не знає всіх метрик або діапазонів вашого домену: поверніться до core.js та metrics.js.');
  console.log(`Слухаю ${bed.url}  (Ctrl+C — зупинити)`);
}
process.on('SIGTERM', () => process.exit(0));
