/* D'Accubin service worker.
 *
 * Network-first for navigation requests so a deploy never serves a stale
 * HTML shell; cache-first for hashed static assets (Vite emits them under
 * /assets/ with a content hash). Anything that fails the network and isn't
 * cached returns a tiny offline notice — enough to know the app is alive
 * but the network isn't.
 *
 * Bump SW_VERSION whenever you change runtime behaviour to force a clean
 * activation (old SW + old caches drop on update).
 */
const SW_VERSION = "daccubin-v1";
const RUNTIME = "daccubin-runtime-v1";
const PRECACHE = "daccubin-precache-v1";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/brand/logo-dark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((c) => c.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== PRECACHE && k !== RUNTIME).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept API requests — auth + freshness matter more than offline.
  if (url.pathname.startsWith("/api/")) return;

  // Navigation requests: network first, falling back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/"))),
    );
    return;
  }

  // Hashed static assets: cache-first.
  if (url.pathname.startsWith("/assets/") || /\.(?:js|css|woff2?|png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        });
      }),
    );
  }
});

// Future: respond to `pushsubscriptionchange` and `push` for push
// notifications. Keeping the surface minimal until the engine wires a
// real VAPID flow.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.SW_VERSION = SW_VERSION;
