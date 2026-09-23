const CACHE = "visits-v14";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "exceljs.min.js",
               "wa-import.js", "reader.js", "reader-model.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
// Network first, revalidating with the server (skips the browser's 10-minute HTTP cache) so updates show
// on the next open; the saved copy is used only when offline.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const isPage = e.request.mode === "navigate" || u.pathname.endsWith("/") || u.pathname.endsWith(".html");
  const key = isPage ? "./" : u.origin + u.pathname;
  const net = fetch(u.origin + u.pathname, {cache: "no-cache", credentials: "same-origin"});
  e.respondWith(net.then(r => { if (r.ok){ const cp = r.clone(); caches.open(CACHE).then(c => c.put(key, cp)); } return r; })
    .catch(() => caches.match(key, {ignoreSearch: true}).then(r => r || (isPage ? caches.match("./").then(p => p || Response.error()) : Response.error()))));
});
