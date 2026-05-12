// useMeetingNotifications — schedules browser Notifications 5 minutes before
// each upcoming meeting in the list it's given. State is persisted in
// localStorage so the user's preference rides across page loads.
//
// Notifications API permission flow:
//   • If not granted, the toggle requests it.
//   • If granted, we schedule via setTimeout for each event. setTimeout
//     drifts under tab throttling, so we also tick a 60s interval that
//     fires anything we may have missed.
//   • If denied, we surface that in the badge so the toggle is clearly
//     blocked at the browser level.
//
// Each ping shows {subject, start time, body=organizer/location} and a
// click handler that focuses the tab + opens the join URL if available.

import { useEffect, useMemo, useState } from "react";

export type MeetingForNotify = {
  id: string;
  subject: string;
  start: string;
  end: string;
  is_online?: boolean;
  join_url?: string;
  organizer?: string;
  location?: string;
};

const PREF_KEY = "meeting-notifications-enabled";
const FIRED_KEY = "meeting-notifications-fired";   // id → epoch ms when fired
const LEAD_MINUTES = 5;
const FIRED_TTL_MS = 24 * 60 * 60 * 1000;          // forget after a day

function permission(): NotificationPermission {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}

function readFired(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FIRED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    // Garbage-collect old entries so the map doesn't grow forever.
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (now - v < FIRED_TTL_MS) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function markFired(id: string) {
  const map = readFired();
  map[id] = Date.now();
  localStorage.setItem(FIRED_KEY, JSON.stringify(map));
}

function fire(ev: MeetingForNotify) {
  if (permission() !== "granted") return;
  const body = [ev.organizer, ev.location].filter(Boolean).join(" · ") ||
    new Date(ev.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const n = new Notification(`${ev.subject || "Meeting"} — starting soon`, {
    body,
    tag: `meeting-${ev.id}`,
    icon: "/brand/logo-dark.png",
    badge: "/brand/logo-dark.png",
  });
  n.onclick = () => {
    window.focus();
    if (ev.join_url) window.open(ev.join_url, "_blank", "noopener");
    n.close();
  };
  markFired(ev.id);
}

export function useMeetingNotifications(events: MeetingForNotify[]) {
  const supported = typeof Notification !== "undefined";
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (!supported) return false;
    return localStorage.getItem(PREF_KEY) === "1" && Notification.permission === "granted";
  });
  const [perm, setPerm] = useState<NotificationPermission>(supported ? Notification.permission : "denied");

  // Schedule per-event timeouts + a safety tick for fallbacks.
  const upcoming = useMemo(() => {
    const now = Date.now();
    return events.filter((e) => new Date(e.start).getTime() > now);
  }, [events]);

  useEffect(() => {
    if (!enabled || !supported) return;
    const timers: number[] = [];
    upcoming.forEach((ev) => {
      const startMs = new Date(ev.start).getTime();
      const fireAt = startMs - LEAD_MINUTES * 60_000;
      const delay = fireAt - Date.now();
      const fired = readFired();
      if (fired[ev.id]) return;
      if (delay <= 0) {
        // Already in the window — fire immediately if start is still
        // future (don't ping for events that already started).
        if (startMs > Date.now()) fire(ev);
        return;
      }
      const t = window.setTimeout(() => fire(ev), delay);
      timers.push(t);
    });
    // Safety net: 60s ticker scans for anything the throttled setTimeout
    // might have missed (background tabs).
    const tick = window.setInterval(() => {
      const now = Date.now();
      const fired = readFired();
      upcoming.forEach((ev) => {
        if (fired[ev.id]) return;
        const startMs = new Date(ev.start).getTime();
        const dueAt = startMs - LEAD_MINUTES * 60_000;
        if (now >= dueAt && now < startMs) fire(ev);
      });
    }, 60_000);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearInterval(tick);
    };
  }, [enabled, supported, upcoming]);

  async function toggle() {
    if (!supported) return;
    if (enabled) {
      setEnabled(false);
      localStorage.setItem(PREF_KEY, "0");
      return;
    }
    // Request permission if needed.
    let p = Notification.permission;
    if (p === "default") {
      p = await Notification.requestPermission();
    }
    setPerm(p);
    if (p === "granted") {
      setEnabled(true);
      localStorage.setItem(PREF_KEY, "1");
    } else {
      setEnabled(false);
      localStorage.setItem(PREF_KEY, "0");
    }
  }

  return {
    supported,
    enabled,
    denied: perm === "denied",
    toggle,
  };
}
