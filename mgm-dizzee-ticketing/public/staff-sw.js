// Service worker for the staff gate app (scope /staff). It caches only the static app shell so the app opens
// quickly; it never touches /api/ — ticket validation, sessions and scan history always go to the server.
// shortcut: /staff/* (manifest, icons) is cache-first; bump this name whenever those files change.
const CACHE = "mgm-staff-shell-v1";
const SHELL = "/staff.html";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const html = await (await fetch(SHELL, { cache: "no-store" })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await c.addAll(["/staff/manifest.json", "/staff/icon-192.png", ...assets]);
    await c.put(SHELL, new Response(html, { headers: { "Content-Type": "text/html" } }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate" && url.pathname.startsWith("/staff")) {
    // Network first so a new deploy is picked up; the cached shell only opens the app when offline.
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(SHELL, copy)); }
      return r;
    }).catch(() => caches.match(SHELL)));
    return;
  }
  // Hashed build assets and staff icons never change under the same URL: cache first.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/staff/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});
