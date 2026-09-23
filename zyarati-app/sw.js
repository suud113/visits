const CACHE = "visits-v10";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "exceljs.min.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
// Network first, skipping the browser's HTTP cache for the page itself so updates show on the next open.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const isPage = e.request.mode === "navigate" || u.pathname.endsWith("/") || u.pathname.endsWith(".html");
  const net = isPage ? fetch(u.origin + u.pathname, {cache: "no-cache", credentials: "same-origin"}) : fetch(e.request);
  e.respondWith(net.then(r => { if (r.ok){ const cp = r.clone(); caches.open(CACHE).then(c => c.put(isPage ? "./" : e.request, cp)); } return r; })
    .catch(() => caches.match(isPage ? "./" : e.request, {ignoreSearch: true}).then(r => r || caches.match("./"))));
});
