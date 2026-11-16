// pr08/calc.mjs: розрахунки ПР8 (підрозділи 7.5.2, 7.5.4, 7.9.1, 7.9.2)
// Запуск з кореня практикуму: node pr08/calc.mjs
const P = {                        // дані з ops-inputs.mjs
  slo: 99.9, errors: [0.02, 0.01], // мета, %; частки помилок e1 і e2
  N: 200, m: 4, T: 60,             // потік показань
  silenceMaxS: 380,                // тишу видно не пізніше, с
  detectS: 45, startS: 5,          // проба: збій видно за, старт, с
  flushS: 22.5,                    // pr06.limit.flush_s із track.json
};
const PAIRS = [                    // [пара, k, довге вікно W, год]
  ['fast', 14.4, 1], ['slow', 6, 6], ['ticket', 1, 72]];
const STEPS = [[60, 15], [30, 10], [15, 5]];  // правила / збір, с
const round = (x, d) => Number(x.toFixed(d));

// 1. Бюджет помилок (7.9.1): b = 1 - SLO / 100
const b = round(1 - P.slo / 100, 9);
console.log(`b = ${b}; бюджет ${round(b * 30 * 1440, 4)} хв за 30 діб`);
for (const [id, k] of PAIRS)
  console.log(`поріг ${id}: ${round(k * b, 9)}`);

// 2. Час спрацювання t = k * b * W / e, хв (7.9.1, формула 7.1)
for (const [id, k, W] of PAIRS) for (const e of P.errors) {
  const t = round(k * b * W * 60 / e, 2);
  console.log(e > k * b
    ? `${id}, e = ${e}: t = ${t} хв`
    : `${id}, e = ${e}: немає, e не більша за поріг`);
}

// 3. Тиша (7.9.2): затримка = поріг 5T + крок правил + крок збору
const threshold = 5 * P.T;
const delay = ([ev, sc]) => threshold + ev + sc;
console.log(`поріг тиші ${threshold} с`);
for (const s of STEPS) console.log(`кроки ${s.join('/')} с:`,
  `затримка ${delay(s)} с,`,
  delay(s) <= P.silenceMaxS ? 'підходить' : 'не підходить');
const pick = STEPS.find((s) => delay(s) <= P.silenceMaxS);
const lambda = P.N * P.m / P.T;
console.log(`обрано ${pick.join('/')}; λ = ${round(lambda, 2)} /с;`,
  `втрачено до ${Math.round(lambda * delay(pick))} показань`);

// 4. Compose (7.5.2, 7.5.4): зупинка й проба працездатності
const grace = Math.max(10, Math.ceil(P.flushS) + 2);
const timeout = 3, retries = 3;
const interval = Math.max(5,
  Math.floor((P.detectS - timeout) / retries));
console.log(`stop_grace_period ${grace} с`);
console.log(`interval ${interval} с, збій видно за`,
  `${interval * retries + timeout} с, start_period`,
  `${Math.ceil(P.startS) + 4} с`);
