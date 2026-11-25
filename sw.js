const CACHE = "erdella-express-v8";
const FIREBASE_ASSETS = [
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js"
];
const ASSETS = ["./?v=8", "index.html", "styles.css?v=6", "data.js?v=6", "xlsx-export.js?v=6", "app.js?v=8", "manifest.webmanifest?v=8", "icon.svg", "icon-192.png", "icon-512.png", ...FIREBASE_ASSETS];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && /^erdella-express-v\d+$/.test(key)).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || (url.origin !== self.location.origin && !FIREBASE_ASSETS.includes(url.href))) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("index.html"))));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus() : clients.openWindow("./?v=7");
  }));
});
