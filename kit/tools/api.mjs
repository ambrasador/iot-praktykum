#!/usr/bin/env node
// Виклик API стенду без curl і jq: node kit/tools/api.mjs <GET|POST|PUT> <шлях> [--body '{…}'] [--header 'Ім’я: значення']
//                                   [--max 3] [--size] [--pick поле1,поле2] [--base http://127.0.0.1:3100]
// Друкує статус, корисні заголовки і тіло відповіді; масиви довші за --max скорочує.
// З --pick друкує лише вказані поля елементів масиву data, по одному рядку на елемент (без JSON).
const argv = process.argv.slice(2);
const flags = { header: [] };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--size') flags.size = true;
  else if (a.startsWith('--')) { const v = argv[++i]; if (a === '--header') flags.header.push(v); else flags[a.slice(2)] = v; }
  else pos.push(a);
}
const [method = 'GET', p] = pos;
if (!p) { console.error('Використання: api.mjs GET /telemetry?device=…  [--body JSON] [--header "K: V"] [--max N] [--size] [--pick поле,…]'); process.exit(2); }
const base = flags.base ?? process.env.API_BASE ?? 'http://127.0.0.1:3100';
const max = Number(flags.max ?? 3);
const headers = Object.fromEntries(flags.header.map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));
if (flags.body !== undefined) headers['content-type'] ??= 'application/json';
let res;
try {
  res = await fetch(base + (p.startsWith('/api') || p.startsWith('/__') ? p : `/api/v1${p}`), { method, headers, body: flags.body });
} catch (e) {
  console.error(`Немає відповіді від ${base}: ${e.cause?.code ?? e.message}. Стенд запущено? (node kit/tools/serve.mjs)`);
  process.exit(1);
}
const text = await res.text();
console.log(`HTTP ${res.status}`);
for (const h of ['etag', 'location', 'retry-after', 'deprecation']) {
  const v = res.headers.get(h);
  if (v && !(h === 'etag' && v.startsWith('W/'))) console.log(`${h}: ${v}`);   // слабкі ETag Express — шум; значущий лише сильний ETag налаштувань
}
if (flags.size) console.log(`розмір тіла: ${Buffer.byteLength(text)} байтів`);
let body;
try { body = JSON.parse(text); } catch { console.log(text); process.exit(0); }
if (flags.pick) {
  const fields = flags.pick.split(',').map((f) => f.trim());
  const rows = Array.isArray(body?.data) ? body.data : [];
  console.log(`елементів: ${rows.length}`);
  for (const r of rows) console.log(fields.map((f) => r?.[f]).join('  '));
  process.exit(0);
}
const cut = (v) => {
  if (Array.isArray(v)) return v.length > max ? [...v.slice(0, max).map(cut), `… ще ${v.length - max} з ${v.length}`] : v.map(cut);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
  return v;
};
console.log(JSON.stringify(cut(body), null, 2));
