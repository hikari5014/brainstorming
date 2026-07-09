// Service worker：快取 app shell 供離線載入與 PWA 安裝。
// WebSocket（翻譯本體）不經過 SW；沒網路時 app 可開但無法翻譯。

const VERSION = 'v5';
const CACHE = `live-translator-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/settings.js',
  './js/languages.js',
  './js/pipeline.js',
  './js/modes.js',
  './js/video.js',
  './js/diagnostics.js',
  './js/audio/capture.js',
  './js/audio/playback.js',
  './js/audio/vad.js',
  './js/audio/worklets/capture-processor.js',
  './js/live/client.js',
  './js/live/engines.js',
  './js/live/mock.js',
  './js/ui/subtitles.js',
  './js/ui/usage.js',
  './js/ui/transcript.js',
  './icons/icon.svg',
  './icons/maskable.svg',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同源請求：網路優先、失敗退回快取（開發改版即時生效，離線仍可開）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
