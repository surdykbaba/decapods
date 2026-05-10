import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";
import { usePendingConfirm, resolveConfirm } from "@/lib/confirm";

/** Mounted once at app root. Renders the active confirm dialog when one is
 *  pending. Outside-click and Escape both resolve `false`. */
export function ConfirmHost() {
  const p = usePendingConfirm();

  // Esc-to-cancel — only when a dialog is open.
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolveConfirm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  if (!p) return null;
  const danger = !!p.danger;

  return (
    <div
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/40 p-4 animate-[slide-in_140ms_ease-out]"
      onClick={() => resolveConfirm(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden"
      >
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <div className={`w-10 h-10 rounded-full grid place-items-center shrink-0 ${
            danger ? "bg-danger/15 text-danger" : "bg-accent-soft text-accent"
          }`}>
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-text">{p.title}</h2>
            {p.body && (
              <p className="text-[12.5px] text-muted mt-1 leading-snug whitespace-pre-line">
                {p.body}
              </p>
            )}
          </div>
          <button
            onClick={() => resolveConfirm(false)}
            className="text-muted hover:text-text shrink-0"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </header>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button
            onClick={() => resolveConfirm(false)}
            className="btn-ghost"
            autoFocus
          >
            {p.cancelLabel ?? "Cancel"}
          </button>
          <SmartButton
            variant={danger ? "danger" : "primary"}
            onClick={() => resolveConfirm(true)}
          >
            {p.confirmLabel ?? "Confirm"}
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}
