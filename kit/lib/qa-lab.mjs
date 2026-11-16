// Лабораторія ПР7: план межових рядків, бюджет піраміди, нестабільні тести, мутанти й їх запуск проти тестів студента.
// Мутанти не змінюють каталог студента: тести виконуються в одноразовій копії застосунку (overlay).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP, appRequire } from './app.mjs';
import { metricTable, DEVICE_KINDS } from './passport.mjs';
import { rng, seedFor } from './rng.mjs';

// ---------------------------------------------------------------- арифметика (підручник, 7.1.1, 7.4.3)
// Вартість одного тесту за рівнями, мс: табл. «Вартість рівнів піраміди» (вимір M1; наскрізні — вимір M4)
export const COST = { unit: 27, db: 72, net: 101, e2e: 836 };   // e2e — для еталона; для домену беремо P.qa.e2eMs
export const NET_CASES = 4;          // три шляхи (збережено, відхилено, дублікат) і відмова брокера
export const EPISODE_ROWS = 6;       // межові рядки findViolations
export const RULE_ROWS = 8;          // межові рядки на одне правило рівнів

const stepOf = (decimals) => 10 ** -decimals;
const fix = (x, d = 9) => Number(x.toFixed(d));

export function usedMetrics(P) {
  const table = metricTable(P);
  const ids = [...new Set(Object.values(DEVICE_KINDS[P.id]).flat())];
  return ids.map((id) => {
    const m = table.get(id);
    return { id, range: m.range, decimals: m.decimals, step: stepOf(m.decimals) };
  });
}

const paramRows = (s) => (s.type === 'bool' ? 3 : s.type === 'enum' ? 2 : 4);
export const numericParams = (specs) => specs.filter((s) => s.type === 'int' || s.type === 'number');

export function ruleCards(P) { return P.ui.cards.filter((c) => c.rule); }

export function rowPlan(P) {
  const metrics = usedMetrics(P);
  const range = 4 * metrics.length;
  const commands = P.commands.reduce((a, c) => a + c.params.reduce((b, s) => b + paramRows(s), 0), 0);
  const settings = P.settings.reduce((a, s) => a + paramRows(s), 0);
  const rules = RULE_ROWS * ruleCards(P).length;
  return { metrics: metrics.length, range, commands, settings, rules, episodes: EPISODE_ROWS,
    db: range, unit: commands + settings + rules + EPISODE_ROWS, net: NET_CASES };
}

export function pyramid(P) {
  const rows = rowPlan(P);
  const baseMs = rows.db * COST.db + rows.unit * COST.unit + rows.net * COST.net;
  const leftMs = P.qa.ciBudgetS * 1000 - baseMs;
  const e2eMax = Math.max(0, Math.floor(leftMs / P.qa.e2eMs));
  const paths = [...P.qa.e2e].sort((a, b) => a.priority - b.priority).slice(0, e2eMax).map((e) => e.path);
  return { rows, base_ms: baseMs, left_ms: leftMs, e2e_max: e2eMax, e2e: paths,
    total_ms: baseMs + paths.length * P.qa.e2eMs };
}

export const nRuns = (p, conf = 0.95) => Math.ceil(Math.log(1 - conf) / Math.log(1 - p));

// Лабораторний нестабільний тест: збій у прогоні i, якщо u(i) < p; u залежить від зерна студента й номера прогону
export function flakyRun(P, seed, runs) {
  const r = rng(seedFor(P.id, seed, 77));
  const failed = [];
  for (let i = 1; i <= runs; i++) if (r() < P.qa.flaky.p) failed.push(i);
  return { runs, failures: failed.length, first: failed[0] ?? null, failed };
}

export function flakyPlan(P, seed) {
  const { p, target } = P.qa.flaky;
  const n95 = nRuns(p); const nFix = nRuns(target);
  const lab = flakyRun(P, seed, 100);
  return { p, target, n95, n99: nRuns(p, 0.99), n_fix: nFix, miss_ppm: (1 - p) ** nFix * 1e6,
    lab_runs: lab.runs, lab_failures: lab.failures, lab_first: lab.first,
    p_hit_lab_pct: (1 - (1 - p) ** lab.runs) * 100 };
}

export const redShare = (ps) => 1 - ps.reduce((a, p) => a * (1 - p), 1);
export function quarantine(P) {
  const order = [...P.qa.suite].sort((a, b) => b.p - a.p);
  const before = redShare(order.map((t) => t.p));
  let k = 0;
  while (k < order.length && redShare(order.slice(k).map((t) => t.p)) > P.qa.redMax) k += 1;
  const rest = order.slice(k).map((t) => t.p);
  return { order: order.map((t) => t.test), set: order.slice(0, k).map((t) => t.test), before_pct: before * 100,
    after_pct: redShare(rest) * 100, red_max_pct: P.qa.redMax * 100 };
}

// ---------------------------------------------------------------- мутанти
const NOTE = '/*QA*/';
// Хвіст модуля: позначає завантаження («load»), успіх («ok») або помилку застосування («fail»)
function footer(id, body) {
  return `\n${NOTE};(() => { const __fs = require('node:fs'); const __m = process.env.QA_MARK; const __w = (s) => { if (__m) __fs.appendFileSync(__m, s + '\\n'); };
  __w('load ${id}'); try { ${body}; __w('ok ${id}'); } catch (e) { __w('fail ${id} ' + e.message); } })();\n`;
}
const q = (s) => JSON.stringify(s);

// Обгортка перевірки значення: межа зсунута на один крок розрізнення (ціле — 1, число — 10^-знаків)
const edgeWrap = (holder, name, key, edge, dir, limit, step, direct) => `
  const __f = ${holder}[${q(name)}];
  const __v = (arg) => ${direct ? 'arg' : `arg?.[${q(key)}]`};
  const __with = (arg, x) => ${direct ? 'x' : `({ ...arg, [${q(key)}]: x })`};
  ${holder}[${q(name)}] = (arg) => {
    const v = __v(arg);
    if (typeof v === 'number') {
      if (${q(edge)} === 'min' && ${q(dir)} === '+' && v < ${limit} + ${step}) return false;
      if (${q(edge)} === 'max' && ${q(dir)} === '-' && v > ${limit} - ${step}) return false;
      if (${q(edge)} === 'min' && ${q(dir)} === '-' && v >= ${limit} - ${step} && v < ${limit}) return __f(__with(arg, ${limit}));
      if (${q(edge)} === 'max' && ${q(dir)} === '+' && v <= ${limit} + ${step} && v > ${limit}) return __f(__with(arg, ${limit}));
    }
    return __f(arg);
  }`;

export const stepFor = (spec) => (spec.type === 'int' ? 1 : (spec.step ?? 0.1));
const EDGES = [['min', '-'], ['min', '+'], ['max', '-'], ['max', '+']];
const edgeText = (edge, dir) => `${edge}${dir}`;

export function dataMutants(P) {
  const out = [];
  for (const m of usedMetrics(P)) {
    for (const [edge, dir] of EDGES) {
      const [lo, hi] = m.range; const s = m.step;
      const nlo = edge === 'min' ? fix(lo + (dir === '+' ? s : -s)) : lo;
      const nhi = edge === 'max' ? fix(hi + (dir === '+' ? s : -s)) : hi;
      const id = `range.${m.id}.${edgeText(edge, dir)}`;
      out.push({ id, group: 'range', layer: 'db', title: `діапазон ${m.id}: ${edge === 'min' ? 'нижня' : 'верхня'} межа ${dir === '+' ? '+' : '−'}${s}`,
        edits: [{ file: 'core.js', footer: footer(id, `RANGE.set(${q(m.id)}, [${nlo}, ${nhi}])`) }] });
    }
  }
  for (const c of P.commands) {
    for (const s of numericParams(c.params)) {
      for (const [edge, dir] of EDGES) {
        const st = stepFor(s); const id = `cmd.${c.name}.${s.key}.${edgeText(edge, dir)}`;
        out.push({ id, group: 'commands', layer: 'unit', title: `команда ${c.name}, ${s.key}: ${edge === 'min' ? 'нижня' : 'верхня'} межа ${dir === '+' ? '+' : '−'}${st}`,
          edits: [{ file: 'commands.js', footer: footer(id, edgeWrap('COMMANDS', c.name, s.key, edge, dir, s[edge], st, false)) }] });
      }
    }
  }
  for (const s of numericParams(P.settings)) {
    for (const [edge, dir] of EDGES) {
      const st = stepFor(s); const id = `set.${s.key}.${edgeText(edge, dir)}`;
      out.push({ id, group: 'settings', layer: 'unit', title: `налаштування ${s.key}: ${edge === 'min' ? 'нижня' : 'верхня'} межа ${dir === '+' ? '+' : '−'}${st}`,
        edits: [{ file: 'settings.js', footer: footer(id, edgeWrap('RULES', s.key, null, edge, dir, s[edge], st, true)) }] });
    }
  }
  return out;
}

// Крок розрізнення правила — за кількістю знаків картки
export function ruleMutants(P) {
  const out = [];
  for (const c of ruleCards(P)) {
    const st = stepOf(c.decimals);
    const R = `RULES_${P.code}`;
    const set = (id, field, delta, title) => out.push({ id, group: 'rules', layer: 'unit', title,
      edits: [{ file: 'push.js', footer: footer(id, `const r = ${R}.get(${q(c.metric)}); r.${field} = Number((r.${field} + ${delta}).toFixed(9))`) }] });
    // Еквівалентні мутанти не породжуємо: коли warn = crit і гістерезису немає, рівня «warning» немає,
    // тож зсув warn у бік гіршого нічого не змінює; від'ємний гістерезис нічого не змінює при h = 0
    let hyst; try { hyst = appRequire('./push')[R].get(c.metric).hysteresis; } catch { hyst = undefined; }
    const flat = c.rule.warn === c.rule.crit && hyst === 0;
    const worse = c.rule.direction === 'below' ? -1 : 1;
    if (!(flat && worse > 0)) set(`rule.${c.metric}.warn+`, 'warn', st, `правило ${c.metric}: warn +${st}`);
    if (!(flat && worse < 0)) set(`rule.${c.metric}.warn-`, 'warn', -st, `правило ${c.metric}: warn −${st}`);
    set(`rule.${c.metric}.crit+`, 'crit', st, `правило ${c.metric}: crit +${st}`);
    set(`rule.${c.metric}.crit-`, 'crit', -st, `правило ${c.metric}: crit −${st}`);
    set(`rule.${c.metric}.hyst+`, 'hysteresis', st, `правило ${c.metric}: гістерезис +${st}`);
    if (!(hyst < st)) set(`rule.${c.metric}.hyst-`, 'hysteresis', -st, `правило ${c.metric}: гістерезис −${st}`);
    const id = `rule.${c.metric}.op`;
    out.push({ id, group: 'rules', layer: 'unit', title: `правило ${c.metric}: напрям порівняння навпаки`,
      edits: [{ file: 'push.js', footer: footer(id, `const r = ${R}.get(${q(c.metric)}); r.op = r.op === 'lt' ? 'gt' : 'lt'`) }] });
  }
  return out;
}

// Дев'ять мутантів із підрозділу 7.2.2 (за симетричним поданням: обидві сторони lt/gt змінено разом)
export const LOGIC = [
  { n: 1, file: 'push.js', find: '(lt ? v < limit : v > limit)', replace: '(lt ? v <= limit : v >= limit)', title: 'nextLevel: поріг порушення включено' },
  { n: 2, file: 'push.js', find: 'lt ? v >= limit + r.hysteresis : v <= limit - r.hysteresis;', replace: 'lt ? v > limit + r.hysteresis : v < limit - r.hysteresis;', title: 'nextLevel: вихід із рівня за строгою нерівністю' },
  { n: 3, file: 'push.js', find: 'lt ? v >= limit + r.hysteresis : v <= limit - r.hysteresis;', replace: 'lt ? v >= limit : v <= limit;', title: 'nextLevel: гістерезис вилучено' },
  { n: 4, file: 'push.js', find: "  if (cur === 'critical' && !clear(r.crit)) return 'critical';\n", replace: '', title: 'nextLevel: критичний рівень не утримується' },
  { n: 5, file: 'push.js', find: "if (cur !== 'normal' && !clear(r.warn)) return 'warning';", replace: "if (cur === 'warning' && !clear(r.warn)) return 'warning';", title: 'nextLevel: із критичного відразу в нормальний' },
  { n: 6, file: 'alerts.js', find: 'if (cur.durationMs >= minDurationMs) out.push(cur);', replace: 'if (cur.durationMs > minDurationMs) out.push(cur);', title: 'findViolations: епізод рівно minDurationMs відкидається' },
  { n: 7, file: 'alerts.js', find: "if (cur && ms - prev > maxGapMs) close(prev, 'gap');", replace: "if (cur && ms - prev >= maxGapMs) close(prev, 'gap');", title: 'findViolations: розрив рівно maxGapMs закриває епізод' },
  { n: 8, file: 'alerts.js', find: '(lt ? v >= threshold + hysteresis : v <= threshold - hysteresis);', replace: '(lt ? v > threshold + hysteresis : v < threshold - hysteresis);', title: 'findViolations: вихід з епізоду за строгою нерівністю' },
  { n: 9, file: 'alerts.js', find: 'const worst = lt ? Math.min : Math.max;', replace: 'const worst = lt ? Math.max : Math.min;', title: 'findViolations: найгірше значення береться навпаки' },
];
export const logicMutants = () => LOGIC.map((m) => ({ id: `logic.${m.n}`, group: 'logic', layer: 'unit', title: m.title,
  edits: [{ file: m.file, find: m.find, replace: m.replace }] }));

export function netMutants(P) {
  const last = usedMetrics(P).at(-1);
  const root = P.topicRoot;
  const topicEdit = root === 'greenhouse'
    ? { file: 'mqtt-source.js', find: '^greenhouse\\/', replace: '^greenhous\\/' }
    : { file: 'mqtt-source.js', find: `|${root})`, replace: `|${root.slice(0, -1)})` };
  const id1 = `net.range.${last.id}.max+`;
  return [
    { id: id1, group: 'net', layer: 'net', title: `діапазон ${last.id}: верхня межа +${last.step} (шлях «відхилено»)`,
      edits: [{ file: 'core.js', footer: footer(id1, `RANGE.set(${q(last.id)}, [${last.range[0]}, ${fix(last.range[1] + last.step)}])`) }] },
    { id: 'net.duplicate', group: 'net', layer: 'net', title: 'повтор QoS 1 записується як нове показання (ON CONFLICT … DO UPDATE)',
      edits: [{ file: 'core.js', find: 'ON CONFLICT (device_id, metric, ts) DO NOTHING', replace: 'ON CONFLICT (device_id, metric, ts) DO UPDATE SET value = excluded.value' }] },
    { id: 'net.topic', group: 'net', layer: 'net', title: `корінь топіка домену «${root}» розпізнається неповністю`,
      edits: [topicEdit] },
  ];
}

// 12 мутантів матриці: за правилом (підручник 7.2.2 + власні дані домену)
export function matrixMutants(P) {
  const data = dataMutants(P); const rules = ruleMutants(P); const logic = logicMutants(); const net = netMutants(P);
  const get = (list, id) => { const m = list.find((x) => x.id === id); if (!m) throw new Error(`немає мутанта ${id}`); return m; };
  const ms = usedMetrics(P);
  const first = ms[0]; const lastM = ms.at(-1);
  const cmds = data.filter((m) => m.group === 'commands' && m.id.endsWith('max+'));
  const sets = data.filter((m) => m.group === 'settings' && m.id.endsWith('min-'));
  const r0 = ruleCards(P)[0]; const r1 = ruleCards(P).at(-1);
  const pick = [
    get(data, `range.${first.id}.max+`), get(data, `range.${first.id}.min-`), get(data, `range.${lastM.id}.min+`),
    cmds[0] ?? sets[0], cmds[0] ? sets[0] : sets[1],
    get(rules, `rule.${r0.metric}.warn+`), get(rules, `rule.${r0.metric}.hyst-`), get(rules, `rule.${r1.metric}.crit-`),
    get(logic, 'logic.5'), get(logic, 'logic.7'), get(net, 'net.duplicate'), get(net, 'net.topic'),
  ];
  const seen = new Set();
  return pick.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

// ---------------------------------------------------------------- копія застосунку й запуск тестів
const SKIP = new Set(['node_modules', 'results', 'bench4', 'wire-dist', 'coverage', 'work', 'sandbox']);
export function makeOverlay(app = APP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-overlay-'));
  fs.cpSync(app, dir, { recursive: true, filter: (src) => {
    const rel = path.relative(app, src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    return !SKIP.has(top) && !/\.(db|db-wal|db-shm)$/.test(rel);
  } });
  fs.symlinkSync(path.join(app, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
export const dropOverlay = (dir) => fs.rmSync(dir, { recursive: true, force: true });

export function applyMutant(dir, m) {
  const saved = [];
  try {
    for (const e of m.edits) {
      const f = path.join(dir, e.file);
      if (!fs.existsSync(f)) throw new Error(`немає файла ${e.file}`);
      const before = fs.readFileSync(f, 'utf8');
      let after;
      if (e.footer) after = before + e.footer;
      else {
        if (!before.includes(e.find)) throw new Error(`у ${e.file} не знайдено «${e.find.slice(0, 50)}»: чи змінювали ви еталонну функцію?`);
        after = before.replace(e.find, () => e.replace);
      }
      saved.push([f, before]);
      fs.writeFileSync(f, after);
    }
  } catch (err) { for (const [f, s] of saved) fs.writeFileSync(f, s); throw err; }
  return () => { for (const [f, s] of saved) fs.writeFileSync(f, s); };
}

const JEST = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js'];
// layer: 'unit' | 'integration' | 'legacy'; files — шляхи відносно застосунку (для legacy обов'язкові)
export function suiteCommand(layer, files) {
  if (layer === 'legacy') return { cmd: process.execPath, args: ['--test', ...files] };
  const proj = layer === 'unit' ? 'unit' : 'integration';
  return { cmd: process.execPath, args: [...JEST, '--selectProjects', proj, '--ci', '--silent', ...(files?.length ? ['--runTestsByPath', ...files] : [])] };
}
export const LEGACY_FILES = ['ingest.test.js', 'settings.test.js', 'alerts.test.js', 'push.test.js', 'contract.test.js'];

export function runProc(cmd, args, { cwd, env = {}, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => ch.kill('SIGKILL'), timeoutMs);
    ch.on('close', (code, sig) => { clearTimeout(timer); resolve({ code: sig ? 124 : code, out, ms: Date.now() - t0 }); });
  });
}

// Один запуск набору в overlay. status: killed | survived | not_applied | error
export async function runOnce(dir, layer, files, m) {
  let restore = () => {};
  const mark = path.join(dir, '.qa-mark');
  fs.rmSync(mark, { force: true });
  try {
    if (m) restore = applyMutant(dir, m);
    const { cmd, args } = suiteCommand(layer, files);
    const r = await runProc(cmd, args, { cwd: dir, env: { QA_MARK: mark } });
    const marks = fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '';
    const failedFooter = /fail /.test(marks) && !/ok /.test(marks);
    const noTests = /No tests found|Cannot find module|Could not find|ENOENT/.test(r.out) && !/Tests:\s+\d+ (passed|failed)|# tests \d+/.test(r.out);
    const status = noTests ? 'error' : (m && failedFooter) ? 'not_applied' : (r.code === 0 ? 'survived' : 'killed');
    return { status, code: r.code, out: r.out, ms: r.ms, failed: [...r.out.matchAll(/^\s*(?:●|✕|not ok \d+ -)\s+(.+)$/gm)].map((x) => x[1]).slice(0, 3), marks };
  } catch (e) {
    return { status: 'error', code: 2, out: String(e.message), ms: 0, failed: [] };
  } finally { restore(); }
}

// Набір мутантів проти одного шару; concurrency копій працюють паралельно
export async function runMutants(muts, layer, files, { concurrency = 2, baseline = true } = {}) {
  const pool = Array.from({ length: Math.min(concurrency, Math.max(muts.length, 1)) }, () => makeOverlay());
  try {
    if (baseline) {
      const b = await runOnce(pool[0], layer, files, null);
      if (b.status !== 'survived') return { baselineFailed: true, baseline: b, results: [] };
    }
    const results = new Array(muts.length);
    let i = 0;
    await Promise.all(pool.map(async (dir) => {
      for (;;) {
        const k = i++; if (k >= muts.length) return;
        results[k] = { mutant: muts[k], ...(await runOnce(dir, layer, files, muts[k])) };
      }
    }));
    return { baselineFailed: false, results };
  } finally { for (const d of pool) dropOverlay(d); }
}

// Перелік файлів тестів студента за назвами домену
export function studentFiles(code) {
  const c = code.toLowerCase();
  const rel = (p) => path.join('jest', ...p);
  return {
    unitDomain: rel(['unit', `domain-${c}.spec.js`]),
    unitRules: rel(['unit', `rules-${c}.spec.js`]),
    dbRange: rel(['integration', `range-${c}.spec.js`]),
    netDomain: rel(['integration', `domain-${c}.spec.js`]),
  };
}
export const have = (rel) => fs.existsSync(path.join(APP, rel));

// ---------------------------------------------------------------- групи мутантів і їхні набори тестів
export const GROUP_OF = { range: ['range'], cmdset: ['commands', 'settings'], rules: ['rules'], logic: ['logic'], net: ['net'] };
export const allMutants = (P) => [...dataMutants(P), ...ruleMutants(P), ...logicMutants(), ...netMutants(P)];

// Який шар і який файл тестів студента відповідає групі
export function planOf(P) {
  const F = studentFiles(P.code);
  return {
    range: { layer: 'integration', files: [F.dbRange] },
    cmdset: { layer: 'unit', files: [F.unitDomain] },
    rules: { layer: 'unit', files: [F.unitRules] },
    logic: { layer: 'unit', files: [F.unitRules] },
    net: { layer: 'integration', files: [F.netDomain] },
  };
}

// Чому набір червоний: назва тесту, що впав; для файла, який не завантажився, — перший рядок пояснення Jest
function baselineWhy(b) {
  const out = b.out.replace(/\x1b\[[0-9;]*m/g, '');
  const m = /Test suite failed to run\s*\n+\s*([^\n]+)/.exec(out);
  if (m) return `Test suite failed to run: ${m[1].trim()}`;
  const crash = /^\s*(TypeError: A dynamic import callback[^\n]*)$/m.exec(out);
  return b.failed[0] ? `${b.failed[0]}${crash ? `: ${crash[1].trim()}` : ''}` : out.trim().split('\n').slice(-3).join(' | ');
}

// {problem} | {total, killed, survivors}
export async function runGroup(P, name) {
  const pl = planOf(P)[name];
  const muts = allMutants(P).filter((m) => GROUP_OF[name].includes(m.group));
  const missing = pl.files.filter((f) => !have(f));
  if (missing.length) return { problem: `немає файла тестів ${missing.join(', ')}`, total: muts.length };
  const r = await runMutants(muts, pl.layer, pl.files);
  if (r.baselineFailed) return { problem: `тести ${pl.files.join(', ')} червоні й без мутантів: ${baselineWhy(r.baseline)}`, total: muts.length };
  const bad = r.results.find((x) => x.status === 'error' || x.status === 'not_applied');
  if (bad) return { problem: `мутант ${bad.mutant.id}: ${bad.status === 'not_applied' ? `не застосовано (${bad.marks.trim().split('\n').pop()}); перевірте назву й місце змінної в модулі` : bad.out.trim().split('\n').slice(-2).join(' | ')}`, total: muts.length };
  return { total: muts.length, killed: r.results.filter((x) => x.status === 'killed').length,
    survivors: r.results.filter((x) => x.status === 'survived').map((x) => x.mutant) };
}
