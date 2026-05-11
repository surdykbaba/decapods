// notificationAlerts — sound + desktop-toast wiring for the bell.
//
// Watches the React Query data behind the bell, detects items that weren't in
// the previous snapshot, and reacts to them:
//
//   • plays a short two-tone chime via Web Audio (no asset hosting needed)
//   • shows a native OS notification through the Notification API
//   • paints the unread count onto the page favicon
//
// All of it respects two user preferences stored in localStorage:
//   pgdp:alerts-sound    → "on" | "off"   (default on)
//   pgdp:alerts-desktop  → "on" | "off"   (default on; needs OS permission)
//
// Designed to be safe to mount in StrictMode — the "previous seen" set lives
// in a ref so a double-mount in dev doesn't fire two chimes.

import { useEffect, useRef } from "react";

export type AlertItem = {
  id: string;
  title: string;
  body?: string;
  link?: string;
  severity?: "info" | "warn" | "danger" | "critical" | string;
  at?: string;
  outbox_id?: string;
  read?: boolean;
};

const LS_SOUND   = "pgdp:alerts-sound";
const LS_DESKTOP = "pgdp:alerts-desktop";
const BASELINE_KEY = "pgdp:alerts-baseline"; // session id keys for first-mount silence

export function getSoundPref(): boolean {
  return (localStorage.getItem(LS_SOUND) ?? "on") !== "off";
}
export function setSoundPref(on: boolean) {
  localStorage.setItem(LS_SOUND, on ? "on" : "off");
}
export function getDesktopPref(): boolean {
  return (localStorage.getItem(LS_DESKTOP) ?? "on") !== "off";
}
export function setDesktopPref(on: boolean) {
  localStorage.setItem(LS_DESKTOP, on ? "on" : "off");
}

/** Current browser permission state for desktop notifications. */
export function desktopPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Request OS permission. Resolves with the new state. */
export async function requestDesktopPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

/** Synthesise a friendly two-tone chime. Cached AudioContext per session. */
let _ctx: AudioContext | null = null;
function chime() {
  if (!getSoundPref()) return;
  try {
    if (!_ctx) {
      const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      _ctx = new AC();
    }
    // Some browsers suspend the context until a user gesture; resume best-effort.
    if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
    const now = _ctx.currentTime;
    play(_ctx, 880, now, 0.18);          // E5-ish ping
    play(_ctx, 1320, now + 0.13, 0.22);  // higher follow
  } catch {
    /* audio failures are non-fatal — the OS toast still fires */
  }
}

function play(ctx: AudioContext, freq: number, when: number, duration: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.18, when + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration + 0.05);
}

/** Repaint the favicon with a small badge if count > 0. Falls back silently. */
export function paintFaviconBadge(count: number) {
  if (typeof document === "undefined") return;
  const link = (document.querySelector('link[rel="icon"]') ?? document.querySelector('link[rel="shortcut icon"]')) as HTMLLinkElement | null;
  if (!link) return;
  // Lazy-create a stash of the original href so we can clear back to it.
  if (!(link as any).__pgdpOriginal) (link as any).__pgdpOriginal = link.href;

  if (count <= 0) {
    link.href = (link as any).__pgdpOriginal;
    return;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      // Red badge in the top-right corner.
      const r = 18;
      ctx.beginPath();
      ctx.arc(size - r, r, r, 0, 2 * Math.PI);
      ctx.fillStyle = "#ef4444";
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.font = "bold 24px -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = count > 9 ? "9+" : String(count);
      ctx.fillText(label, size - r, r + 2);
      link.href = canvas.toDataURL("image/png");
    } catch {
      /* tainted-canvas etc. — leave the icon alone */
    }
  };
  img.src = (link as any).__pgdpOriginal;
}

/**
 * Hook: react to changes in the notification list.
 *
 * • On first mount we seed the "seen" set from the current items — that way
 *   refreshing the page doesn't re-ping you for everything you already knew
 *   about. The baseline lives on the window so a navigation within the SPA
 *   doesn't reset it either.
 *
 * • On every subsequent change, any id we haven't seen fires the chime + a
 *   single OS toast. Multiple new items get grouped into one toast.
 */
export function useNotificationAlerts(items: AlertItem[], unreadCount: number) {
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    paintFaviconBadge(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    // First-mount: seed silently so existing items don't all toast at once.
    if (seenRef.current === null) {
      // If the session-baseline marker is already in window memory we keep it
      // (e.g. tab navigation). Otherwise we just seed from current items.
      const w = window as any;
      if (w[BASELINE_KEY] instanceof Set) {
        seenRef.current = w[BASELINE_KEY];
      } else {
        seenRef.current = new Set(items.map((i) => i.id));
        w[BASELINE_KEY] = seenRef.current;
      }
      return;
    }

    const seen = seenRef.current;
    const fresh = items.filter((i) => !seen.has(i.id) && !i.read);
    if (fresh.length === 0) return;

    fresh.forEach((i) => seen.add(i.id));

    chime();

    if (getDesktopPref() && desktopPermission() === "granted") {
      // One toast for one item, "+ N more" pattern for multiples.
      const head = fresh[0];
      const title = fresh.length === 1
        ? head.title
        : `${fresh.length} new updates`;
      const body = fresh.length === 1
        ? (head.body ?? "")
        : `${head.title}${fresh.length > 1 ? ` · +${fresh.length - 1} more` : ""}`;
      try {
        const n = new Notification(title, {
          body,
          icon: "/brand/logo-dark.png",
          tag: head.outbox_id ?? head.id, // collapse identical re-fires
          silent: false,
        });
        if (head.link) {
          n.onclick = () => {
            window.focus();
            window.location.assign(head.link!);
            n.close();
          };
        }
      } catch {
        /* some browsers throw if called from non-secure or stripped-down contexts */
      }
    }
  }, [items, unreadCount]);
}
