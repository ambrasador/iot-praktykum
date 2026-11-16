// pr03/calc.mjs: розрахунки ПР3 за формулами розділу 3
const P = {                      // дані паспорта: замініть на свої
  n: 40, m: 4, T: 60,            // пристроїв, вимірювань у звіті, період, с
  U: 600, memMB: 64,             // клієнтів; пам’ять під з’єднання, МБ
  fresh: 5000,                   // вимога свіжості, мс
  hot: 20, fanMs: 100,           // «гаряча» кімната; бюджет розсилання, мс
  deployS: 8,                    // найдовше розвантаження екземпляра, с
  k: 1,                          // на скільки кімнат розбито зону
  pol: { b: 1, c: 30, retry: 3 },   // політика перепідключення
};
const K = {                      // сталі довідки (3.7.1–3.7.6)
  eta: 0.5, C: 400,
  g: { sio: 17.6, sse: 25.8 },   // мкс на пару «кадр — отримувач»
  mem: { sio: 15, sse: 17 },     // КБ на з’єднання
  idle: { sio: 20, sse: 104 },   // байтів за 61 с простою
  frame: { sio: (w) => 61 + 68.5 * w, sse: (w) => 142.5 * w },
};
const frames = (86400 * P.n) / P.T;          // кадрів за добу на клієнта
const idle = (tr) => (86400 / 61) * K.idle[tr];
const day = {
  poll: (86400 / (P.fresh / 1000)) * 762 + frames * P.m * 123,
  sse: frames * K.frame.sse(P.m) + idle('sse'),
  sio: frames * K.frame.sio(P.m) + idle('sio'),
};
const mb = (x) => (x / 1e6).toFixed(3);
console.log(`Трафік за добу, МБ: опитування ${mb(day.poll)}, ` +
  `SSE ${mb(day.sse)}, Socket.IO ${mb(day.sio)}`);
const F = P.n / P.k / P.T;                   // кадрів за секунду на клієнта
for (const tr of ['sio', 'sse']) {
  const cpu = (K.eta * 1e6) / (F * K.g[tr]);        // (3.2)
  const mem = (P.memMB * 1024) / K.mem[tr];         // (3.3)
  const { b, c, retry } = P.pol;
  const s = tr === 'sio'
    ? Math.max(Math.min(1, 1.5 / b), 2 / c) : 1 / retry;
  const storm = K.C / s;                            // (3.4)
  const u = Math.min(cpu, mem, storm);              // (3.5)
  console.log(`${tr}: U_cpu ${cpu.toFixed(0)}, U_mem ${mem.toFixed(0)}, ` +
    `U_storm ${storm.toFixed(0)}, U_max ${u.toFixed(0)}`);
  const nMax = Math.floor((K.eta * 1e6 * P.T) / (K.g[tr] * P.U));
  const memNeed = Math.ceil((P.U * K.mem[tr]) / 1024);
  const kMax = Math.floor((P.fanMs * 1000) / K.g[tr]);
  console.log(`${tr}: кімната n ≤ ${nMax}, пам’ять ≥ ${memNeed} МБ, ` +
    `k_max ${kMax}`);
}
const rule = (x) => ((x * P.U) / K.C).toFixed(2);
console.log(`Правило: b ≥ ${rule(1.5)}, c ≥ ${rule(2)}, ` +
  `retry ≥ ${rule(1)}`);
const drain = (N) => P.U / N / (((N - 1) * K.C) / 2);   // п. 3.8.2
let N = 2;
while (drain(N) > P.deployS) N += 1;
console.log(`Екземплярів ${N}, розвантаження ${drain(N).toFixed(2)} с`);
