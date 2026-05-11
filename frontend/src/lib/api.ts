// api — fetch wrapper used by every TanStack query in the app.
//
// Two layers of robustness around the bare fetch:
//
//   1. Body decoding   — Gin's default 404 / 405 / panic responses are plain
//      text ("404 page not found"). JSON.parse would crash on those and
//      mask the real status, so we try-catch and fall back to the raw
//      string so the caller still sees a meaningful error.
//
//   2. Token refresh   — when the access token expires the server replies
//      401. We used to call logout() right away, which kicked the user
//      out mid-session every ~15 minutes. Instead, we POST the stored
//      refresh token to /auth/refresh, swap the new tokens into the
//      auth store, and retry the original request once. Only when the
//      refresh itself fails do we sign them out for real.
//
//      A shared in-flight promise dedupes concurrent 401s — if ten
//      queries all hit a stale token at once, they share a single
//      refresh call instead of stampeding the endpoint.

import { useAuth } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Endpoints that should NOT trigger an auto-refresh. /auth/refresh itself
// obviously, and /auth/login (no token to refresh by definition).
const SKIP_REFRESH = ["/api/v1/auth/refresh", "/api/v1/auth/login", "/api/v1/auth/mfa/verify"];

// In-flight refresh promise — null when no refresh is happening. Every 401
// awaits this one promise so concurrent requests share a single round trip.
let inflightRefresh: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const state = useAuth.getState();
    const refresh = state.refresh;
    if (!refresh) return null;
    try {
      const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) return null;
      const tok = (await res.json().catch(() => null)) as
        | { access_token?: string; refresh_token?: string }
        | null;
      if (!tok?.access_token) return null;
      // Persist immediately so the retry + every other in-flight request
      // picks up the new value. If the server didn't rotate the refresh
      // token, keep the old one.
      state.setTokens(tok.access_token, tok.refresh_token ?? refresh);
      return tok.access_token;
    } catch {
      return null;
    } finally {
      // Always clear so the next 401 can start a fresh attempt.
      setTimeout(() => { inflightRefresh = null; }, 0);
    }
  })();
  return inflightRefresh;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = useAuth.getState();
  const skipRefresh = SKIP_REFRESH.some((p) => path.startsWith(p));

  // First attempt with the current access token.
  let res = await doFetch(path, init, auth.token);

  // 401 → try to refresh and replay, exactly once. Skips on /auth/* paths
  // where refresh is either meaningless or recursive.
  if (res.status === 401 && !skipRefresh && auth.refresh) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      res = await doFetch(path, init, newToken);
    }
  }

  if (res.status === 401) {
    // Either no refresh token, or the refresh itself failed. Surface a
    // clear signal AND log out — but only now, after we've genuinely
    // exhausted the auto-recovery path.
    useAuth.getState().logout();
    throw new ApiError(401, null, "unauthorized");
  }

  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && (body as any).error) ||
      (typeof body === "string" && body) ||
      res.statusText ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, body, message);
  }
  return body as T;
}

// Thin helper so the auto-refresh retry path doesn't duplicate header logic.
async function doFetch(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}
