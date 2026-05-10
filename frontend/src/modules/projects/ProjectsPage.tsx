import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Empty, Skeleton } from "@/components/ui";
import {
  Search, X, LayoutGrid, List as ListIcon, ChevronRight, Users, AlertCircle,
  Flag, Wallet, Clock, CheckCircle2,
  MoreHorizontal, Loader,
} from "lucide-react";

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: "green" | "amber" | "red";
  risk_score: number;
  budget: number;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  opportunity_id?: string | null;
  client_name: string;
  lead_type: string;
  updated_at: string;
  tasks: number;
  tasks_done: number;
  blockers: number;
  stakeholders: number;
  milestones: number;
};

const STATUS_META: Record<string, { label: string; color: string; phase: number }> = {
  planning:          { label: "Planning",          color: "#f59e0b", phase: 1 },
  in_progress:       { label: "In progress",       color: "#10b981", phase: 2 },
  qa_review:         { label: "QA review",         color: "#06b6d4", phase: 3 },
  client_acceptance: { label: "Client acceptance", color: "#0ea5e9", phase: 4 },
  invoiced:          { label: "Invoiced",          color: "#8b5cf6", phase: 5 },
  paid:              { label: "Paid",              color: "#22c55e", phase: 6 },
  closed:            { label: "Closed",            color: "#6b7280", phase: 7 },
};

const ACTIVE_STATUSES = ["planning", "in_progress", "qa_review", "client_acceptance"];
const FINISHED_STATUSES = ["invoiced", "paid", "closed"];

function fmtMoney(n: number, ccy = "NGN"): string {
  if (!n && n !== 0) return "—";
  const sym = ({ USD: "$", EUR: "€", GBP: "£", NGN: "₦", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA" } as Record<string, string>)[ccy] ?? ccy;
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
}

function relTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

type View = "grid" | "list";
type StatusFilter = "all" | "active" | "finished" | string;

export function ProjectsPage() {
  const { data, isLoading } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api<{ items: Project[] }>("/api/v1/projects").then((r) => r.items),
  });

  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const items = data ?? [];
  const filtered = useMemo(() => {
    return items.filter((p) => {
      if (query && !`${p.name} ${p.code} ${p.client_name}`.toLowerCase().includes(query.toLowerCase())) return false;
      if (filter === "all") return true;
      if (filter === "active") return ACTIVE_STATUSES.includes(p.status);
      if (filter === "finished") return FINISHED_STATUSES.includes(p.status);
      return p.status === filter;
    });
  }, [items, query, filter]);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">Projects</h1>
          <p className="text-sm text-muted mt-1">Engagements that crossed the planning gate.</p>
        </div>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-8"
            placeholder="Search project, code, or client…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 border border-border bg-surface rounded-md p-1 text-xs">
          <FilterPill on={filter === "all"} onClick={() => setFilter("all")}>All ({items.length})</FilterPill>
          <FilterPill on={filter === "active"} onClick={() => setFilter("active")}>Active</FilterPill>
          {Object.entries(STATUS_META).filter(([k]) => ACTIVE_STATUSES.includes(k)).map(([k, m]) => {
            const count = items.filter((p) => p.status === k).length;
            if (count === 0) return null;
            return <FilterPill key={k} on={filter === k} onClick={() => setFilter(k)}>{m.label} ({count})</FilterPill>;
          })}
          <FilterPill on={filter === "finished"} onClick={() => setFilter("finished")}>Finished</FilterPill>
        </div>

        <div className="flex-1" />

        <div className="inline-flex border border-border bg-surface rounded-md p-0.5">
          <ViewToggle on={view === "grid"} onClick={() => setView("grid")} icon={<LayoutGrid size={13} />} label="Grid" />
          <ViewToggle on={view === "list"} onClick={() => setView("list")} icon={<ListIcon size={13} />} label="List" />
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          title={items.length === 0 ? "No projects yet" : "No projects match your filter"}
          body={items.length === 0 ? "Move an opportunity into Planning to convert it into a project." : "Try clearing search or switching filter."}
        />
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => <ProjectCard key={p.id} project={p} />)}
        </div>
      ) : (
        <ProjectTable items={filtered} />
      )}
    </div>
  );
}

/* ---------- Pieces ---------- */

function FilterPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded transition-colors capitalize ${
        on ? "bg-accent text-white font-semibold" : "text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function ViewToggle({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded transition-colors ${
        on ? "bg-bg text-text font-semibold" : "text-muted hover:text-text"
      }`}
    >
      {icon} {label}
    </button>
  );
}

function ProjectCard({ project: p }: { project: Project }) {
  const status = STATUS_META[p.status] ?? { label: p.status, color: "#6b7280", phase: 0 };
  const ccy = p.currency || "NGN";
  const completion = p.tasks === 0 ? 0 : Math.round((p.tasks_done / p.tasks) * 100);
  const days = daysUntil(p.end_date);
  const overdue = days !== null && days < 0 && !FINISHED_STATUSES.includes(p.status);
  const healthClass =
    p.health === "green" ? "bg-success/15 text-success border-success/30"
    : p.health === "amber" ? "bg-warn/15 text-warn border-warn/30"
    : "bg-danger/15 text-danger border-danger/30";

  return (
    <Link
      to={`/projects/${p.id}`}
      className="group bg-surface border border-border rounded-2xl p-5 hover:shadow-card hover:-translate-y-0.5 transition-all flex flex-col"
    >
      {/* Top: code + health + risk */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-mono font-semibold text-muted">{p.code}</span>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${healthClass}`}>
            {p.health}
          </span>
          {p.risk_score > 0 && (
            <span className="text-[10px] font-bold text-muted uppercase tracking-wide">
              risk {Math.round(p.risk_score)}
            </span>
          )}
        </div>
      </div>

      {/* Name & client */}
      <div className="flex-1">
        <div className="text-base font-bold text-text leading-tight">{p.name}</div>
        <div className="text-xs text-muted mt-0.5 truncate">
          {p.client_name || p.lead_type || "—"}
          {p.lead_type && p.client_name && <span className="text-muted/70"> · {p.lead_type}</span>}
        </div>
      </div>

      {/* Stage progress chevron */}
      <div className="mt-3 mb-3">
        <div className="flex items-center gap-1.5 text-xs text-text">
          <span className="w-2 h-2 rounded-full" style={{ background: status.color }} />
          {status.label}
          {overdue && <span className="ml-1 text-[10px] font-bold text-danger uppercase">overdue</span>}
        </div>
        <div className="mt-1.5 h-1.5 bg-bg rounded-full overflow-hidden flex gap-0.5">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <span
              key={i}
              className="flex-1"
              style={{
                background: i <= status.phase ? status.color : "transparent",
                opacity: i <= status.phase ? 1 : 0.15,
              }}
            />
          ))}
        </div>
      </div>

      {/* Tasks completion */}
      {p.tasks > 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] text-muted mb-1">
            <span>Tasks</span>
            <span>{p.tasks_done}/{p.tasks} · {completion}%</span>
          </div>
          <div className="h-1 bg-bg rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                completion === 100 ? "bg-success" : completion >= 50 ? "bg-accent" : "bg-warn"
              }`}
              style={{ width: `${completion}%` }}
            />
          </div>
        </div>
      )}

      {/* Bottom row: stats */}
      <div className="grid grid-cols-3 gap-2 mt-auto pt-3 border-t border-border text-[11px]">
        <Stat icon={<Wallet size={11} />} label="Budget" value={fmtMoney(p.budget, ccy)} />
        <Stat icon={<Users size={11} />} label="Team" value={p.stakeholders} />
        <Stat icon={<Flag size={11} />} label="Milestones" value={p.milestones} />
      </div>

      {/* Alerts row */}
      {(p.blockers > 0 || overdue) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.blockers > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide bg-danger/10 text-danger px-1.5 py-0.5 rounded">
              <AlertCircle size={10} /> {p.blockers} blocker{p.blockers === 1 ? "" : "s"}
            </span>
          )}
          {overdue && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide bg-warn/10 text-warn px-1.5 py-0.5 rounded">
              <Clock size={10} /> {Math.abs(days as number)}d overdue
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 text-[11px] text-muted">
        <span>Updated {relTime(p.updated_at)}</span>
        <span className="inline-flex items-center gap-1 text-accent group-hover:gap-1.5 transition-all">
          Open <ChevronRight size={12} />
        </span>
      </div>
    </Link>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-muted">{icon}{label}</div>
      <div className="text-text font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function fmtDateLong(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

function priorityFromHealth(p: Project): { label: string; tone: "danger" | "warn" | "ok" | "muted" } {
  // Use risk_score + health as a proxy until projects have a dedicated priority field.
  if (p.health === "red")     return { label: "High",   tone: "danger" };
  if (p.health === "amber")   return { label: "Medium", tone: "warn" };
  if (p.risk_score >= 60)     return { label: "High",   tone: "danger" };
  if (p.risk_score >= 30)     return { label: "Medium", tone: "warn" };
  return { label: "Low", tone: "ok" };
}

function ProjectTable({ items }: { items: Project[] }) {
  return (
    <div className="border border-border rounded-2xl bg-surface overflow-hidden">
      {/* Header row */}
      <div className="grid grid-cols-[24px_minmax(0,2fr)_140px_120px_180px_minmax(0,1fr)_36px] items-center gap-3 px-5 py-3.5 border-b border-border bg-bg/40 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
        <span />
        <span className="flex items-center gap-2"><Loader size={13} className="text-accent" /> Project name</span>
        <span className="flex items-center gap-2"><Loader size={13} className="text-accent" /> Status</span>
        <span className="flex items-center gap-2"><Flag size={12} className="text-accent" /> Priority</span>
        <span className="flex items-center gap-2"><Clock size={12} className="text-accent" /> Deadline</span>
        <span className="flex items-center gap-2"><Users size={12} className="text-accent" /> Owner</span>
        <span />
      </div>

      <ul>
        {items.map((p) => <ProjectRow key={p.id} project={p} />)}
      </ul>
    </div>
  );
}

function ProjectRow({ project: p }: { project: Project }) {
  const status = STATUS_META[p.status] ?? { label: p.status, color: "#6b7280", phase: 0 };
  const priority = priorityFromHealth(p);
  const completion = p.tasks === 0 ? 0 : Math.round((p.tasks_done / p.tasks) * 100);
  const days = daysUntil(p.end_date);
  const overdue = days !== null && days < 0 && !FINISHED_STATUSES.includes(p.status);
  const finished = FINISHED_STATUSES.includes(p.status);
  const ownerInitial = (p.client_name || p.lead_type || "?").trim()[0]?.toUpperCase() || "?";

  // Status icon — matches Workflow inspiration:
  //   In progress → spinning amber
  //   Completed   → solid violet/teal check
  //   Not started → empty circle
  const statusIcon = finished ? (
    <span className="w-3.5 h-3.5 rounded-full bg-accent grid place-items-center text-white">
      <CheckCircle2 size={10} />
    </span>
  ) : p.status === "planning" ? (
    <span className="w-3.5 h-3.5 rounded-full border-2 border-muted/60" />
  ) : (
    <span className="w-3.5 h-3.5 rounded-full" style={{ background: status.color }} />
  );

  const priorityCls = {
    danger: "text-danger",
    warn:   "text-warn",
    ok:     "text-success",
    muted:  "text-muted",
  }[priority.tone];

  return (
    <li className="border-b border-border last:border-0 group">
      <Link
        to={`/projects/${p.id}`}
        className="grid grid-cols-[24px_minmax(0,2fr)_140px_120px_180px_minmax(0,1fr)_36px] items-center gap-3 px-5 py-4 hover:bg-bg transition-colors"
      >
        {/* Checkbox (visual only for now) */}
        <span
          className="w-4 h-4 rounded border-2 border-border group-hover:border-accent/50 transition-colors"
          aria-hidden
        />

        {/* Name + client */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-mono font-semibold text-muted">{p.code}</span>
            <span className="text-[15px] font-bold text-text truncate">{p.name}</span>
            {p.blockers > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-danger/10 text-danger px-1.5 py-0.5 rounded shrink-0">
                <AlertCircle size={10} /> {p.blockers}
              </span>
            )}
          </div>
          <div className="text-[12.5px] text-muted truncate mt-0.5">
            {p.client_name || "—"}
            {p.lead_type && p.client_name && <span className="text-muted/70"> · {p.lead_type}</span>}
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 text-[14px] text-text">
          {statusIcon}
          <span>{status.label}</span>
        </div>

        {/* Priority */}
        <div className={`text-[14px] font-semibold ${priorityCls}`}>
          {priority.label}
        </div>

        {/* Deadline */}
        <div className="text-[14px] text-text whitespace-nowrap">
          {p.end_date ? fmtDateLong(p.end_date) : <span className="text-muted">—</span>}
          {overdue && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-danger">overdue</span>}
        </div>

        {/* Owner avatar + name */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full bg-accent-soft text-accent text-[12px] font-bold grid place-items-center shrink-0">
            {ownerInitial}
          </span>
          <span className="text-[14px] text-text truncate">{p.client_name || "Unassigned"}</span>
        </div>

        {/* Trailing menu */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="text-muted hover:text-text p-1 -m-1 rounded hover:bg-surface justify-self-end"
          aria-label="Row actions"
        >
          <MoreHorizontal size={16} />
        </button>
      </Link>

      {/* Optional sub-row: tasks completion bar */}
      {p.tasks > 0 && (
        <div className="px-5 pb-3 -mt-1 grid grid-cols-[24px_minmax(0,2fr)_minmax(0,3fr)] gap-3 items-center">
          <span />
          <span className="text-[11px] text-muted">{p.tasks_done}/{p.tasks} tasks · {completion}%</span>
          <div className="h-1 bg-bg rounded-full overflow-hidden">
            <div
              className={`h-full ${completion === 100 ? "bg-success" : completion >= 50 ? "bg-accent" : "bg-warn"}`}
              style={{ width: `${completion}%` }}
            />
          </div>
        </div>
      )}
    </li>
  );
}
