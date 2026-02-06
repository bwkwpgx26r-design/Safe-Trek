// SafeTrek Service Worker
// Wichtig: Wenn du Änderungen pushst und iOS cached, VERSION erhöhen!
const VERSION = "safetrekw-v15";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./Logo.PNG"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== VERSION ? caches.delete(k) : Promise.resolve())))
    ).then(() => self.clients.claim())
  );
});

// Network-first für API, Cache-first für static
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // APIs immer network-first
  const isApi =
    url.hostname.includes("open-meteo.com") ||
    url.hostname.includes("nominatim.openstreetmap.org") ||
    url.hostname.includes("overpass-api.de") ||
    url.hostname.includes("overpass.kumi.systems") ||
    url.hostname.includes("overpass.openstreetmap.ru");

  if (isApi) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // static cache-first
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});