import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // "prompt" instead of "autoUpdate" so the SPA can surface a
      // "Reload to update" toast when a new build is detected — quieter
      // than yanking the page out from under a user mid-task.
      registerType: "prompt",
      includeAssets: ["favicon.svg", "robots.txt", "brand/logo-dark.png"],
      // The canonical manifest lives in /public/manifest.webmanifest so
      // it can be served as-is on the OAuth callback page too. We
      // intentionally don't redefine it inline here — the includeManifest
      // path would override the static file. Leaving manifest:false-ish
      // (empty object) keeps Vite-PWA from generating a duplicate.
      manifest: false,
      workbox: {
        navigateFallback: "/index.html",
        // Never let the SPA shell take over /api/* requests — that was
        // silently hijacking OAuth callbacks (Microsoft → /api/v1/auth/
        // microsoft/callback?code=…) and serving index.html instead,
        // so the backend never saw the auth code and no token was
        // persisted. Anything under /api/ must hit the network.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          // API: always try network, fall back to cache after 5s. Lets
          // the app keep rendering a "last known" view when offline,
          // while live data wins when online.
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "api",
              networkTimeoutSeconds: 5,
              expiration: { maxAgeSeconds: 60 * 60 * 24, maxEntries: 200 },
            },
          },
          // Images: stale-while-revalidate — fast paint, refresh in the
          // background. Mostly the brand assets + uploaded avatars.
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "img",
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30, maxEntries: 100 },
            },
          },
          // Google Fonts: long-cache the woff2 files themselves.
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts",
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Surface a "new version available" event the SPA can listen to
      // (see PwaUpdateToast in Shell.tsx).
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
