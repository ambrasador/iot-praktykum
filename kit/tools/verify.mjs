#!/usr/bin/env node
// Вхідний/вихідний контроль: node kit/tools/verify.mjs pr01 [--level 4] [--declared-only]
// --declared-only: не виконувати довідкові пункти рівнів вище заявленого (корисно в ПР7, де вони тривалі)
import { readTrack } from '../lib/track.mjs';
import { runChecks } from '../lib/verify-core.mjs';
import { loadPassport } from '../lib/passport.mjs';

const [which, ...rest] = process.argv.slice(2);
if (!/^pr0[1-8]$/.test(which ?? '')) { console.error('Використання: verify.mjs pr01…pr08 [--level 3|4|5]'); process.exit(2); }
const track = readTrack();
if (rest.includes('--declared-only')) process.env.VERIFY_ONLY_LEVEL = '1';
const li = rest.indexOf('--level');
const level = li >= 0 ? Number(rest[li + 1]) : track.level;
const mod = await import(`../lib/checks/${which}.mjs`);
const P = loadPassport(track.variant);
const title = `${which.toUpperCase()} — варіант ${track.variant} («${P.title}»), зерно ${track.seed}, рівень ${level}`;
const ok = await runChecks({ title, checks: mod.checks(track), level });
if (mod.cleanup) await mod.cleanup();
process.exit(ok ? 0 : 1);
