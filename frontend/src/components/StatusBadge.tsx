// Skype-style presence badge for the top bar. Shows the user's current
// effective status (online / away / busy / offline) and lets them override
// it manually. Auto mode falls back to the heartbeat-derived presence.
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  Circle, Moon, MinusCircle, EyeOff, Sparkles, ChevronDown, Check,
} from "lucide-react";

type EffectiveStatus = "online" | "away" | "busy" | "offline";
type ManualStatus   = "" | "online" | "away" | "busy" | "invisible";

type StatusResponse = {
  presence:      EffectiveStatus;
  manual_status: ManualStatus;
  manual_until:  string | null;
  last_seen_at:  string | null;
};

// Visual config per effective state.
const STATUS_META: Record<EffectiveStatus, {
  label: string;
  dot: string;            // tailwind colour for the small dot
  ring: string;           // tailwind colour for an optional outer ring
  textCls: string;        // text colour for the badge label
  description: string;    // help tooltip / sublabel
}> = {
  online:  { label: "Online",       dot: "bg-success",      ring: "ring-success/40",  textCls: "text-success", description: "Available — you'll get immediate notifications." },
  away:    { label: "Away",         dot: "bg-warn",         ring: "ring-warn/40",     textCls: "text-warn",    description: "Stepped away briefly." },
  busy:    { label: "Do not disturb", dot: "bg-danger",     ring: "ring-danger/40",   textCls: "text-danger",  description: "Focus mode — desktop notifications muted." },
  offline: { label: "Offline",      dot: "bg-muted",        ring: "ring-muted/40",    textCls: "text-muted",   description: "Appearing offline to teammates." },
};

// Pickable options in the dropdown (these map to manual_status, not effective).
const MANUAL_OPTIONS: { value: ManualStatus | "auto"; label: string; sublabel: string; icon: React.ReactNode; dot: string }[] = [
  { value: "online",    label: "Available",    sublabel: "Show me as online",                    icon: <Circle size={14} className="fill-current" />, dot: "bg-success" },
  { value: "away",      label: "Away",         sublabel: "Stepped away — I'll be back soon",     icon: <Moon size={14} />,                              dot: "bg-warn" },
  { value: "busy",      label: "Do not disturb", sublabel: "Heads-down — minimise interruptions",icon: <MinusCircle size={14} />,                       dot: "bg-danger" },
  { value: "invisible", label: "Appear offline", sublabel: "Hide your status from teammates",    icon: <EyeOff size={14} />,                            dot: "bg-muted" },
  { value: "auto",      label: "Automatic",    sublabel: "Use my heartbeat to decide",           icon: <Sparkles size={14} />,                          dot: "bg-accent" },
];

export function StatusBadge() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Poll my own status occasionally so an expiry or external override surfaces.
  const { data } = useQuery<StatusResponse>({
    queryKey: ["me", "status"],
    queryFn: () => api("/api/v1/me/status"),
    refetchInterval: 60_000,
  });
  const effective: EffectiveStatus = data?.presence ?? "online";
  const manual = data?.manual_status ?? "";
  const meta = STATUS_META[effective];

  const set = useMutation({
    mutationFn: (status: ManualStatus | "auto") =>
      api("/api/v1/me/status", { method: "PUT", body: JSON.stringify({ status }) }),
    onSuccess: (_d, status) => {
      qc.invalidateQueries({ queryKey: ["me", "status"] });
      qc.invalidateQueries({ queryKey: ["presence"] });
      const next = status === "auto" ? "Automatic" : MANUAL_OPTIONS.find((o) => o.value === status)?.label ?? status;
      toast.success(`Status set to ${next}`);
    },
    onError: (e: Error) => toast.error("Could not change status", e.message),
  });

  // Close on outside click + Escape.
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

  const selectedManual: ManualStatus | "auto" = manual === "" ? "auto" : manual;

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-full hover:bg-bg transition-colors group"
        title={meta.description}
      >
        {/* Pulsing dot — only when online */}
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
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">Set your status</div>
            <div className="text-sm text-text mt-0.5">
              Currently <span className={`font-bold ${meta.textCls}`}>{meta.label}</span>
              {manual && (
                <span className="text-muted"> · manually set</span>
              )}
            </div>
            <div className="text-[11.5px] text-muted mt-0.5 leading-snug">{meta.description}</div>
          </div>
          <ul className="py-1">
            {MANUAL_OPTIONS.map((o) => {
              const active = selectedManual === o.value;
              return (
                <li key={o.value ?? "auto"}>
                  <button
                    onClick={() => { set.mutate(o.value); setOpen(false); }}
                    className={`w-full text-left flex items-center gap-3 px-4 py-2.5 transition-colors ${
                      active ? "bg-bg/60" : "hover:bg-bg/40"
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full grid place-items-center shrink-0 ${o.dot} text-white`}>
                      {o.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-bold text-text">{o.label}</div>
                      <div className="text-[11px] text-muted leading-snug">{o.sublabel}</div>
                    </div>
                    {active && <Check size={14} className="text-accent shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="px-4 py-2.5 bg-bg/40 border-t border-border text-[10.5px] text-muted">
            Your status is visible to everyone in this workspace.
          </div>
        </div>
      )}
    </div>
  );
}
