// Правила домену D0 (вставити в push.js перед const LEVELS).
// Гістерезис soil_moisture виведено з шуму датчика (h >= k * sigma),
// temperature узято з клітинки варіанта
const RULES_D0 = new Map([
  ['soil_moisture', {
    op: 'lt', warn: 33, crit: 28, hysteresis: 6.5,
    label: 'Вологість ґрунту', unit: '%', decimals: 1,
  }],
  ['temperature', {
    op: 'gt', warn: 32, crit: 35, hysteresis: 1,
    label: 'Температура повітря', unit: '°C', decimals: 1,
  }],
]);

// у module.exports додайте RULES_D0 після RULES
