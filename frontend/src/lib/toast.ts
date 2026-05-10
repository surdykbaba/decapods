// Tiny global toast bus — no provider needed. Components subscribe via useToasts().
import { useEffect, useState } from "react";

export type ToastTone = "success" | "error" | "info" | "warn";
export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  ttl: number; // ms before auto-dismiss
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emit() { listeners.forEach((l) => l(toasts)); }

export function pushToast(t: Omit<Toast, "id" | "ttl"> & { ttl?: number }) {
  const id = Math.random().toString(36).slice(2);
  const ttl = t.ttl ?? (t.tone === "error" ? 6000 : 3000);
  const next: Toast = { id, ttl, ...t };
  toasts = [...toasts, next];
  emit();
  setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string, body?: string) => pushToast({ tone: "success", title, body }),
  error:   (title: string, body?: string) => pushToast({ tone: "error",   title, body }),
  info:    (title: string, body?: string) => pushToast({ tone: "info",    title, body }),
  warn:    (title: string, body?: string) => pushToast({ tone: "warn",    title, body }),
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
