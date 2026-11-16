// main.js: фрагменти, змінені в ПР3 (число в кінці рядка — рівень)
const cfg = {
  // … mqttUrl, dbFile, port, sync — як у підручнику …
  root: process.env.TOPIC_ROOT ?? 'greenhouse',              // 3
  windowMs: Number(process.env.RT_WINDOW_MS ?? 100),         // 4
  sseRetryMs: Number(process.env.RT_SSE_RETRY_MS ?? 3000),   // 4
  sseMaxBuffered: Number(process.env.RT_SSE_MAX_BUFFERED
    ?? 1048576),                                             // 5
  maxQueue: Number(process.env.RT_MAX_QUEUE ?? 500),         // 5
};
const source = createMqttSource({
  url: cfg.mqttUrl,
  clientId: 'ingest-1',
  filter: `${cfg.root}/+/telemetry`,                         // 3
});
const feed = createFeed({
  windowMs: cfg.windowMs,                                    // 4
  onError: (e) => log('feed_error', { message: e.message }),
});
const channel = createMqttCommandChannel({
  url: cfg.mqttUrl, clientId: 'api-1',
  root: cfg.root,                                            // 3
});
// у main(): до виклику createServer додано поле sse,
// а до виклику attachRealtime — параметр maxQueue
const api = createServer({
  /* … поля як було … */
  sse: {
    retryMs: cfg.sseRetryMs,                                 // 4
    maxBuffered: cfg.sseMaxBuffered,                         // 5
    ...(security.tokens && {
      maxLifetimeMs: security.tokens.accessTtlSec * 1000 }),
  },
});
const realtime = attachRealtime(server, {
  db, feed, auth: security.auth, origins: sec.origins,
  maxQueue: cfg.maxQueue,                                    // 5
});
