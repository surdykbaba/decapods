import { useAuth } from "./auth";
const BASE = import.meta.env.VITE_API_BASE ?? "";
export class ApiError extends Error {
    status;
    body;
    constructor(status, body, message) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
export async function api(path, init = {}) {
    const { token, logout } = useAuth.getState();
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (token)
        headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    if (res.status === 401) {
        logout();
        throw new ApiError(401, null, "unauthorized");
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok)
        throw new ApiError(res.status, body, body?.error ?? res.statusText);
    return body;
}
