// DailyCheckinsPage — HR rollup of morning check-ins.
//
// Two layers:
//   1. Compliance summary — per-member, sorted by most missed first, with
//      streak and last mood for fast appraisal scanning.
//   2. Member drill-down drawer — day-by-day timeline with tile summary.
// (The page-level KPI strip was removed — the per-row Compliance column
// already carries the same signal without taking a header band of space.)
import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import {
  ShieldCheck, AlertCircle, Link2, CheckCircle2, Filter, Flame,
  Smile, ListChecks, Activity,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Attachment = { kind: "link" | "file"; name: string; url: string };

type Row = {
  user_id: string;
  user_name: string;
  email: string;
  day: string;
  mood?: string | null;
  focus_note?: string | null;
  yesterday_note?: string | null;
  attachments?: Attachment[];
  posted_to_campfire?: boolean;
  missed: boolean;
  first_seen_at?: string | null;
  tasks_done: number;
};

type Compliance = {
  user_id: string;
  user_name: string;
  email: string;
  done: number;
  missed: number;
  tasks_done: number;
  streak: number;
  last_mood?: string | null;
};

type Resp = {
  items: Row[];
  total: number;
  limit: number;
  offset: number;
  from: string;
  days: number;
  compliance: Compliance[];
  insights: {
    total_done: number;
    total_missed: number;
    at_risk: number;
    mood_counts: Record<string, number>;
    members: number;
  };
};

const ROLES_ALLOWED = ["super_admin", "hr", "ceo", "coo"];
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100, 0] as const; // 0 = "All"

function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
// CheckinsPanel — the page body, factored out so AttendancePage can mount it
// as a tab inside the merged "Daily HR" view without duplicating the table /
// filter logic. The standalone page is now a thin wrapper that adds the
// header + role guard.
export function CheckinsPanel({ embedded = false }: { embedded?: boolean }) {
  const me = useAuth((s) => s.user);
  const allowed = !!me?.roles?.some((r) => ROLES_ALLOWED.includes(r));

  const [windowDays, setWindowDays] = useState(7);
  const [userFilter, setUserFilter] = useState("");
  const [missedOnly, setMissedOnly] = useState(false);
  const [pageSize, setPageSize] = useState<number>(20); // 0 = view all
  const [page, setPage] = useState(0);
  const [drilldown, setDrilldown] = useState<Compliance | null>(null);

  // Reset to first page whenever the active filter set changes — staying on
  // page 5 of an empty filtered list is hostile UX.
  useEffect(() => { setPage(0); }, [userFilter, missedOnly, windowDays, pageSize]);

  const { data } = useQuery<Resp>({
    enabled: allowed,
    queryKey: ["admin", "daily-checkins", windowDays, userFilter, missedOnly, page, pageSize],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("days", String(windowDays));
      // 0 = view all — cap at 500 to match the backend ceiling. Otherwise
      // pass the chosen page size + offset.
      const limit = pageSize === 0 ? 500 : pageSize;
      p.set("limit", String(limit));
      p.set("offset", String(pageSize === 0 ? 0 : page * pageSize));
      if (userFilter.trim()) p.set("user", userFilter.trim());
      if (missedOnly) p.set("missed", "1");
      return api(`/api/v1/admin/daily-checkins?${p.toString()}`);
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const compliance = data?.compliance ?? [];
  const total = data?.total ?? 0;
  // Pagination now scopes the *compliance summary* (one row per member).
  // Day-by-day rows live in the drill-down drawer so they don't need their
  // own page strip.
  const complianceTotal = compliance.length;
  const effectivePageSize = pageSize === 0 ? Math.max(1, complianceTotal) : pageSize;
  const totalPages = Math.max(1, Math.ceil(complianceTotal / effectivePageSize));
  const firstShown = complianceTotal === 0 ? 0 : (pageSize === 0 ? 1 : page * pageSize + 1);
  const lastShown = pageSize === 0 ? complianceTotal : Math.min(complianceTotal, page * pageSize + Math.min(pageSize, complianceTotal - page * pageSize));
  const pagedCompliance = useMemo(
    () => (pageSize === 0 ? compliance : compliance.slice(page * pageSize, page * pageSize + pageSize)),
    [compliance, page, pageSize],
  );

  if (!me) return null;
  if (!allowed) return <Navigate to="/" replace />;

  return (
    <div className={embedded ? "space-y-5" : "space-y-5 max-w-7xl"}>
      {!embedded && (
        <div>
          <h1 className="h1 flex items-center gap-2">
            <ShieldCheck size={22} className="text-accent" /> Daily check-ins
          </h1>
          <p className="text-sm text-muted mt-1">
            Mood, what shipped, what's next — by person, by day. Drives compliance + appraisal.
          </p>
        </div>
      )}

      {/* ============ Filters ============ */}
      <section className="bg-surface border border-border rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-muted">
          <Filter size={13} /> Filters
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            placeholder="Filter by name or email"
            className="input"
          />
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(parseInt(e.target.value, 10))}
            className="input"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={missedOnly}
              onChange={(e) => setMissedOnly(e.target.checked)}
            />
            <span>Missed check-ins only</span>
          </label>
          <div className="text-xs text-muted self-center">
            {total.toLocaleString()} matching row{total === 1 ? "" : "s"}
          </div>
        </div>
      </section>

      {/* ============ Check-ins (one table) ============ */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-bold text-text inline-flex items-center gap-2">
            <ListChecks size={14} className="text-accent" /> Check-ins
          </div>
          <div className="text-[11px] text-muted">
            Sorted by most missed first · click a row for the day-by-day timeline
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/40 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Member</th>
                <th className="text-left px-4 py-2 font-semibold">Streak</th>
                <th className="text-left px-4 py-2 font-semibold">Last mood</th>
                <th className="text-left px-4 py-2 font-semibold">Checked in</th>
                <th className="text-left px-4 py-2 font-semibold">Missed</th>
                <th className="text-left px-4 py-2 font-semibold">Tasks shipped</th>
                <th className="text-left px-4 py-2 font-semibold">Compliance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {compliance.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-muted text-sm">No data yet</td></tr>
              ) : pagedCompliance.map((p) => {
                const t = p.done + p.missed;
                const pct = t > 0 ? Math.round((p.done / t) * 100) : 0;
                const tone = pct >= 80 ? "text-success" : pct >= 50 ? "text-warn" : "text-danger";
                return (
                  <tr
                    key={p.user_id}
                    className="hover:bg-bg/40 align-top cursor-pointer"
                    onClick={() => setDrilldown(p)}
                    title="Open member drill-down"
                  >
                    <td className="px-4 py-2">
                      <div className="font-semibold text-text hover:text-accent">{p.user_name || "—"}</div>
                      <div className="text-[11px] text-muted">{p.email}</div>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {p.streak > 0 ? (
                        <span className="inline-flex items-center gap-1 text-warn font-semibold">
                          <Flame size={12} /> {p.streak}d
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-base">{p.last_mood ?? <span className="text-muted text-xs">—</span>}</td>
                    <td className="px-4 py-2 text-sm">{p.done}</td>
                    <td className="px-4 py-2 text-sm">
                      {p.missed > 0 ? (
                        <span className="inline-flex items-center gap-1 text-danger font-semibold">
                          <AlertCircle size={12} /> {p.missed}
                        </span>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-sm">{p.tasks_done}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden max-w-[120px]">
                          <div
                            className={`h-full ${pct >= 80 ? "bg-success" : pct >= 50 ? "bg-warn" : "bg-danger"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={`text-sm font-bold ${tone}`}>{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {compliance.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-bg/30 text-xs flex-wrap">
            <div className="text-muted inline-flex items-center gap-3 flex-wrap">
              <span>
                Showing <span className="font-semibold text-text">{firstShown}</span>–
                <span className="font-semibold text-text">{lastShown}</span> of{" "}
                <span className="font-semibold text-text">{complianceTotal.toLocaleString()}</span> members
              </span>
              <label className="inline-flex items-center gap-1.5">
                Rows
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
                  className="bg-surface border border-border rounded-lg px-2 py-1 text-[12px] font-semibold text-text"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n === 0 ? "All" : n}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || pageSize === 0}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                ← Prev
              </button>
              <span className="text-muted px-1">
                Page <span className="font-semibold text-text">{pageSize === 0 ? 1 : page + 1}</span> of{" "}
                <span className="font-semibold text-text">{pageSize === 0 ? 1 : totalPages}</span>
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={pageSize === 0 || page + 1 >= totalPages}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </section>

      {drilldown && (
        <MemberDrillDown
          member={drilldown}
          windowDays={windowDays}
          rows={items.filter((r) => r.user_id === drilldown.user_id)}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}

// MemberDrillDown — slide-in drawer that shows the selected member's
// summary tiles + every day in the window. Uses rows already in the
// detail table (no extra fetch) so the open/close is instant.
function MemberDrillDown({
  member, windowDays, rows, onClose,
}: {
  member: Compliance;
  windowDays: number;
  rows: Row[];
  onClose: () => void;
}) {
  const t = member.done + member.missed;
  const pct = t > 0 ? Math.round((member.done / t) * 100) : 0;
  const tone = pct >= 80 ? "good" : pct >= 50 ? "warn" : "bad";

  // Mood histogram + most logged mood — quick "how have they been" read.
  const moodCounts = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { if (r.mood) m[r.mood] = (m[r.mood] ?? 0) + 1; });
    return m;
  }, [rows]);
  const topMood = useMemo(() => {
    const entries = Object.entries(moodCounts);
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b[1] - a[1])[0];
  }, [moodCounts]);

  // Sort newest first; we want today at the top of the timeline.
  const ordered = useMemo(
    () => [...rows].sort((a, b) => b.day.localeCompare(a.day)),
    [rows],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <aside
        className="bg-surface w-full max-w-2xl h-full overflow-y-auto shadow-card flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3 sticky top-0 bg-surface z-10">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-accent">Member drill-down</div>
            <h2 className="text-xl font-extrabold text-text leading-tight mt-1 truncate">{member.user_name || "—"}</h2>
            <div className="text-[12px] text-muted truncate">{member.email}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg text-muted hover:text-text shrink-0"
            aria-label="Close"
          >
            <ShieldCheck size={16} className="rotate-45" />
          </button>
        </header>

        {/* Summary tiles */}
        <div className="p-5 grid grid-cols-2 gap-3">
          <InsightTile
            icon={<Activity size={14} />}
            tone={tone}
            label="Compliance"
            value={`${pct}%`}
            sub={`${member.done} done · ${member.missed} missed (${windowDays}d)`}
          />
          <InsightTile
            icon={<Flame size={14} />}
            tone={member.streak >= 5 ? "good" : member.streak > 0 ? "warn" : "bad"}
            label="Current streak"
            value={`${member.streak}d`}
            sub={member.streak >= 5 ? "Strong rhythm" : member.streak > 0 ? "Hold the line" : "Reach out"}
          />
          <InsightTile
            icon={<Smile size={14} />}
            tone="info"
            label="Top mood"
            value={topMood ? topMood[0] : (member.last_mood ?? "—")}
            sub={topMood ? `${topMood[1]} of ${rows.length} day${rows.length === 1 ? "" : "s"}` : "No mood logged yet"}
          />
          <InsightTile
            icon={<ListChecks size={14} />}
            tone="good"
            label="Tasks shipped"
            value={String(member.tasks_done)}
            sub={`In the last ${windowDays} days`}
          />
        </div>

        {/* Day-by-day timeline */}
        <div className="px-5 pb-5">
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Timeline</div>
          {ordered.length === 0 ? (
            <div className="text-sm text-muted py-6 text-center">No matching days in the window.</div>
          ) : (
            <ul className="divide-y divide-border border border-border rounded-2xl overflow-hidden">
              {ordered.map((r) => (
                <li key={r.day} className={`px-4 py-3 ${r.missed ? "bg-danger/5" : ""}`}>
                  <div className="flex items-start gap-3">
                    <div className="w-[88px] shrink-0">
                      <div className="text-[12px] font-bold text-text">{fmtDay(r.day)}</div>
                      <div className="text-[10.5px] text-muted/80">{r.day}</div>
                      <div className="mt-1 text-[16px] leading-none">
                        {r.missed
                          ? <span className="text-[10.5px] text-danger font-semibold inline-flex items-center gap-1"><AlertCircle size={10} /> Missed</span>
                          : (r.mood || <span className="text-muted text-[11px]">—</span>)}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      {r.yesterday_note && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider font-bold text-muted">Yesterday</div>
                          <div className="text-[12.5px] text-text whitespace-pre-wrap leading-snug">{r.yesterday_note}</div>
                        </div>
                      )}
                      {r.focus_note && (
                        <div className="pt-1">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-muted">Today</div>
                          <div className="text-[12.5px] text-text whitespace-pre-wrap leading-snug">{r.focus_note}</div>
                          {r.posted_to_campfire && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-accent mt-1">
                              <CheckCircle2 size={9} /> Shared to Campfire
                            </span>
                          )}
                        </div>
                      )}
                      {(r.attachments?.length ?? 0) > 0 && (
                        <ul className="pt-1 space-y-0.5">
                          {r.attachments!.map((a, i) => (
                            <li key={i}>
                              <a
                                href={a.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline truncate max-w-[260px]"
                              >
                                <Link2 size={10} /> {a.name}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      {r.tasks_done > 0 && (
                        <div className="pt-1 inline-flex items-center gap-1 text-[11px] text-success font-semibold">
                          <ListChecks size={10} /> {r.tasks_done} task{r.tasks_done === 1 ? "" : "s"} shipped
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pageSizeWarning(rows)}
        </div>
      </aside>
    </div>
  );
}

// Helper — when the user has the table filtered/paginated to less than the
// full window, the drilldown only sees the visible rows. Surface that so
// HR doesn't think "5 days in window" means anything else.
function pageSizeWarning(rows: Row[]) {
  if (rows.length === 0) return null;
  return (
    <div className="text-[10.5px] text-muted mt-2">
      Showing {rows.length} row{rows.length === 1 ? "" : "s"} currently visible in the main table.
      Switch the Rows selector to “All” for the full window.
    </div>
  );
}

// Thin wrapper for the standalone /admin/daily-checkins route — keeps the
// URL valid for anyone with bookmarks, but the canonical home is now the
// merged Attendance "Check-ins" tab.
export function DailyCheckinsPage() {
  return <CheckinsPanel />;
}

function InsightTile({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "info";
}) {
  const bubble = {
    good: "bg-success/10 text-success",
    warn: "bg-warn/10 text-warn",
    bad:  "bg-danger/10 text-danger",
    info: "bg-accent-soft text-accent",
  }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${bubble}`}>
          {icon}
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted">{label}</span>
      </div>
      <div className="text-[1.5rem] font-extrabold text-text leading-none">{value}</div>
      <div className="text-[11.5px] text-muted leading-snug">{sub}</div>
    </div>
  );
}
