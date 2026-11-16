// Каркас перевірки: кожен пункт — це {level, text, run}; run повертає true або рядок з підказкою
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { getPath } from './track.mjs';

export const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
export const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
export const rel = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);

// all(a, b, …): перший пункт, що не true, інакше true (заміна небезпечного a && b для рядків-підказок)
export const all = (...rs) => rs.find((r) => r !== true) ?? true;

// number(track, 'pr01.lambda_avg', expected, 0.02) → true | підказка
export function number(track, key, expected, tol = 0.02, hint = '') {
  const v = getPath(track, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${key}: очікується число, у журналі ${JSON.stringify(v)}`;
  if (rel(v, expected, tol)) return true;
  const pct = tol * 100; // допуск у відсотках: ціле число без дробу, інакше один знак після коми
  const shown = Math.abs(pct - Math.round(pct)) < 1e-9 ? String(Math.round(pct)) : pct.toFixed(1).replace('.', ',');
  return `${key} = ${v}: розбіжність із очікуваним більша за ${shown} %${hint ? `. ${hint}` : ''}`;
}

export async function runChecks({ title, checks, level }) {
  console.log(title);
  let failedAt = null;
  const perLevel = { 3: [0, 0], 4: [0, 0], 5: [0, 0] };
  for (const lv of [3, 4, 5]) {
    const items = checks.filter((c) => c.level === lv);
    if (!items.length) continue;
    // викладацький режим: VERIFY_ONLY_LEVEL=1 пропускає пункти вище заявленого рівня (перевірка вкладеності ланцюга)
    if (process.env.VERIFY_ONLY_LEVEL === '1' && lv > level) continue;
    console.log(`\nРівень «${lv}»${lv > level ? ' (поза вашим рівнем, для довідки)' : ''}`);
    for (const c of items) {
      let r;
      try { r = await c.run(); } catch (e) { r = `помилка перевірки: ${e.message}`; }
      const ok = r === true;
      perLevel[lv][ok ? 0 : 1] += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${c.text}${ok ? '' : `\n      ${r}`}`);
    }
  }
  const done = [3, 4, 5].filter((lv) => perLevel[lv][0] + perLevel[lv][1] > 0 && perLevel[lv][1] === 0);
  const best = done.reduce((m, lv) => (lv === m + 1 || (m === 2 && lv === 3) ? lv : m), 2);
  console.log(`\nПідсумок: ${[3, 4, 5].filter((lv) => perLevel[lv][0] + perLevel[lv][1] > 0).map((lv) => `рівень ${lv}: ${perLevel[lv][0]}/${perLevel[lv][0] + perLevel[lv][1]}`).join('; ')}`);
  const need = [3, 4, 5].filter((lv) => lv <= level).some((lv) => perLevel[lv][1] > 0);
  console.log(need ? `Для заявленого рівня ${level} є невиконані пункти.` : `Пункти рівня ${level} і нижчих виконано.`);
  return !need;
}

// Запуск тестів клієнта еталона: node --test <файли> у каталозі застосунку
import { spawnSync } from 'node:child_process';
import { APP } from './app.mjs';
export function runClientTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: APP, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const fail = /# fail (\d+)/.exec(out)?.[1];
  const pass = /# pass (\d+)/.exec(out)?.[1];
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { ok: r.status === 0, pass: Number(pass ?? 0), fail: Number(fail ?? 0), failed, out };
}
