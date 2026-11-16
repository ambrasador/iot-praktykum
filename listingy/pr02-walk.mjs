// pr02/walk.mjs: обхід сторінок історії за курсором
const base = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const q = new URLSearchParams({
  device: 'bed-01', metric: 'soil_moisture',      // замініть на свої
  from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z',
  limit: '200',
});
let rows = 0, pages = 0;
for (;;) {
  const r = await (await fetch(`${base}/api/v1/telemetry?${q}`)).json();
  rows += r.data.length; pages += 1;
  console.log(`сторінка ${pages}: ${r.data.length} рядків, ` +
    `next ${r.next ? 'є' : 'немає'}`);
  if (!r.next) break;
  q.set('cursor', r.next);
}
console.log(`усього: ${rows} рядків на ${pages} сторінках`);
