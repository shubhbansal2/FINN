// Network-first for pages and the API (fresh when online, last copy when offline);
// cache-first only for content-hashed build assets, which never change under the same name.
const SHELL = "finn-shell-v2";
const DATA = "finn-data-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, cacheName) {
  return fetch(request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(cacheName).then((c) => c.put(request, copy));
      }
      return res;
    })
    .catch(() => caches.match(request));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
        return res;
      }))
    );
    return;
  }
  e.respondWith(networkFirst(e.request, url.pathname.startsWith("/api/") ? DATA : SHELL));
});

// Alerts as system notifications (raised by the page when the alert feed has something new).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data?.url || "/#/alerts"));
});
