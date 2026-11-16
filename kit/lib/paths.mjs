// Корінь практикуму (каталог, у якому лежать kit/, greenhouse-monitor/, track.json і pr01…pr08)
import path from 'node:path';
export const ROOT = process.env.PRAKT_ROOT
  ? path.resolve(process.env.PRAKT_ROOT)
  : path.resolve(import.meta.dirname, '..', '..');
