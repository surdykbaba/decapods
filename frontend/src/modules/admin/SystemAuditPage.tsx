import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui";
import {
  Search, ScrollText, ChevronDown, ChevronRight,
  ShieldCheck, Globe, Monitor, Filter,
} from "lucide-react";
import { SortHeader, type SortState } from "@/components/TableTools";

type AuditRow = {
  id: string;
  actor_id: string | null;
  actor_name: string;
  actor_email: string;
  action: string;
  entity: string;
  entity_id: string;
  diff: Record<string, any> | null;
  ip: string;
  user_agent: string;
  request_method: string;
  request_path: string;
  created_at: string;
};

function actionTone(action: string): { bg: string; fg: string } {
  if (/auth\.login\.failure|auth\.mfa\.failure/.test(action)) return { bg: "bg-danger/15", fg: "text-danger" };
  if (/auth\.login|auth\.mfa/.test(action))                  return { bg: "bg-accent/10", fg: "text-accent" };
  if (/\.delete|\.revoke|\.deleted|\.revoked/.test(action))  return { bg: "bg-danger/10", fg: "text-danger" };
  if (/\.create|\.invited|\.invite$|\.created/.test(action)) return { bg: "bg-success/10", fg: "text-success" };
  if (/\.update|\.updated|\.changed/.test(action))           return { bg: "bg-warn/15", fg: "text-warn" };
  return { bg: "bg-bg", fg: "text-muted" };
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

// Trim a User-Agent down to something readable in a table cell — drop the
// version soup, keep the browser/OS hint.
function shortUA(ua: string): string {
  if (!ua) return "—";
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Postman|curl|Go-http-client)[\/ ]([\d.]+)/i);
  const browser = m ? `${m[1]} ${m[2].split(".")[0]}` : ua.split(" ")[0];
  const os = /Mac OS X|Windows|Linux|Android|iPhone|iPad/.exec(ua)?.[0] ?? "";
  return os ? `${browser} · ${os}` : browser;
}

export function SystemAuditPage() {
  const me = useAuth((s) => s.user);
  const isSuper = !!me?.roles?.includes("super_admin");

  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [ip, setIp] = useState("");
  const [entity, setEntity] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Reset page when filters change — no point staying on page 7 of an empty
  // filtered set.
  useEffect(() => { setPage(0); }, [actor, action, ip, entity]);

  const { data, isLoading } = useQuery<{ items: AuditRow[]; total: number; limit: number; offset: number }>({
    enabled: isSuper,
    queryKey: ["system-audit", actor, action, ip, entity, page],
    queryFn: () => {
      const p = new URLSearchParams();
      if (actor.trim())  p.set("actor", actor.trim());
      if (action.trim()) p.set("action", action.trim());
      if (ip.trim())     p.set("ip", ip.trim());
      if (entity)        p.set("entity", entity);
      p.set("limit", String(PAGE_SIZE));
      p.set("offset", String(page * PAGE_SIZE));
      return api(`/api/v1/admin/audit?${p.toString()}`);
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
  });

  type AuditSort = "when" | "actor" | "action" | "entity" | "ip";
  const [sort, setSort] = useState<SortState<AuditSort>>({ col: "when", dir: "desc" });
  function toggleSort(col: AuditSort) {
    setSort((p) => p.col === col ? { col, dir: p.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "when" ? "desc" : "asc" });
  }
  // Server-side paginated; sort is applied to the visible page only. With a
  // 50-row page that's enough for "show me failures first on this page"
  // without paying a query round-trip per click.
  const rawRows = data?.items ?? [];
  const rows = useMemo(() => {
    const xs = [...rawRows];
    const mul = sort.dir === "asc" ? 1 : -1;
    xs.sort((a, b) => {
      switch (sort.col) {
        case "when":   return mul * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        case "actor":  return mul * (a.actor_name || a.actor_email || "").localeCompare(b.actor_name || b.actor_email || "");
        case "action": return mul * a.action.localeCompare(b.action);
        case "entity": return mul * a.entity.localeCompare(b.entity);
        case "ip":     return mul * (a.ip || "").localeCompare(b.ip || "");
      }
    });
    return xs;
  }, [rawRows, sort]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE + rows.length);
  const entityOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.entity));
    return Array.from(set).sort();
  }, [rows]);

  if (!me) return null;
  if (!isSuper) return <Navigate to="/" replace />;

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
          <h1 className="h1 flex items-center gap-2">
            <ShieldCheck size={22} className="text-accent" /> System audit trail
          </h1>
          <p className="text-sm text-muted mt-1">
            Every authentication event and state-changing action across the workspace — actor, action,
            entity, IP address, user agent, and request path. Restricted to super admins.
          </p>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-muted">
          <Filter size={13} /> Filters
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="Actor name or email"
              className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm"
            />
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Action (e.g. auth.login)"
              className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm"
            />
          </div>
          <div className="relative">
            <Globe size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="IP address"
              className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm"
            />
          </div>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg text-sm px-3 py-2"
          >
            <option value="">All entities</option>
            {entityOptions.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted text-sm">Loading audit trail…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <ScrollText size={32} className="mx-auto text-muted mb-3" />
            <div className="text-sm font-medium">No matching audit events</div>
            <div className="text-xs text-muted mt-1">
              Try widening the filters above.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/40 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold w-6"></th>
                  <SortHeader col="when"   label="When"   sort={sort} onSort={toggleSort} />
                  <SortHeader col="actor"  label="Actor"  sort={sort} onSort={toggleSort} />
                  <SortHeader col="action" label="Action" sort={sort} onSort={toggleSort} />
                  <SortHeader col="entity" label="Entity" sort={sort} onSort={toggleSort} />
                  <SortHeader col="ip"     label="IP"     sort={sort} onSort={toggleSort} />
                  <th className="text-left px-3 py-2 font-semibold">Client</th>
                  <th className="text-left px-3 py-2 font-semibold">Endpoint</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const tone = actionTone(r.action);
                  const isOpen = expanded.has(r.id);
                  const hasDiff = r.diff && Object.keys(r.diff).length > 0;
                  const display = r.actor_name?.trim() || r.actor_email || "System";
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-bg/40 align-top">
                        <td className="px-3 py-2">
                          <button
                            onClick={() => hasDiff && toggle(r.id)}
                            className={`${hasDiff ? "text-muted hover:text-text" : "text-transparent"}`}
                            disabled={!hasDiff}
                            aria-label="Toggle details"
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="text-xs font-medium" title={new Date(r.created_at).toLocaleString()}>
                            {relativeTime(r.created_at)}
                          </div>
                          <div className="text-[10px] text-muted/70">
                            {new Date(r.created_at).toLocaleString()}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-sm font-semibold truncate max-w-[180px]">{display}</div>
                          {r.actor_email && (
                            <div className="text-[11px] text-muted truncate max-w-[180px]">{r.actor_email}</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`pill ${tone.bg} ${tone.fg} text-[11px]`}>{r.action}</span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.entity}
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-muted">
                          {r.ip || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted">
                          <span className="inline-flex items-center gap-1">
                            <Monitor size={11} /> {shortUA(r.user_agent)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[11px] font-mono text-muted truncate max-w-[260px]">
                          {r.request_method && <span className="font-bold mr-1">{r.request_method}</span>}
                          {r.request_path || "—"}
                        </td>
                      </tr>
                      {isOpen && hasDiff && (
                        <tr className="bg-bg/30">
                          <td colSpan={8} className="px-6 py-3">
                            <pre className="p-3 bg-surface rounded-lg text-[11px] font-mono text-text overflow-x-auto border border-border">
                              {JSON.stringify(r.diff, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-bg/30 text-xs">
            <div className="text-muted">
              Showing <span className="font-semibold text-text">{firstShown}</span>–
              <span className="font-semibold text-text">{lastShown}</span> of{" "}
              <span className="font-semibold text-text">{total.toLocaleString()}</span> events
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                ← Prev
              </button>
              <span className="text-muted px-1">
                Page <span className="font-semibold text-text">{page + 1}</span> of{" "}
                <span className="font-semibold text-text">{totalPages}</span>
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= totalPages}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
