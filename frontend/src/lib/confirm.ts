// Promise-based custom confirm dialog. Replaces window.confirm() so we get a
// styled modal that matches the rest of the app instead of the browser-native
// "localhost:5173 says…" gray box.
//
// Usage:
//   if (await confirmAction({ title: "Remove Jane?", body: "...", danger: true })) {
//     remove.mutate(id);
//   }
//
// Mount <ConfirmHost /> once in App.tsx (already done in this PR).

import { useEffect, useState } from "react";

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  id: string;
  resolve: (ok: boolean) => void;
}

let pending: PendingConfirm | null = null;
const listeners = new Set<(p: PendingConfirm | null) => void>();

function emit() { listeners.forEach((l) => l(pending)); }

/** Open a confirm modal. Resolves true if the user confirms, false on cancel
 *  (including outside-click and Escape). Only one confirm is open at a time —
 *  if you call this while another is open, the previous resolves false. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (pending) {
      pending.resolve(false);
    }
    pending = {
      id: Math.random().toString(36).slice(2),
      ...opts,
      resolve,
    };
    emit();
  });
}

export function resolveConfirm(answer: boolean) {
  if (!pending) return;
  const p = pending;
  pending = null;
  emit();
  p.resolve(answer);
}

export function usePendingConfirm(): PendingConfirm | null {
  const [p, setP] = useState<PendingConfirm | null>(pending);
  useEffect(() => {
    const l = (next: PendingConfirm | null) => setP(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return p;
}
