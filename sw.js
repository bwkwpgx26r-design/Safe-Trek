const CACHE = "safetrek-shell-v6";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
    return;
  }

  event.respondWith(
    fetch(req)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return resp;
      })
      .catch(() => caches.match(req))
  );
});