#!/usr/bin/env node
// Хвіст нормального розподілу Q(z) і зворотна задача (формули 5.5 і 5.8 підручника).
//   node kit/tools/qinv.mjs 0.0007             → z, для якого Q(z) = 0,0007
//   node kit/tools/qinv.mjs --z 3.2            → Q(3,2)
//   node kit/tools/qinv.mjs --n 1440 --r 1     → p = R / (N − 2R) і множник k = Q⁻¹(p)
import { Q, qInv } from '../lib/formulas.mjs';

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(String(argv[i + 1]).replace(',', '.')) : undefined; };
const fmt = (x, d = 4) => x.toFixed(d).replace('.', ',');
const exp = (x) => x.toExponential(3).replace('.', ',');

const z = flag('z'); const N = flag('n'); const R = flag('r');
if (z !== undefined) {
  if (!Number.isFinite(z)) { console.error('--z: потрібне число'); process.exit(2); }
  console.log(`Q(${fmt(z, 3)}) = ${exp(Q(z))}`);
} else if (N !== undefined) {
  const r = R ?? 1;
  if (!(N > 2 * r) || !(r > 0)) { console.error('Потрібні N > 2R і R > 0.'); process.exit(2); }
  const p = r / (N - 2 * r);
  console.log(`N = ${N}, R = ${r}: Q(k) ≤ R / (N − 2R) = ${exp(p)}`);
  console.log(`k = ${fmt(qInv(p))}`);
} else {
  const p = Number(String(argv[0] ?? '').replace(',', '.'));
  if (!(p > 0 && p < 0.5)) { console.error('Використання: qinv.mjs <p, 0 < p < 0,5> | --z <z> | --n <N> [--r <R>]'); process.exit(2); }
  console.log(`Q⁻¹(${exp(p)}) = ${fmt(qInv(p))}`);
}
