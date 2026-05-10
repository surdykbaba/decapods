// Presence helpers — client-side heartbeat plus the shared formatter that
// renders "online", "5m offline", "2h offline" etc.
import { useEffect, useRef } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

export type Presence = "online" | "away" | "offline";

const HEARTBEAT_MS    = 60_000; // ping cadence while visible
const FAST_RESUME_MS  = 1_500;  // ping ~immediately when the tab regains focus

/** Mounts a heartbeat for the signed-in user. Idempotent — call once at the
 *  shell level. Pauses while the document is hidden so background tabs don't
 *  keep someone "online" forever. */
export function useHeartbeat() {
  const { token } = useAuth();
  const timerRef = useRef<number | null>(null);
  const lastSentRef = useRef<number>(0);

  useEffect(() => {
    if (!token) return;

    const send = () => {
      // Throttle: never two pings within 5s of each other (covers focus-flap).
      if (Date.now() - lastSentRef.current < 5_000) return;
      lastSentRef.current = Date.now();
      // Fire and forget. Failures (offline, server down) are silent — next
      // success bumps the timestamp and the user just shows "X minutes ago"
      // until then.
      api("/api/v1/me/heartbeat", { method: "POST" }).catch(() => {});
    };

    const start = () => {
      send();
      stop();
      timerRef.current = window.setInterval(send, HEARTBEAT_MS) as unknown as number;
    };
    const stop = () => {
      if (timerRef.current != null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        setTimeout(send, FAST_RESUME_MS);
        start();
      }
    };
    const onFocus = () => { if (!document.hidden) start(); };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [token]);
}

/** Format a `last_seen_at` timestamp as "online", "away · 2m", "offline · 14h",
 *  "offline · never" — matches the badge text used across the directory. */
export function presenceLabel(presence: Presence | string, lastSeenIso: string | null | undefined): string {
  if (presence === "online") return "online";
  if (lastSeenIso == null)   return presence === "offline" ? "never signed in" : presence;
  const delta = Date.now() - new Date(lastSeenIso).getTime();
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${presence} · ${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${presence} · ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${presence} · ${d}d`;
  return `${presence} · ${new Date(lastSeenIso).toLocaleDateString()}`;
}

export const PRESENCE_COLORS: Record<Presence, { dot: string; pill: string }> = {
  online:  { dot: "bg-success",        pill: "bg-success/15 text-success" },
  away:    { dot: "bg-warn",           pill: "bg-warn/15 text-warn" },
  offline: { dot: "bg-muted/50",       pill: "bg-bg text-muted border border-border" },
};
