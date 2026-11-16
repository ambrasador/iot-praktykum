// commands.js: допустимі команди й перевірка їхніх параметрів
const exact = (p, keys) => p !== null && typeof p === 'object'
  && !Array.isArray(p) && Object.keys(p).length === keys.length
  && keys.every((k) => k in p);

const COMMANDS = {
  irrigate: (p) => Number.isInteger(p?.duration_sec)
    && p.duration_sec >= 1 && p.duration_sec <= 600,
  set_setpoint: (p) => ['temperature', 'humidity'].includes(p?.metric)
    && Number.isFinite(p?.value),
  // нова команда домену: точний набір ключів і межі з паспорта
  set_fan: (p) => exact(p, ['speed_pct'])
    && Number.isInteger(p.speed_pct)
    && p.speed_pct >= 0 && p.speed_pct <= 100,
};
