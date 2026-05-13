// Phase 1 PWA primitives — install prompt + update notice + app badge.
//
// These are deliberately small, framework-agnostic pieces a single
// `<PwaHooks />` mount renders inside the app Shell. None of them
// require a backend round-trip; everything is local browser plumbing.
//
//   • Install prompt — captures `beforeinstallprompt` and surfaces a
//     dismissible chip in the Shell footer. Once dismissed (or
//     installed) it stays dismissed for the device session via
//     localStorage so we never nag.
//
//   • Update notice — vite-plugin-pwa's `registerType: "prompt"`
//     emits an `onNeedRefresh` callback when the new SW is waiting
//     for activation. We toast "New version available · Reload" and
//     let the user pick the moment.
//
//   • App badge — `navigator.setAppBadge()` (Android/Chrome + iOS
//     16.4+ when installed). Reads the unread notifications count
//     from the existing /notifications endpoint and keeps the home
//     screen number in sync.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, X as XIcon } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

// BeforeInstallPromptEvent isn't in lib.dom yet — type it minimally.
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// Storage key — bumped if we ever want to re-surface the chip for
// users who've dismissed it.
const INSTALL_DISMISSED_KEY = "pwa-install-dismissed:v1";

export function PwaHooks() {
  return (
    <>
      <InstallChip />
      <UpdateWatcher />
      <BadgeSync />
    </>
  );
}

/* ---------- Install chip ---------- */

function InstallChip() {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(INSTALL_DISMISSED_KEY) === "1",
  );

  useEffect(() => {
    function onPrompt(e: Event) {
      // Stop the browser's default mini-infobar.
      e.preventDefault();
      setEvt(e as InstallPromptEvent);
    }
    function onInstalled() {
      setEvt(null);
      // Treat installation as a permanent dismiss — don't show the
      // chip again on this device.
      localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
      setDismissed(true);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!evt || dismissed) return null;

  async function install() {
    if (!evt) return;
    await evt.prompt();
    const choice = await evt.userChoice;
    if (choice.outcome === "accepted") {
      toast.success("Installing D'Accubin…", "It'll appear on your home screen.");
    }
    setEvt(null);
  }

  function dismiss() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    setDismissed(true);
    setEvt(null);
  }

  return (
    // Bottom-right pill — out of the way on desktop, big tap target on
    // phones. Anchors via fixed so the Shell layout doesn't need to
    // reserve space.
    <div className="fixed bottom-4 right-4 z-40 max-w-[320px] bg-surface border border-accent/40 rounded-2xl shadow-card px-4 py-3 flex items-start gap-3">
      <span className="w-9 h-9 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
        <Download size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-text">Install D'Accubin</div>
        <p className="text-[11.5px] text-muted leading-snug mt-0.5">
          Add to your home screen for a faster, full-screen experience.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={install}
            className="text-[12px] font-bold bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent/90"
          >
            Install
          </button>
          <button
            onClick={dismiss}
            className="text-[12px] font-semibold text-muted hover:text-text"
          >
            Not now
          </button>
        </div>
      </div>
      <button
        onClick={dismiss}
        className="text-muted/70 hover:text-text"
        aria-label="Dismiss install prompt"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

/* ---------- Update watcher ---------- */

function UpdateWatcher() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Re-poll for an update every 15 minutes while the page is open.
      // Cheap because the SW file is tiny + cache headers do the heavy
      // lifting once it has been fetched once.
      if (!reg) return;
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    },
  });

  useEffect(() => {
    if (!needRefresh) return;
    // Use the existing toast surface for consistency. The action
    // triggers SW activation + reload.
    toast.info("New version available", "Reload to pick it up — your work is saved.", {
      action: {
        label: "Reload",
        onClick: () => { updateServiceWorker(true); },
      },
      // Don't auto-dismiss this one — the user picks the moment.
      duration: Infinity,
    });
    // Clearing the flag immediately so a re-fire doesn't stack toasts;
    // the prompt itself stays visible until the user clicks it.
    setNeedRefresh(false);
  }, [needRefresh, updateServiceWorker, setNeedRefresh]);

  return null;
}

/* ---------- App badge ---------- */

// Badge support varies — Chrome+Edge on Android/Windows, Safari iOS 16.4+
// when the app is installed. We try/catch so unsupported browsers don't
// throw on every refetch.
type BadgeNav = Navigator & {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function BadgeSync() {
  const { data } = useQuery<{ unread?: number }>({
    queryKey: ["notifications", "unread-count-for-badge"],
    queryFn: async () => {
      // Re-uses the existing /notifications list endpoint and counts
      // unread client-side. Cheap (limit=50) and avoids needing a new
      // endpoint. If the count ever grows past 50 we under-report,
      // which is benign — the bell in the header still shows "9+".
      const r = await api<{ items?: { is_read: boolean }[] }>("/api/v1/notifications");
      const unread = (r.items ?? []).filter((n) => !n.is_read).length;
      return { unread };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useEffect(() => {
    const nav = navigator as BadgeNav;
    if (!nav.setAppBadge) return; // unsupported browser
    const count = data?.unread ?? 0;
    if (count > 0) {
      nav.setAppBadge(count).catch(() => {});
    } else {
      nav.clearAppBadge?.().catch(() => {});
    }
  }, [data?.unread]);

  return null;
}
