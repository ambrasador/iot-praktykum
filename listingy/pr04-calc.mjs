// pr04/calc.mjs: розрахунки ПР4 за формулами розділу 4
import { INTERVALS } from '../greenhouse-monitor/client/intervals.js';
import { contrast } from '../greenhouse-monitor/client/color.js';

const P = {                       // дані завдання: замініть на свої
  T: 60, p: 0.05, delta: 0.5,     // період, с; частка втрат; розкид, с
  n: 40, cards: 2,                // пристроїв на екрані; карток на пристрій
  falseMax: 1, silenceMax: 300,   // хибних на екран за добу; тиша, с
  ageMax: 150,                    // найстаріше здорове показання, с
  U: 20, trafficMax: 300,         // екранів; МБ на добу на екран
  B: 350, ranges: ['1h', '24h', '7d'],
  palette: { ok: '#2E7D32', warn: '#F9A825',
    crit: '#C62828', off: '#757575' },
};
const R_READ = 4000;              // запитів на читання за секунду
const g = (x) => Number(x.toPrecision(4));          // 4 значущі цифри
const r6 = (x) => Number(x.toFixed(6));
const col = (x, w) => String(x).padStart(w);

// 1. Число періодів k до «Немає даних» (4.1)
const total = P.n * P.cards;                         // карток на екрані
const W = [1, 11, 14, 13, 6];                        // ширини стовпців
const row = (cells) => cells.map((x, i) => col(x, W[i])).join('  ');
const rows = [];
console.log(row(['k', 'P_хиб, %', 'на картку/добу', 'на екран/добу',
  'k·T, с']) + '  допуск');
for (let k = 2; k <= 6; k += 1) {
  const pk = P.p ** k;                               // (4.1)
  const card = (86400 / P.T) * (1 - P.p) * pk;
  const ok = card * total <= P.falseMax && k * P.T <= P.silenceMax;
  rows.push({ k, ok });
  console.log(row([k, g(100 * pk), g(card), g(card * total), k * P.T]) +
    `  ${ok ? 'так' : 'ні'}`);
}
const k = rows.find((r) => r.ok).k;
console.log(`Найменше допустиме k = ${k}`);

// 2. Період опитування карток P (4.2)
const bk = r6((k - 1) * P.T - P.delta);              // P < bk
const ba = r6(P.ageMax - P.T - P.delta);             // T + P + δ ≤ ageMax
const poll = Math.min(Math.ceil(bk) - 1, Math.floor(ba));
console.log(`Межа за k: P < ${bk}; межа за віком: P ≤ ${ba}; ` +
  `P = ${poll} с`);

// 3. Контраст тексту на кольорах статусів (4.3)
for (const [state, color] of Object.entries(P.palette)) {
  const w = contrast(color, '#FFFFFF');
  const b = contrast(color, '#000000');
  console.log(`${state.padEnd(5)}${color}  білий ${w.toFixed(2)}  ` +
    `чорний ${b.toFixed(2)}  текст ${w >= b ? 'white' : 'black'}`);
}

// 4. Інтервали діапазонів і початковий діапазон (4.4)
const SEC = { '1h': 3600, '24h': 86400, '3d': 259200,
  '7d': 604800, '14d': 1209600, '30d': 2592000 };
let first = null;
for (const name of P.ranges) {
  const R = SEC[name] * 1000;                        // вікно, мс
  const raw = R / (P.T * 1000);                      // сирих точок R / T
  const d = raw <= P.B ? null : INTERVALS.find(
    ([, ms]) => ms >= P.T * 1000 && R / ms <= P.B);  // (4.4)
  const points = d ? R / d[1] : raw;
  if (!first && raw >= 24) first = name;
  console.log(`${name.padEnd(4)} сирих ${raw}, інтервал ` +
    `${d ? d[0] : '—'}, точок ${points}`);
}
console.log(`Початковий діапазон: ${first}`);

// 5. Ємність опитування карток (4.8)
const share = (rps) => rps / (R_READ / 3);           // частка порога
const load = (P.U * P.n) / poll;                     // запитів за секунду
const nMax = Math.floor((R_READ * poll) / (3 * P.U));
const traffic = ((86400 / poll) * P.n * 0.4) / 1000; // МБ на добу
const trafficOk = traffic <= P.trafficMax;
const mode = share(load) <= 0.5 && trafficOk ? 'per_device'
  : share(P.U / poll) <= 0.5 && trafficOk ? 'group' : 'stream';
console.log(`Навантаження ${g(load)} запитів/с, ` +
  `${g(100 * share(load))} % порога; n_max ${nMax}`);
console.log(`Трафік екрана ${g(traffic)} МБ/добу; режим ${mode}`);
