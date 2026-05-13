import { useCallback, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { SortHeader, TablePager, usePagedSort, type SortState } from "@/components/TableTools";
import {
  Network, Plus, Search, ShieldCheck, ShieldAlert, Clock, CheckCircle2,
  X, LayoutGrid, Rows3, AlertTriangle, Globe, Mail, Phone, UserCircle2,
  Sparkles,
} from "lucide-react";

type AgentStatus = "draft" | "onboarded" | "engaged" | "suspended" | "terminated";
type RiskLevel = "low" | "medium" | "high" | "critical";
type AgentType =
  | "pr_consultant" | "relationship_agent" | "strategic_adviser"
  | "business_introducer" | "government_relations" | "market_entry_partner"
  | "independent_consultant";

type AgentRow = {
  id: string;
  name: string;
  organization: string;
  agent_type: AgentType;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  region: string;
  country: string;
  sector_focus: string[];
  relationship_owner_id: string | null;
  relationship_owner_name: string;
  status: AgentStatus;
  risk_level: RiskLevel;
  pep_flag: boolean;
  conflict_flag: boolean;
  notes: string;
  last_activity_at: string | null;
  created_at: string;
  document_count: number;
  document_kinds: string[] | null;
  mandatory_missing: string[];
  can_engage: boolean;
  active_engagements_count: number;
  introductions_count: number;
  commission_exposure: number;
};

export const AGENT_TYPE_LABEL: Record<AgentType, string> = {
  pr_consultant:          "PR consultant",
  relationship_agent:     "Relationship agent",
  strategic_adviser:      "Strategic adviser",
  business_introducer:    "Business introducer",
  government_relations:   "Government relations",
  market_entry_partner:   "Market entry partner",
  independent_consultant: "Independent consultant",
};

const STATUS_META: Record<AgentStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  draft:      { label: "Onboarding",  cls: "bg-warn/15 text-warn",       icon: <Clock size={11} /> },
  onboarded:  { label: "Onboarded",   cls: "bg-accent-soft text-accent", icon: <CheckCircle2 size={11} /> },
  engaged:    { label: "Engaged",     cls: "bg-success/15 text-success", icon: <ShieldCheck size={11} /> },
  suspended:  { label: "Suspended",   cls: "bg-warn/25 text-warn",       icon: <ShieldAlert size={11} /> },
  terminated: { label: "Terminated",  cls: "bg-danger/15 text-danger",   icon: <X size={11} /> },
};

const RISK_META: Record<RiskLevel, { label: string; cls: string }> = {
  low:      { label: "Low",      cls: "bg-success/15 text-success" },
  medium:   { label: "Medium",   cls: "bg-warn/15 text-warn" },
  high:     { label: "High",     cls: "bg-danger/15 text-danger" },
  critical: { label: "Critical", cls: "bg-danger text-white" },
};

const SECTOR_OPTIONS = [
  "finance", "energy", "public_sector", "telecom", "health", "manufacturing",
  "agriculture", "logistics", "education", "tech", "real_estate", "extractives",
];

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export function AgentsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: AgentRow[] }>({
    queryKey: ["agents"], queryFn: () => api("/api/v1/agents"),
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AgentStatus>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | RiskLevel>("all");
  const [view, setView] = useState<"table" | "cards">("table");
  const [createOpen, setCreateOpen] = useState(false);

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    let list = items;
    if (statusFilter !== "all") list = list.filter((a) => a.status === statusFilter);
    if (typeFilter   !== "all") list = list.filter((a) => a.agent_type === typeFilter);
    if (regionFilter !== "all") list = list.filter((a) => a.region === regionFilter);
    if (riskFilter   !== "all") list = list.filter((a) => a.risk_level === riskFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.organization.toLowerCase().includes(q) ||
        a.contact_name.toLowerCase().includes(q) ||
        a.contact_email.toLowerCase().includes(q) ||
        a.sector_focus.some((s) => s.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [items, query, statusFilter, typeFilter, regionFilter, riskFilter]);

  // Distinct regions from data so the filter is honest about what exists.
  const regions = useMemo(() =>
    Array.from(new Set(items.map((a) => a.region).filter(Boolean))).sort(),
  [items]);

  // Just the status counts the pill row needs.
  const kpis = useMemo(() => {
    const counts = { all: items.length, draft: 0, onboarded: 0, engaged: 0, suspended: 0, terminated: 0 };
    items.forEach((a) => { counts[a.status]++; });
    return { counts };
  }, [items]);

  const create = useMutation({
    mutationFn: (body: Partial<AgentRow>) =>
      api<{ id: string }>("/api/v1/agents", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success("Agent added", "They're in onboarding until the compliance docset lands.");
      qc.invalidateQueries({ queryKey: ["agents"] });
      setCreateOpen(false);
    },
    onError: (e: Error) => toast.error("Could not add agent", e.message),
  });

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Relationship governance</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <Network size={26} className="text-accent" /> PR & Agents
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            PR consultants, business introducers, government-relations advisers, market-entry partners — the
            relationships that move opportunities from cold to qualified. Compliance-first onboarding, with
            engagement and commission tracking layering on next.
          </p>
        </div>
        <SmartButton variant="primary" onClick={() => setCreateOpen(true)} icon={<Plus size={14} />}>
          Add agent
        </SmartButton>
      </header>

      {/* Status pills */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["all","engaged","onboarded","draft","suspended","terminated"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setStatusFilter(k)}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-full transition-colors ${
              statusFilter === k ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {k === "all" ? "All" : STATUS_META[k].label}
            <span className="ml-1.5 opacity-70">{k === "all" ? kpis.counts.all : kpis.counts[k]}</span>
          </button>
        ))}
      </div>

      {/* Filter toolbar */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex flex-wrap gap-2 items-end">
          <FilterSelect label="Agent type" value={typeFilter} onChange={setTypeFilter}
            options={[{ value: "all", label: "All types" }, ...Object.entries(AGENT_TYPE_LABEL).map(([v, l]) => ({ value: v, label: l }))]}
          />
          <FilterSelect label="Region" value={regionFilter} onChange={setRegionFilter}
            options={[{ value: "all", label: "All regions" }, ...regions.map((r) => ({ value: r, label: r }))]}
            disabled={regions.length === 0}
          />
          <FilterSelect label="Risk level" value={riskFilter} onChange={(v) => setRiskFilter(v as "all" | RiskLevel)}
            options={[
              { value: "all", label: "Any risk" },
              { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
              { value: "high", label: "High" }, { value: "critical", label: "Critical" },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-full w-[260px] focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex gap-1 p-1 bg-surface border border-border rounded-full" title="Toggle layout">
            <button onClick={() => setView("table")}
              className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "table" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
              aria-label="Table"><Rows3 size={13} /></button>
            <button onClick={() => setView("cards")}
              className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "cards" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
              aria-label="Cards"><LayoutGrid size={13} /></button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-muted">Loading agents…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
            <Network size={22} />
          </div>
          <div className="text-base font-bold text-text">
            {items.length === 0 ? "No agents yet" : "Nothing matches those filters"}
          </div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            {items.length === 0
              ? "Add the PR consultants, introducers and advisers who source or unblock opportunities for you. Compliance docs gate engagement."
              : "Try clearing the filters or the search term."}
          </p>
        </div>
      ) : view === "cards" ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {filtered.map((a) => <AgentCard key={a.id} a={a} />)}
        </div>
      ) : (
        <AgentTable rows={filtered} />
      )}

      {createOpen && (
        <CreateAgentDialog
          submitting={create.isPending}
          onClose={() => setCreateOpen(false)}
          onCreate={(body) => create.mutate(body)}
        />
      )}
    </div>
  );
}

/* ---------------- Sub-components ---------------- */

function FilterSelect({
  label, value, onChange, options, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">{label}</div>
      <select disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}
        className="bg-surface border border-border rounded-full text-[12.5px] px-3 py-1.5 focus:outline-none focus:border-accent disabled:opacity-50">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function AgentTable({ rows }: { rows: AgentRow[] }) {
  type AgentSort = "name" | "type" | "region" | "owner" | "status" | "risk" | "engagements" | "activity";
  const compare = useCallback((a: AgentRow, b: AgentRow, s: SortState<AgentSort>) => {
    const mul = s.dir === "asc" ? 1 : -1;
    switch (s.col) {
      case "name":        return mul * a.name.localeCompare(b.name);
      case "type":        return mul * a.agent_type.localeCompare(b.agent_type);
      case "region":      return mul * (a.region || a.country || "").localeCompare(b.region || b.country || "");
      case "owner":       return mul * (a.relationship_owner_name || "").localeCompare(b.relationship_owner_name || "");
      case "status":      return mul * a.status.localeCompare(b.status);
      case "risk":        return mul * a.risk_level.localeCompare(b.risk_level);
      case "engagements": return mul * (a.active_engagements_count - b.active_engagements_count);
      case "activity":    return mul * ((a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0) - (b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0));
    }
  }, []);
  const ps = usePagedSort<AgentRow, AgentSort>({
    rows,
    storageKey: "agents-page-size",
    defaultSort: { col: "activity", dir: "desc" },
    compare,
  });
  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              <SortHeader col="name"        label="Agent"         sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="type"        label="Type"          sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="region"      label="Region"        sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <th className="text-left px-3 py-3 font-semibold">Sectors</th>
              <SortHeader col="owner"       label="Owner"         sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="status"      label="Status"        sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="risk"        label="Risk"          sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="engagements" label="Engagements"   sort={ps.sort} onSort={(c) => ps.toggleSort(c)} align="right" />
              <SortHeader col="activity"    label="Last activity" sort={ps.sort} onSort={(c) => ps.toggleSort(c)} />
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {ps.pageRows.map((a) => {
              const sm = STATUS_META[a.status];
              const rm = RISK_META[a.risk_level];
              return (
                <tr key={a.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                  <td className="px-4 py-3 min-w-[220px]">
                    <Link to={`/agents/${a.id}`} className="block">
                      <div className="font-bold text-text truncate">{a.name}</div>
                      {a.organization && <div className="text-[11px] text-muted truncate">{a.organization}</div>}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {!a.can_engage && (
                          <span className="text-[10.5px] text-warn font-semibold inline-flex items-center gap-1">
                            <AlertTriangle size={10} /> {a.mandatory_missing.length} doc{a.mandatory_missing.length === 1 ? "" : "s"} missing
                          </span>
                        )}
                        {a.pep_flag    && <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-px rounded bg-danger/15 text-danger">PEP</span>}
                        {a.conflict_flag && <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-px rounded bg-warn/15 text-warn">Conflict</span>}
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted text-[12.5px]">{AGENT_TYPE_LABEL[a.agent_type] ?? a.agent_type}</td>
                  <td className="px-3 py-3 text-muted text-[12.5px]">{a.region || a.country || "—"}</td>
                  <td className="px-3 py-3">
                    {a.sector_focus.length === 0 ? <span className="text-muted">—</span> : (
                      <div className="flex flex-wrap gap-1 max-w-[180px]">
                        {a.sector_focus.slice(0, 3).map((s) => (
                          <span key={s} className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-px rounded bg-bg border border-border text-muted">{s.replace(/_/g, " ")}</span>
                        ))}
                        {a.sector_focus.length > 3 && <span className="text-[10px] text-muted">+{a.sector_focus.length - 3}</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-muted text-[12.5px]">{a.relationship_owner_name || "—"}</td>
                  <td className="px-3 py-3"><span className={`pill ${sm.cls}`}>{sm.icon}{sm.label}</span></td>
                  <td className="px-3 py-3"><span className={`pill ${rm.cls}`}>{rm.label}</span></td>
                  <td className="px-3 py-3 text-right text-muted">{a.active_engagements_count}</td>
                  <td className="px-3 py-3 text-[11px] text-muted whitespace-nowrap">{fmtRel(a.last_activity_at)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <Link to={`/agents/${a.id}`} className="text-xs font-semibold text-accent hover:underline">Open →</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TablePager
        total={ps.total}
        pageSize={ps.pageSize}
        pickPageSize={ps.pickPageSize}
        page={ps.page}
        setPage={ps.setPage}
        totalPages={ps.totalPages}
        firstShown={ps.firstShown}
        lastShown={ps.lastShown}
        label="agent"
      />
    </div>
  );
}

function AgentCard({ a }: { a: AgentRow }) {
  const sm = STATUS_META[a.status];
  return (
    <Link to={`/agents/${a.id}`} className="bg-surface border border-border rounded-2xl p-4 hover:border-accent transition-colors block">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text truncate">{a.name}</div>
          <div className="text-[11px] text-muted truncate">
            {AGENT_TYPE_LABEL[a.agent_type] ?? a.agent_type}
            {a.organization && <> · {a.organization}</>}
          </div>
        </div>
        <span className={`pill ${sm.cls} shrink-0`}>{sm.icon}{sm.label}</span>
      </div>
      {a.sector_focus.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {a.sector_focus.slice(0, 4).map((s) => (
            <span key={s} className="text-[10.5px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-bg border border-border text-muted">{s.replace(/_/g, " ")}</span>
          ))}
          {a.sector_focus.length > 4 && <span className="text-[10.5px] text-muted">+{a.sector_focus.length - 4}</span>}
        </div>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted mt-3 pt-3 border-t border-border gap-2">
        <span className="truncate">{a.contact_email || a.contact_name || "no contact"}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {a.pep_flag && <span className="text-[10px] uppercase font-bold text-danger">PEP</span>}
          {!a.can_engage && <span className="text-[10px] uppercase font-bold text-warn">Blocked</span>}
          <span>{a.document_count} doc{a.document_count === 1 ? "" : "s"}</span>
        </div>
      </div>
    </Link>
  );
}

/* ---------------- Create dialog ---------------- */

function CreateAgentDialog({
  submitting, onClose, onCreate,
}: {
  submitting: boolean;
  onClose: () => void;
  onCreate: (body: Partial<AgentRow>) => void;
}) {
  const [form, setForm] = useState<Partial<AgentRow>>({
    name: "", organization: "", agent_type: "relationship_agent",
    contact_name: "", contact_email: "", contact_phone: "",
    region: "West Africa", country: "Nigeria",
    sector_focus: [], notes: "",
    risk_level: "low", pep_flag: false, conflict_flag: false,
  });
  const set = <K extends keyof AgentRow>(k: K, v: AgentRow[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleSector = (s: string) =>
    setForm((f) => ({
      ...f,
      sector_focus: (f.sector_focus ?? []).includes(s)
        ? (f.sector_focus ?? []).filter((x) => x !== s)
        : [...(f.sector_focus ?? []), s],
    }));
  const valid = (form.name ?? "").trim().length > 1;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between gap-3 p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center"><Network size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">Add an agent</h2>
              <p className="text-xs text-muted mt-0.5">
                Just the basics now — compliance docs and the engagement memo come next on the agent page.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Agent name *</div>
              <input className="input" autoFocus value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Aminu Bello" />
            </label>
            <label className="block">
              <div className="label">Organization</div>
              <input className="input" value={form.organization ?? ""} onChange={(e) => set("organization", e.target.value)} placeholder="firm or independent" />
            </label>
            <label className="block">
              <div className="label">Type</div>
              <select className="input" value={form.agent_type ?? "relationship_agent"} onChange={(e) => set("agent_type", e.target.value as AgentType)}>
                {Object.entries(AGENT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Initial risk level</div>
              <select className="input" value={form.risk_level ?? "low"} onChange={(e) => set("risk_level", e.target.value as RiskLevel)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Region</div>
              <input className="input" value={form.region ?? ""} onChange={(e) => set("region", e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Country</div>
              <input className="input" value={form.country ?? ""} onChange={(e) => set("country", e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Contact name</div>
              <input className="input" value={form.contact_name ?? ""} onChange={(e) => set("contact_name", e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Contact email</div>
              <input className="input" type="email" value={form.contact_email ?? ""} onChange={(e) => set("contact_email", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <div className="label">Contact phone</div>
              <input className="input" value={form.contact_phone ?? ""} onChange={(e) => set("contact_phone", e.target.value)} />
            </label>
          </div>
          <div>
            <div className="label">Sector focus</div>
            <div className="flex flex-wrap gap-1.5">
              {SECTOR_OPTIONS.map((s) => {
                const active = (form.sector_focus ?? []).includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleSector(s)}
                    className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                      active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                    }`}>{s.replace(/_/g, " ")}</button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-4 pt-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.pep_flag ?? false} onChange={(e) => set("pep_flag", e.target.checked)} />
              <span>Politically exposed person (PEP)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.conflict_flag ?? false} onChange={(e) => set("conflict_flag", e.target.checked)} />
              <span>Known conflict of interest</span>
            </label>
          </div>
          <label className="block">
            <div className="label">Notes</div>
            <textarea className="input" rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="How they were sourced, who introduced them, prior work, anything compliance-relevant." />
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton variant="primary" disabled={!valid || submitting} loading={submitting} onClick={() => onCreate(form)} icon={<Plus size={13} />}>
            Add agent
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// Re-exports so unused-warning doesn't flag the icons we use elsewhere.
export const _icons = { Globe, Mail, Phone, UserCircle2, Sparkles };
