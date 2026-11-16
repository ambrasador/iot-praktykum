// pr01/calc.mjs — розрахунок навантаження за паспортом об'єкта
import * as F from '../kit/lib/formulas.mjs';
import { loadPassport } from '../kit/lib/passport.mjs';

const p = loadPassport(0);       // для свого варіанта: loadPassport(K)
const L = p.load;
const avg = F.lambdaAvg(L.N, L.m, L.T);   // формула (1.1)
const peak = F.lambdaPeak(L);    // квантиль Пуассона або модель сплеску
const k = F.round(peak / avg, 1);
console.log(`λ_avg  = ${F.round(avg, 2)} рядків/с`);
console.log(`λ_peak = ${F.round(peak, 1)} рядків/с (k = ${k})`);
const mln = F.round(F.rowsPerYear(avg) / 1e6, 1);
const gb = F.round(F.gbPerYear(avg), 1);
console.log(`за рік = ${mln} млн рядків, ${gb} ГБ`);

const options = [['A', 'wal-full', 1],
  ['B', 'wal-full', p.requirements.deviceBatch],
  ['C', 'wal-normal', 1], ['D', 'wal-full', 500]];
for (const [id, mode, s] of options) {
  const cap = F.pipelineCapacity(mode, s);  // λ_max для s рядків
  const allowed = F.allowedPeak(cap);       // λ_max / 3, умова (1.4)
  const share = F.headroomShare(peak, cap) * 100;
  console.log(`${id}: λ_max = ${Math.round(cap)}, `
    + `допустимий пік = ${Math.round(allowed)}, `
    + `частка = ${F.round(share, 1)} %`);
}
