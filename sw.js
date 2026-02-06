const CACHE_NAME = "safetrek-cache-v7";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./Logo.PNG"
];

// Install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - App-Shell: cache-first
// - APIs (Overpass/Wetter): network-first (damit es nicht "hängen bleibt" mit alten Daten)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  const isAppShell =
    url.origin === location.origin &&
    (APP_SHELL.includes(url.pathname.replace(location.pathname.replace(/\/[^/]*$/, "/"), "./")) ||
     url.pathname.endsWith(".css") ||
     url.pathname.endsWith(".js") ||
     url.pathname.endsWith(".json") ||
     url.pathname.endsWith(".PNG"));

  const isApi =
    url.hostname.includes("open-meteo.com") ||
    url.hostname.includes("overpass-api") ||
    url.hostname.includes("openstreetmap") ||
    url.hostname.includes("nominatim") ||
    url.hostname.includes("opentopodata");

  if (isApi) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(fetch(event.request).catch(() => caches.match("./")));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  cache.put(req, fresh.clone());
  return fresh;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}