// FoundIt service worker — minimal, safe caching for PWA installability + basic
// offline shell. It deliberately bypasses cross-origin requests (Supabase auth,
// data, Realtime, Google OAuth, fonts) so it never interferes with live APIs.

const CACHE = "foundit-v3"; // bump to drop every older cache on activate
const APP_SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Background sync (Chromium): the offline queue lives in page storage, so ask any
// open page to replay it. Other browsers replay on the page's "online" event.
self.addEventListener("sync", (event) => {
  if (event.tag !== "foundit-replay") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: "replay-queue" }));
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin requests. Never touch Supabase / Google / CDNs.
  if (url.origin !== self.location.origin) return;

  // The manifest carries the theme color and icons; always fetch it fresh so
  // changes reach installed apps instead of being served from a stale cache.
  if (url.pathname === "/manifest.webmanifest") return;

  // Never cache Vite dev-server modules; otherwise a worker left over from a
  // production build on the same origin serves stale source during development.
  if (/^\/(src|@vite|@id|@fs|@react-refresh|node_modules)\//.test(url.pathname) || url.pathname.startsWith("/@")) return;

  // Navigation requests: network-first so users get the latest app; fall back
  // to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/"))),
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    }),
  );
});
