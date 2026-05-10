import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Coffee, MessageCircle, Plus, Paperclip, Users as UsersIcon, AlertTriangle,
  ArrowUpRight,
} from "lucide-react";

type Person = {
  id: string;
  name: string;
  weeks: { week: string; hours: number; utilization: number }[];
  current_allocation?: number;
  active_projects?: { id: string; name: string; role: string; allocation: number }[];
};

type Bucket = "available" | "engaged" | "overloaded";

const COL_META: Record<Bucket, { label: string; tone: string; bar: string; chip: string }> = {
  available: {
    label: "Available",
    tone: "from-accent-soft to-accent-soft/40 text-accent border-accent/30",
    bar:  "bg-accent",
    chip: "text-accent",
  },
  engaged: {
    label: "Engaged",
    tone: "from-[#dbeafe] to-[#dbeafe]/40 text-[#1d4ed8] border-[#1d4ed8]/30",
    bar:  "bg-[#1d4ed8]",
    chip: "text-[#1d4ed8]",
  },
  overloaded: {
    label: "Overloaded",
    tone: "from-danger/15 to-danger/5 text-danger border-danger/30",
    bar:  "bg-danger",
    chip: "text-danger",
  },
};

function avgUtilization(p: Person): number {
  // Prefer the live project_members allocation if the server provided one —
  // that captures "engaged" the moment somebody is staffed, before they log
  // any hours. Falls back to the rolling time_entries average otherwise.
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

export function WorkforcePage() {
  const { data, isLoading } = useQuery<{ people: Person[] }>({
    queryKey: ["workforce", "load"], queryFn: () => api("/api/v1/workforce/load"),
  });

  const people = data?.people ?? [];

  const grouped = useMemo(() => {
    const out: Record<Bucket, Person[]> = { available: [], engaged: [], overloaded: [] };
    people.forEach((p) => {
      const u = avgUtilization(p);
      out[bucketFor(u)].push(p);
    });
    // Sort each bucket by utilization (desc for engaged/overloaded, asc for available)
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

  // "Standup" feed — most recently logged person + a couple of high-utilization callouts
  const standupItems = useMemo(() => {
    return [...people]
      .map((p) => ({ p, u: avgUtilization(p), last: p.weeks.at(-1) }))
      .sort((a, b) => (b.last?.hours ?? 0) - (a.last?.hours ?? 0))
      .slice(0, 3);
  }, [people]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Team workflow</h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Capacity at a glance — who is free for new work, who is shipping, and who's at risk of burnout.
          Buckets are computed from the last 8 weeks of logged hours against a 40h baseline.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5">
        {/* Main board (left) */}
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(["available","engaged","overloaded"] as Bucket[]).map((b) =>
                <div key={b} className="h-[420px] rounded-2xl bg-bg/40 border border-border" />
              )}
            </div>
          ) : people.length === 0 ? (
            <div className="bg-surface border border-border rounded-2xl py-12 text-center">
              <UsersIcon size={28} className="mx-auto text-muted mb-3" />
              <h2 className="text-lg font-bold text-text">No team data yet</h2>
              <p className="text-sm text-muted mt-1">
                Hours and utilization are derived from logged time entries. Once your team starts
                tracking time, the buckets below will populate automatically.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(["available","engaged","overloaded"] as Bucket[]).map((bucket) => (
                <CapacityColumn
                  key={bucket}
                  bucket={bucket}
                  people={grouped[bucket]}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right rail */}
        <div className="space-y-5">
          <CapacityHero
            headcount={totals.headcount}
            avgUtilization={totals.avg}
            totalHours={totals.totalHours}
          />
          <StandupCard items={standupItems} />
        </div>
      </div>
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
  bucket, people,
}: {
  bucket: Bucket; people: Person[];
}) {
  const meta = COL_META[bucket];
  return (
    <div className="flex flex-col">
      {/* Column header pill */}
      <div className={`rounded-2xl bg-gradient-to-b ${meta.tone} border px-4 py-3 mb-3 flex items-center justify-between`}>
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
        ) : people.map((p) => <PersonCard key={p.id} person={p} bucket={bucket} />)}
      </div>
    </div>
  );
}

function PersonCard({ person: p, bucket }: { person: Person; bucket: Bucket }) {
  const meta = COL_META[bucket];
  const u = avgUtilization(p);
  const last = p.weeks.at(-1);
  const code = shortCode(p.name, p.id);
  const initial = (p.name || "?")[0]?.toUpperCase();
  const overloaded = bucket === "overloaded";

  return (
    <div className="bg-surface border border-border rounded-2xl p-4 hover:shadow-soft transition-all">
      <div className="flex items-center justify-between text-[11px] font-bold">
        <span className={meta.chip}>{code}</span>
        <button className="text-muted hover:text-text" aria-label="Card actions">⋯</button>
      </div>

      <div className="text-[15px] font-bold text-text mt-2">{p.name}</div>
      <div className="text-[12px] text-muted mt-0.5">
        Average <strong className={meta.chip}>{fmtPct(u)}</strong> · last 8 weeks
      </div>

      {/* Utilization bar */}
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
    </div>
  );
}
