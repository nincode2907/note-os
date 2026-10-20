const CACHE = 'noteos-gate1-shell-v1';
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try { await cache.addAll(['/powersync', '/watermelon']); } catch {}
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached && (url.pathname.startsWith('/_next/static/') || request.mode === 'navigate')) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith('/_next/static/') || request.mode === 'navigate')) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
