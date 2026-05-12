// DailyCheckinsPage — HR rollup of morning check-ins across the workspace.
//
// Pivots every active user × every day in the window so HR sees mood,
// yesterday/today notes, attachments, tasks completed and "first seen"
// timestamps in one screen. Missed check-ins are flagged so compliance
// chasing has a single source of truth instead of HR pinging individuals.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { ShieldCheck, AlertCircle, Link2, Paperclip, CheckCircle2, Calendar, Filter } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Attachment = { kind: "link" | "file"; name: string; url: string };

type Row = {
  user_id: string;
  user_name: string;
  email: string;
  day: string;            // YYYY-MM-DD
  mood?: string | null;
  focus_note?: string | null;
  yesterday_note?: string | null;
  attachments?: Attachment[];
  posted_to_campfire?: boolean;
  missed: boolean;
  first_seen_at?: string | null;
  tasks_done: number;
};

const ROLES_ALLOWED = ["super_admin", "hr", "ceo", "coo"];

function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function DailyCheckinsPage() {
  const me = useAuth((s) => s.user);
  const allowed = !!me?.roles?.some((r) => ROLES_ALLOWED.includes(r));

  const [windowDays, setWindowDays] = useState(7);
  const [userFilter, setUserFilter] = useState("");
  const [missedOnly, setMissedOnly] = useState(false);

  const { data, isLoading } = useQuery<{ items: Row[]; from: string; days: number }>({
    enabled: allowed,
    queryKey: ["admin", "daily-checkins", windowDays],
    queryFn: () => api(`/api/v1/admin/daily-checkins?days=${windowDays}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const rows = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    return rows.filter((r) => {
      if (missedOnly && !r.missed) return false;
      if (!q) return true;
      return r.user_name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
    });
  }, [rows, userFilter, missedOnly]);

  // Per-user compliance summary across the window — how many days they
  // checked in vs. missed. HR's primary appraisal signal.
  const compliance = useMemo(() => {
    const m = new Map<string, { name: string; email: string; done: number; missed: number; tasksDone: number }>();
    rows.forEach((r) => {
      const cur = m.get(r.user_id) ?? { name: r.user_name, email: r.email, done: 0, missed: 0, tasksDone: 0 };
      if (r.missed) cur.missed++; else cur.done++;
      cur.tasksDone += r.tasks_done;
      m.set(r.user_id, cur);
    });
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v, total: v.done + v.missed }))
      .sort((a, b) => b.missed - a.missed || a.name.localeCompare(b.name));
  }, [rows]);

  if (!me) return null;
  if (!allowed) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1 flex items-center gap-2">
          <ShieldCheck size={22} className="text-accent" /> Daily check-ins
        </h1>
        <p className="text-sm text-muted mt-1">
          One row per person per day across the window. Use it to triage missed check-ins, scan mood
          trends, and read what each person said they shipped or are picking up.
        </p>
      </div>

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
            {filtered.length} row{filtered.length === 1 ? "" : "s"} · window starts {data?.from}
          </div>
        </div>
      </section>

      {/* Compliance roll-up — per person, sorted by most missed first */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="text-sm font-bold text-text">Compliance summary</div>
          <div className="text-[11px] text-muted">Sorted by most missed first</div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/40 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Member</th>
                <th className="text-left px-4 py-2 font-semibold">Checked in</th>
                <th className="text-left px-4 py-2 font-semibold">Missed</th>
                <th className="text-left px-4 py-2 font-semibold">Tasks shipped</th>
                <th className="text-left px-4 py-2 font-semibold">Compliance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {compliance.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted text-sm">No data yet</td></tr>
              ) : compliance.map((p) => {
                const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                const tone = pct >= 80 ? "text-success" : pct >= 50 ? "text-warn" : "text-danger";
                return (
                  <tr key={p.id} className="hover:bg-bg/40">
                    <td className="px-4 py-2">
                      <div className="font-semibold text-text">{p.name || "—"}</div>
                      <div className="text-[11px] text-muted">{p.email}</div>
                    </td>
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
                    <td className="px-4 py-2 text-sm">{p.tasksDone}</td>
                    <td className={`px-4 py-2 text-sm font-bold ${tone}`}>{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Day-by-day detail */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Calendar size={14} className="text-accent" />
          <div className="text-sm font-bold text-text">Day-by-day detail</div>
        </header>
        {isLoading ? (
          <div className="p-10 text-center text-muted text-sm">Loading check-ins…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-muted text-sm">No matching rows.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/40 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Day</th>
                  <th className="text-left px-4 py-2 font-semibold">Member</th>
                  <th className="text-left px-4 py-2 font-semibold">Mood</th>
                  <th className="text-left px-4 py-2 font-semibold">Yesterday</th>
                  <th className="text-left px-4 py-2 font-semibold">Today</th>
                  <th className="text-left px-4 py-2 font-semibold">Attachments</th>
                  <th className="text-left px-4 py-2 font-semibold">First seen</th>
                  <th className="text-left px-4 py-2 font-semibold">Shipped</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((r, idx) => (
                  <tr key={`${r.user_id}-${r.day}-${idx}`} className={`align-top hover:bg-bg/40 ${r.missed ? "bg-danger/5" : ""}`}>
                    <td className="px-4 py-2 whitespace-nowrap text-xs">
                      <div className="font-semibold text-text">{fmtDay(r.day)}</div>
                      <div className="text-[10.5px] text-muted/80">{r.day}</div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-semibold text-text">{r.user_name || "—"}</div>
                      <div className="text-[11px] text-muted">{r.email}</div>
                    </td>
                    <td className="px-4 py-2 text-base">
                      {r.missed ? (
                        <span className="text-[11px] text-danger font-semibold inline-flex items-center gap-1">
                          <AlertCircle size={11} /> Missed
                        </span>
                      ) : (r.mood || <span className="text-muted text-xs">—</span>)}
                    </td>
                    <td className="px-4 py-2 max-w-[260px]">
                      <div className="text-[12.5px] text-text whitespace-pre-wrap leading-snug">
                        {r.yesterday_note || <span className="text-muted">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2 max-w-[260px]">
                      <div className="text-[12.5px] text-text whitespace-pre-wrap leading-snug">
                        {r.focus_note || <span className="text-muted">—</span>}
                      </div>
                      {r.posted_to_campfire && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] text-accent mt-1">
                          <CheckCircle2 size={10} /> Shared to Campfire
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {(r.attachments?.length ?? 0) === 0 ? (
                        <span className="text-muted text-xs">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {r.attachments!.map((a, i) => (
                            <li key={i}>
                              <a
                                href={a.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline max-w-[200px] truncate"
                              >
                                <Link2 size={10} /> {a.name}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[11.5px] text-muted whitespace-nowrap">
                      {r.first_seen_at ? fmtTime(r.first_seen_at) : <span>—</span>}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {r.tasks_done > 0 ? (
                        <span className="inline-flex items-center gap-1 text-success font-semibold">
                          <Paperclip size={11} /> {r.tasks_done}
                        </span>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
