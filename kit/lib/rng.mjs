// Відтворюваний генератор випадкових чисел: те саме зерно дає ту саму послідовність
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));      // ціле з [lo, hi]
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return next;
}

// Зерно студента + номер варіанта дають незалежні потоки для кожного призначення
export const seedFor = (variant, seed, salt = 0) =>
  (Math.imul(variant + 1, 1_000_003) + Math.imul(seed + 1, 7_919) + Math.imul(salt + 1, 104_729)) >>> 0;
