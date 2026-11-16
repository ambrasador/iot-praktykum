// client/domain.js: додати в кінець файлу (варіант 0)
export const D0 = {
  title: 'Теплиця (демонстраційний приклад з підручника)',
  push: true,                      // канал реального часу з ПР3
  defaultRange: '1h',              // з якого діапазону починається графік
  cards: ['soil_moisture', 'temperature'],
  metrics: {
    soil_moisture: {
      label: 'Вологість ґрунту', unit: '%', decimals: 1, periodSec: 60,
      rule: { direction: 'below', warn: 33, crit: 28 } },
    temperature: {
      label: 'Температура повітря', unit: '°C', decimals: 1, periodSec: 60,
      rule: { direction: 'above', warn: 32, crit: 35 } },
  },
};
