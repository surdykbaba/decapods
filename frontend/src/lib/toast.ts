// Tiny global toast bus — no provider needed. Components subscribe via useToasts().
import { useEffect, useState } from "react";

export type ToastTone = "success" | "error" | "info" | "warn";
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  ttl: number; // ms before auto-dismiss; Infinity = sticky until user dismisses or clicks the action
  action?: ToastAction; // optional inline button — used by the SW-update prompt and similar
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emit() { listeners.forEach((l) => l(toasts)); }

export type ToastOpts = {
  duration?: number;        // ms; Number.POSITIVE_INFINITY for sticky
  action?: ToastAction;     // attaches an inline button
};

export function pushToast(t: Omit<Toast, "id" | "ttl"> & { ttl?: number }) {
  const id = Math.random().toString(36).slice(2);
  const ttl = t.ttl ?? (t.tone === "error" ? 6000 : 3000);
  const next: Toast = { id, ttl, ...t };
  toasts = [...toasts, next];
  emit();
  // Only schedule auto-dismiss when ttl is finite. Infinity = sticky;
  // the user (or the action click handler) is the dismiss path.
  if (Number.isFinite(ttl)) {
    setTimeout(() => dismissToast(id), ttl);
  }
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// Helper to keep call sites tidy. Accepts an optional opts bag so most
// existing two-arg calls (title, body) still work unchanged.
function make(tone: ToastTone, title: string, body?: string, opts?: ToastOpts) {
  pushToast({
    tone, title, body,
    ttl: opts?.duration ?? undefined,
    action: opts?.action,
  });
}

export const toast = {
  success: (title: string, body?: string, opts?: ToastOpts) => make("success", title, body, opts),
  error:   (title: string, body?: string, opts?: ToastOpts) => make("error",   title, body, opts),
  info:    (title: string, body?: string, opts?: ToastOpts) => make("info",    title, body, opts),
  warn:    (title: string, body?: string, opts?: ToastOpts) => make("warn",    title, body, opts),
};

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    const l: Listener = (next) => setList(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return list;
}
