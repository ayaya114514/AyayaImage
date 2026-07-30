const CACHE_PREFIX = 'ayayaimage-shell';
const CACHE_VERSION = 'v5';
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const workerScope =
  /** @type {ServiceWorkerGlobalScope} */ (
    /** @type {unknown} */ (globalThis)
  );
const APP_SCOPE = new URL(workerScope.registration.scope);
const APP_ROOT = new URL('./', APP_SCOPE);
const PRECACHE_FILES = /* INJECT_PRECACHE */ [];

const STATIC_FILES = [
  APP_ROOT.href,
  ...PRECACHE_FILES.map((path) => new URL(path, APP_SCOPE).href),
];

const isCacheableResponse = (response) =>
  response?.ok && (response.type === 'basic' || response.type === 'default');

const isInAppScope = (url) =>
  url.origin === APP_SCOPE.origin && url.pathname.startsWith(APP_SCOPE.pathname);

async function fetchAndCache(cache, url) {
  const request = new Request(url, {
    cache: 'reload',
    credentials: 'same-origin',
  });
  const response = await fetch(request);

  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }

  return response;
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(
    STATIC_FILES.map((url) => fetchAndCache(cache, url)),
  );
  const rootResult = results[0];

  if (rootResult.status !== 'fulfilled' || !isCacheableResponse(rootResult.value)) {
    return;
  }

  const html = await rootResult.value.text();
  const referencedAssets = Array.from(
    html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g),
    ([, value]) => value,
  )
    .map((value) => {
      try {
        return new URL(value, APP_ROOT);
      } catch {
        return null;
      }
    })
    .filter((url) => url && isInAppScope(url))
    .map((url) => url.href);

  await Promise.allSettled(
    [...new Set(referencedAssets)].map((url) => fetchAndCache(cache, url)),
  );
}

workerScope.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().then(() => workerScope.skipWaiting()));
});

workerScope.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
              .map((key) => caches.delete(key)),
          ),
        ),
      workerScope.registration.navigationPreload?.enable(),
      workerScope.clients.claim(),
    ]),
  );
});

async function networkFirst(request, preloadResponse) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = (await preloadResponse) || (await fetch(request));
    if (isCacheableResponse(response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match(APP_ROOT.href));
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const refreshed = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cached || refreshed;
}

workerScope.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    request.headers.has('range') ||
    !isInAppScope(url)
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, event.preloadResponse));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
