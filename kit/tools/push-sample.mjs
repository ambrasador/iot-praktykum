#!/usr/bin/env node
// Зразок повідомлення FCM, строк актуальності й повтори диспетчера push вашого застосунку.
//   node kit/tools/push-sample.mjs                         повідомлення про критичне сповіщення метрики ПР2 і його розмір у байтах
//   node kit/tools/push-sample.mjs --ttl [--ttl-s 150] [--max-age 140]
//                                                          стара й свіжа подія: що пропускає tracker, що несе повідомлення
//   node kit/tools/push-sample.mjs --retries [--ttl-s 150] постійні відмови 503 і 429: паузи при джитері max і min
//   --json                                                 вивід для скриптів
import { readTrack, getPath } from '../lib/track.mjs';
import { loadPassport } from '../lib/passport.mjs';
import { appRequire } from '../lib/app.mjs';
import { buildHistory } from '../lib/series.mjs';
import * as L from '../lib/mob-lab.mjs';

const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(String(argv[i + 1]).replace(',', '.')) : d; };
const t = readTrack(); const P = loadPassport(t.variant);
const push = appRequire('./push');
const rules = push[`RULES_${P.code}`];
if (!(rules instanceof Map)) { console.error(`push.js не експортує RULES_${P.code}. Додайте карту правил домену (ПР5, крок 5).`); process.exit(2); }
const ttlS = num('ttl-s', getPath(t, 'pr05.push.ttl_s') ?? P.mob.alertStaleS);
const fmt = (x, d = 1) => x.toFixed(d).replace('.', ',');
const json = argv.includes('--json');

if (argv.includes('--retries')) {
  const r = await L.retriesRun(push, rules, { variant: t.variant, P, ttlS });
  if (json) { console.log(JSON.stringify({ ttl_s: ttlS, ...r })); process.exit(0); }
  console.log(`Постійна відмова FCM, TTL тривоги ${ttlS} с (диспетчер: до ${5} спроб, перша пауза 1 с, квота — 60 с)`);
  console.log('Відмова | джитер | пауз вміщається | сума пауз, с | результат | паузи, с');
  for (const [code, name] of [['r503', '503 UNAVAILABLE'], ['r429', '429 QUOTA']]) {
    for (const j of ['max', 'min']) {
      const x = r[code][j];
      console.log(`${name.padEnd(15)} | ${j.padEnd(6)} | ${String(x.n).padStart(15)} | ${fmt(x.wait_s).padStart(12)} | ${x.outcome.padEnd(9)} | ${x.sleeps_s.map((s) => fmt(s)).join('; ') || '—'}`);
    }
  }
  console.log('\nДжитер max — rnd() = 1, пауза дорівнює верхній межі; min — rnd() = 0, пауза вдвічі менша (квота 429: не менше 60 с).');
  process.exit(0);
}

if (argv.includes('--ttl')) {
  const maxAge = num('max-age', getPath(t, 'pr05.push.max_age_s') ?? 300);
  const run = await L.ttlRun(push, rules, { variant: t.variant, P, ttlS, maxAgeS: maxAge });
  if (json) { console.log(JSON.stringify({ ttl_s: ttlS, max_age_s: maxAge, ...run })); process.exit(0); }
  console.log(`TTL тривоги ${ttlS} с; найбільший вік події в tracker (maxAgeMs) ${maxAge} с`);
  console.log(`Стара подія, вік ${run.oldAge} с (старша за TTL): tracker ${run.stale_pushed ? `ПРОПУСТИВ → диспетчер: ${run.stale_result} (рівень позначено надісланим, тривога втрачена)` : 'відкинув'}`);
  console.log(`Свіжа подія, вік ${run.freshAge} с: tracker ${run.fresh_pushed ? 'пропустив' : 'ВІДКИНУВ'}`);
  if (run.delivered) {
    const d = run.delivered;
    console.log(`  доставка: ${d.result}; android.ttl = ${d.ttl} (очікується ${d.want_ttl}); apns-expiration = ${d.expiration} (очікується ${d.want_expiration})`);
  }
  process.exit(0);
}

const hist = buildHistory(t.variant, P, t.seed);
const alert = L.sampleAlertForAlertMetric(t.variant, P, t.seed, hist);
const name = L.deviceName(alert.device);
const sz = L.messageSizes(push, rules, alert, name, ttlS);
if (json) { console.log(JSON.stringify({ alert, name, ttl_s: ttlS, total_b: sz.total_b, data_b: sz.data_b, nd_b: sz.nd_b, share_pct: sz.share_pct, collapse_b: sz.collapse_b, chars_vs_bytes: sz.chars_vs_bytes, message: sz.message })); process.exit(0); }
console.log(`Повідомлення про ${alert.level === 'critical' ? 'критичний' : 'попереджувальний'} рівень ${alert.metric}, пристрій ${alert.device}, значення ${alert.value}, TTL ${ttlS} с`);
console.log(JSON.stringify({ message: sz.message }, null, 2));
console.log('\nРозмір (UTF-8, байти)');
console.log(`  весь запит                          ${sz.total_b} Б`);
console.log(`  data                                ${sz.data_b} Б`);
console.log(`  notification + data (ліміт FCM)     ${sz.nd_b} Б з ${L.FCM_MAX_BYTES}  (${fmt(sz.share_pct, 2)} %)`);
console.log(`  apns-collapse-id                    ${sz.collapse_b} Б (не більше 64)`);
console.log(`  тіло повідомлення                   ${sz.chars_vs_bytes.body_chars} символів, ${sz.chars_vs_bytes.body_bytes} байтів`);
