// pr05/calc.mjs: розрахунки ПР5 (формули 5.2-5.4); блок P - з додатків
import { readFileSync } from 'node:fs';

const J = JSON.parse(readFileSync('track.json', 'utf8'));
const k = J.pr04.k, P04 = J.pr04.poll_s;        // результати ПР4
const P = {
  T: 60, deltaS: 0.5, silenceMaxS: 300,         // звітування, межі
  rttMs: 300, skewS: 100,                       // телефон
  mtu: 23, L: 54, wifiS: 10, maxWaitS: 90,      // прив'язка
};
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const c = (x) => String(r6(x)).replace('.', ',');

// BLE (5.3): n = ceil((L + 2) / (MTU - 3)); запис на подію зв'язку 30 мс
const n = Math.ceil((P.L + 2) / (P.mtu - 3));
const last = P.L + 2 - (n - 1) * (P.mtu - 3);
console.log(`BLE: записів ${n}, останній ${last} Б, ${n * 30} мс`);

// Прив'язка (5.4): строк >= t_Wi-Fi + T
const need = P.wifiS + P.T;
const mode = need <= 60 ? 'default'
  : need <= P.maxWaitS ? 'extended' : 'async';
const deadline = { default: 60, extended: need, async: null }[mode];
const polls = deadline && Math.floor(deadline / 3) + 1;
console.log(`Прив'язка: потрібно ${need} с, режим ${mode},`,
  `строк ${deadline}, опитувань ${polls}`);

// Годинник (5.2): eps = 0,5 с + RTT / 2
const eps = 0.5 + P.rttMs / 2000;
const margin = k * P.T - (P.T + P04 + P.deltaS); // до хибного сірого
const behind = P.silenceMaxS - k * P.T;          // до запізнілої тиші
const verdict = P.skewS > 0
  ? (P.skewS > margin ? 'false_gray' : 'ok')
  : (-P.skewS > behind ? 'late' : 'ok');
const fits = eps <= margin && eps <= behind;
const poll = Math.min(P04, Math.floor(r6((k - 1) * P.T - P.deltaS - eps)));
console.log(`eps = ${c(eps)} с; запас ${c(margin)} с,`,
  `запізнення ${c(behind)} с`);
console.log(`Зсув ${P.skewS} с без виправлення: ${verdict};`,
  `після виправлення в межах запасу: ${fits}`);
console.log(`Період опитування мобільного клієнта: ${poll} с`);
