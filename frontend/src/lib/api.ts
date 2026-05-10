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

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { token, logout } = useAuth.getState();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    logout();
    throw new ApiError(401, null, "unauthorized");
  }
  const text = await res.text();
  // Most endpoints return JSON, but Gin's default 404 / 405 / panic responses
  // are plain text ("404 page not found"). Don't let those crash the parser
  // and obscure the real status — fall back to a string body in that case.
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!res.ok) {
    const message = (body && typeof body === "object" && (body as any).error)
      || (typeof body === "string" && body)
      || res.statusText
      || `HTTP ${res.status}`;
    throw new ApiError(res.status, body, message);
  }
  return body as T;
}
