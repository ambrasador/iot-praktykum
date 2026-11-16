#!/usr/bin/env node
// Вхідні дані ПР6 з паспорта: node kit/tools/sec.mjs
// Прибирання за строками з вашого profile.js на пробній базі: node kit/tools/sec.mjs --retention
import { readTrack, getPath } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { pr06 as expect06 } from '../lib/expect.mjs';
import * as F from '../lib/formulas.mjs';

const t = readTrack();
const P = loadPassport(t.variant);
const S = P.sec;

if (process.argv.includes('--retention')) {
  // Пробна база: у кожній таблиці частина рядків старша за строк, частина свіжіша; admin-cli.js retention має видалити лише прострочені
  const L = await import('../lib/sec-lab.mjs');
  const prof = L.loadProfile(P.code);
  if (prof.error) { console.error(prof.error); process.exit(1); }
  const days = prof.profile.retention ?? {};
  const run = L.retentionRun(days);
  if (run.error) { console.error(run.error); process.exit(1); }
  console.log(`Строки з profile.js (діб): ${Object.entries(days).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [table, n] of Object.entries(run.planned)) {
    console.log(`  ${table}: прострочених ${n}, свіжих ${run.fresh}, видалено ${run.deleted[table]}${run.deleted[table] === n ? '' : ' ✗'}`);
  }
  process.exit(0);
}
console.log(`Паспорт варіанта ${P.id} «${P.title}», код ${P.code}\n`);
console.log(`Пароль: одночасних хешувань C = ${S.pw.C}, бюджет пам’яті ${S.pw.memBudgetMiB} МіБ, найдовший розбіг входів ${S.pw.burstMaxS} с`);
console.log('Набори scrypt (час одного хешу виміряно на еталонному застосунку):');
for (const s of F.SCRYPT) console.log(`  ${s.id}: N = 2^${Math.log2(s.N)}, r = ${s.r}, p = ${s.p}, ${s.tMs} мс`);
const L = S.login;
console.log(`\nВходи: словник найпоширеніших паролів ${L.topN}, перебір має тривати не менше ${F.dobG(L.minDays)}; законних входів на добу з одного імені ${L.legitPerDay}; облікових записів ${L.accounts}`);
console.log(`Розпилення: ${L.sprayTop} паролів проти всіх записів, не швидше ніж за ${F.dobA(L.sprayMinDays)}; за однією адресою до ${L.natUsers} працівників, по ${L.triesPerUserDay} спроб на добу кожен`);
console.log(`\nПолітика ролей (речень вимог: ${S.policy.text.length}):`);
S.policy.text.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
console.log(`\nОбмеження запитів: інших користувачів ${S.limit.other}; черга має спорожнюватися не довше ${S.limit.flushMaxS} с; стеля burst ${S.limit.burstCap}`);
console.log(`Токени: access не довше ${S.tokens.accessMaxS} с; пам’ять під refresh_tokens ${S.tokens.storageMiB} МіБ; офлайн-вікно до ${F.dobG(S.tokens.offlineMaxDays)}; абсолютна межа ${F.dobG(S.tokens.absMaxDays)}`);
console.log(`Вебхук: зсув годинників ${S.hook.skewS} с, затримка доставки ${S.hook.delayS} с, пам’ять кешу повторів ${S.hook.memMB} МБ`);
console.log(`Зберігання: telemetry не довше ${S.retention.telemetryMaxDays} діб і не більше ${Math.round(S.retention.diskShare * 100)} % диска; audit_log ${S.retention.audit_log} діб; rejected ${S.retention.rejected} діб`);
if (S.geo) console.log(`Геодані: ${JSON.stringify(S.geo)}`);
// Дані з попередніх робіт: якщо рівень «5» ПР2 і ПР4 не виконувався, режим карток і байти на рядок беруться звідси
const X = await expect06(t.variant, P, t.seed);
const kJ = getPath(t, 'pr04.k'); const k = X.ks.includes(kJ) ? kJ : X.k0;
const bpr = getPath(t, 'pr02.bytes_per_row');
const c = X.chainFor({ k, bytesPerRow: bpr > 0 ? bpr : null });
console.log(`\nДані з попередніх робіт (k = ${k}${k === kJ ? ' з вашого журналу' : ': у журналі немає допустимого k, взято найменше допустиме'}):`);
console.log(`  період опитування карток P = ${c.P04} с (ПР4); період мобільного клієнта P_моб = ${c.Pmob} с (ПР5)`);
console.log(`  режим опитування карток: ${c.mode}; q = ${c.q} запитів на одне опитування; інших запитів o = ${c.o}`);
console.log(`  байтів на рядок відповіді (ПР2, рівень «5»): ${bpr > 0 ? bpr : 'немає в журналі; потрібні лише для строків зберігання'}`);
