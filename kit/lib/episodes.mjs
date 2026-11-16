// Еталонний пошук епізодів порушення порога, незалежний від alerts.js застосунку.
// Правила ті самі, що у підручнику (п. 2.5): епізод починається з першого значення «за порогом»,
// закривається поверненням за поріг із гістерезисом, розривом даних або кінцем вікна;
// епізоди коротші за min_duration відкидаються.
//
// points — масив { ms, value } за зростанням ms; rule — { op, threshold, hysteresis, minDurationMs, maxGapMs }.

export function episodes(points, rule) {
  const { op, threshold, hysteresis = 0, minDurationMs = 0, maxGapMs = Infinity } = rule;
  const sign = op === 'lt' ? -1 : 1;                       // «за порогом» у напрямку sign
  const beyond = (v) => sign * (v - threshold) > 0;        // gt: v > θ; lt: v < θ
  const cleared = (v) => sign * (v - threshold) <= -hysteresis;   // gt: v ≤ θ − h; lt: v ≥ θ + h
  const better = (a, b) => (sign > 0 ? Math.max(a, b) : Math.min(a, b));

  // 1) ряд ділиться на відрізки без розривів, довших за max_gap
  const segments = [];
  let seg = [];
  for (const p of points) {
    if (seg.length && p.ms - seg.at(-1).ms > maxGapMs) { segments.push(seg); seg = []; }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);

  // 2) у кожному відрізку — автомат «спокій / порушення»
  const out = [];
  segments.forEach((s, si) => {
    const lastSegment = si === segments.length - 1;
    let from = -1;                                         // індекс першого порушника
    let extreme = 0;
    const emit = (endIdx, endedBy, open) => {
      const startMs = s[from].ms;
      const endMs = s[endIdx].ms;
      if (endMs - startMs >= minDurationMs) {
        out.push({
          start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
          duration_sec: (endMs - startMs) / 1000, extreme, samples: endedBy === 'recovered' ? endIdx - from : endIdx - from + 1,
          ended_by: endedBy, open,
        });
      }
      from = -1;
    };
    s.forEach((p, i) => {
      if (from < 0) {
        if (beyond(p.value)) { from = i; extreme = p.value; }
      } else if (cleared(p.value)) {
        emit(i, 'recovered', false);
      } else {
        extreme = better(extreme, p.value);
      }
    });
    if (from >= 0) emit(s.length - 1, lastSegment ? 'window_end' : 'gap', lastSegment);
  });
  return out;
}

// Область допустимих (гістерезис, мінімальна тривалість): усі пари з сітки, що дають очікувані епізоди.
// want — функція від масиву епізодів, що повертає true для «правильного» результату.
export function validRegion(points, base, hGrid, dGrid, want) {
  const ok = [];
  for (const h of hGrid) {
    for (const d of dGrid) {
      if (want(episodes(points, { ...base, hysteresis: h, minDurationMs: d * 1000 }))) ok.push([h, d]);
    }
  }
  return ok;
}
