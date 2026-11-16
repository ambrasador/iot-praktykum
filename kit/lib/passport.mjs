// Паспорти об'єктів: дані варіантів 1–5 і демонстраційного прикладу 0
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', 'domains');

export function loadPassport(variant) {
  const file = path.join(DIR, variant === 0 ? 'd0.json' : `v${variant}.json`);
  if (!fs.existsSync(file)) throw new Error(`немає паспорта для варіанта ${variant}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Метрики, які еталон уже знає (core.js, RANGE): паспорт додає до них власні
export const BASE_METRICS = [
  { id: 'temperature',   range: [-40, 85],   gen: { mean: 24, sd: 3, min: 5 },        decimals: 1 },
  { id: 'humidity',      range: [0, 100],    gen: { mean: 62, sd: 8, min: 20, max: 98 }, decimals: 1 },
  { id: 'soil_moisture', range: [0, 100],    gen: { mean: 45, sd: 6, min: 20, max: 80 }, decimals: 1 },
  { id: 'light',         range: [0, 200000], gen: { mean: 30000, sd: 12000, min: 0 }, decimals: 0 },
];

// Вид пристрою: яку множину метрик він надсилає за один звітний період
export const DEVICE_KINDS = {
  0: { bed: ['temperature', 'humidity', 'soil_moisture', 'ec'] },
  1: { bed: ['temperature', 'humidity', 'soil_moisture', 'soil_temp'], mast: ['wind', 'light', 'temperature', 'humidity'] },
  2: { room: ['temperature', 'co2', 'motion'], entry: ['door', 'power_w', 'motion'] },
  3: { water: ['water_m3'], gas: ['gas_m3'], power: ['energy_kwh'], flow: ['flow_lpm'] },
  4: { vehicle: ['lat', 'lon', 'speed', 'fuel_level', 'odometer'] },
  5: { pole: ['lamp_on', 'voltage', 'mains_present'] },
};

export function metricTable(passport) {
  const all = new Map(BASE_METRICS.map((m) => [m.id, m]));
  for (const m of passport.metrics) all.set(m.id, m);
  return all;
}
