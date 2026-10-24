const CACHE_PREFIX = 'noteos-pwa-shell-';
const CACHE_NAME = `${CACHE_PREFIX}0002`;
const LEGACY_CACHE_NAMES = ['noteos-gate1-shell-v1'];
const MAX_DYNAMIC_ENTRIES = 80;
const SHELL_ASSETS = [
  '/',
  '/offline',
  '/pwa-guide',
  '/manifest.webmanifest',
  '/icons/noteos-192.png',
  '/icons/noteos-512.png',
  '/icons/noteos-maskable-512.png',
  '/apple-icon.png',
  '/apple-touch-icon.png',
];

function isSyncApi(url) {
  return url.pathname === '/api/v1/sync' || url.pathname.startsWith('/api/v1/sync/');
}

function isRscShellRequest(request, url) {
  return request.headers.get('rsc') === '1'
    && url.searchParams.has('_rsc')
    && [...url.searchParams.keys()].every(key => key === '_rsc');
}

function isCacheableRequest(request, url) {
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (['/manifest.webmanifest', ...SHELL_ASSETS.slice(4)].includes(url.pathname)) return true;
  if (request.mode === 'navigate' && !url.search) return true;
  return isRscShellRequest(request, url);
}

async function shellCacheNames() {
  return (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX)).sort().reverse();
}

async function cachedResponse(request) {
  for (const name of await shellCacheNames()) {
    const cache = await caches.open(name);
    const response = await cache.match(request, { ignoreSearch: false });
    if (response) return response;
  }
  return undefined;
}

async function trimDynamicEntries(cache) {
  const core = new Set(SHELL_ASSETS.map(path => new URL(path, self.location.origin).href));
  const keys = await cache.keys();
  const dynamic = keys.filter(request => {
    const url = new URL(request.url);
    return !core.has(url.href) && !url.pathname.startsWith('/_next/static/');
  });
  for (const request of dynamic.slice(0, Math.max(0, dynamic.length - MAX_DYNAMIC_ENTRIES))) await cache.delete(request);
}

async function saveResponse(request, response) {
  if (!response.ok || response.type === 'opaque') return;
  if (/\bno-store\b|\bprivate\b/i.test(response.headers.get('cache-control') ?? '')
    && response.headers.get('x-noteos-offline-shell') !== 'client-only') return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  await trimDynamicEntries(cache);
}

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(SHELL_ASSETS.map(async path => {
    const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
    if (!response.ok) throw new Error(`Could not prepare offline shell asset: ${path}`);
    await cache.put(path, response);
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await shellCacheNames();
  await Promise.all(names.slice(2).map(name => caches.delete(name)));
  await Promise.all(LEGACY_CACHE_NAMES.map(name => caches.delete(name)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sync requests are always network-only, including authenticated responses.
  if (isSyncApi(url)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (request.method !== 'GET' || !isCacheableRequest(request, url)) return;

  const immutableAsset = url.pathname.startsWith('/_next/static/')
    || (url.pathname.startsWith('/icons/') && url.pathname.endsWith('.png'))
    || url.pathname === '/apple-icon.png'
    || url.pathname === '/apple-touch-icon.png';
  event.respondWith((async () => {
    if (immutableAsset) {
      const existing = await cachedResponse(request);
      if (existing) return existing;
    }
    try {
      const response = await fetch(request);
      if (response.ok) await saveResponse(request, response);
      return response;
    } catch (error) {
      const existing = await cachedResponse(request);
      if (existing) return existing;
      if (request.mode === 'navigate') {
        const offline = await cachedResponse('/offline');
        if (offline) return offline;
      }
      throw error;
    }
  })());
});
