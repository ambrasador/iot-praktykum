// Зонд дашборда (ПР4): завантажує client/domain.js, client/status.js, client/cards.js студента й перевіряє
// конфігурацію домену та поведінку карток на граничних значеннях і віках. Без браузера.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appPath } from './app.mjs';
import { loadPassport } from './passport.mjs';
import * as F from './formulas.mjs';

const url = (f) => pathToFileURL(appPath('client', f)).href;

export const expectedLevel = (v, rule) => {
  if (!rule) return 'ok';
  const beyond = (lim) => (rule.direction === 'below' ? v < lim : v > lim);
  return beyond(rule.crit) ? 'critical' : beyond(rule.warn) ? 'warning' : 'ok';
};

// k — кількість періодів до «Немає даних» (з журналу студента); без нього вік не перевіряється
export async function probeDomain(variant, { k } = {}) {
  const P = loadPassport(variant); const ui = P.ui; const T = P.load.T;
  const problems = []; const rows = [];
  let cfg; let status; let cards; let format;
  try {
    const mod = await import(url('domain.js'));
    cfg = mod[P.code];
    status = await import(url('status.js')); cards = await import(url('cards.js')); format = await import(url('format.js'));
  } catch (e) { return { problems: [`client/domain.js або модулі, які він використовує, не завантажуються: ${e.message}`], rows }; }
  if (!cfg || !Array.isArray(cfg.cards) || !cfg.metrics) return { problems: [`у client/domain.js немає експорту ${P.code} з полями cards і metrics (за зразком GREENHOUSE): export const ${P.code} = { … }`], rows };
  const entry = appPath('client', 'dashboard.jsx');
  const src = fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '';
  if (!new RegExp(`config=\\{\\s*${P.code}\\s*\\}`).test(src) || !/from\s+'\.\/domain\.js'/.test(src)) problems.push(`client/dashboard.jsx має підключати домен: import { ${P.code} } from './domain.js' і <DashboardPage config={${P.code}} …>`);

  if (cfg.title !== P.title) problems.push(`title = ${JSON.stringify(cfg.title)}, очікується ${JSON.stringify(P.title)}`);
  if (cfg.push !== true) problems.push(`push = ${JSON.stringify(cfg.push)}: канал ПР3 уже є, графік живить потік (push: true)`);
  const want = ui.cards.map((c) => c.metric);
  if (JSON.stringify(cfg.cards) !== JSON.stringify(want)) problems.push(`cards = ${JSON.stringify(cfg.cards)}, очікується ${JSON.stringify(want)} (метрики з рішенням оператора, порядок з паспорта)`);
  for (const c of ui.cards) {
    const m = cfg.metrics?.[c.metric];
    if (!m) { problems.push(`у metrics немає запису ${c.metric}`); continue; }
    for (const f of ['label', 'unit', 'decimals']) if (m[f] !== c[f]) problems.push(`${c.metric}.${f} = ${JSON.stringify(m[f])}, очікується ${JSON.stringify(c[f])}`);
    if (m.periodSec !== T) problems.push(`${c.metric}.periodSec = ${JSON.stringify(m.periodSec)}, очікується період звітування T = ${T} с`);
    const r = m.rule; const w = c.rule;
    const same = (!r && !w) || (r && w && r.direction === w.direction && r.warn === w.warn && r.crit === w.crit);
    if (!same) problems.push(`${c.metric}.rule = ${JSON.stringify(r)}, очікується ${JSON.stringify(w)}`);
  }

  // Поведінка: картки, зібрані кодом студента, на граничних значеннях і віках
  const now = Date.parse('2026-11-05T12:00:00Z');
  const iso = (ageS) => new Date(now - ageS * 1000).toISOString();
  const run = (c, value, ageS) => {
    const dev = [{ id: 'dev-01', name: 'dev-01', latest: [{ metric: c.metric, ts: iso(ageS), value }] }];
    const card = cards.buildCards(dev, cfg, now).find((x) => x.metric === c.metric);
    return card;
  };
  for (const c of ui.cards) {
    if (!cfg.metrics?.[c.metric]) continue;
    const e = 0.01; const r = c.rule;
    const cases = r
      ? (r.direction === 'above'
        ? [['під warn', r.warn - e], ['рівно warn', r.warn], ['над warn', r.warn + e], ['рівно crit', r.crit], ['над crit', r.crit + e]]
        : [['над warn', r.warn + e], ['рівно warn', r.warn], ['під warn', r.warn - e], ['рівно crit', r.crit], ['під crit', r.crit - e]])
      : [['будь-яке значення', 1]];
    for (const [name, v] of cases) {
      const got = run(c, v, 0); const exp = expectedLevel(v, r);
      rows.push({ metric: c.metric, case: name, value: v, age: 0, expected: exp, got: got?.level });
      if (got?.level !== exp) problems.push(`${c.metric}: значення ${v} (${name}) → «${got?.level}», очікується «${exp}» (строгі порівняння: рівне межі значення ще не за межею)`);
    }
    const sample = r ? (r.direction === 'above' ? r.warn - 1 : r.warn + 1) : 1;
    const txt = run(c, sample, 0)?.text; const wantTxt = format.formatValue(sample, c.unit, c.decimals);
    if (txt !== wantTxt) problems.push(`${c.metric}: текст картки ${JSON.stringify(txt)}, очікується ${JSON.stringify(wantTxt)} (одиниця й кількість знаків з паспорта)`);
    if (k) {
      for (const [name, age, exp] of [[`вік ${k}·T`, k * T, null], [`вік ${k}·T + 1 с`, k * T + 1, 'offline']]) {
        const got = run(c, sample, age)?.level; const e2 = exp ?? expectedLevel(sample, r);
        rows.push({ metric: c.metric, case: name, value: sample, age, expected: e2, got });
        if (got !== e2) problems.push(`${c.metric}: ${name} → «${got}», очікується «${e2}»: «Немає даних» настає через ${k} періоди (STALE_PERIODS у client/status.js)`);
      }
    }
  }
  if (k && status.staleAfterMs?.(T) !== k * T * 1000) problems.push(`staleAfterMs(${T}) = ${status.staleAfterMs?.(T)}, очікується ${k * T * 1000} мс (k = ${k})`);
  return { problems, rows, cfg };
}

// ---- CSS: змінні палітри й колір тексту позначок ----
const NAMED = { white: '#FFFFFF', black: '#000000' };
const norm = (c) => {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  return `#${(m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1]).toUpperCase()}`;
};
export function parseCss(css) {
  const vars = {};
  for (const m of css.matchAll(/--(ok|warn|crit|off)\s*:\s*([^;}]+)/g)) vars[m[1]] = norm(m[2]);
  const block = (sel) => {
    const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : null;
  };
  const prop = (b, name) => { const m = b && new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(b); return m ? m[1].trim() : null; };
  const base = norm(prop(block('.badge'), 'color'));
  const badge = {};
  const map = { ok: 'ok', warning: 'warn', critical: 'crit', offline: 'off' };
  for (const [level, v] of Object.entries(map)) {
    const b = block(`.badge--${level}`);
    const bg = prop(b, 'background');
    const bgRef = bg && /var\(--(\w+)\)/.exec(bg);
    badge[level] = { background: bgRef ? vars[bgRef[1]] : norm(bg), color: norm(prop(b, 'color')) ?? base, via: v };
  }
  return { vars, base, badge };
}

export function paletteProblems(variant) {
  const P = loadPassport(variant); const pal = P.ui.palette; const problems = [];
  const f = appPath('client', 'dashboard.css');
  if (!fs.existsSync(f)) return ['немає client/dashboard.css'];
  const css = parseCss(fs.readFileSync(f, 'utf8'));
  for (const [s, c] of Object.entries(pal)) if (css.vars[s] !== c.toUpperCase()) problems.push(`--${s} = ${css.vars[s]}, очікується ${c} (палітра з паспорта)`);
  const names = { ok: 'ok', warning: 'warn', critical: 'crit', offline: 'off' };
  for (const [level, b] of Object.entries(css.badge)) {
    if (!b.background || !b.color) { problems.push(`.badge--${level}: не вдалося визначити фон або колір тексту`); continue; }
    const ratio = F.cr(b.background, b.color);
    if (ratio < F.UI.textMin) problems.push(`.badge--${level}: текст ${b.color} на ${b.background} має контраст ${ratio.toFixed(2)} : 1 < ${F.UI.textMin} : 1 (критерій 1.4.3)`);
  }
  return problems;
}
