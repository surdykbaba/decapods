import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Flame, ShieldCheck, ArrowLeft, ChevronRight, ChevronDown,
} from "lucide-react";

type Band = "healthy" | "watch" | "elevated" | "critical";

type Signals = {
  hours_last_7: number;
  concurrent_projects: number;
  missed_deadlines: number;
  after_hours_pct: number;
  weekend_activity: number;
  pr_review_lag_hours: number;
};

type Row = {
  user_id: string;
  name: string;
  score: number;
  band: Band;
  captured_at: string;
  signals: Signals;
  computed?: "live" | "cached";
};

const BAND_META: Record<Band, { label: string; cls: string; pillCls: string; barCls: string }> = {
  healthy:  { label: "Healthy",  cls: "text-success", pillCls: "bg-success/15 text-success", barCls: "bg-success" },
  watch:    { label: "Watch",    cls: "text-accent",  pillCls: "bg-accent-soft text-accent", barCls: "bg-accent" },
  elevated: { label: "Elevated", cls: "text-warn",    pillCls: "bg-warn/15 text-warn",       barCls: "bg-warn" },
  critical: { label: "Critical", cls: "text-danger",  pillCls: "bg-danger/15 text-danger",   barCls: "bg-danger" },
};

const SIGNAL_META: Record<keyof Signals, { label: string; tooltip: string; ceiling: number; fmt: (n: number) => string }> = {
  hours_last_7:        { label: "Hours last 7d",       tooltip: "Total hours logged via time entries over the past 7 days. Score ceiling: 60h.", ceiling: 60, fmt: (n) => `${n.toFixed(1)}h` },
  concurrent_projects: { label: "Concurrent projects", tooltip: "Active project memberships. Ceiling: 5.",                                       ceiling: 5,  fmt: (n) => `${n}` },
  missed_deadlines:    { label: "Overdue tasks",       tooltip: "Tasks past their due-date that aren't done/cancelled. Ceiling: 10.",            ceiling: 10, fmt: (n) => `${n}` },
  after_hours_pct:     { label: "After-hours work",    tooltip: "Share of activity outside core hours. Ceiling: 50%.",                          ceiling: 0.5, fmt: (n) => `${(n * 100).toFixed(0)}%` },
  weekend_activity:    { label: "Weekend commits",     tooltip: "Sat/Sun commits over the last 30 days. Ceiling: 8.",                            ceiling: 8,  fmt: (n) => `${n}` },
  pr_review_lag_hours: { label: "PR review lag",       tooltip: "Average hours between PR creation and review. Ceiling: 48h.",                   ceiling: 48, fmt: (n) => `${n.toFixed(1)}h` },
};

function fmtRel(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function BurnoutPage() {
  const { data, isLoading } = useQuery<{ watchlist: Row[] }>({
    queryKey: ["workforce", "burnout"],
    queryFn: () => api("/api/v1/workforce/burnout"),
    refetchInterval: 60_000,
  });
  const [bandFilter, setBandFilter] = useState<"all" | Band>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const items = data?.watchlist ?? [];

  const counts = useMemo(() => {
    const c = { all: items.length, healthy: 0, watch: 0, elevated: 0, critical: 0 };
    items.forEach((r) => { c[r.band]++; });
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    if (bandFilter === "all") return items;
    return items.filter((r) => r.band === bandFilter);
  }, [items, bandFilter]);

  const teamAvg = useMemo(() => {
    if (items.length === 0) return 0;
    return items.reduce((s, r) => s + r.score, 0) / items.length;
  }, [items]);

  const flagged = items.filter((r) => r.band === "elevated" || r.band === "critical").length;

  return (
    <div className="space-y-5 max-w-7xl">
      <Link to="/workforce" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft size={14} /> Back to workforce
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-wider text-accent font-bold">People health</div>
        <h1 className="h1 mt-1 flex items-center gap-2">
          <Flame size={26} className="text-accent" /> Burnout watchlist
        </h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Composite score (0-100) per member from hours logged, project load, missed deadlines, after-hours
          activity, weekend commits, and PR-review lag. Higher scores need attention. Refreshes every minute.
        </p>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Team avg score" value={teamAvg.toFixed(0)}
             sub={teamAvg >= 60 ? "team running hot" : teamAvg >= 40 ? "watch" : "looking healthy"}
             tone={teamAvg >= 60 ? "warn" : teamAvg >= 40 ? "info" : "good"} />
        <Kpi label="Flagged"   value={flagged} sub="elevated + critical" tone={flagged ? "warn" : "good"} />
        <Kpi label="Critical"  value={counts.critical} tone={counts.critical ? "bad" : "good"} />
        <Kpi label="Healthy"   value={counts.healthy} tone="good" />
      </div>

      {/* Band filter */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["all", "critical", "elevated", "watch", "healthy"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setBandFilter(k)}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-full transition-colors ${
              bandFilter === k ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {k === "all" ? "Everyone" : BAND_META[k].label}
            <span className="ml-1.5 opacity-70">{counts[k]}</span>
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-muted">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-success/15 text-success grid place-items-center mb-3">
            <ShieldCheck size={22} />
          </div>
          <div className="text-base font-bold text-text">
            {items.length === 0 ? "No data yet" : "No one in this band"}
          </div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            {items.length === 0
              ? "Once members start logging time and shipping work, their burnout signals show up here."
              : "Healthy team — nothing flagged at this severity."}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-2xl overflow-hidden">
          <ul className="divide-y divide-border">
            {filtered.map((r) => (
              <BurnoutRow
                key={r.user_id}
                row={r}
                expanded={!!expanded[r.user_id]}
                onToggle={() => setExpanded((s) => ({ ...s, [r.user_id]: !s[r.user_id] }))}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" | "bad" | "info" | "neutral" }) {
  const cls = { good: "text-success", warn: "text-warn", bad: "text-danger", info: "text-accent", neutral: "text-text" }[tone ?? "neutral"];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-2xl font-extrabold mt-1 ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function BurnoutRow({
  row, expanded, onToggle,
}: { row: Row; expanded: boolean; onToggle: () => void }) {
  const meta = BAND_META[row.band];
  const initial = row.name[0]?.toUpperCase() ?? "?";

  return (
    <li>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-bg/40 transition-colors text-left"
      >
        <span className="text-muted shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="w-9 h-9 rounded-full bg-accent-soft text-accent font-bold text-[13px] grid place-items-center shrink-0">
          {initial}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-text truncate">{row.name}</div>
          <div className="text-[11.5px] text-muted">
            score {row.score.toFixed(0)}/100 · {meta.label.toLowerCase()}
            {row.computed === "live"   && <> · <span className="italic">live</span></>}
            {row.computed === "cached" && <> · captured {fmtRel(row.captured_at)}</>}
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2 w-[200px] shrink-0">
          <div className="flex-1 h-2 bg-bg rounded-full overflow-hidden">
            <div className={`h-full ${meta.barCls} transition-all`} style={{ width: `${Math.min(100, row.score)}%` }} />
          </div>
          <span className={`text-[12px] font-bold w-10 text-right ${meta.cls}`}>{row.score.toFixed(0)}</span>
        </div>
        <span className={`pill ${meta.pillCls} shrink-0`}>{meta.label}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 grid grid-cols-2 md:grid-cols-3 gap-2 bg-bg/30 border-t border-border pt-3">
          {(Object.keys(SIGNAL_META) as (keyof Signals)[]).map((k) => {
            const sig = SIGNAL_META[k];
            const v = row.signals[k] ?? 0;
            const ratio = Math.min(1, sig.ceiling ? v / sig.ceiling : 0);
            const intensity = ratio > 0.8 ? "bg-danger" : ratio > 0.6 ? "bg-warn" : ratio > 0.4 ? "bg-accent" : "bg-success";
            return (
              <div key={k} className="bg-surface border border-border rounded-lg p-2.5" title={sig.tooltip}>
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted truncate">{sig.label}</div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-[14px] font-bold text-text">{sig.fmt(v)}</span>
                  <span className="text-[10.5px] text-muted">/ {sig.fmt(sig.ceiling)}</span>
                </div>
                <div className="h-1 bg-bg rounded-full overflow-hidden mt-1.5">
                  <div className={`h-full ${intensity} transition-all`} style={{ width: `${ratio * 100}%` }} />
                </div>
              </div>
            );
          })}
          <div className="bg-surface border border-border rounded-lg p-2.5 col-span-2 md:col-span-1 flex flex-col justify-center">
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">What to do</div>
            <div className="text-[12px] text-text leading-snug mt-1">
              {row.band === "critical" && "1:1 this week. Review hours, redistribute concurrent projects, clear overdue blockers."}
              {row.band === "elevated" && "Check in. Watch after-hours / weekend pattern. Tighten task scope."}
              {row.band === "watch"    && "Keep an eye. Trend matters more than the score right now."}
              {row.band === "healthy"  && "All good. Trust the rhythm."}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
