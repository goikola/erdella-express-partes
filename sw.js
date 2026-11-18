const CACHE = "erdella-express-v5";
const ASSETS = ["./?v=5", "index.html", "styles.css?v=5", "data.js?v=5", "xlsx-export.js?v=5", "app.js?v=5", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("index.html"))));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus() : clients.openWindow("./?v=5");
  }));
});
