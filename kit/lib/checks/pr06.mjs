import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getPath } from '../track.mjs';
import { exists, read, number, all } from '../verify-core.mjs';
import { APP } from '../app.mjs';
import { pr06 as expect06 } from '../expect.mjs';
import { loadPassport } from '../passport.mjs';
import * as F from '../formulas.mjs';
import * as S from '../sec-lab.mjs';

const MUTATE_HOOK = path.resolve(import.meta.dirname, '..', 'mutate-hook.cjs');
const SECURITY_TESTS = ['authz.test.js', 'auth.test.js', 'passwords.test.js', 'ratelimit.test.js', 'refresh.test.js', 'tokens.test.js',
  'webhook-sign.test.js', 'privacy.test.js', 'admin-cli.test.js', 'contract.test.js'];

const inApp = (f) => fs.existsSync(path.join(APP, f));
const exact = (t, key, expected, hint = '') => {
  const v = getPath(t, key);
  return JSON.stringify(v) === JSON.stringify(expected) ? true : `${key} = ${JSON.stringify(v)}, очікується ${JSON.stringify(expected)}${hint ? `. ${hint}` : ''}`;
};
const close = (a, b, tol = 0.01) => typeof a === 'number' && Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);
const norm = (s) => s.replace(/(\d)[\s ](?=\d{3}\b)/g, '$1');

export function checks(track) {
  const t = track;
  const P = loadPassport(t.variant);
  const S0 = P.sec;
  let X = null; let prof = null; let wire = null;
  const ex = async () => (X ??= await expect06(t.variant, P, t.seed));
  const profile = () => (prof ??= S.loadProfile(P.code));
  const wiring = async () => (wire ??= await S.captureWiring());
  const chain = async () => {
    const x = await ex();
    const k = getPath(t, 'pr04.k'); const bpr = getPath(t, 'pr02.bytes_per_row');
    if (!x.ks.includes(k)) return { error: `pr04.k = ${JSON.stringify(k)} не належить допустимим для вашого варіанта: завершіть ПР4` };
    // байти на рядок з’являються в ПР2 лише на рівні «5»; нижчі рівні їх не потребують (строки зберігання — пункт рівня «5»)
    if (Number(t.level) >= 5 && !(bpr > 0)) return { error: 'у track.json немає pr02.bytes_per_row: завершіть ПР2 (рівень «5»)' };
    return { ...x.chainFor({ k, bytesPerRow: bpr > 0 ? bpr : null }), x };
  };
  // Підключення в main.js: повідомлення, що стосуються однієї служби
  const wiringFor = async (...fns) => {
    const p = profile(); if (p.error) return p.error;
    const w = await wiring(); if (w.error) return w.error;
    const diff = S.wiringDiff(w.calls, p.options).filter((m) => fns.some((f) => m.includes(f)));
    return diff.length ? `${diff[0]}${diff.length > 1 ? ` (і ще ${diff.length - 1})` : ''}. Підключіть profile.js у main.js: const opt = securityOptions(active()) і розгорніть opt.* у виклики служб` : true;
  };
  const runTests = (files, mut) => {
    const env = { ...process.env };
    if (mut) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${MUTATE_HOOK}`.trim();
    if (mut) env.SEC_MUTATE = JSON.stringify({ code: P.code, ...mut });
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: APP, env, encoding: 'utf8', timeout: 180_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { ok: r.status === 0, failed: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]), out, noFile: /Could not find|ENOENT/.test(out) && r.status !== 0 && !/# tests \d+/.test(out) };
  };
  // Чому тести червоні: назва тесту, а для файлу, що не завантажився, — помилка з місцем («SyntaxError: … (auth.js:26)»)
  const why = (r) => {
    const first = r.failed[0];
    if (first && !/\.js$/.test(first)) return first;
    const c = S.crashLine(r.out.replace(/^#\s?/gm, ''));
    return first ? `${first}: ${c}` : c;
  };
  // Мутація має зупинити тести: інакше число в профілі ніщо не охороняє
  const mutation = (label, mut, files = ['profile.test.js', 'policy.domain.test.js']) => {
    const have = files.filter(inApp);
    if (!have.length) return `немає ${files.join(' або ')}: тести профілю не написано`;
    const base = runTests(have);
    if (!base.ok) return `тести профілю не зелені до мутації: ${why(base)}`;
    const m = runTests(have, mut);
    return m.ok ? `тести не помітили зміну: ${label}. Додайте твердження про цю вимогу в profile.test.js` : true;
  };
  const adr = () => (exists('pr06', 'adr-006.md') ? read('pr06', 'adr-006.md') : '');

  return [
    // ---------- рівень 3 ----------
    { level: 3, text: 'Вхідний контроль: ПР4 (k і період опитування карток) та ПР5 (період мобільного клієнта) виконано; для рівня «5» — ще режим опитування з ПР4 і байти на рядок з ПР2', run: async () => {
      const c = await chain();
      if (c.error) return c.error;
      const modeJ = getPath(t, 'pr04.poll.mode');
      return all(
        exact(t, 'pr04.poll_s', c.P04, `за вашим k = ${c.k}`),
        Number(t.level) >= 5 || modeJ !== undefined ? exact(t, 'pr04.poll.mode', c.mode, 'режим опитування з ПР4 (per_device / group / stream)') : true,
        exact(t, 'pr05.clock.poll_s', c.Pmob, 'період опитування мобільного клієнта з ПР5'));
    } },
    { level: 3, text: 'Пароль: набір scrypt із таблиці за пам’яттю C хешів і часом входу всіх користувачів (формули 6.1, 6.2); набір у profile.js і в main.js', run: async () => {
      const x = await ex(); const pk = x.pw.pick;
      const p = profile(); if (p.error) return p.error;
      const g = (k, e, tol, h) => number(t, `pr06.pw.${k}`, e, tol, h);
      const r1 = all(
        exact(t, 'pr06.pw.id', pk.id, `набір, що вміщується в ${S0.pw.memBudgetMiB} МіБ (C = ${S0.pw.C} одночасних хешів) і дає вхід ${x.U} користувачів не довше ніж за ${S0.pw.burstMaxS} с; з таких — найбільша пам’ять`),
        exact(t, 'pr06.pw.N', pk.N), exact(t, 'pr06.pw.r', pk.r), exact(t, 'pr06.pw.p', pk.p),
        g('mem_mib', S0.pw.C * pk.memMiB, 0.001, 'C · 128 · N · r / 2^20'),
        g('t_ms', pk.tMs, 0.001, 'виміряний час одного хешу набору з таблиці підручника'),
        g('burst_s', pk.burstS, 0.01, 'U · t / C: за який час вхід пропустить усіх U користувачів'));
      if (r1 !== true) return r1;
      const pw = p.profile.password ?? {};
      for (const k of ['N', 'r', 'p']) if (pw[k] !== pk[k]) return `profile.js: password.${k} = ${JSON.stringify(pw[k])}, за вашим журналом має бути ${pk[k]}`;
      if (pw.concurrency !== S0.pw.C) return `profile.js: password.concurrency = ${JSON.stringify(pw.concurrency)}, у паспорті C = ${S0.pw.C} одночасних хешів`;
      const w = await wiringFor('createPasswordService'); if (w !== true) return w;
      const pr = await S.passwordProbe(p.options);
      if (pr.N !== pk.N || pr.r !== pk.r || pr.p !== pk.p) return `службі паролів передано N = ${pr.N}, r = ${pr.r}, p = ${pr.p}; хеш записано з іншими параметрами, ніж у профілі`;
      if (!pr.ok) return 'пароль, захешований за параметрами профілю, не перевіряється';
      if (!pr.needsRehashOld) return 'хеш за іншими параметрами (інше N) має вимагати перехешування, а needsRehash каже «ні»';
      return true;
    } },
    { level: 3, text: 'Ліміти входу: спроб на добу A = b + r · 86 400 для імені й адреси (формула 6.3) — між потребою законних користувачів і стійкістю до перебору й розпилення', run: async () => {
      const x = await ex(); const w = x.login.window;
      const p = profile(); if (p.error) return p.error;
      const lim = p.profile.login ?? {};
      const A = (o) => (o?.burst ?? 0) + (o?.rate ?? 0) * 86400;
      const au = A(lim.user); const ai = A(lim.ip);
      if (!(au >= w.user.aMin) || !(au <= w.user.aMax)) return `ліміт за ім’ям: A = ${au.toFixed(1)} спроб на добу; потрібно від ${w.user.aMin} (законні входи) до ${w.user.aMax} (топ-${S0.login.topN} паролів мають перебиратися не менше ${F.dobG(S0.login.minDays)})`;
      if (!(lim.user.burst >= w.user.bMin)) return `burst за ім’ям ${lim.user.burst}: людина помиляється кілька разів поспіль, потрібно щонайменше ${w.user.bMin}`;
      if (!(ai >= w.ip.aMin) || !(ai <= w.ip.aMax)) return `ліміт за адресою: A = ${ai.toFixed(1)} спроб на добу; потрібно від ${w.ip.aMin} (${S0.login.natUsers} працівників за одним NAT × ${S0.login.triesPerUserDay} спроб) до ${w.ip.aMax} (розпилення ${S0.login.sprayTop} паролів × ${S0.login.accounts} облікових записів не швидше ніж за ${F.dobA(S0.login.sprayMinDays)})`;
      if (!(lim.ip.burst >= w.ip.bMin)) return `burst за адресою ${lim.ip.burst}: ${S0.login.natUsers} працівників за одним NAT входять одночасно, потрібно щонайменше ${w.ip.bMin}`;
      const r1 = all(
        number(t, 'pr06.login.a_user', au, 0.01, 'b + r · 86 400 для ліміту за ім’ям з profile.js'),
        number(t, 'pr06.login.a_ip', ai, 0.01, 'b + r · 86 400 для ліміту за адресою з profile.js'),
        number(t, 'pr06.login.brute_days', S0.login.topN / au, 0.02, `${S0.login.topN} паролів / A за ім’ям`),
        number(t, 'pr06.login.spray_days', x.login.spray / ai, 0.02, `${S0.login.sprayTop} · ${S0.login.accounts} = ${x.login.spray} спроб розпилення / A за адресою`));
      if (r1 !== true) return r1;
      const wf = await wiringFor('createAuth'); if (wf !== true) return wf;
      const day = await S.loginDay(p.options);
      if (Math.abs(day.user - au) > 3 || Math.abs(day.ip - ai) > 3) return `за добу атакувальник встигає ${day.user} спроб за ім’ям і ${day.ip} за адресою, а профіль обіцяє ${au.toFixed(1)} і ${ai.toFixed(1)}: ліміти не дійшли до createAuth`;
      return true;
    } },
    { level: 3, text: 'Політика ролей: перевизначення дій із речень вимог варіанта (profile.js), guard із політикою, поточна політика в main.js, тест матриці', run: async () => {
      const x = await ex(); const pol = x.policy;
      const p = profile(); if (p.error) return p.error;
      const r1 = exact(t, 'pr06.policy.changed', pol.changed, 'дії, ролі яких відрізняються від базової політики розділу 6 (відсортований перелік назв)');
      if (r1 !== true) return r1;
      const eff = p.options.auth?.policy;
      if (!eff || typeof eff !== 'object') return 'securityOptions не повертає auth.policy (повна політика: { ...ACTIONS, ...profile.policy })';
      for (const [action, roles] of Object.entries(pol.expected)) {
        if (JSON.stringify([...(eff[action] ?? [])].sort()) !== JSON.stringify([...roles].sort())) return `політика ${action}: у профілі ${JSON.stringify(eff[action] ?? null)}, за вимогами має бути ${JSON.stringify(roles)}`;
      }
      const wf = await wiringFor('createAuth policy'); if (wf !== true) return wf;
      const problems = await S.policyGuard(eff, pol.changed, pol.expected);
      if (problems.length) return `guard не виконує політику: ${problems[0]}${problems.length > 1 ? ` (і ще ${problems.length - 1})` : ''}. Перевірте, що createAuth читає policy, а не ACTIONS`;
      return true;
    } },
    { level: 3, text: 'Тести: легасі-набір безпеки зелений, profile.test.js і policy.domain.test.js охороняють політику й пароль (зміна правила чи набору scrypt їх зупиняє)', run: async () => {
      const x = await ex();
      const legacy = runTests(SECURITY_TESTS.filter(inApp));
      if (!legacy.ok) return `легасі-тести безпеки не проходять: ${why(legacy)}`;
      const p = profile(); if (p.error) return p.error;
      const first = x.policy.changed[0];
      const base = F.BASE_ACTIONS[first];
      const m1 = mutation(`політика ${first} повернена до базової`, { profile: { [`policy.${first}`]: base } }, ['policy.domain.test.js']);
      if (m1 !== true) return m1;
      return mutation('N scrypt збільшено вдвічі', { profile: { 'password.N': p.profile.password.N * 2 } }, ['profile.test.js']);
    } },
    // ---------- рівень 4 ----------
    { level: 4, text: 'Ліміт запитів користувача: сталий потік двох клієнтів, відкриття застосунку, повторне надсилання черги; кошик у profile.js і в main.js; година роботи без 429', run: async () => {
      const c = await chain(); if (c.error) return c.error;
      const p = profile(); if (p.error) return p.error;
      const L = c.limit; const lim = p.profile.limit ?? {};
      const r1 = all(
        number(t, 'pr06.limit.rho_rps', L.rho, 0.01, `(q + o) / P + (q + o) / P_моб, q = ${c.q} запитів на опитування (${c.mode}), o = ${c.o} інших`),
        exact(t, 'pr06.limit.rate', lim.rate, 'число з profile.js (limit.rate)'),
        exact(t, 'pr06.limit.burst', lim.burst, 'число з profile.js (limit.burst)'));
      if (r1 !== true) return r1;
      if (!(lim.rate >= L.rateMin) || !(lim.rate <= L.rateMax)) return `limit.rate = ${lim.rate}: потрібно від ${F.round(L.rateMin, 3)} (1,5 · ρ) до ${F.round(L.rateMax, 2)} (U · rate ≤ ${F.R_READ} читань за секунду)`;
      const bMin = L.burstMin(lim.rate);
      if (!(lim.burst >= bMin) || !(lim.burst <= L.burstMax)) return `limit.burst = ${lim.burst}: потрібно від ${bMin} (відкриття ${c.q + c.o} запитів і черга ${P.mob.queueN}, витрата не довша за ${S0.limit.flushMaxS} с) до ${L.burstMax}`;
      const flush = L.flushS(lim.rate, lim.burst);
      const r2 = number(t, 'pr06.limit.flush_s', flush, 0.03, '(N + q + o − b) / r, але не менше нуля');
      if (r2 !== true) return r2;
      const wf = await wiringFor('createServer limits'); if (wf !== true) return wf;
      const sim = S.apiLimitSim(p.options.api?.limits ?? lim, { q: c.q, o: c.o, P04: c.P04, Pmob: c.Pmob, queueN: P.mob.queueN });
      if (sim.denied > 0) return `за годину сталої роботи двох клієнтів ${sim.denied} із ${sim.events * (c.q + c.o)} запитів дістали 429: rate або burst замалі`;
      if (!sim.flushed || sim.flushS > S0.limit.flushMaxS + 0.15) return `після відновлення зв’язку черга й відкриття застосунку витрачаються ${sim.flushed ? `${sim.flushS} с` : 'понад 10 хв'}, а має бути не довше ніж ${S0.limit.flushMaxS} с`;
      return mutation('rate ліміту зменшено у 100 разів', { profile: { 'limit.rate': lim.rate / 100 } }, ['profile.test.js']);
    } },
    { level: 4, text: 'Токени: найменший access TTL, що вміщує таблицю refresh_tokens у бюджет; refresh не коротший за офлайн-вікно; термін дії токенів у справжніх модулях', run: async () => {
      const x = await ex(); const tk = x.tokens;
      const p = profile(); if (p.error) return p.error;
      const r1 = all(
        exact(t, 'pr06.tokens.access_s', tk.access, `найменший зі ряду ${F.TOKEN_TTLS.join(', ')} с, що не перевищує ${S0.tokens.accessMaxS} с і дає таблицю refresh_tokens не більшу за ${S0.tokens.storageMiB} МіБ для ${S0.login.accounts} облікових записів`),
        exact(t, 'pr06.tokens.refresh_days', tk.days, `найменший зі ряду ${F.REFRESH_DAYS.join(', ')} діб, не коротший за офлайн-вікно ${F.dobG(S0.tokens.offlineMaxDays)} і не довший за ${F.dobG(S0.tokens.absMaxDays)}`),
        number(t, 'pr06.tokens.rows_per_user', tk.rows, 0.005, `(діб refresh + ${F.SEC.graceDays} діб до прибирання) · 86 400 / TTL access`),
        number(t, 'pr06.tokens.storage_mib', tk.miB, 0.01, `облікових записів · рядків · ${F.SEC.refreshRowB} Б / 2^20`));
      if (r1 !== true) return r1;
      const tp = p.profile.tokens ?? {};
      if (tp.accessTtlSec !== tk.access) return `profile.js: tokens.accessTtlSec = ${JSON.stringify(tp.accessTtlSec)}, за журналом ${tk.access}`;
      if (tp.refreshTtlSec !== tk.days * 86400) return `profile.js: tokens.refreshTtlSec = ${JSON.stringify(tp.refreshTtlSec)}, має бути ${tk.days} · 86 400 = ${tk.days * 86400}`;
      const wf = await wiringFor('createTokens', 'createRefresh'); if (wf !== true) return wf;
      const sim = await S.tokensSim(p.options, { accessS: tk.access, days: tk.days });
      if (!sim.okBefore || sim.okAfter) return `access-токен ${sim.okBefore ? 'не спливає' : 'спливає раніше'} за ${tk.access} с (до: ${sim.okBefore}, після: ${sim.okAfter})`;
      if (!sim.refreshBefore) return `refresh-токен не приймається за секунду до ${tk.days} діб`;
      if (sim.refreshAfter !== 'expired') return `refresh-токен приймається після ${tk.days} діб (результат: ${JSON.stringify(sim.refreshAfter)})`;
      if (Math.abs(sim.rows - tk.rows) > 0.01 * tk.rows + 2) return `у сталому режимі в refresh_tokens ${sim.rows} рядків на користувача, а формула дає ${F.round(tk.rows, 1)}`;
      return mutation('TTL access-токена збільшено вчетверо', { profile: { 'tokens.accessTtlSec': tp.accessTtlSec * 4 } }, ['profile.test.js']);
    } },
    { level: 4, text: 'Вебхук: допуск часу ⌈(зсув + затримка) / 30⌉ · 30 с, розмір пакета подій за пам’яттю кешу повторів; межі допуску й повтор у справжньому верифікаторі', run: async () => {
      const x = await ex(); const h = x.hook;
      const p = profile(); if (p.error) return p.error;
      const row = h.rows.find((r) => r.b === h.b);
      const r1 = all(
        exact(t, 'pr06.hook.tol_s', h.tol, `⌈(${h.skewS} + ${h.delayS}) / 30⌉ · 30`),
        exact(t, 'pr06.hook.batch', h.b, `найменша кількість подій в одній доставці з ряду ${F.HOOK_B.join(', ')}, за якої кеш повторів вміщується в ${h.memMB} МБ`),
        number(t, 'pr06.hook.rho', row.rho, 0.01, 'доставок за секунду = λ / B'),
        number(t, 'pr06.hook.entries', row.entries, 0.01, 'запис живе допуск + розсинхрон годинників і ще до наступного прибирання: ρ · (2 · допуск + зсув)'),
        number(t, 'pr06.hook.mem_mb', row.mb, 0.02, `записів · ${F.SEC.hookEntryB} Б / 10^6`));
      if (r1 !== true) return r1;
      const hp = p.profile.hook ?? {};
      if (hp.toleranceSec !== h.tol || hp.batch !== h.b) return `profile.js: hook = ${JSON.stringify(hp)}, за журналом toleranceSec = ${h.tol}, batch = ${h.b}`;
      const wf = await wiringFor('createVerifier'); if (wf !== true) return wf;
      const sim = S.hookSim(p.options.verifier ?? { toleranceSec: hp.toleranceSec }, { rho: row.rho, skewS: h.skewS, delayS: h.delayS });
      if (sim.atTol !== null || sim.pastTol !== 'stale' || sim.aheadTol !== null || sim.aheadPast !== 'stale') return `межі допуску ${h.tol} с: на межі ${JSON.stringify(sim.atTol)}, поза нею ${JSON.stringify(sim.pastTol)}; уперед ${JSON.stringify(sim.aheadTol)} / ${JSON.stringify(sim.aheadPast)}`;
      if (sim.delayed !== null) return `доставка, затримана на ${h.delayS} с постачальником із відстаючим на ${h.skewS} с годинником, відхилена (${sim.delayed}): допуск замалий`;
      if (sim.first !== null || sim.again !== 'replay' || sim.afterWindow !== 'stale') return `повтор: перша ${JSON.stringify(sim.first)}, друга ${JSON.stringify(sim.again)}, після вікна ${JSON.stringify(sim.afterWindow)}; очікується null, replay, stale`;
      if (sim.peak > row.entries * 1.1 + 3 || sim.peak < row.entries * 0.85 - 3) return `пік кешу повторів ${sim.peak} записів, а формула дає ${F.round(row.entries, 0)}: перевірте допуск і розмір пакета`;
      if (F.hookMB(sim.peak) > h.memMB) return `кеш повторів займає ${F.round(F.hookMB(sim.peak), 3)} МБ, а бюджет — ${h.memMB} МБ`;
      return mutation('допуск вебхука скорочено до 30 с', { profile: { 'hook.toleranceSec': 30 } }, ['profile.test.js']);
    } },
    // ---------- рівень 5 ----------
    { level: 5, text: 'Строки зберігання: telemetry за диском і політикою, audit_log і rejected із вимог, push_tokens не довші за сеанс; admin-cli retention видаляє рівно прострочене', run: async () => {
      const c = await chain(); if (c.error) return c.error;
      if (!(c.retention.bytesPerRow > 0)) return 'у track.json немає pr02.bytes_per_row: виконайте відповідний крок ПР2 (рівень «5»)';
      const x = c.x; const p = profile(); if (p.error) return p.error;
      const R = c.retention; const days = { telemetry: R.days, audit_log: S0.retention.audit_log, rejected: S0.retention.rejected, push_tokens: x.tokens.days };
      const r1 = all(
        exact(t, 'pr06.retention.by_disk_days', R.byDisk, `⌊${S0.retention.diskShare} · ${P.diskGB} ГБ / (λ · 86 400 · ${R.bytesPerRow} Б)⌋`),
        number(t, 'pr06.retention.mb_day', R.mb_day, 0.01, 'λ · 86 400 · байтів на рядок з ПР2 / 10^6'),
        exact(t, 'pr06.retention.telemetry_days', days.telemetry, `найбільший зі ряду ${F.RET_DAYS.join(', ')}, що не перевищує min(${S0.retention.telemetryMaxDays} діб за політикою, ${R.byDisk} діб за диском)`),
        exact(t, 'pr06.retention.audit_log', days.audit_log, 'із вимог паспорта'),
        exact(t, 'pr06.retention.rejected', days.rejected, 'із вимог паспорта'),
        exact(t, 'pr06.retention.push_tokens', days.push_tokens, 'не довше за refresh-сеанс'));
      if (r1 !== true) return r1;
      const rp = p.profile.retention ?? {};
      for (const [k, v] of Object.entries(days)) if (rp[k] !== v) return `profile.js: retention.${k} = ${JSON.stringify(rp[k])}, за журналом ${v}`;
      const run = S.retentionRun(days);
      if (run.error) return run.error;
      for (const [tbl, n] of Object.entries(run.planned)) {
        if (run.deleted[tbl] !== n) return `admin-cli.js retention: у таблиці ${tbl} видалено ${run.deleted[tbl]} із ${n} прострочених рядків (строк ${days[tbl]} діб). Передайте строки з профілю: { ...DEFAULT_DAYS, ...active().retention }`;
      }
      if (x.geo) {
        const gv = P.sec.geo;
        const r2 = all(exact(t, 'pr06.geo.cell_deg', x.geo.deg, `найменша кратна 0,005° комірка, довша за ${gv.minCellKm} км по меридіану й не довша за ${gv.maxCellKm} км`),
          number(t, 'pr06.geo.ns_km', x.geo.km, 0.005, 'комірка · 111,195 км/°'));
        if (r2 !== true) return r2;
        if (p.profile.geo?.cellDeg !== x.geo.deg) return `profile.js: geo.cellDeg = ${JSON.stringify(p.profile.geo?.cellDeg)}, має бути ${x.geo.deg}`;
        const g = S.geoProbe(x.geo.deg);
        if (g.errLat > g.half + 1e-9 || g.errLon > g.half + 1e-9) return 'coarsen зсуває координату більше ніж на пів комірки';
      }
      return mutation('строк зберігання telemetry подвоєно', { profile: { 'retention.telemetry': days.telemetry * 2 } }, ['profile.test.js']);
    } },
    { level: 5, text: 'ADR-006 «Безпека застосунку»: розділи, числа рішень, змінені дії політики, мінімізація даних і обмеження', run: async () => {
      const x = await ex();
      const text = adr();
      if (!text) return 'немає pr06/adr-006.md';
      const miss = ['Контекст', 'Рішення', 'Альтернативи', 'Наслідки', 'Тригер'].filter((s) => !new RegExp(`^#{1,3}\\s*${s}`, 'mi').test(text));
      if (miss.length) return `у ADR-006 бракує розділів: ${miss.join(', ')}`;
      const body = norm(text);
      const has = (n) => new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(body);
      const pk = x.pw.pick;
      const log2 = Math.log2(pk.N);
      if (!(has(pk.N) || new RegExp(`2\\s*(\\^|<sup>|\\*\\*)\\s*${log2}`).test(body) || body.includes(['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'].length ? `2${String(log2).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d])}` : ''))) return `ADR-006 не називає параметр N = ${pk.N} (2^${log2}) scrypt`;
      for (const [label, n] of [['TTL access-токена, с', x.tokens.access], ['строк refresh, діб', x.tokens.days], ['допуск вебхука, с', x.hook.tol], ['розмір пакета подій', x.hook.b]]) {
        if (!has(n)) return `ADR-006 не називає число ${n} (${label})`;
      }
      for (const a of x.policy.changed) if (!text.includes(a)) return `ADR-006 не згадує змінену дію політики ${a}`;
      if (x.geo && !/комірк/i.test(text)) return 'ADR-006 має пояснити зернистість координат (комірка сітки)';
      if (P.sec.pseudonym && !/HMAC|псевдонім/i.test(text)) return 'ADR-006 має сказати, що ідентифікатори в журналах і аналітиці замінюються псевдонімом (HMAC із окремим ключем)';
      return true;
    } },
  ];
}
