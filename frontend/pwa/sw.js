const CACHE_NAME = "nutrition-pwa-v19";
const ASSETS = ["/", "/src/styles.css", "/src/app.js", "/src/state.js", "/src/api.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => 
      Promise.all(keys.map((key) => caches.delete(key)))
    ).then(() => 
      caches.open(CACHE_NAME).then((cache) => {
        return cache.addAll(ASSETS);
      })
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Bypass cache completely for debugging
  event.respondWith(fetch(event.request));
});
