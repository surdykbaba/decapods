import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Bell, FileText, ListChecks, Clock,
  ThumbsUp, MessageSquare, Activity, ShieldAlert, CheckCircle2,
  Check, X, CheckCheck, Trash2,
} from "lucide-react";

// Live attention item — derived from current state, or pulled from the
// notification_outbox. Outbox items carry an OutboxID and a Read flag so the
// frontend can mark them seen explicitly; synthetic items auto-clear.
type Attention = {
  id: string;
  kind: string;
  severity: "info" | "warn" | "danger";
  title: string;
  body: string;
  link: string;
  at: string;
  outbox_id?: string;
  read?: boolean;
};

type Resp = { items: Attention[]; unread: number };

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function iconFor(kind: string) {
  if (kind.startsWith("task.overdue"))                return <Clock size={14} />;
  if (kind.startsWith("task.due_today"))              return <Clock size={14} />;
  if (kind.startsWith("task.blocked"))                return <ShieldAlert size={14} />;
  if (kind.startsWith("opportunity.awaiting"))        return <ThumbsUp size={14} />;
  if (kind.startsWith("opportunity.missing_documents")) return <FileText size={14} />;
  if (kind.startsWith("project.health"))              return <Activity size={14} />;
  if (kind.startsWith("personal."))                   return <MessageSquare size={14} />;
  return <ListChecks size={14} />;
}

function toneCls(sev: Attention["severity"]) {
  if (sev === "danger") return "bg-danger/15 text-danger";
  if (sev === "warn")   return "bg-warn/15 text-warn";
  return "bg-accent-soft text-accent";
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data } = useQuery<Resp>({
    queryKey: ["notifications"],
    queryFn: () => api(`/api/v1/notifications`),
    refetchInterval: 30_000,
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const items = data?.items ?? [];
  const count = data?.unread ?? items.filter((i) => !i.read).length;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/notifications/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const prev = qc.getQueryData<Resp>(["notifications"]);
      if (prev) {
        qc.setQueryData<Resp>(["notifications"], {
          ...prev,
          items: prev.items.filter((i) => i.id !== id),
          unread: prev.items.find((i) => i.id === id && !i.read)
            ? Math.max(0, prev.unread - 1)
            : prev.unread,
        });
      }
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notifications"], ctx.prev);
    },
    onSettled: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api(`/api/v1/notifications/read-all`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const dismissAll = useMutation({
    mutationFn: () =>
      api(`/api/v1/notifications/dismiss-all`, {
        method: "POST",
        body: JSON.stringify({ ids: items.map((i) => i.id) }),
      }),
    onSuccess: invalidate,
  });

  // Group items by severity for visual hierarchy.
  const sections: { title: string; items: Attention[] }[] = (() => {
    const dangers = items.filter((i) => i.severity === "danger");
    const warns   = items.filter((i) => i.severity === "warn");
    const infos   = items.filter((i) => i.severity === "info");
    const out: { title: string; items: Attention[] }[] = [];
    if (dangers.length) out.push({ title: "Urgent",       items: dangers });
    if (warns.length)   out.push({ title: "Needs attention", items: warns });
    if (infos.length)   out.push({ title: "For your awareness", items: infos });
    return out;
  })();

  function onItemClick(n: Attention) {
    if (n.outbox_id && !n.read) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) nav(n.link);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2.5 hover:bg-bg rounded-full text-text"
        aria-label={`Attention items${count ? ` (${count})` : ""}`}
      >
        <Bell size={17} />
        {count > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold grid place-items-center">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[400px] bg-surface border border-border rounded-xl shadow-card overflow-hidden">
          <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="min-w-0">
              <div className="text-sm font-bold text-text">Needs your attention</div>
              <div className="text-[11px] text-muted">Items auto-clear when resolved</div>
            </div>
            {items.length > 0 ? (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending || count === 0}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline disabled:opacity-40 disabled:no-underline"
                  title="Mark all as read"
                >
                  <CheckCheck size={12} /> Read all
                </button>
                <span className="text-muted/40">·</span>
                <button
                  onClick={() => dismissAll.mutate()}
                  disabled={dismissAll.isPending}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-danger disabled:opacity-40"
                  title="Clear all"
                >
                  <Trash2 size={12} /> Clear
                </button>
              </div>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <CheckCircle2 size={13} /> All clear
              </span>
            )}
          </header>

          <div className="max-h-[440px] overflow-y-auto">
            {items.length === 0 ? (
              <div className="p-8 text-center">
                <div className="w-12 h-12 mx-auto rounded-full bg-success/10 text-success grid place-items-center mb-3">
                  <CheckCircle2 size={20} />
                </div>
                <div className="text-sm font-semibold text-text">Nothing needs your attention</div>
                <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
                  Overdue tasks, missing documents, approvals waiting on you, and at-risk projects show up here automatically.
                </p>
              </div>
            ) : (
              sections.map((sec) => (
                <div key={sec.title}>
                  <div className="px-4 pt-3 pb-1.5 text-[10.5px] uppercase tracking-[0.08em] font-bold text-muted">
                    {sec.title} · {sec.items.length}
                  </div>
                  <ul>
                    {sec.items.map((n) => {
                      const isRead = !!n.read;
                      return (
                        <li
                          key={n.id}
                          className={`group relative flex gap-3 px-4 py-3 hover:bg-bg transition-colors border-b border-border last:border-0 ${isRead ? "opacity-70" : ""}`}
                        >
                          <button
                            onClick={() => onItemClick(n)}
                            className="flex gap-3 text-left flex-1 min-w-0"
                          >
                            <span className={`w-8 h-8 rounded-full grid place-items-center shrink-0 ${toneCls(n.severity)}`}>
                              {iconFor(n.kind)}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className={`text-sm truncate ${isRead ? "font-medium text-muted" : "font-semibold text-text"}`}>
                                {n.title}
                              </div>
                              {n.body && <div className="text-xs text-muted truncate mt-0.5">{n.body}</div>}
                              <div className="text-[11px] text-muted/70 mt-1">{relativeTime(n.at)}</div>
                            </div>
                          </button>
                          <div className="flex flex-col gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            {n.outbox_id && !isRead && (
                              <button
                                onClick={(e) => { e.stopPropagation(); markRead.mutate(n.id); }}
                                className="p-1 rounded hover:bg-surface text-muted hover:text-accent"
                                title="Mark as read"
                                aria-label="Mark as read"
                              >
                                <Check size={13} />
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); dismiss.mutate(n.id); }}
                              className="p-1 rounded hover:bg-surface text-muted hover:text-danger"
                              title="Dismiss"
                              aria-label="Dismiss"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>

          <footer className="px-4 py-2.5 border-t border-border bg-bg/40 text-[11px] text-muted">
            Live attention list · refreshes automatically
          </footer>
        </div>
      )}
    </div>
  );
}
