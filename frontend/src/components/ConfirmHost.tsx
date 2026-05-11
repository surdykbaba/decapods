import { useEffect, useState } from "react";
import { AlertTriangle, X, ShieldAlert } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";
import { usePendingConfirm, resolveConfirm } from "@/lib/confirm";

/** Mounted once at app root. Renders the active confirm dialog when one is
 *  pending. Outside-click and Escape both resolve `false`. */
export function ConfirmHost() {
  const p = usePendingConfirm();
  // Type-to-confirm input. Reset whenever the active dialog id changes so a
  // second confirm doesn't inherit the previous typed value.
  const [confirmText, setConfirmText] = useState("");
  useEffect(() => { setConfirmText(""); }, [p?.id]);

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
  // The confirm button is gated by the type-to-confirm input when one is
  // configured. Case-sensitive on purpose — names with capitalisation that
  // matter (initials, brand names) should round-trip exactly.
  const guardMet = !p.requireText || confirmText.trim() === p.requireText;

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

        {/* Body — bullets, warning banner and type-to-confirm input. All
            optional; renders nothing extra for a plain yes/no confirm. */}
        {(p.bullets?.length || p.warning || p.requireText) && (
          <div className="px-5 py-4 space-y-3 border-b border-border">
            {p.bullets && p.bullets.length > 0 && (
              <ul className="text-[12.5px] text-text space-y-1.5">
                {p.bullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                      danger ? "bg-danger" : "bg-accent"
                    }`} />
                    <span className="leading-snug">{b}</span>
                  </li>
                ))}
              </ul>
            )}
            {p.warning && (
              <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-[12px] ${
                danger
                  ? "bg-danger/10 border-danger/30 text-danger"
                  : "bg-warn/10 border-warn/30 text-warn"
              }`}>
                <ShieldAlert size={13} className="shrink-0 mt-0.5" />
                <span className="leading-snug">{p.warning}</span>
              </div>
            )}
            {p.requireText && (
              <div>
                <label className="block">
                  <div className="text-[11px] text-muted font-medium mb-1">
                    Type <code className="bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-text">{p.requireText}</code> to confirm
                  </div>
                  <input
                    autoFocus
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    className="input font-mono text-[13px]"
                    placeholder={p.requireText}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && guardMet) resolveConfirm(true);
                    }}
                  />
                </label>
              </div>
            )}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 p-4 bg-bg">
          <button
            onClick={() => resolveConfirm(false)}
            className="btn-ghost"
            autoFocus={!p.requireText}
          >
            {p.cancelLabel ?? "Cancel"}
          </button>
          <SmartButton
            variant={danger ? "danger" : "primary"}
            disabled={!guardMet}
            onClick={() => resolveConfirm(true)}
          >
            {p.confirmLabel ?? "Confirm"}
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}
