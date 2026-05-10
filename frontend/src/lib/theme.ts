import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const KEY = "pgdp-theme";

function systemPref(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function read(): Theme {
  if (typeof localStorage === "undefined") return "light";
  const v = localStorage.getItem(KEY);
  if (v === "light" || v === "dark") return v;
  return systemPref();
}

function apply(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", t === "dark");
  document.documentElement.style.colorScheme = t;
}

let current: Theme = read();
apply(current);

const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }

export function setTheme(t: Theme) {
  current = t;
  try { localStorage.setItem(KEY, t); } catch {}
  apply(t);
  notify();
}

export function toggleTheme() {
  setTheme(current === "dark" ? "light" : "dark");
}

export function useTheme() {
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const get = () => current;
  return useSyncExternalStore(subscribe, get, get);
}
