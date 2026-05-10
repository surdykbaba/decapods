import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import { Search, ScrollText, ChevronDown, ChevronRight } from "lucide-react";

type AuditRow = {
  id: string;
  actor_id: string | null;
  actor_name: string;
  actor_email: string;
  action: string;
  entity: string;
  entity_id: string;
  diff: Record<string, any> | null;
  created_at: string;
};

// Categorise actions for colour-coded badges. Keep this list permissive — new
// event types fall back to neutral grey, not a hard-coded list.
function actionTone(action: string): { bg: string; fg: string } {
  if (/\.delete|\.revoke|\.deleted|\.revoked/.test(action)) return { bg: "bg-danger/10", fg: "text-danger" };
  if (/\.create|\.invited|\.invite$|\.created/.test(action)) return { bg: "bg-success/10", fg: "text-success" };
  if (/\.update|\.updated|\.changed/.test(action)) return { bg: "bg-warning/10", fg: "text-warning" };
  if (/login|signin|signout|logout/.test(action)) return { bg: "bg-accent/10", fg: "text-accent" };
  return { bg: "bg-bg", fg: "text-muted" };
}

// Friendly entity labels for the chip column.
const ENTITY_LABEL: Record<string, string> = {
  user: "Member",
  invitation: "Invitation",
  opportunity: "Opportunity",
  project: "Project",
  invoice: "Invoice",
  payment: "Payment",
  vendor: "Vendor",
  agent: "Agent",
  policy: "Policy",
  role: "Role",
  document: "Document",
  checkpoint: "Checkpoint",
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

export function AuditPage() {
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery<{ items: AuditRow[] }>({
    queryKey: ["audit", entity, q],
    queryFn: () => {
      const p = new URLSearchParams();
      if (entity) p.set("entity", entity);
      if (q.trim()) p.set("q", q.trim());
      const qs = p.toString();
      return api(`/api/v1/audit${qs ? `?${qs}` : ""}`);
    },
    staleTime: 10_000,
  });

  const rows = data?.items ?? [];
  const entityOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.entity));
    return Array.from(set).sort();
  }, [rows]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">Audit log</h1>
          <p className="text-sm text-muted mt-1">
            Every state-changing action across the workspace — who did what, when, and to which record.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search action, actor…"
              className="pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm w-64"
            />
          </div>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="bg-surface border border-border rounded-lg text-sm px-3 py-2"
          >
            <option value="">All entities</option>
            {entityOptions.map((e) => (
              <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>
            ))}
          </select>
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted text-sm">Loading audit trail…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <ScrollText size={32} className="mx-auto text-muted mb-3" />
            <div className="text-sm font-medium">No audit events yet</div>
            <div className="text-xs text-muted mt-1">
              {q || entity
                ? "Try clearing the filters above."
                : "Actions across the workspace will show up here as they happen."}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => {
              const tone = actionTone(r.action);
              const isOpen = expanded.has(r.id);
              const hasDiff = r.diff && Object.keys(r.diff).length > 0;
              const initial = (r.actor_name || r.actor_email || "S")[0]?.toUpperCase();
              const display = r.actor_name?.trim() || r.actor_email || "System";
              return (
                <div key={r.id} className="px-4 py-3 hover:bg-bg/40">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => hasDiff && toggle(r.id)}
                      className={`shrink-0 ${hasDiff ? "text-muted hover:text-text" : "text-transparent"}`}
                      disabled={!hasDiff}
                      aria-label="Toggle details"
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>

                    <span className="w-7 h-7 rounded-full bg-accent-soft text-accent text-xs font-bold grid place-items-center shrink-0">
                      {initial}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-text truncate">{display}</span>
                        <span className={`pill ${tone.bg} ${tone.fg} text-[11px]`}>{r.action}</span>
                        <span className="pill bg-bg text-muted text-[11px]">
                          {ENTITY_LABEL[r.entity] ?? r.entity}
                        </span>
                      </div>
                      {r.actor_email && (
                        <div className="text-[11px] text-muted truncate">{r.actor_email}</div>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted" title={new Date(r.created_at).toLocaleString()}>
                        {relativeTime(r.created_at)}
                      </div>
                      <div className="text-[10px] text-muted/70">
                        {new Date(r.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  {isOpen && hasDiff && (
                    <pre className="mt-3 ml-10 p-3 bg-bg rounded-lg text-[11px] font-mono text-text overflow-x-auto border border-border">
                      {JSON.stringify(r.diff, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
