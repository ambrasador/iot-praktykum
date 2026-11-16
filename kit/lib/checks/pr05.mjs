import { getPath } from '../track.mjs';
import { exists, read, number, rel, all } from '../verify-core.mjs';
import { appRequire } from '../app.mjs';
import { pr05 as expect05 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import * as L from '../mob-lab.mjs';

const nums = (s) => [...s.matchAll(/\d[\d  ]*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')));
const exact = (t, key, expected, hint = '') => {
  const v = getPath(t, key);
  return v === expected ? true : `${key} = ${JSON.stringify(v)}, очікується ${JSON.stringify(expected)}${hint ? `. ${hint}` : ''}`;
};

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const mob = P.mob; const T = P.load.T;
  let X = null;
  const ex = async () => (X ??= await expect05(t.variant, P, t.seed));
  const kStudent = () => getPath(t, 'pr04.k');
  let pushMod = null;
  // Завантаження push.js студента: помилка в коді стає підказкою
  const loadPush = () => {
    if (pushMod) return pushMod;
    try { pushMod = { push: appRequire('./push') }; } catch (e) { pushMod = { error: `push.js не завантажується: ${e.message.split('\n')[0]}` }; }
    return pushMod;
  };
  const rulesOf = () => {
    const m = loadPush();
    if (m.error) return { error: m.error };
    const rules = m.push[`RULES_${P.code}`];
    if (!(rules instanceof Map)) return { error: `push.js не експортує RULES_${P.code} (Map метрика → правило). Додайте карту правил домену й експортуйте її поруч з RULES` };
    return { push: m.push, rules };
  };
  const adr = () => (exists('pr05', 'adr-005.md') ? read('pr05', 'adr-005.md') : '');
  const ttl = () => getPath(t, 'pr05.push.ttl_s');
  const maxAge = () => getPath(t, 'pr05.push.max_age_s');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: ПР3 (канал) і ПР4 (k і період опитування карток) виконано', run: async () => {
      const x = await ex();
      if (!['sio', 'sse'].includes(getPath(t, 'pr03.transport'))) return 'у track.json немає pr03.transport: завершіть ПР3';
      const k = kStudent();
      if (!x.ks.includes(k)) return `pr04.k = ${JSON.stringify(k)} не належить допустимим для вашого варіанта: завершіть ПР4 (рівень «3»)`;
      const f = x.forK(k);
      if (getPath(t, 'pr04.poll_s') !== f.P04) return `pr04.poll_s = ${JSON.stringify(getPath(t, 'pr04.poll_s'))}, а за вашим k має бути ${f.P04}: виправте ПР4`;
      return true;
    } },
    { level: 3, text: 'BLE і прив’язка: записів у характеристику (формула 5.3), строк очікування онлайну (формула 5.4) і режим прив’язки', run: async () => {
      const x = await ex(); const b = x.ble; const pv = x.prov;
      return all(
        exact(t, 'pr05.ble.writes', b.writes, `n = ⌈(L + 2) / (MTU − 3)⌉ при L = ${b.L} Б, MTU = ${b.mtu}`),
        exact(t, 'pr05.ble.last_bytes', b.last_bytes, 'розмір останнього запису: (L + 2) − (n − 1) · (MTU − 3)'),
        exact(t, 'pr05.ble.time_ms', b.time_ms, 'n · 30 мс (припущення підручника: один запис на подію зв’язку з інтервалом 30 мс)'),
        number(t, 'pr05.prov.need_s', pv.need, 0.001, 't_Wi-Fi + t_перше, де прошивка надсилає перше вимірювання не раніше ніж через період T'),
        exact(t, 'pr05.prov.mode', pv.mode, `default — потрібно ≤ 60 с; extended — більше за 60 с, але не більше за ${mob.maxWaitS} с (час, який користувач готовий чекати); async — більше`),
        exact(t, 'pr05.prov.deadline_s', pv.deadline, 'default → 60; extended → потрібний час; async → null'),
        exact(t, 'pr05.prov.polls', pv.polls, 'опитувань Wi-Fi кожні 3 с: ⌊строк / 3⌋ + 1; для async — null'));
    } },
    { level: 3, text: 'Годинник телефона: похибка оцінки (формула 5.2), запас до хибного «Немає даних», вердикт зсуву, період опитування мобільного клієнта', run: async () => {
      const x = await ex(); const k = kStudent();
      if (!x.ks.includes(k)) return 'спершу виправте pr04.k';
      const f = x.forK(k);
      return all(
        number(t, 'pr05.clock.eps_s', f.eps, 0.01, 'ε = 0,5 с + RTT / 2'),
        number(t, 'pr05.clock.margin_s', f.margin, 0.005, `запас k · T − (T + P + δ), де P = pr04.poll_s = ${f.P04} с, δ = ${x.deltaS} с`),
        number(t, 'pr05.clock.behind_s', f.behind, 0.001, `запас затримки виявлення мовчання: ${x.ui.silenceMaxS} − k · T`),
        exact(t, 'pr05.clock.uncorrected', f.uncorrected, `зсув телефона ${mob.skewS > 0 ? '+' : ''}${mob.skewS} с без виправлення: false_gray — картка хибно сіріє (зсув вперед більший за запас); late — мовчання помічають із запізненням (зсув назад більший за запас затримки); ok — у межах запасу`),
        exact(t, 'pr05.clock.corrected_ok', f.corrected_ok, 'після виправлення лишається похибка ε: вона має вміщатися і в запас хибного «Немає даних», і в запас затримки'),
        exact(t, 'pr05.clock.poll_s', f.poll_s, 'найбільше ціле P ≤ P з ПР4, для якого запас хибного «Немає даних» ≥ ε: P ≤ (k − 1) · T − δ − ε'));
    } },
    { level: 3, text: 'Шум датчика метрики сповіщення: σ на всьому ряді й на спокійній ділянці, множник k для допустимих повторів, гістерезис h (формули 5.6 і 5.8)', run: async () => {
      const x = await ex(); const nz = x.noise;
      const rec = getPath(t, 'pr05.noise') ?? {};
      const bad = all(
        rec.metric === nz.metric ? true : `pr05.noise.metric = ${JSON.stringify(rec.metric)}, очікується "${nz.metric}" (метрика сповіщення ПР2)`,
        rec.device === nz.device ? true : `pr05.noise.device = ${JSON.stringify(rec.device)}, очікується "${nz.device}" (перший пристрій із цією метрикою)`,
        number(t, 'pr05.noise.sigma_all', nz.sigma_all, 0.02, 'std(Δv) / √2 за всіма різницями сусідніх показань'),
        number(t, 'pr05.noise.sigma_calm', nz.sigma_calm, 0.02, 'те саме без вікон ±1 год навколо подій (kit/tools/noise.mjs друкує обидва числа)'),
        number(t, 'pr05.noise.k', nz.k, 0.015, `Q(k) ≤ R / (N − 2R) (формула 5.8 для R = 1) при N = ${nz.N} показань за добу і R = ${nz.R} повторних сповіщень на добу; k знаходить kit/tools/qinv.mjs`),
        number(t, 'pr05.noise.h_min', nz.h_min, 0.03, 'h_min = k · σ на спокійній ділянці'));
      if (bad !== true) return bad;
      const h = rec.h;
      if (!Number.isFinite(h) || h <= 0) return `pr05.noise.h = ${JSON.stringify(h)}: очікується додатне число — обраний гістерезис`;
      const A = nz.alertsAt(h);
      if (h < 0.97 * nz.h_min) return `h = ${h} дає за формулою 5.5 ≈ ${A.toFixed(1)} сповіщення на добу, а допустимо 1 + ${nz.R}: гістерезис не менший за h_min = ${nz.h_min.toFixed(2)} (округлюйте вгору до розрядності метрики)`;
      if (h > nz.room) return `h = ${h} більший за запас між нормою (${nz.baseline}) і порогом попередження (${nz.card.rule.warn}): ${nz.room}. Рівень ніколи не знімається`;
      return true;
    } },
    { level: 3, text: 'push.js: карта RULES_<код> із правилами карток домену; тести зелені й ловлять зміну порога (мутації warn + 1, crit + 1)', run: async () => {
      const x = await ex();
      const r = rulesOf();
      if (r.error) return r.error;
      const bad = [];
      for (const [i, item] of x.rules.entries()) {
        const c = item.card; const got = r.rules.get(c.metric);
        if (!got) { bad.push(`${c.metric}: правила в RULES_${P.code} немає`); continue; }
        const want = { op: L.opOf(c.rule.direction), warn: c.rule.warn, crit: c.rule.crit, label: c.label, unit: c.unit, decimals: c.decimals };
        for (const [key, v] of Object.entries(want)) if (got[key] !== v) bad.push(`${c.metric}.${key} = ${JSON.stringify(got[key])}, очікується ${JSON.stringify(v)}`);
        const hWant = i === 0 ? getPath(t, 'pr05.noise.h') : item.hysteresis;
        if (got.hysteresis !== hWant) bad.push(`${c.metric}.hysteresis = ${JSON.stringify(got.hysteresis)}, очікується ${JSON.stringify(hWant)}${i === 0 ? ' (pr05.noise.h)' : ' (задано варіантом)'}`);
      }
      for (const key of r.rules.keys()) if (!x.rules.some((q) => q.metric === key)) bad.push(`${key}: зайве правило, якого немає серед карток домену`);
      if (bad.length) return bad.slice(0, 5).join('; ');
      const base = L.testsRun(['push.test.js']);
      if (!base.ok) return `тести push.test.js червоні (${base.fail}): ${base.failed.slice(0, 3).join('; ')}. Після змін RULES і buildMessage оновіть тест збіжності правил з client/domain.js для домену ${P.code}`;
      const first = x.rules[0].metric; const last = x.rules.at(-1).metric;
      const m1 = L.testsRun(['push.test.js'], { mutate: L.mutationJs(P.code, first, 'warn', 1) });
      if (m1.ok) return `тести не помітили зміну warn метрики ${first} на +1: потрібен тест, що порівнює RULES_${P.code} із client/domain.js (op, warn, crit, label, unit, decimals) для всіх метрик домену`;
      const m2 = L.testsRun(['push.test.js'], { mutate: L.mutationJs(P.code, last, 'crit', 1) });
      if (m2.ok) return `тести не помітили зміну crit метрики ${last} на +1: порівнюйте пороги кожної метрики, а не лише першої`;
      return true;
    } },
    { level: 3, text: 'Правила під навантаженням: шум біля порога тривоги, спад і повернення до норми — через createAlertTracker із вашими правилами', run: async () => {
      const x = await ex();
      const r = rulesOf();
      if (r.error) return r.error;
      const bad = [];
      for (const item of x.rules) {
        let d;
        try { d = L.declineRun(r.push, r.rules, item.card, item.baseline, T); } catch (e) { return `${item.metric}: tracker впав: ${e.message}`; }
        if (JSON.stringify(d.once) !== JSON.stringify(d.expected.once)) bad.push(`${item.metric}: спад дав ${JSON.stringify(d.once)}, очікується ${JSON.stringify(d.expected.once)} — перевірте напрямок і пороги`);
        else if (JSON.stringify(d.twice) !== JSON.stringify(d.expected.twice)) bad.push(`${item.metric}: після повернення до норми (${item.baseline}) другий спад дав ${JSON.stringify(d.twice)}, очікується ${JSON.stringify(d.expected.twice)} — гістерезис ${r.rules.get(item.metric).hysteresis} більший за запас між нормою й порогом, рівень не знімається`);
      }
      if (bad.length) return bad.slice(0, 3).join('; ');
      const sigma = x.noise.sigma_calm;
      const c = L.chatter(r.push, r.rules, t.variant, P, t.seed, x.noise.card, sigma, 30);
      if (c.student_mean > c.limit) return `шум біля порога ${x.noise.card.rule.crit} (σ = ${sigma.toFixed(2)}) дав у середньому ${c.student_mean.toFixed(1)} сповіщення на добу, а еталонний гістерезис h_min = ${x.noise.h_min.toFixed(2)} — ${c.ref_mean.toFixed(1)} (межа ${c.limit.toFixed(1)}). Збільште h`;
      return true;
    } },

    // ---------- рівень 4 ----------
    { level: 4, text: 'Повідомлення за правилами домену: значення з decimals метрики, одиниця, заголовок; диспетчер приймає rules, імітація FCM не знаходить порушень', run: async () => {
      const r = rulesOf();
      if (r.error) return r.error;
      const del = await L.deliveryRun(r.push, r.rules, t.variant, P);
      const bad = [];
      for (const row of del.rows) {
        if (row.error) { bad.push(`${row.metric}: ${row.error}. Правила мають передаватися через opts.rules у buildMessage і параметр rules у createDispatcher`); continue; }
        if (row.result !== 'sent') { bad.push(`${row.metric}/${row.level}: результат «${row.result}», очікується «sent»`); continue; }
        if (row.got.title !== row.exp.title) bad.push(`${row.metric}: заголовок «${row.got.title}», очікується «${row.exp.title}»`);
        else if (row.got.body !== row.exp.body) bad.push(`${row.metric}: тіло «${row.got.body}», очікується «${row.exp.body}» — значення за decimals метрики, одиниця через пробіл (порожня одиниця без зайвого пробілу)`);
      }
      if (del.rejected.length) bad.push(`імітація FCM відхилила повідомлення: ${JSON.stringify(del.rejected[0])}`);
      return bad.length ? [...new Set(bad)].slice(0, 3).join('; ') : true;
    } },
    { level: 4, text: 'Строк актуальності й розмір: PUSH_<код> у push.js (TTL, найбільший вік події не більший за TTL), тест на цю умову, байти повідомлення', run: async () => {
      const x = await ex();
      const r = rulesOf();
      if (r.error) return r.error;
      const cfg = r.push[`PUSH_${P.code}`];
      if (!cfg || typeof cfg !== 'object') return `push.js не експортує PUSH_${P.code} = { rules, ttlSec, maxAgeMs }: єдине місце, де домен задає строки доставки (rules — це RULES_${P.code})`;
      if (cfg.rules !== r.rules) return `PUSH_${P.code}.rules має бути тією самою картою, що RULES_${P.code}`;
      if (cfg.ttlSec !== x.push.ttl_s) return `PUSH_${P.code}.ttlSec = ${JSON.stringify(cfg.ttlSec)}, очікується ${x.push.ttl_s}: строк актуальності тривоги домену (паспорт, mob.alertStaleS)`;
      const maxAgeS = cfg.maxAgeMs / 1000;
      if (!(maxAgeS >= x.push.max_age_lo && maxAgeS <= x.push.max_age_hi)) return `PUSH_${P.code}.maxAgeMs = ${cfg.maxAgeMs}: потрібне число від ${x.push.max_age_lo * 1000} до ${x.push.max_age_hi * 1000} мс — tracker не має пропускати тривогу, яку диспетчер відкине за TTL, і не має відкидати свіжу`;
      const hint = all(
        exact(t, 'pr05.push.ttl_s', cfg.ttlSec, `журнал і код мають збігатися: PUSH_${P.code}.ttlSec`),
        exact(t, 'pr05.push.max_age_s', maxAgeS, `журнал і код мають збігатися: PUSH_${P.code}.maxAgeMs / 1000`));
      if (hint !== true) return hint;
      const run = await L.ttlRun(r.push, r.rules, { variant: t.variant, P, ttlS: cfg.ttlSec, maxAgeS });
      if (run.stale_pushed) return `tracker із maxAgeMs = ${cfg.maxAgeMs} пропустив тривогу віком ${run.oldAge} с, старшу за TTL ${cfg.ttlSec} с: диспетчер відкине її як expired${run.stale_result ? ` (результат «${run.stale_result}»)` : ''}, а рівень уже позначено як надісланий — тривога втрачена без сліду`;
      if (!run.fresh_pushed) return `tracker відкинув свіжу тривогу віком ${run.freshAge} с при maxAgeMs = ${cfg.maxAgeMs}`;
      const d = run.delivered;
      if (!d || d.result !== 'sent') return `свіжу тривогу не доставлено: результат «${d?.result}»`;
      if (d.ttl !== d.want_ttl) return `android.ttl = ${d.ttl}, очікується ${d.want_ttl} (залишок строку: TTL мінус вік тривоги)`;
      if (d.expiration !== d.want_expiration) return `apns-expiration = ${d.expiration}, очікується ${d.want_expiration}`;
      const m3 = L.testsRun(['push.test.js'], { mutate: `module.exports.PUSH_${P.code}.maxAgeMs = module.exports.PUSH_${P.code}.ttlSec * 1000 + 1000;` });
      if (m3.ok) return `тести не помітили maxAgeMs більший за TTL: додайте тест, що PUSH_${P.code}.maxAgeMs <= PUSH_${P.code}.ttlSec * 1000`;
      const al = L.sampleAlertForAlertMetric(t.variant, P, t.seed, x.hist);
      const sz = L.messageSizes(r.push, r.rules, al, L.deviceName(al.device), cfg.ttlSec);
      const rec = getPath(t, 'pr05.payload') ?? {};
      const bad = [];
      for (const [key, v] of [['total_b', sz.total_b], ['nd_b', sz.nd_b], ['collapse_b', sz.collapse_b]]) if (rec[key] !== v) bad.push(`${key} = ${JSON.stringify(rec[key])}, очікується ${v}`);
      if (!Number.isFinite(rec.share_pct) || Math.abs(rec.share_pct - sz.share_pct) > 0.05) bad.push(`share_pct = ${JSON.stringify(rec.share_pct)}, очікується ≈ ${sz.share_pct.toFixed(2)}`);
      if (bad.length) return `pr05.payload: ${bad.join('; ')}. Байти, а не символи (Buffer.byteLength): kit/tools/push-sample.mjs друкує всі числа`;
      return true;
    } },
    { level: 4, text: 'Черга дій: повтори при втраті відповіді — рядки без ключа, з ключем на спробу й на дію, теорія (формула 5.7)', run: async () => {
      const x = await ex();
      const rec = getPath(t, 'pr05.dups') ?? {};
      const sim = await L.queueSim(t.variant, P, t.seed);
      if (Object.values(sim.statuses).some((s) => Object.keys(s).some((c) => !['200', '201', '202'].includes(c)))) {
        return `сервер відхилив команду ${sim.command.name}: ${JSON.stringify(sim.statuses.none)} — команди домену додає ПР2 (commands.js); завершіть її`;
      }
      const bad = [];
      for (const [key, v] of [['n', sim.n], ['q_pct', sim.q_pct], ['m', sim.m], ['requests', sim.requests], ['rows_none', sim.rows.none], ['rows_attempt', sim.rows.attempt], ['rows_action', sim.rows.action]]) {
        if (rec[key] !== v) bad.push(`${key} = ${JSON.stringify(rec[key])}, очікується ${v}`);
      }
      if (!Number.isFinite(rec.theory) || !rel(rec.theory, x.dups.theory, 0.005)) bad.push(`theory = ${JSON.stringify(rec.theory)}, очікується ≈ ${x.dups.theory.toFixed(1)} (R = N · (1 − q^m) / (1 − q))`);
      if (sim.reuse && sim.reuse.status !== 422) bad.push(`той самий ключ з іншим тілом дав ${sim.reuse.status}, очікується 422 (idempotency-key-reuse)`);
      if (rec.mode !== 'per_action') bad.push(`mode = ${JSON.stringify(rec.mode)}, очікується "per_action": лише ключ, створений при постановці дії, зв’язує всі повтори`);
      return bad.length ? `pr05.dups: ${bad.slice(0, 4).join('; ')}. Числа друкує kit/tools/queue-sim.mjs` : true;
    } },

    // ---------- рівень 5 ----------
    { level: 5, text: 'Повтори FCM у межах TTL: скільки пауз вміщається при 503 і 429 (найбільший і найменший джитер), чим закінчується постійна відмова', run: async () => {
      const x = await ex();
      const r = rulesOf();
      if (r.error) return r.error;
      if (ttl() !== x.push.ttl_s) return 'спершу виправте pr05.push.ttl_s';
      const rec = getPath(t, 'pr05.retries') ?? {};
      const run = await L.retriesRun(r.push, r.rules, { variant: t.variant, P, ttlS: x.push.ttl_s });
      const bad = [];
      if (rec.ttl_s !== x.push.ttl_s) bad.push(`ttl_s = ${JSON.stringify(rec.ttl_s)}, очікується ${x.push.ttl_s}`);
      for (const code of ['r503', 'r429']) for (const j of ['max', 'min']) {
        const e = x.retries[code][j]; const g = run[code][j]; const s = rec[code]?.[j] ?? {};
        if (e.n !== g.n || Math.abs(e.wait_s - g.wait_s) > 1e-6) return `розбіжність формули (${e.n} пауз, ${e.wait_s} с) і диспетчера (${g.n}, ${g.wait_s} с) для ${code}/${j}: перевірте, що pause() у push.js не змінено`;
        if (s.n !== e.n) bad.push(`${code}.${j}.n = ${JSON.stringify(s.n)}, очікується ${e.n}`);
        if (!Number.isFinite(s.wait_s) || Math.abs(s.wait_s - e.wait_s) > 0.01) bad.push(`${code}.${j}.wait_s = ${JSON.stringify(s.wait_s)}, очікується ${e.wait_s}`);
      }
      for (const code of ['r503', 'r429']) if (rec.outcome?.[code] !== run[code].max.outcome) bad.push(`outcome.${code} = ${JSON.stringify(rec.outcome?.[code])}, очікується "${run[code].max.outcome}" (gave-up — усі спроби вичерпано; expired — наступна пауза виходить за TTL)`);
      return bad.length ? `pr05.retries: ${bad.slice(0, 4).join('; ')}. Паузи: 1, 2, 4, 8 с (503); 60, 120, 240, 480 с (429); kit/tools/push-sample.mjs --retries` : true;
    } },
    { level: 5, text: 'ADR-005 (мобільний клієнт домену): гістерезис, TTL і вік події, період опитування, режим прив’язки, ключ ідемпотентності, тригер перегляду', run: async () => {
      const x = await ex();
      const a = adr();
      if (!a) return 'немає pr05/adr-005.md (шаблон: kit/templates/adr.md)';
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки', 'Тригер'].filter((h) => !new RegExp(`^#+\\s*${h}`, 'mi').test(a));
      if (miss.length) return `У ADR-005 бракує розділів: ${miss.join(', ')}`;
      const have = nums(a);
      const need = [['h', getPath(t, 'pr05.noise.h')], ['TTL', ttl()], ['вік події', maxAge()], ['період опитування', getPath(t, 'pr05.clock.poll_s')], ['σ', getPath(t, 'pr05.noise.sigma_calm')]].filter(([, v]) => Number.isFinite(v));
      const lost = need.filter(([, v]) => !have.some((q) => (Number.isInteger(v) ? q === v : rel(q, v, 0.03))));
      if (lost.length) return `У ADR-005 немає чисел: ${lost.map(([n, v]) => `${n} = ${v}`).join(', ')}`;
      const words = [getPath(t, 'pr05.prov.mode'), 'per_action'].filter(Boolean).filter((w) => !a.toLowerCase().includes(String(w).toLowerCase()));
      if (words.length) return `У ADR-005 не згадано: ${words.join(', ')}`;
      if (x.lostOn429 && !/429[^\n]*(втрач|не доставл|губ|зника)|(втрач|не доставл|губ|зника)[^\n]*429/i.test(a)) return `Для вашого TTL (${ttl()} с) жодна пауза 429 не вміщається: ADR має прямо сказати, що тривога при 429 втрачається, і що з цим робити`;
      return true;
    } },
  ];
}
