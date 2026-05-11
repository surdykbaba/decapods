import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Coffee, MessageCircle, Plus, Paperclip, Users as UsersIcon, AlertTriangle,
  ArrowUpRight, LayoutGrid, List as ListIcon, X, ExternalLink, FolderKanban,
  PanelRightClose, PanelRightOpen,
} from "lucide-react";

type Person = {
  id: string;
  name: string;
  weeks: { week: string; hours: number; utilization: number }[];
  current_allocation?: number;
  active_projects?: { id: string; name: string; role: string; allocation: number }[];
};

type Bucket = "available" | "engaged" | "overloaded";
type View = "grid" | "list";

const COL_META: Record<Bucket, { label: string; tone: string; bar: string; chip: string; pillBg: string }> = {
  available: {
    label: "Available",
    tone: "bg-accent-soft text-accent border-accent/30",
    bar:  "bg-accent",
    chip: "text-accent",
    pillBg: "bg-accent-soft text-accent",
  },
  engaged: {
    label: "Engaged",
    tone: "bg-[#dbeafe] text-[#1d4ed8] border-[#1d4ed8]/30",
    bar:  "bg-[#1d4ed8]",
    chip: "text-[#1d4ed8]",
    pillBg: "bg-[#dbeafe] text-[#1d4ed8]",
  },
  overloaded: {
    label: "Overloaded",
    tone: "bg-danger/10 text-danger border-danger/30",
    bar:  "bg-danger",
    chip: "text-danger",
    pillBg: "bg-danger/10 text-danger",
  },
};

function avgUtilization(p: Person): number {
  if (typeof p.current_allocation === "number") return p.current_allocation;
  if (!p.weeks.length) return 0;
  const sum = p.weeks.reduce((s, w) => s + (w.utilization || 0), 0);
  return sum / p.weeks.length;
}

function bucketFor(u: number): Bucket {
  if (u >= 0.95) return "overloaded";
  if (u >= 0.5)  return "engaged";
  return "available";
}

function shortCode(name: string, fallback: string): string {
  const parts = (name || "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase() + "-" + fallback.slice(0, 4).toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase() + "-" + fallback.slice(0, 4).toUpperCase();
  return "PM-" + fallback.slice(0, 4).toUpperCase();
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function relWeek(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

const VIEW_KEY = "workforce-view";
const RAIL_KEY = "workforce-rail-hidden";

export function WorkforcePage() {
  const { data, isLoading } = useQuery<{ people: Person[] }>({
    queryKey: ["workforce", "load"], queryFn: () => api("/api/v1/workforce/load"),
  });

  const people = data?.people ?? [];
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View) || "grid");
  const [openId, setOpenId] = useState<string | null>(null);
  const [railHidden, setRailHidden] = useState<boolean>(() => localStorage.getItem(RAIL_KEY) === "1");

  function pickView(v: View) {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  }

  function toggleRail() {
    setRailHidden((prev) => {
      const next = !prev;
      localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      return next;
    });
  }

  const grouped = useMemo(() => {
    const out: Record<Bucket, Person[]> = { available: [], engaged: [], overloaded: [] };
    people.forEach((p) => {
      const u = avgUtilization(p);
      out[bucketFor(u)].push(p);
    });
    out.available.sort((a, b) => avgUtilization(b) - avgUtilization(a));
    out.engaged.sort((a, b) => avgUtilization(b) - avgUtilization(a));
    out.overloaded.sort((a, b) => avgUtilization(b) - avgUtilization(a));
    return out;
  }, [people]);

  const totals = useMemo(() => {
    const totalHours = people.reduce((s, p) => s + p.weeks.reduce((ss, w) => ss + w.hours, 0), 0);
    const avg = people.length === 0 ? 0
      : people.reduce((s, p) => s + avgUtilization(p), 0) / people.length;
    return { totalHours, avg, headcount: people.length };
  }, [people]);

  const standupItems = useMemo(() => {
    return [...people]
      .map((p) => ({ p, u: avgUtilization(p), last: p.weeks.at(-1) }))
      .sort((a, b) => (b.last?.hours ?? 0) - (a.last?.hours ?? 0))
      .slice(0, 3);
  }, [people]);

  const openPerson = people.find((p) => p.id === openId);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="h1">Team workflow</h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Capacity at a glance — who is free for new work, who is shipping, and who's at risk of burnout.
            Buckets are computed from the last 8 weeks of logged hours against a 40h baseline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={pickView} />
          <button
            onClick={toggleRail}
            title={railHidden ? "Show standup panel" : "Hide standup panel"}
            aria-label={railHidden ? "Show standup panel" : "Hide standup panel"}
            className="hidden lg:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-surface border border-border text-muted hover:text-text transition-colors"
          >
            {railHidden ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
            {railHidden ? "Show panel" : "Hide panel"}
          </button>
        </div>
      </header>

      <div className={`grid grid-cols-1 gap-5 ${railHidden ? "" : "lg:grid-cols-[minmax(0,1fr)_320px]"}`}>
        {/* Main board (left) */}
        <div>
          {isLoading ? (
            view === "grid" ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(["available","engaged","overloaded"] as Bucket[]).map((b) =>
                  <div key={b} className="h-[420px] rounded-2xl bg-bg/40 border border-border" />
                )}
              </div>
            ) : (
              <div className="h-[420px] rounded-2xl bg-bg/40 border border-border" />
            )
          ) : people.length === 0 ? (
            <div className="bg-surface border border-border rounded-2xl py-12 text-center">
              <UsersIcon size={28} className="mx-auto text-muted mb-3" />
              <h2 className="text-lg font-bold text-text">No team data yet</h2>
              <p className="text-sm text-muted mt-1">
                Hours and utilization are derived from logged time entries. Once your team starts
                tracking time, the buckets below will populate automatically.
              </p>
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(["available","engaged","overloaded"] as Bucket[]).map((bucket) => (
                <CapacityColumn
                  key={bucket}
                  bucket={bucket}
                  people={grouped[bucket]}
                  onOpen={setOpenId}
                />
              ))}
            </div>
          ) : (
            <CapacityList people={people} onOpen={setOpenId} />
          )}
        </div>

        {/* Right rail — hide-able. State persists in localStorage so the
            choice rides with the user across sessions. */}
        {!railHidden && (
          <div className="space-y-5">
            <CapacityHero
              headcount={totals.headcount}
              avgUtilization={totals.avg}
              totalHours={totals.totalHours}
            />
            <StandupCard items={standupItems} />
          </div>
        )}
      </div>

      {openPerson && (
        <PersonDrawer person={openPerson} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 bg-surface border border-border rounded-full">
      <button
        onClick={() => onChange("grid")}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
          view === "grid" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
        }`}
        title="Grid view"
      >
        <LayoutGrid size={12} /> Grid
      </button>
      <button
        onClick={() => onChange("list")}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
          view === "list" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
        }`}
        title="List view"
      >
        <ListIcon size={12} /> List
      </button>
    </div>
  );
}

function CapacityHero({
  headcount, avgUtilization, totalHours,
}: {
  headcount: number; avgUtilization: number; totalHours: number;
}) {
  return (
    <div className="rounded-2xl bg-accent text-white p-5 relative overflow-hidden">
      <div className="absolute -right-6 -top-6 w-32 h-32 rounded-full bg-white/10" />
      <div className="absolute -right-2 bottom-0 w-20 h-20 rounded-full bg-white/5" />

      <div className="relative">
        <div className="text-[12px] uppercase tracking-wider font-bold text-white/80">Capacity standup</div>
        <h2 className="text-[1.6rem] font-extrabold leading-tight mt-1">Today's check-in</h2>

        <div className="mt-5 flex items-end gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Headcount</div>
            <div className="text-3xl font-extrabold leading-none mt-1">{headcount}</div>
          </div>
          <div className="flex-1" />
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Avg utilization</div>
            <div className="text-2xl font-bold leading-none mt-1">{fmtPct(avgUtilization)}</div>
          </div>
        </div>

        <div className="mt-4 h-1.5 bg-white/20 rounded-full overflow-hidden">
          <div className="h-full bg-white" style={{ width: `${Math.min(100, Math.round(avgUtilization * 100))}%` }} />
        </div>

        <div className="mt-4 flex items-center gap-2 text-[12.5px] text-white/85">
          <Coffee size={14} />
          <span>{totalHours.toLocaleString()} hours logged · last 8 weeks</span>
        </div>

        <Link
          to="/workforce/burnout"
          className="mt-5 inline-flex items-center justify-center gap-1.5 bg-white text-accent px-4 py-2 rounded-full font-bold text-[13px] hover:opacity-95 transition"
        >
          Burnout check
          <ArrowUpRight size={14} />
        </Link>
      </div>
    </div>
  );
}

function StandupCard({ items }: { items: { p: Person; u: number; last?: Person["weeks"][number] }[] }) {
  return (
    <div className="rounded-2xl bg-lime-soft border border-lime/30 p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-text/10 grid place-items-center text-text">
          <MessageCircle size={15} />
        </div>
        <h3 className="text-[15px] font-bold text-text">Latest activity</h3>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-muted">No recent time entries.</div>
      ) : (
        <ul className="space-y-3">
          {items.map(({ p, u, last }) => (
            <li key={p.id} className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-full bg-surface border border-border text-text font-bold text-[13px] grid place-items-center shrink-0">
                {(p.name || "?")[0]?.toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-bold text-text truncate">{p.name}</span>
                  <span className="text-[11px] font-bold text-text/70">{fmtPct(u)}</span>
                </div>
                <p className="text-[12.5px] text-text/80 leading-relaxed">
                  Logged <strong>{last?.hours ?? 0}h</strong> the week of {relWeek(last?.week)}.
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CapacityColumn({
  bucket, people, onOpen,
}: {
  bucket: Bucket; people: Person[]; onOpen: (id: string) => void;
}) {
  const meta = COL_META[bucket];
  return (
    <div className="flex flex-col">
      <div className={`rounded-2xl ${meta.tone} border px-4 py-3 mb-3 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${meta.bar}`} />
          <span className="text-[14px] font-bold capitalize">{meta.label}</span>
          <span className="text-[13px] font-bold opacity-70">— {people.length}</span>
        </div>
        <button
          className="w-7 h-7 grid place-items-center rounded-full bg-surface border border-border text-muted hover:text-text"
          aria-label="Add to bucket"
          title="Coming soon"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="space-y-3 min-h-[80px]">
        {people.length === 0 ? (
          <div className="text-xs text-muted/60 italic py-6 text-center border border-dashed border-border rounded-xl">
            No one here.
          </div>
        ) : people.map((p) => <PersonCard key={p.id} person={p} bucket={bucket} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function PersonCard({ person: p, bucket, onOpen }: { person: Person; bucket: Bucket; onOpen: (id: string) => void }) {
  const meta = COL_META[bucket];
  const u = avgUtilization(p);
  const last = p.weeks.at(-1);
  const code = shortCode(p.name, p.id);
  const initial = (p.name || "?")[0]?.toUpperCase();
  const overloaded = bucket === "overloaded";

  return (
    <button
      onClick={() => onOpen(p.id)}
      className="bg-surface border border-border rounded-2xl p-4 text-left hover:shadow-soft hover:border-accent/40 transition-all w-full"
    >
      <div className="flex items-center justify-between text-[11px] font-bold">
        <span className={meta.chip}>{code}</span>
        <span className="text-muted">⋯</span>
      </div>

      <div className="text-[15px] font-bold text-text mt-2">{p.name}</div>
      <div className="text-[12px] text-muted mt-0.5">
        Average <strong className={meta.chip}>{fmtPct(u)}</strong> · last 8 weeks
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-muted mb-1">
          <span>Load</span>
          <span>{fmtPct(u)}</span>
        </div>
        <div className="h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${meta.bar}`}
            style={{ width: `${Math.min(100, Math.round(u * 100))}%` }}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Paperclip size={13} />
          {last ? `${last.hours}h · ${relWeek(last.week)}` : "no entries yet"}
        </div>
        <span className="w-7 h-7 rounded-full bg-accent-soft text-accent font-bold text-[12px] grid place-items-center">
          {initial}
        </span>
      </div>

      {overloaded && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-danger bg-danger/10 px-2 py-1 rounded-md">
          <AlertTriangle size={11} /> Burnout risk
        </div>
      )}
    </button>
  );
}

/* ---------- List view ---------- */

type SortKey = "name" | "load" | "last";

function CapacityList({ people, onOpen }: { people: Person[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | Bucket>("all");
  const [sort, setSort] = useState<SortKey>("load");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    let list = people.map((p) => ({
      p,
      u: avgUtilization(p),
      last: p.weeks.at(-1),
      bucket: bucketFor(avgUtilization(p)),
    }));
    if (filter !== "all") list = list.filter((r) => r.bucket === filter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((r) => r.p.name.toLowerCase().includes(q));
    list.sort((a, b) => {
      if (sort === "name") return a.p.name.localeCompare(b.p.name);
      if (sort === "last") return (b.last?.hours ?? 0) - (a.last?.hours ?? 0);
      return b.u - a.u;
    });
    return list;
  }, [people, filter, sort, search]);

  const counts = useMemo(() => {
    const c = { all: people.length, available: 0, engaged: 0, overloaded: 0 };
    people.forEach((p) => { c[bucketFor(avgUtilization(p))]++; });
    return c;
  }, [people]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full">
          {([
            { k: "all", label: `All · ${counts.all}` },
            { k: "available", label: `Available · ${counts.available}` },
            { k: "engaged", label: `Engaged · ${counts.engaged}` },
            { k: "overloaded", label: `Overloaded · ${counts.overloaded}` },
          ] as { k: "all" | Bucket; label: string }[]).map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                filter === f.k ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name…"
            className="bg-surface border border-border rounded-lg text-sm px-3 py-2 w-48"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-surface border border-border rounded-lg text-sm px-3 py-2"
          >
            <option value="load">Sort by load</option>
            <option value="name">Sort by name</option>
            <option value="last">Sort by last hours</option>
          </select>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_minmax(180px,2fr)_140px_120px] gap-3 px-4 py-2.5 bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
          <div>Member</div>
          <div>Bucket</div>
          <div>Load · last 8 weeks</div>
          <div>Last week</div>
          <div className="text-right">Risk</div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted italic">No one matches.</div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ p, u, last, bucket }) => {
              const meta = COL_META[bucket];
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onOpen(p.id)}
                    className="w-full grid grid-cols-[1fr_120px_minmax(180px,2fr)_140px_120px] gap-3 items-center px-4 py-3 text-left hover:bg-bg/40 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-8 h-8 rounded-full bg-accent-soft text-accent font-bold text-sm grid place-items-center shrink-0">
                        {(p.name || "?")[0]?.toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-text truncate">{p.name}</div>
                        <div className="text-[11px] text-muted truncate">{shortCode(p.name, p.id)}</div>
                      </div>
                    </div>
                    <div>
                      <span className={`pill ${meta.pillBg} text-[10.5px] capitalize`}>{meta.label}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center justify-between text-[11px] text-muted mb-1">
                        <span>Load</span>
                        <span className={`${meta.chip} font-semibold`}>{fmtPct(u)}</span>
                      </div>
                      <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                        <div className={`h-full ${meta.bar}`} style={{ width: `${Math.min(100, Math.round(u * 100))}%` }} />
                      </div>
                    </div>
                    <div className="text-[12px] text-muted">
                      {last ? `${last.hours}h · ${relWeek(last.week)}` : "no entries"}
                    </div>
                    <div className="text-right">
                      {bucket === "overloaded" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-danger">
                          <AlertTriangle size={11} /> burnout
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted/70">—</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------- Drawer ---------- */

function PersonDrawer({ person: p, onClose }: { person: Person; onClose: () => void }) {
  const u = avgUtilization(p);
  const bucket = bucketFor(u);
  const meta = COL_META[bucket];
  const overloaded = bucket === "overloaded";

  // 8-week spark — render bars relative to the max so quiet weeks read clearly.
  const maxHours = Math.max(1, ...p.weeks.map((w) => w.hours));

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside
        className="absolute right-0 top-0 bottom-0 w-full max-w-[480px] bg-surface border-l border-border shadow-card flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className={`text-[11px] uppercase tracking-wider font-bold ${meta.chip}`}>{meta.label}</div>
            <h2 className="text-lg font-extrabold text-text mt-0.5 leading-tight">{p.name}</h2>
            <div className="text-[11px] text-muted mt-0.5">{shortCode(p.name, p.id)}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {overloaded && (
            <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger inline-flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-bold">Burnout risk.</span> Average load ≥ 95% across the last 8 weeks.
                Consider reassigning or pausing one of the projects below.
              </span>
            </div>
          )}

          {/* Headline numbers */}
          <div className="grid grid-cols-2 gap-3">
            <Tile label="Avg load · 8 weeks" value={fmtPct(u)} tone={meta.chip} />
            <Tile
              label="Hours · 8 weeks"
              value={`${p.weeks.reduce((s, w) => s + w.hours, 0).toFixed(0)}h`}
            />
          </div>

          {/* 8-week sparkline */}
          <div>
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider font-bold text-muted mb-2">
              <span>Last 8 weeks</span>
              <span className="text-text font-bold normal-case tracking-normal">40h baseline</span>
            </div>
            {p.weeks.length === 0 ? (
              <div className="text-sm text-muted italic">No time entries yet.</div>
            ) : (
              <div className="grid grid-cols-8 gap-1.5">
                {p.weeks.map((w) => {
                  const h = Math.max(3, Math.round((w.hours / maxHours) * 56));
                  const overBar = w.utilization >= 0.95;
                  return (
                    <div key={w.week} className="flex flex-col items-center gap-1" title={`${relWeek(w.week)} · ${w.hours}h · ${fmtPct(w.utilization)}`}>
                      <div className="w-full h-16 bg-bg rounded relative flex items-end overflow-hidden">
                        <div
                          className={`w-full ${overBar ? "bg-danger" : w.utilization >= 0.5 ? "bg-[#1d4ed8]" : "bg-accent"}`}
                          style={{ height: `${h}px` }}
                        />
                      </div>
                      <span className="text-[9px] text-muted truncate">{relWeek(w.week)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Active projects */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Active projects</div>
            {!p.active_projects || p.active_projects.length === 0 ? (
              <div className="text-sm text-muted italic">Not staffed on any active project.</div>
            ) : (
              <ul className="space-y-1.5">
                {p.active_projects.map((pr) => (
                  <li key={pr.id}>
                    <Link
                      to={`/projects/${pr.id}`}
                      onClick={onClose}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border hover:border-accent/40 hover:bg-bg/40 group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-text truncate group-hover:text-accent">
                          <FolderKanban size={12} /> {pr.name}
                        </div>
                        {pr.role && <div className="text-[11px] text-muted truncate">{pr.role}</div>}
                      </div>
                      <span className={`text-[11px] font-bold shrink-0 ${pr.allocation >= 80 ? "text-danger" : pr.allocation >= 40 ? "text-warn" : "text-text"}`}>
                        {pr.allocation}%
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Resolution hint */}
          <div className="text-[11px] text-muted leading-relaxed bg-bg/40 border border-border rounded-lg px-3 py-2">
            Need to rebalance? Open a project above and remove this member from{" "}
            <span className="text-text font-semibold">Invite team</span>, or reduce their allocation.
            Buckets refresh on next load.
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center gap-2">
          <Link
            to={`/members/${p.id}`}
            onClick={onClose}
            className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[rgb(var(--accent-hover))]"
          >
            View full profile <ExternalLink size={12} />
          </Link>
          <button
            onClick={onClose}
            className="text-sm text-muted hover:text-text px-3 py-2"
          >
            Close
          </button>
        </footer>
      </aside>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg/30 p-3">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-2xl font-extrabold mt-1 ${tone ?? "text-text"}`}>{value}</div>
    </div>
  );
}
