// Матриця «мутант × шар»: який із трьох наборів тестів помічає кожну з 12 помилок (ПР7, рівень «5»)
import * as Q from './qa-lab.mjs';

export const LAYERS = [['unit', 'Jest, unit'], ['integration', 'Jest, integration'], ['legacy', 'node:test']];

export async function matrix(P) {
  const muts = Q.matrixMutants(P);
  const cols = {};
  for (const [layer] of LAYERS) {
    const files = layer === 'legacy' ? Q.LEGACY_FILES.filter(Q.have) : undefined;
    const r = await Q.runMutants(muts, layer, files);
    if (r.baselineFailed) return { error: `набір «${layer}» червоний без мутантів: ${r.baseline.failed[0] ?? r.baseline.out.trim().split('\n').slice(-3).join(' | ')}` };
    cols[layer] = r.results.map((x) => (x.status === 'killed' ? true : x.status === 'survived' ? false : `${x.status}: ${x.mutant.id}`));
    const bad = cols[layer].find((v) => typeof v === 'string');
    if (bad) return { error: bad };
  }
  const rows = muts.map((m, i) => ({ id: m.id, title: m.title, unit: cols.unit[i], integration: cols.integration[i], legacy: cols.legacy[i] }));
  return { rows };
}

export async function printMatrix(P, listOnly, onSave = null) {
  if (listOnly) { for (const m of Q.matrixMutants(P)) console.log(`${m.id.padEnd(34)} ${m.title}`); return 0; }
  const m = await matrix(P);
  if (m.error) { console.log(`✗ ${m.error}`); return 1; }
  console.log(`\n${'мутант'.padEnd(34)} ${LAYERS.map(([, t]) => t.padEnd(18)).join('')}`);
  for (const r of m.rows) console.log(`${r.id.padEnd(34)} ${LAYERS.map(([l]) => (r[l] ? 'вбито' : '—').padEnd(18)).join('')}`);
  const tot = LAYERS.map(([l]) => m.rows.filter((r) => r[l]).length);
  console.log(`${'Вбито мутантів'.padEnd(34)} ${tot.map((n) => `${n} із ${m.rows.length}`.padEnd(18)).join('')}`);
  const lost = m.rows.filter((r) => !r.unit && !r.integration && !r.legacy);
  for (const r of lost) console.log(`✗ жоден набір не помічає: ${r.title} [${r.id}]`);
  if (onSave) onSave(m);
  return lost.length ? 1 : 0;
}
