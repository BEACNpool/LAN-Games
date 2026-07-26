/* LAN Games app shell. Multiplayer state is always live and never cached;
   only the lightweight interface/assets are kept for fast repeat launches. */
const CACHE = "lan-games-shell-v3";
const SHELL = [
  "/",
  "/offline",
  "/shared/shared.css",
  "/shared/hub-premium.css",
  "/shared/gameart.css",
  "/shared/hubnet.js",
  "/shared/hub.js",
  "/shared/gameart.js",
  "/shared/brand.js",
  "/shared/qr.js",
  "/shared/app-icon.svg",
  "/shared/app-icon-192.png",
  "/shared/app-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/avatars/")
      || url.pathname.startsWith("/chatmedia/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((hit) => hit || caches.match("/offline")))
    );
    return;
  }

  if (url.pathname.startsWith("/shared/") || url.pathname.startsWith("/games/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
});
