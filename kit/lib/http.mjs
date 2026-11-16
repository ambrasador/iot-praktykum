// Мінімальний HTTP-клієнт для перевірок: повертає { status, headers, body }
export async function call(base, method, path, { body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: json, text };
}
export const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
