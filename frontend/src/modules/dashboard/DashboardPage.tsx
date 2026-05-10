import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Skeleton } from "@/components/ui";
import {
  TrendingUp, TrendingDown, AlertTriangle, FileText, CheckCircle2,
  Briefcase, Clock, ArrowRight, Trophy, Gauge,
} from "lucide-react";

type Transition = { from: string; to: string; label?: string; roles?: string[] };

type Opp = {
  id: string;
  title: string;
  stage: string;
  lead_type: string;
  estimated_value: number;
  priority: number;
  risk_level: string;
  created_at: string;
  updated_at: string;
  client_name: string;
  docs_attached: number;
  docs_required: number;
  next_stages: Transition[];
};

const STAGES: { key: string; label: string; color: string }[] = [
  { key: "new_request",       label: "New request",     color: "#1e212a" },
  { key: "under_review",      label: "Under review",    color: "#ef4444" },
  { key: "approved",          label: "Approved",        color: "#3b82f6" },
  { key: "contracting",       label: "Contracting",     color: "#a855f7" },
  { key: "planning",          label: "Planning",        color: "#f59e0b" },
  { key: "in_progress",       label: "In progress",     color: "#10b981" },
  { key: "qa_review",         label: "QA review",       color: "#06b6d4" },
  { key: "client_acceptance", label: "Client accept",   color: "#0ea5e9" },
  { key: "invoiced",          label: "Invoiced",        color: "#8b5cf6" },
  { key: "paid",              label: "Paid",            color: "#22c55e" },
  { key: "closed",            label: "Closed",          color: "#6b7280" },
];

function fmtMoney(n: number, compact = true): string {
  if (!n && n !== 0) return "₦0";
  if (compact) {
    if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `₦${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `₦${n.toLocaleString()}`;
}

function daysSince(iso: string): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function statusOf(o: Opp): "on_track" | "attention" | "blocked" | "ready" | "review" | "missing_docs" {
  const days = daysSince(o.updated_at);
  const missing = Math.max(0, o.docs_required - o.docs_attached);
  if (o.stage === "new_request") return missing > 0 ? "missing_docs" : "ready";
  if (o.stage === "under_review" && o.next_stages?.length) return "review";
  if (days >= 14 && o.stage !== "closed" && o.stage !== "paid") return "blocked";
  if (o.risk_level === "high" && o.stage !== "closed") return "attention";
  if (days >= 7 && o.stage !== "closed" && o.stage !== "paid") return "attention";
  return "on_track";
}

const ACTIVE_STAGES = new Set([
  "new_request", "under_review", "approved", "contracting", "planning",
  "in_progress", "qa_review", "client_acceptance", "invoiced",
]);

export function DashboardPage() {
  const { data: oppsRes, isLoading } = useQuery<{ items: Opp[] }>({
    queryKey: ["opps"],
    queryFn: () => api("/api/v1/opportunities"),
  });

  const items = oppsRes?.items ?? [];

  const summary = useMemo(() => {
    const active = items.filter((o) => ACTIVE_STAGES.has(o.stage));
    const won = items.filter((o) => o.stage === "paid" || o.stage === "closed");
    const needs = items.filter((o) => {
      const s = statusOf(o);
      return s !== "on_track" && s !== "ready";
    });
    const totalValue = items.reduce((s, o) => s + (o.estimated_value || 0), 0);
    const wonValue = won.reduce((s, o) => s + (o.estimated_value || 0), 0);
    const activeValue = active.reduce((s, o) => s + (o.estimated_value || 0), 0);
    const docsAttached = active.reduce((s, o) => s + (o.docs_attached || 0), 0);
    const docsRequired = active.reduce((s, o) => s + (o.docs_required || 0), 0);
    const docsPct = docsRequired === 0 ? 100 : Math.round((docsAttached / docsRequired) * 100);
    const conversionRate = items.length > 0 ? Math.round((won.length / items.length) * 100) : 0;

    return {
      active, won, needs, totalValue, wonValue, activeValue,
      docsAttached, docsRequired, docsPct,
      conversionRate,
    };
  }, [items]);

  const stageBreakdown = useMemo(() => {
    return STAGES.map((s) => {
      const stageItems = items.filter((o) => o.stage === s.key);
      const value = stageItems.reduce((sum, o) => sum + (o.estimated_value || 0), 0);
      return { ...s, count: stageItems.length, value };
    });
  }, [items]);

  const maxStageValue = Math.max(1, ...stageBreakdown.map((s) => s.value));

  const topOpps = useMemo(() =>
    [...items]
      .filter((o) => ACTIVE_STAGES.has(o.stage))
      .sort((a, b) => b.estimated_value - a.estimated_value)
      .slice(0, 5),
  [items]);

  const recentActivity = useMemo(() =>
    [...items]
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 6),
  [items]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Executive overview</h1>
        <p className="text-sm text-muted mt-1">A live picture of where your engagements stand right now.</p>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <>
          {/* Top KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiTile
              icon={<Briefcase size={16} />}
              label="Pipeline value"
              value={fmtMoney(summary.activeValue)}
              sub={`${summary.active.length} active engagement${summary.active.length === 1 ? "" : "s"}`}
              accent="indigo"
            />
            <KpiTile
              icon={<Trophy size={16} />}
              label="Won this period"
              value={fmtMoney(summary.wonValue)}
              sub={`${summary.won.length} closed · ${summary.conversionRate}% conversion`}
              accent="green"
            />
            <KpiTile
              icon={<AlertTriangle size={16} />}
              label="Need attention"
              value={String(summary.needs.length)}
              sub={summary.needs.length === 0 ? "All on track" : "Click below to see why"}
              accent={summary.needs.length === 0 ? "green" : "amber"}
            />
            <KpiTile
              icon={<Gauge size={16} />}
              label="Doc compliance"
              value={`${summary.docsPct}%`}
              sub={`${summary.docsAttached} of ${summary.docsRequired} attached on active`}
              accent={summary.docsPct >= 80 ? "green" : summary.docsPct >= 50 ? "amber" : "red"}
            />
          </div>

          {/* Pipeline funnel + Compliance gauge */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card
              title="Pipeline by stage"
              action={<Link to="/pipeline" className="text-xs text-accent hover:underline">Open board →</Link>}
              className="lg:col-span-2"
            >
              {summary.active.length === 0 ? (
                <div className="text-sm text-muted py-8 text-center">
                  No active opportunities yet.{" "}
                  <Link to="/pipeline/new" className="text-accent hover:underline">Create one →</Link>
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {stageBreakdown.filter((s) => s.count > 0).map((s) => (
                    <li key={s.key} className="grid grid-cols-[140px_1fr_70px_70px] items-center gap-3 text-sm">
                      <span className="flex items-center gap-2 text-text">
                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </span>
                      <div className="h-6 bg-bg rounded relative overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 rounded transition-all"
                          style={{
                            width: `${Math.max(4, (s.value / maxStageValue) * 100)}%`,
                            background: s.color,
                            opacity: 0.85,
                          }}
                        />
                      </div>
                      <span className="text-right text-muted text-xs">{s.count} {s.count === 1 ? "deal" : "deals"}</span>
                      <span className="text-right text-text font-medium">{fmtMoney(s.value)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Document compliance">
              <ComplianceRing pct={summary.docsPct} attached={summary.docsAttached} required={summary.docsRequired} />
              {summary.docsRequired > summary.docsAttached && (
                <div className="mt-3 text-xs text-muted text-center">
                  <strong className="text-text">{summary.docsRequired - summary.docsAttached}</strong>{" "}
                  required documents still missing across active opportunities.
                </div>
              )}
              {summary.docsRequired === 0 && summary.active.length > 0 && (
                <div className="mt-3 text-xs text-muted text-center">No document requirements yet.</div>
              )}
            </Card>
          </div>

          {/* Two columns: needs attention + recent activity */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card
              title={
                <div className="flex items-center gap-2">
                  <AlertTriangle size={16} className="text-warn" /> Needs your attention
                </div>
              }
              action={
                summary.needs.length > 0 && (
                  <Link to="/pipeline" className="text-xs text-accent hover:underline">View all →</Link>
                )
              }
            >
              {summary.needs.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted py-4">
                  <CheckCircle2 size={18} className="text-success" />
                  Nothing urgent — every engagement is on track.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {summary.needs.slice(0, 6).map((o) => (
                    <AttentionRow key={o.id} opp={o} />
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title={
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-muted" /> Recent activity
                </div>
              }
            >
              {recentActivity.length === 0 ? (
                <div className="text-sm text-muted py-4">Nothing happening yet.</div>
              ) : (
                <ul className="space-y-2">
                  {recentActivity.map((o) => {
                    const stage = STAGES.find((s) => s.key === o.stage);
                    return (
                      <li key={o.id} className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: stage?.color ?? "#888" }} />
                        <Link to={`/pipeline/${o.id}`} className="text-sm text-text hover:underline truncate flex-1">
                          {o.title}
                        </Link>
                        <span className="text-xs text-muted capitalize whitespace-nowrap">{stage?.label ?? o.stage}</span>
                        <span className="text-xs text-muted whitespace-nowrap">
                          {daysSince(o.updated_at) === 0 ? "today" : `${daysSince(o.updated_at)}d ago`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {/* Top opportunities by value */}
          <Card
            title="Top active engagements"
            action={<Link to="/pipeline" className="text-xs text-accent hover:underline">Open pipeline →</Link>}
          >
            {topOpps.length === 0 ? (
              <div className="text-sm text-muted py-4">No active engagements yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="text-left font-medium px-2 py-2">Title</th>
                    <th className="text-left font-medium px-2 py-2">Client</th>
                    <th className="text-left font-medium px-2 py-2">Stage</th>
                    <th className="text-right font-medium px-2 py-2">Value</th>
                    <th className="text-left font-medium px-2 py-2 w-32">Docs</th>
                  </tr>
                </thead>
                <tbody>
                  {topOpps.map((o) => {
                    const stage = STAGES.find((s) => s.key === o.stage);
                    const docPct = o.docs_required > 0 ? Math.round((o.docs_attached / o.docs_required) * 100) : 100;
                    return (
                      <tr key={o.id} className="border-b border-border last:border-0 hover:bg-bg cursor-pointer">
                        <td className="px-2 py-2.5">
                          <Link to={`/pipeline/${o.id}`} className="text-text hover:underline font-medium">{o.title}</Link>
                          <div className="text-xs text-muted capitalize">{o.lead_type}</div>
                        </td>
                        <td className="px-2 py-2.5 text-muted">{o.client_name || "—"}</td>
                        <td className="px-2 py-2.5">
                          <span className="inline-flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ background: stage?.color }} />
                            <span className="text-text">{stage?.label ?? o.stage}</span>
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-right font-semibold">{fmtMoney(o.estimated_value)}</td>
                        <td className="px-2 py-2.5">
                          {o.docs_required === 0 ? (
                            <span className="text-xs text-muted">—</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
                                <div
                                  className="h-full"
                                  style={{
                                    width: `${docPct}%`,
                                    background: docPct === 100 ? "#22c55e" : docPct >= 50 ? "#f59e0b" : "#ef4444",
                                  }}
                                />
                              </div>
                              <span className="text-xs text-muted w-8">{o.docs_attached}/{o.docs_required}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function KpiTile({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: "indigo" | "green" | "amber" | "red";
}) {
  const accentMap = {
    indigo: { bg: "#eef2ff", fg: "#635dff" },
    green:  { bg: "#dcf5ec", fg: "#0e7c54" },
    amber:  { bg: "#fef3c7", fg: "#a16207" },
    red:    { bg: "#fee2e2", fg: "#b91c1c" },
  } as const;
  const cls = accentMap[accent];
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-full grid place-items-center" style={{ background: cls.bg, color: cls.fg }}>
          {icon}
        </span>
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      </div>
      <div className="text-[28px] font-semibold tracking-tight text-text mt-2">{value}</div>
      <div className="text-xs text-muted mt-1">{sub}</div>
    </div>
  );
}

function ComplianceRing({ pct, attached, required }: { pct: number; attached: number; required: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * c;
  const color = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex flex-col items-center justify-center py-2">
      <div className="relative w-32 h-32">
        <svg viewBox="0 0 120 120" className="-rotate-90 w-full h-full">
          <circle cx="60" cy="60" r={r} stroke="rgb(var(--border))" strokeWidth="10" fill="none" />
          <circle
            cx="60" cy="60" r={r}
            stroke={color} strokeWidth="10" fill="none"
            strokeDasharray={`${dash} ${c - dash}`}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-semibold text-text">{pct}%</div>
          <div className="text-xs text-muted">attached</div>
        </div>
      </div>
      <div className="text-sm text-text mt-2 font-medium">{attached} of {required}</div>
    </div>
  );
}

function AttentionRow({ opp }: { opp: Opp }) {
  const status = statusOf(opp);
  const icon = {
    missing_docs: <FileText size={13} className="text-warn shrink-0" />,
    review:       <ArrowRight size={13} className="text-accent shrink-0" />,
    attention:    <AlertTriangle size={13} className="text-warn shrink-0" />,
    blocked:      <TrendingDown size={13} className="text-danger shrink-0" />,
    ready:        <CheckCircle2 size={13} className="text-success shrink-0" />,
    on_track:     <CheckCircle2 size={13} className="text-success shrink-0" />,
  }[status];
  const reason = (() => {
    const days = daysSince(opp.updated_at);
    if (status === "missing_docs") {
      const m = Math.max(0, opp.docs_required - opp.docs_attached);
      return `${m} doc${m === 1 ? "" : "s"} to attach`;
    }
    if (status === "review") return "Awaiting your review";
    if (status === "blocked") return `Stalled ${days}d`;
    if (status === "attention" && opp.risk_level === "high") return "High risk";
    if (status === "attention") return `${days}d in stage`;
    return "On track";
  })();
  const stage = STAGES.find((s) => s.key === opp.stage);
  return (
    <li className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
      {icon}
      <Link to={`/pipeline/${opp.id}`} className="text-sm text-text hover:underline truncate flex-1">{opp.title}</Link>
      <span className="text-xs text-muted whitespace-nowrap capitalize hidden md:inline">{stage?.label}</span>
      <span className="text-xs font-medium text-warn whitespace-nowrap">{reason}</span>
    </li>
  );
}

// Hint at potential value-trend small indicator (kept local, not a chart).
export function TrendArrow({ up }: { up: boolean }) {
  return up ? <TrendingUp size={12} className="text-success" /> : <TrendingDown size={12} className="text-danger" />;
}
