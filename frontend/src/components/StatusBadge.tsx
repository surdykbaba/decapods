// Top-bar presence badge. Only two choices in the menu: Automatic (default,
// derived from heartbeat) and Request for leave (opens the formal HR dialog).
// No manual override clutter — absence flows through proper approval.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronDown, CalendarPlus, Sparkles, Check, Clock, CheckCircle2 } from "lucide-react";
import { RequestLeaveDialog } from "@/modules/leave/LeavePage";

type EffectiveStatus = "online" | "away" | "busy" | "offline";

type StatusResponse = {
  presence:     EffectiveStatus;
  last_seen_at: string | null;
};

type PendingLeave = {
  id: string;
  status: "pending" | "approved";
  approval_stage: "manager_pending" | "hr_pending" | "completed";
  type_name: string;
  start_date: string;
  end_date: string;
  days: number;
};

function fmtLeaveStatus(p: PendingLeave): { label: string; sublabel: string; cls: string; icon: React.ReactNode } {
  if (p.status === "approved") {
    return {
      label: "Leave approved",
      sublabel: `${p.type_name} · ${new Date(p.start_date).toLocaleDateString()} → ${new Date(p.end_date).toLocaleDateString()}`,
      cls: "bg-success/10 text-success border-success/30",
      icon: <CheckCircle2 size={13} />,
    };
  }
  if (p.approval_stage === "manager_pending") {
    return {
      label: "Awaiting line manager",
      sublabel: `${p.type_name} · ${p.days}d from ${new Date(p.start_date).toLocaleDateString()}`,
      cls: "bg-accent-soft text-accent border-accent/30",
      icon: <Clock size={13} />,
    };
  }
  return {
    label: "Awaiting HR sign-off",
    sublabel: `${p.type_name} · ${p.days}d from ${new Date(p.start_date).toLocaleDateString()}`,
    cls: "bg-warn/10 text-warn border-warn/30",
    icon: <Clock size={13} />,
  };
}

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

  // Surface the user's most recent live leave request (pending or approved-but-
  // future) so the dropdown can tell them "Awaiting HR sign-off" without
  // making them open the Leave page.
  const { data: pendingLeave } = useQuery<{ item: PendingLeave | null }>({
    queryKey: ["me", "leave-pending"],
    queryFn: () => api("/api/v1/leave/my-pending"),
    refetchInterval: 60_000,
  });
  const live = pendingLeave?.item;
  const liveMeta = live ? fmtLeaveStatus(live) : null;

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

            {liveMeta && (
              <div className={`mx-3 mt-3 px-3 py-2 rounded-lg border text-[11.5px] flex items-start gap-2 ${liveMeta.cls}`}>
                <span className="mt-0.5">{liveMeta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{liveMeta.label}</div>
                  <div className="opacity-80 leading-tight">{liveMeta.sublabel}</div>
                </div>
              </div>
            )}

            <ul className="py-1 mt-1">
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
                    <div className="text-[13px] font-bold text-text">
                      {live ? "Apply for another leave" : "Request for leave"}
                    </div>
                    <div className="text-[11px] text-muted leading-snug">
                      {live ? "You can stack a second request" : "Submit a request to HR for approval"}
                    </div>
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
            qc.invalidateQueries({ queryKey: ["me", "leave-pending"] });
          }}
        />
      )}
    </>
  );
}
