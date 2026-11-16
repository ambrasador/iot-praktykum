// Доступ до еталонного застосунку (каталог greenhouse-monitor поруч із kit/)
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

import { ROOT } from './paths.mjs';
export { ROOT };
export const APP = process.env.GM_APP ? path.resolve(process.env.GM_APP) : path.join(ROOT, 'greenhouse-monitor');

if (!fs.existsSync(path.join(APP, 'package.json'))) {
  console.error(`Немає застосунку в ${APP}. Розпакуйте kod_rozdilu7.zip у ${ROOT} і виконайте npm ci у greenhouse-monitor.`);
  process.exit(2);
}
export const appRequire = createRequire(path.join(APP, 'package.json'));
export const appPath = (...p) => path.join(APP, ...p);
