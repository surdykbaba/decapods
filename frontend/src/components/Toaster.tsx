import { CheckCircle2, AlertTriangle, Info, XCircle, X } from "lucide-react";
import { useToasts, dismissToast, type ToastTone } from "@/lib/toast";

const TONE_CLS: Record<ToastTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  error:   "border-danger/30 bg-danger/10 text-danger",
  warn:    "border-warn/30 bg-warn/10 text-warn",
  info:    "border-accent/30 bg-accent-soft text-accent",
};

function iconFor(t: ToastTone) {
  if (t === "success") return <CheckCircle2 size={16} />;
  if (t === "error")   return <XCircle size={16} />;
  if (t === "warn")    return <AlertTriangle size={16} />;
  return <Info size={16} />;
}

export function Toaster() {
  const items = useToasts();
  // Top-centre, anchored under the page header — natural eye-line for confirmations.
  // Drops down with a soft slide so it draws attention without being jarring.
  return (
    <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[1100] flex flex-col gap-2 w-[min(440px,calc(100vw-2rem))] pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto bg-surface border-2 rounded-xl shadow-card px-4 py-3 flex items-start gap-2.5 animate-[toast-drop_220ms_cubic-bezier(0.32,0.72,0,1)] ${TONE_CLS[t.tone]}`}
        >
          <div className="shrink-0 mt-0.5">{iconFor(t.tone)}</div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-bold text-text leading-tight">{t.title}</div>
            {t.body && <div className="text-[12.5px] text-muted mt-0.5 leading-snug">{t.body}</div>}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-muted hover:text-text -mr-1 -mt-0.5"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
