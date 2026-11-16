import { appPath } from '../app.mjs';
import fs from 'node:fs';
import { getPath } from '../track.mjs';
import { exists, read, number, rel, all } from '../verify-core.mjs';
import { pr03 as expect03 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import { runSmoke, parseEnv } from '../rt-bed.mjs';
import * as F from '../formulas.mjs';

const nums = (s) => [...s.matchAll(/\d[\d  ]*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')));
const int = (t, key, expected, hint = 'очікується ціле число, яке випливає з формули (див. завдання)') => {
  const v = getPath(t, key);
  return v === expected ? true : `${key} = ${JSON.stringify(v)}: ${hint}`;
};

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const rt = P.rt;
  const X = expect03(t.variant, P);
  const tr = X.transport;
  const envText = () => (exists('pr03', 'rt.env') ? read('pr03', 'rt.env') : '');
  const env = () => parseEnv(envText());
  let smoke = null;
  const getSmoke = () => (smoke ??= runSmoke({ variant: t.variant, rtEnv: { TOPIC_ROOT: P.topicRoot, ...env() } }));
  const smokeOk = async () => {
    const s = await getSmoke();
    if (!s.fatal) return null;
    const tail = s.logTail.length ? ` Журнал main.js: ${s.logTail.slice(-3).join(' | ')}` : '';
    return `стенд не відпрацював: ${s.errors.join('; ')}.${tail}`;
  };
  const storm = async () => {
    const { loadDelay, sweep } = await import('../storm.mjs');
    const rec = getPath(t, 'pr03.reconnect') ?? {};
    const policy = tr === 'sio' ? { kind: 'sio', b: rec.b_s, c: rec.c_s } : { kind: 'sse', retry: rec.retry_s };
    const ok = tr === 'sio' ? rec.b_s > 0 && rec.c_s > 0 : rec.retry_s > 0;
    if (!ok) return { error: tr === 'sio' ? 'pr03.reconnect.b_s і pr03.reconnect.c_s мають бути додатними числами (секунди)' : 'pr03.reconnect.retry_s має бути додатним числом (секунди)' };
    return { policy, ...sweep({ U: X.U, policy, seed: t.seed, delay: await loadDelay() }) };
  };
  const tuned = () => {
    const rec = getPath(t, 'pr03.reconnect') ?? {}; const k = getPath(t, 'pr03.tuned.room_split'); const mem = getPath(t, 'pr03.tuned.mem_mb');
    const uStorm = tr === 'sio' ? F.uStormSio(rec.b_s, rec.c_s) : F.uStormSse(rec.retry_s);
    const uCpu = F.uCpu(F.frameRate(rt.room.n / k, P.load.T), tr);
    const uMem = F.uMem(mem, tr);
    return { k, mem, uStorm, uCpu, uMem, uMax: Math.min(uStorm, uCpu, uMem) };
  };
  const adr3 = () => (exists('pr03', 'adr-003.md') ? read('pr03', 'adr-003.md') : '');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: ПР2 виконано (є історія, епізоди й requests.http)', run: () => {
      if (typeof getPath(t, 'pr02.episodes') !== 'number') return 'у track.json немає pr02.episodes: завершіть ПР2';
      return exists('pr02', 'requests.http') ? true : 'немає pr02/requests.http: завершіть ПР2';
    } },
    { level: 3, text: 'Трафік клієнта за добу, МБ: опитування, SSE, Socket.IO (формули п. 3.7.1 і константи довідки)', run: () => all(
      number(t, 'pr03.bytes_mb_day.poll', X.bytes.poll, 0.02, 'запитів за добу × 762 Б + вимірювань за добу × 123 Б; період опитування — вимога свіжості rt.latencyMs'),
      number(t, 'pr03.bytes_mb_day.sse', X.bytes.sse, 0.02, 'кадрів за добу × 142,5 Б × m + простій 104 Б за 61 с'),
      number(t, 'pr03.bytes_mb_day.sio', X.bytes.sio, 0.02, 'кадрів за добу × (61 + 68,5 · m) + простій 20 Б за 61 с')) },
    { level: 3, text: 'Транспорт обрано з урахуванням обмежень паспорта (WebSocket, зворотний напрям) і ціни трафіку', run: () => {
      const v = getPath(t, 'pr03.transport');
      if (!['sio', 'sse'].includes(v)) return `pr03.transport = ${JSON.stringify(v)}: очікується "sio" або "sse"`;
      return v === tr ? true : 'вибір суперечить обмеженням паспорта (rt.wsBlocked, rt.duplex) або дорожчий за трафіком; опитування як основний канал не розглядається';
    } },
    { level: 3, text: 'Ємність одного процесу за політикою за замовчуванням: U_cpu, U_mem, U_storm, U_max, що обмежує', run: () => all(
      number(t, 'pr03.capacity.u_cpu', X.cap.u_cpu, 0.02, 'F_cl = n / T кадрів за секунду; g за обраним транспортом'),
      number(t, 'pr03.capacity.u_mem', X.cap.u_mem, 0.02, 'M у МБ × 1024 / m у КБ (1 МБ = 1024 КБ, як у прикладі підручника)'),
      number(t, 'pr03.capacity.u_storm', X.cap.u_storm, 0.02, tr === 'sio' ? 'за замовчуванням b = 1 с, c = 30 с' : 'за замовчуванням retry = 3 с'),
      number(t, 'pr03.capacity.u_max', X.cap.u_max, 0.02, 'найменше з трьох'),
      getPath(t, 'pr03.capacity.binding') === X.cap.binding ? true : `pr03.capacity.binding: очікується одне з "cpu", "mem", "storm" — те, що дає найменше значення`,
      getPath(t, 'pr03.fits_default') === X.fits_default ? true : 'pr03.fits_default (true/false): чи вміщує процес усіх клієнтів rt.clients за політикою за замовчуванням') },
    { level: 3, text: 'Застосунок запускається з доменом: main.js слухає корінь топіків, приймання без відхилень, rt.env містить TOPIC_ROOT', run: async () => {
      const e = await smokeOk(); if (e) return e;
      const s = await getSmoke();
      if (s.stored === 0) return 'жодного вимірювання не збережено: main.js слухає лише greenhouse/+/telemetry? Перевірте filter у main.js (змінна TOPIC_ROOT) і TOPIC у mqtt-source.js (ПР1)';
      if (s.rejected.length) return `приймання відхилило вимірювання: ${s.rejected.map((x) => `${x.reason} ${x.n}`).join(', ')} (метрики й діапазони з ПР1)`;
      if (s.stored !== s.published) return `збережено ${s.stored} із ${s.published} опублікованих`;
      return env().TOPIC_ROOT === P.topicRoot ? true : `у pr03/rt.env немає рядка TOPIC_ROOT=${P.topicRoot}`;
    } },
    { level: 3, text: 'Доставка без пропусків і зайвих точок у Socket.IO й SSE після перезапуску застосунку посеред потоку', run: async () => {
      const e = await smokeOk(); if (e) return e;
      const s = await getSmoke();
      const bad = [];
      for (const [name, r] of [['Socket.IO', s.sio], ['SSE', s.sse]]) {
        if (r.gaps) bad.push(`${name}: пропусків ${r.gaps}`);
        if (r.extras) bad.push(`${name}: зайвих точок ${r.extras}`);
      }
      if (s.clients_connected < s.sio.clients + s.sse.clients) bad.push(`після перезапуску повернулися лише ${s.clients_connected} клієнтів`);
      return bad.length ? `${bad.join('; ')}. Запустіть node kit/tools/rt-smoke.mjs і перегляньте журнал` : true;
    } },
    { level: 3, text: 'Команда проходить через брокер домену: POST → <корінь>/<пристрій>/commands → підтвердження → стан acked', run: async () => {
      const e = await smokeOk(); if (e) return e;
      const c = (await getSmoke()).command;
      if (!c) return 'у паспорті немає команд';
      if (c.http !== 202) return `POST команди дав ${c.http}`;
      if (!c.delivered) return 'пристрій не отримав команду: перевірте тему публікації в mqtt-commands.js (root)';
      return c.final === 'acked' ? true : `команда лишилась у стані «${c.final}»: підтвердження <корінь>/<пристрій>/acks не дійшло (підписка в mqtt-commands.js)`;
    } },

    // ---------- рівень 4 ----------
    { level: 4, text: 'Вікно шини: window_ms покриває розкид повідомлень звіту, у rt.env, один кадр на звіт, затримка в межах вимоги', run: async () => {
      const w = getPath(t, 'pr03.window_ms');
      if (!Number.isInteger(w)) return 'pr03.window_ms має бути цілим числом мілісекунд';
      if (w < X.window.lo || w > X.window.hi) return `window_ms = ${w}: вікно має бути не меншим за розкид повідомлень одного звіту (rt.spreadMs = ${rt.spreadMs}) і не більшим за половину вимоги свіжості (${X.window.hi} мс)`;
      if (Number(env().RT_WINDOW_MS) !== w) return `у pr03/rt.env має бути RT_WINDOW_MS=${w}`;
      const e = await smokeOk(); if (e) return e;
      const s = await getSmoke();
      if (!(s.frames_per_report >= 0.95 && s.frames_per_report <= 1.05)) return `кадрів на звіт ${s.frames_per_report.toFixed(2)} (очікується 1): вікно коротше за розкид звіту або довше за період`;
      return s.latency_p95_ms <= rt.latencyMs ? true : `затримка p95 = ${Math.round(s.latency_p95_ms)} мс перевищує вимогу ${rt.latencyMs} мс`;
    } },
    { level: 4, text: 'Політика перепідключення задовольняє правило п. 3.7.6 (b ≥ 1,5·U/C і c ≥ 2·U/C; для SSE retry ≥ U/C)', run: () => {
      const r = getPath(t, 'pr03.reconnect') ?? {};
      if (tr === 'sio') {
        if (!Number.isFinite(r.b_s) || !Number.isFinite(r.c_s)) return 'pr03.reconnect.b_s і pr03.reconnect.c_s мають бути числами (секунди)';
        if (!(r.b_s >= X.rule.b)) return `b_s = ${r.b_s}: правило дає не менше ${(X.rule.b).toFixed(2)} с для U = ${X.U}, C = ${F.RT.C}`;
        if (!(r.c_s >= X.rule.c) || r.c_s < r.b_s) return `c_s = ${r.c_s}: межа має бути не меншою за ${(X.rule.c).toFixed(2)} с і не меншою за b_s`;
        return true;
      }
      if (!Number.isFinite(r.retry_s)) return 'pr03.reconnect.retry_s має бути числом (секунди)';
      if (!(r.retry_s >= X.rule.retry)) return `retry_s = ${r.retry_s}: правило дає не менше ${X.rule.retry.toFixed(2)} с`;
      return Number(env().RT_SSE_RETRY_MS) === Math.round(r.retry_s * 1000) ? true : `у pr03/rt.env має бути RT_SSE_RETRY_MS=${Math.round(r.retry_s * 1000)}`;
    } },
    { level: 4, text: 'Імітація шторму (kit/tools/storm-sim.mjs): найгірший пік ≤ C, медіана повернення в межах вимоги, числа збігаються з журналом', run: async () => {
      const s = await storm(); if (s.error) return s.error;
      const peak = getPath(t, 'pr03.storm.peak_per_s'); const med = getPath(t, 'pr03.storm.median_return_s');
      if (s.worst.peak > F.RT.C) return `найгірший пік ${s.worst.peak} підкл./с перевищує C = ${F.RT.C}: збільште ${tr === 'sio' ? 'b' : 'retry'} і повторіть імітацію (правило дає лише нижню межу)`;
      if (s.median0 > rt.returnMaxS) return `медіана повернення ${s.median0.toFixed(1)} с перевищує вимогу ${rt.returnMaxS} с: політика надто повільна`;
      if (!Number.isFinite(peak) || Math.abs(peak - s.worst.peak) > Math.max(1, 0.005 * s.worst.peak)) return `pr03.storm.peak_per_s = ${peak}: імітація за вашою політикою й зерном ${t.seed} дає інше значення — перенесіть «Найгірший пік» із виводу kit/tools/storm-sim.mjs`;
      return Number.isFinite(med) && Math.abs(med - s.median0) <= 0.06 ? true : `pr03.storm.median_return_s = ${med}: перенесіть «Медіана повернення (D = 0)» із виводу storm-sim.mjs`;
    } },
    { level: 4, text: 'Ємність після налаштування: що обмежує тепер, розбиття кімнати / пам\'ять, U_max ≥ U; обсяг узгодження після перезапуску', run: () => {
      const k = getPath(t, 'pr03.tuned.room_split'); const mem = getPath(t, 'pr03.tuned.mem_mb');
      if (!Number.isInteger(k) || k < 1) return 'pr03.tuned.room_split має бути цілим числом ≥ 1 (на скільки кімнат розбито зону; 1 — без розбиття)';
      if (!(mem > 0)) return 'pr03.tuned.mem_mb має бути додатним числом (МБ під з\'єднання; без змін — значення з паспорта)';
      const u = tuned();
      const rec = getPath(t, 'pr03.reconnect') ?? {};
      if (!(rec.b_s > 0 || rec.retry_s > 0)) return 'спершу заповніть pr03.reconnect';
      const fits = u.uMax >= X.U - 1e-6;
      const r = all(
        number(t, 'pr03.tuned.u_max', u.uMax, 0.02, 'найменше з U_cpu (кімната n / room_split), U_mem (mem_mb), U_storm (ваша політика)'),
        getPath(t, 'pr03.tuned.fits') === fits ? true : 'pr03.tuned.fits (true/false) не збігається з порівнянням U_max ≥ U');
      if (r !== true) return r;
      if (!fits) return `U_max = ${Math.round(u.uMax)} < U = ${X.U}: обмежує ${u.uMax === u.uCpu ? 'процесор — розбийте зону на кілька кімнат' : u.uMax === u.uMem ? 'пам\'ять — збільште бюджет' : 'шторм — збільште b або retry'}`;
      const points = getPath(t, 'pr02.points');
      if (!Number.isFinite(points)) return 'немає pr02.points (ПР2, рівень 4): без нього не порахувати обсяг узгодження';
      return all(int(t, 'pr03.resync.rows', points, 'рядків узгодження має бути стільки, скільки точок графіка в pr02.points'),
        number(t, 'pr03.resync.mb_total', (X.U * points * 46.9) / 1e6, 0.03, 'U клієнтів × pr02.points рядків × 46,9 Б на рядок відповіді (ПР2: 1000 рядків = 46 878 Б)'));
    } },

    // ---------- рівень 5 ----------
    { level: 5, text: 'Гаряча кімната: k_max за бюджетом затримки розсилання (k·g ≤ бюджет) і на скільки кімнат розбити', run: () => all(
      number(t, 'pr03.k_max', X.k_max, 0.01, 'k_max = бюджет (мс) × 1000 / g (мкс) для обраного транспорту'),
      int(t, 'pr03.rooms_hot', X.rooms_hot, 'кімнат має бути ⌈отримувачів у гарячій кімнаті / k_max⌉ (округлення вгору)')) },
    { level: 5, text: 'Розгортання без шторму: мінімальна кількість екземплярів і час розвантаження одного (U / N / ((N − 1)·C / 2))', run: () => all(
      int(t, 'pr03.instances', X.instances, 'екземплярів має бути стільки, скільки дає найменше N ≥ 2, за якого (U / N) / ((N − 1)·C / 2) не перевищує часу розгортання'),
      number(t, 'pr03.drain_s', X.drain_s, 0.03, 'час = (U / N) / ((N − 1) · C / 2)')) },
    { level: 5, text: 'Захист від повільного клієнта: ліміт черги в допустимих межах, у rt.env, main.js його читає', run: () => {
      const q = getPath(t, 'pr03.queue_limit');
      if (!Number.isFinite(q)) return `pr03.queue_limit (${X.queue.unit}) — число`;
      if (q < X.queue.lo) return `queue_limit = ${q} нижчий за ${X.queue.lo}: короткий збій мережі (rt.stallS = ${rt.stallS} с) відключатиме справних клієнтів`;
      if (q > X.queue.hi) return `queue_limit = ${q} вищий за ${X.queue.hi}: один повільний клієнт займе більше за rt.queueKB = ${rt.queueKB} КБ`;
      if (Number(env()[X.queue.env]) !== q) return `у pr03/rt.env має бути ${X.queue.env}=${q}`;
      const main = fs.readFileSync(appPath('main.js'), 'utf8');
      const opt = tr === 'sio' ? 'maxQueue' : 'maxBuffered';
      return main.includes(X.queue.env) && main.includes(opt) ? true : `main.js не читає ${X.queue.env} і не передає ${opt}`;
    } },
    { level: 5, text: 'ADR-003 (канал реального часу): транспорт, вікно, політика перепідключення, екземпляри, ліміт черги, тригер перегляду', run: () => {
      const a = adr3();
      if (!a) return 'немає pr03/adr-003.md (шаблон: kit/templates/adr.md)';
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки', 'Тригер'].filter((h) => !new RegExp(`^#+\\s*${h}`, 'mi').test(a));
      if (miss.length) return `У ADR-003 бракує розділів: ${miss.join(', ')}`;
      const have = nums(a);
      const rec = getPath(t, 'pr03.reconnect') ?? {};
      const need = [['window_ms', getPath(t, 'pr03.window_ms')], ['instances', getPath(t, 'pr03.instances')], ['queue_limit', getPath(t, 'pr03.queue_limit')],
        tr === 'sio' ? ['b_s', rec.b_s] : ['retry_s', rec.retry_s]].filter(([, v]) => Number.isFinite(v));
      const lost = need.filter(([, v]) => !have.some((x) => rel(x, v, 0.001)));
      return lost.length ? `У ADR-003 немає чисел: ${lost.map(([n, v]) => `${n} = ${v}`).join(', ')}` : true;
    } },
  ];
}
