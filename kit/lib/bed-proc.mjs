// Запуск стенду окремим процесом: збій у коді студента не валить перевірку, а стає підказкою
import { spawn } from 'node:child_process';
import path from 'node:path';

const SERVE = path.resolve(import.meta.dirname, '..', 'tools', 'serve.mjs');
let cached = null;

export function getBed(track) {
  if (!cached) cached = launch(track);
  return cached;
}

function launch(track) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVE, '--json', '--port', '0', '--variant', String(track.variant), '--seed', String(track.seed)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const done = (v) => resolve({ child, ...v });
    const timer = setTimeout(() => done({ error: 'стенд не запустився за 90 с' }), 90_000);
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(timer); done(JSON.parse(line)); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(timer); if (!out.includes('{')) done({ error: `стенд завершився з кодом ${code}: ${err.trim().split('\n').slice(0, 3).join(' | ')}` }); });
  });
}

export async function stopBed() {
  if (!cached) return;
  const b = await cached;
  b.child?.kill();
}
