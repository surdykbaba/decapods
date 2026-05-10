// Top-bar presence badge. Only two choices in the menu: Automatic (default,
// derived from heartbeat) and Request for leave (opens the formal HR dialog).
// No manual override clutter — absence flows through proper approval.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronDown, CalendarPlus, Sparkles, Check } from "lucide-react";
import { RequestLeaveDialog } from "@/modules/leave/LeavePage";

type EffectiveStatus = "online" | "away" | "busy" | "offline";

type StatusResponse = {
  presence:     EffectiveStatus;
  last_seen_at: string | null;
};

const STATUS_META: Record<EffectiveStatus, {
  label: string;
  dot: string;
  textCls: string;
  description: string;
}> = {
  online:  { label: "Online",  dot: "bg-success", textCls: "text-success", description: "Available — you'll get immediate notifications." },
  away:    { label: "Away",    dot: "bg-warn",    textCls: "text-warn",    description: "Idle for a while — your heartbeat went quiet." },
  busy:    { label: "Busy",    dot: "bg-danger",  textCls: "text-danger",  description: "Focus mode — desktop notifications muted." },
  offline: { label: "Offline", dot: "bg-muted",   textCls: "text-muted",   description: "Not connected." },
};

export function StatusBadge() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const { data } = useQuery<StatusResponse>({
    queryKey: ["me", "status"],
    queryFn: () => api("/api/v1/me/status"),
    refetchInterval: 60_000,
  });
  const effective: EffectiveStatus = data?.presence ?? "online";
  const meta = STATUS_META[effective];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <div ref={wrap} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-full hover:bg-bg transition-colors group"
          title={meta.description}
        >
          <span className="relative flex h-2.5 w-2.5">
            {effective === "online" && (
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${meta.dot} opacity-50`} />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-surface ${meta.dot}`} />
          </span>
          <span className={`text-[13px] font-semibold hidden sm:inline ${meta.textCls}`}>{meta.label}</span>
          <ChevronDown size={13} className="text-muted group-hover:text-text transition-colors" />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-50 w-[280px] bg-surface border border-border rounded-2xl shadow-card overflow-hidden animate-[slide-in_140ms_ease-out]"
          >
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                <span className={`text-sm font-bold ${meta.textCls}`}>{meta.label}</span>
              </div>
              <div className="text-[11.5px] text-muted mt-1 leading-snug">{meta.description}</div>
            </div>

            <ul className="py-1">
              <li>
                <button
                  className="w-full text-left flex items-center gap-3 px-4 py-2.5 bg-bg/40"
                  disabled
                >
                  <span className="w-8 h-8 rounded-full bg-accent text-white grid place-items-center shrink-0">
                    <Sparkles size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-text">Automatic</div>
                    <div className="text-[11px] text-muted leading-snug">Tracked from your activity</div>
                  </div>
                  <Check size={14} className="text-accent shrink-0" />
                </button>
              </li>
              <li>
                <button
                  onClick={() => { setOpen(false); setLeaveOpen(true); }}
                  className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-bg/40 transition-colors"
                >
                  <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0">
                    <CalendarPlus size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-text">Request for leave</div>
                    <div className="text-[11px] text-muted leading-snug">Submit a request to HR for approval</div>
                  </div>
                </button>
              </li>
            </ul>
          </div>
        )}
      </div>

      {leaveOpen && (
        <RequestLeaveDialog
          onClose={() => setLeaveOpen(false)}
          onCreated={() => {
            setLeaveOpen(false);
            qc.invalidateQueries({ queryKey: ["leave-requests"] });
            qc.invalidateQueries({ queryKey: ["me", "status"] });
          }}
        />
      )}
    </>
  );
}
