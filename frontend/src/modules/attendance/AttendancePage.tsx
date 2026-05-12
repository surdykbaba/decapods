// Attendance — HR-only insight surface.
//
// Three tabs:
//   • Today — who's in, who's late, who's stepped away, who's on leave.
//   • Trend — 14-day attendance sparkline + late-start count.
//   • Appraisal — auto-generated scorecards (attendance, delivery,
//     responsiveness, wellbeing) with a suggested next-step goal.
//
// Everything here is derived from data the platform already collects — there's
// no staff-facing punch clock. Heartbeats become sessions; sessions roll up
// into the numbers below.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import {
  ClipboardCheck, Activity, TrendingUp, AlertTriangle, CheckCircle2,
  Clock, Laptop, Smartphone, Tablet, Target, Sparkles, Award,
  LayoutGrid, List as ListIcon, ChevronRight, ChevronDown,
  CalendarDays,
} from "lucide-react";
import { CheckinsPanel } from "@/modules/admin/DailyCheckinsPage";

/* ─── types ─── */

type TodayRow = {
  id: string; name: string; email: string; avatar_url?: string;
  first_in: string | null; last_seen: string | null;
  minutes_online: number;
  platform: string; os: string; browser: string;
  on_leave: boolean;
  label: string;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
};

type TrendRow = {
  day: string;
  users_active: number;
  total_hours: number;
  late_count: number;
};

type Insights = {
  active_now: number;
  total_active: number;
  on_leave_today: number;
  late_today: number;
  avg_hours_30d: number;
  devices: Record<string, number>;
};

type Scores = { attendance: number; delivery: number; responsiveness: number; wellbeing: number; total: number };

type AppraisalRow = {
  id: string; name: string; email: string; avatar_url?: string;
  days_present: number;
  hours_30: number;
  tasks_done: number; tasks_open: number; tasks_overdue: number;
  updates_30: number; kudos_in: number;
  mood_avg: number | null;
  scores: Scores;
  suggested_goal: string;
  band: string;
};

/* ─── helpers ─── */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${m ? ` ${m}m` : ""}`;
}

function platformIcon(p: string) {
  if (p === "mobile") return <Smartphone size={12} />;
  if (p === "tablet") return <Tablet size={12} />;
  return <Laptop size={12} />;
}

const TONE_BG: Record<TodayRow["tone"], string> = {
  good:    "bg-success/15 text-success border-success/30",
  warn:    "bg-warn/15 text-warn border-warn/30",
  bad:     "bg-danger/15 text-danger border-danger/30",
  info:    "bg-accent-soft text-accent border-accent/30",
  neutral: "bg-bg text-muted border-border",
};

/* ─── page ─── */

type Tab = "today" | "trend" | "checkins" | "warnings" | "appraisal";

type Warning = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  avatar_url?: string;
  kind: string;
  gap_minutes: number;
  started_at: string;
  ended_at: string | null;
  notified_at: string | null;
  acknowledged_at: string | null;
  created_at: string;
};

export function AttendancePage() {
  const [tab, setTab] = useState<Tab>("today");

  // Pull open warnings up here so we can badge the tab + show a banner on Today.
  const { data: warnData } = useQuery<{ items: Warning[] }>({
    queryKey: ["attendance", "warnings", "open"],
    queryFn: () => api("/api/v1/attendance/warnings?status=open"),
    refetchInterval: 60_000,
  });
  const openWarnings = warnData?.items ?? [];

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; badge?: number }[] = [
    { key: "today",     label: "Today",      icon: Activity },
    { key: "trend",     label: "Trend",      icon: TrendingUp },
    { key: "checkins",  label: "Check-ins",  icon: CalendarDays },
    { key: "warnings",  label: "Warnings",   icon: AlertTriangle, badge: openWarnings.length || undefined },
    { key: "appraisal", label: "Appraisals", icon: Award },
  ];

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">People ops</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <ClipboardCheck size={26} className="text-accent" /> Attendance & check-ins
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            One HR view — automatic attendance from heartbeats + declared
            morning check-ins side by side. Today, Trend and Warnings are
            derived from presence; Check-ins is what each member said about
            their day; Appraisals fold both signals into a scorecard.
          </p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              tab === t.key ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
          >
            <t.icon size={14} /> {t.label}
            {t.badge ? (
              <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold grid place-items-center ${
                tab === t.key ? "bg-white text-accent" : "bg-danger text-white"
              }`}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* Open-warnings banner on the Today tab — drives HR straight to action. */}
      {tab === "today" && openWarnings.length > 0 && (
        <div className="bg-danger/10 border border-danger/30 rounded-2xl px-4 py-3 flex items-center gap-3">
          <AlertTriangle size={18} className="text-danger shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-danger">
              {openWarnings.length} unacknowledged attendance warning{openWarnings.length === 1 ? "" : "s"}
            </div>
            <div className="text-[12px] text-muted">
              Members were away beyond 30 min during work hours without leave coverage.
            </div>
          </div>
          <button
            onClick={() => setTab("warnings")}
            className="text-[12.5px] font-semibold text-danger hover:underline shrink-0"
          >
            Review →
          </button>
        </div>
      )}

      {tab === "today"     && <TodayTab />}
      {tab === "trend"     && <TrendTab />}
      {tab === "checkins"  && <CheckinsPanel embedded />}
      {tab === "warnings"  && <WarningsTab />}
      {tab === "appraisal" && <AppraisalTab />}
    </div>
  );
}

/* ─── warnings tab ─── */

function WarningsTab() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"open" | "all">("open");
  const { data, isLoading } = useQuery<{ items: Warning[] }>({
    queryKey: ["attendance", "warnings", scope],
    queryFn: () => api(`/api/v1/attendance/warnings?status=${scope}`),
  });
  const items = data?.items ?? [];

  const ack = useMutation({
    mutationFn: (id: string) => api(`/api/v1/attendance/warnings/${id}/ack`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance", "warnings"] }),
  });

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["open", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`px-3 py-1 text-[12px] font-semibold rounded-full ${
              scope === s ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {s === "open" ? "Open" : "All (30d)"}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <CheckCircle2 size={28} className="text-success mx-auto mb-2" />
          <div className="text-sm font-semibold text-text">All clear</div>
          <div className="text-xs text-muted mt-1">
            No {scope === "open" ? "unacknowledged" : "recent"} attendance warnings.
          </div>
        </div>
      ) : (
        <ul className="bg-surface border border-border rounded-2xl divide-y divide-border overflow-hidden">
          {items.map((w) => {
            const since = new Date(w.created_at);
            const sinceMin = Math.max(1, Math.round((Date.now() - since.getTime()) / 60_000));
            const ago = sinceMin < 60 ? `${sinceMin}m` : sinceMin < 1440 ? `${Math.round(sinceMin / 60)}h` : `${Math.round(sinceMin / 1440)}d`;
            return (
              <li key={w.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <Avatar name={w.name} email={w.email} src={w.avatar_url} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text truncate">{w.name || w.email}</div>
                  <div className="text-[11.5px] text-muted">
                    Away <span className="font-bold text-danger">{w.gap_minutes} min</span>
                    {" "}during work hours · started {new Date(w.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" · "}{ago} ago
                  </div>
                </div>
                {w.acknowledged_at ? (
                  <span className="pill bg-success/10 text-success text-[11px]">Acknowledged</span>
                ) : (
                  <button
                    onClick={() => ack.mutate(w.id)}
                    disabled={ack.isPending}
                    className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-40"
                  >
                    Acknowledge
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── insights tiles ─── */

function InsightTiles() {
  const { data } = useQuery<Insights>({
    queryKey: ["attendance", "insights"],
    queryFn: () => api("/api/v1/attendance/insights"),
    refetchInterval: 60_000,
  });
  if (!data) return null;

  const onTimeRate = data.total_active > 0
    ? Math.round(((data.total_active - data.late_today - data.on_leave_today) / Math.max(1, data.total_active - data.on_leave_today)) * 100)
    : 100;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile
        label="Active right now"
        value={`${data.active_now} / ${data.total_active}`}
        hint="Heartbeat in last 5 minutes"
        icon={<Activity size={14} />}
        tone="good"
      />
      <Tile
        label="On-time today"
        value={`${onTimeRate}%`}
        hint={`${data.late_today} late start${data.late_today === 1 ? "" : "s"}`}
        icon={<Clock size={14} />}
        tone={onTimeRate >= 80 ? "good" : onTimeRate >= 60 ? "warn" : "bad"}
      />
      <Tile
        label="On leave today"
        value={`${data.on_leave_today}`}
        hint="Approved leave overlapping today"
        icon={<Sparkles size={14} />}
        tone="info"
      />
      <Tile
        label="Avg hours (30d)"
        value={`${data.avg_hours_30d.toFixed(1)}h`}
        hint="Daily active duration per person"
        icon={<TrendingUp size={14} />}
        tone="neutral"
      />
    </div>
  );
}

function Tile({ label, value, hint, icon, tone }: {
  label: string; value: string; hint: string; icon: React.ReactNode;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
}) {
  const tones = {
    good: "text-success",
    warn: "text-warn",
    bad:  "text-danger",
    info: "text-accent",
    neutral: "text-text",
  } as const;
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="text-[11px] uppercase tracking-wide font-bold text-muted flex items-center gap-1.5">
        {icon} {label}
      </div>
      <div className={`text-2xl font-extrabold mt-1 ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{hint}</div>
    </div>
  );
}

/* ─── today tab ─── */

function TodayTab() {
  const { data, isLoading } = useQuery<{ items: TodayRow[] }>({
    queryKey: ["attendance", "today"],
    queryFn: () => api("/api/v1/attendance/today"),
    refetchInterval: 60_000,
  });
  const items = data?.items ?? [];

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading…</div>;
  if (items.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-10 text-center">
        <div className="text-sm font-semibold text-text">No active members yet</div>
        <div className="text-xs text-muted mt-1">
          Activity appears as soon as someone signs in to the platform.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              <th className="text-left px-4 py-3">Member</th>
              <th className="text-left px-4 py-3">First in</th>
              <th className="text-left px-4 py-3">Last seen</th>
              <th className="text-left px-4 py-3">Online</th>
              <th className="text-left px-4 py-3">Device</th>
              <th className="text-left px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={r.name} email={r.email} src={r.avatar_url} size={32} />
                    <div className="min-w-0">
                      <div className="font-semibold text-text truncate">{r.name || r.email}</div>
                      <div className="text-[11px] text-muted truncate">{r.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted whitespace-nowrap">{fmtTime(r.first_in)}</td>
                <td className="px-4 py-3 text-muted whitespace-nowrap">{fmtTime(r.last_seen)}</td>
                <td className="px-4 py-3 font-semibold text-text whitespace-nowrap">{fmtDuration(r.minutes_online)}</td>
                <td className="px-4 py-3 text-muted">
                  <span className="inline-flex items-center gap-1.5 text-[11px]">
                    {platformIcon(r.platform)} {r.os || "—"} {r.browser ? `· ${r.browser}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${TONE_BG[r.tone]}`}>
                    {r.label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <ul className="md:hidden divide-y divide-border">
        {items.map((r) => (
          <li key={r.id} className="px-4 py-3 flex items-center gap-3">
            <Avatar name={r.name} email={r.email} src={r.avatar_url} size={36} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-text truncate">{r.name || r.email}</div>
              <div className="text-[11px] text-muted flex items-center gap-2 flex-wrap">
                <span>{fmtTime(r.first_in)} → {fmtTime(r.last_seen)}</span>
                <span>·</span>
                <span>{fmtDuration(r.minutes_online)}</span>
              </div>
            </div>
            <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10.5px] font-semibold border ${TONE_BG[r.tone]}`}>
              {r.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── trend tab ─── */

function TrendTab() {
  const { data } = useQuery<{ items: TrendRow[] }>({
    queryKey: ["attendance", "trend"],
    queryFn: () => api("/api/v1/attendance/trend?days=14"),
  });
  const items = data?.items ?? [];

  const maxUsers = useMemo(() => Math.max(1, ...items.map((r) => r.users_active)), [items]);
  const maxHours = useMemo(() => Math.max(1, ...items.map((r) => r.total_hours)), [items]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="bg-surface border border-border rounded-2xl p-5">
        <h3 className="text-sm font-bold mb-3">Daily active members · 14 days</h3>
        {items.length === 0 ? (
          <div className="text-sm text-muted">Not enough data yet.</div>
        ) : (
          <div className="flex items-end gap-1.5 h-32 overflow-x-auto">
            {items.map((r) => (
              <div key={r.day} className="flex flex-col items-center gap-1 min-w-[28px]">
                <div className="w-5 bg-bg rounded h-24 flex flex-col justify-end overflow-hidden">
                  <div
                    className="w-full bg-accent rounded"
                    style={{ height: `${(r.users_active / maxUsers) * 100}%` }}
                    title={`${r.users_active} active`}
                  />
                </div>
                <span className="text-[9px] text-muted">{r.day.slice(5, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-2xl p-5">
        <h3 className="text-sm font-bold mb-3">Workspace hours online · 14 days</h3>
        {items.length === 0 ? (
          <div className="text-sm text-muted">Not enough data yet.</div>
        ) : (
          <div className="flex items-end gap-1.5 h-32 overflow-x-auto">
            {items.map((r) => (
              <div key={r.day} className="flex flex-col items-center gap-1 min-w-[28px]">
                <div className="w-5 bg-bg rounded h-24 flex flex-col justify-end overflow-hidden">
                  <div
                    className="w-full bg-warn rounded"
                    style={{ height: `${(r.total_hours / maxHours) * 100}%` }}
                    title={`${r.total_hours.toFixed(1)}h`}
                  />
                </div>
                <span className="text-[9px] text-muted">{r.day.slice(5, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-2xl p-5 lg:col-span-2">
        <h3 className="text-sm font-bold mb-3">Late starts · 14 days</h3>
        {items.length === 0 ? (
          <div className="text-sm text-muted">Not enough data yet.</div>
        ) : (
          <div className="grid grid-cols-7 sm:grid-cols-14 gap-1.5">
            {items.map((r) => {
              const intensity = Math.min(1, r.late_count / 5);
              return (
                <div
                  key={r.day}
                  className="aspect-square rounded-md grid place-items-center text-[10px] font-bold"
                  style={{
                    backgroundColor: r.late_count === 0
                      ? "rgba(34,197,94,0.12)"
                      : `rgba(239,68,68,${0.15 + intensity * 0.55})`,
                    color: r.late_count === 0 ? "rgb(22,163,74)" : "rgb(127,29,29)",
                  }}
                  title={`${r.day.slice(0, 10)} · ${r.late_count} late`}
                >
                  {r.late_count}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── appraisal tab ─── */

const BAND_TONE: Record<string, string> = {
  "Exceeding":     "bg-success/15 text-success border-success/30",
  "Strong":        "bg-success/10 text-success border-success/20",
  "On track":      "bg-accent-soft text-accent border-accent/30",
  "Needs support": "bg-warn/10 text-warn border-warn/30",
  "At risk":       "bg-danger/10 text-danger border-danger/30",
};

type AppraisalView = "list" | "grid";
const APPRAISAL_VIEW_KEY = "attendance-appraisal-view";

function AppraisalTab() {
  const { data, isLoading } = useQuery<{ items: AppraisalRow[] }>({
    queryKey: ["attendance", "appraisal"],
    queryFn: () => api("/api/v1/attendance/appraisal"),
  });
  const items = data?.items ?? [];
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.scores.total - a.scores.total),
    [items],
  );

  // List is the default — it scans faster when the team grows past a handful
  // of people. Preference is persisted so the HR lead doesn't keep flipping.
  const [view, setView] = useState<AppraisalView>(
    () => (localStorage.getItem(APPRAISAL_VIEW_KEY) as AppraisalView) || "list",
  );
  function pickView(v: AppraisalView) {
    setView(v);
    localStorage.setItem(APPRAISAL_VIEW_KEY, v);
  }

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading scorecards…</div>;
  if (sorted.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-10 text-center">
        <div className="text-sm font-semibold text-text">No data yet</div>
        <div className="text-xs text-muted mt-1">
          Scorecards appear once members are active and have a few tasks under their name.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-1 p-1 bg-surface border border-border rounded-full">
          <button
            onClick={() => pickView("list")}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
              view === "list" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
            title="List view"
          >
            <ListIcon size={12} /> List
          </button>
          <button
            onClick={() => pickView("grid")}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
              view === "grid" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
            title="Grid view"
          >
            <LayoutGrid size={12} /> Grid
          </button>
        </div>
      </div>

      {view === "list" ? (
        <AppraisalList rows={sorted} />
      ) : (
        <AppraisalGrid rows={sorted} />
      )}
    </div>
  );
}

function AppraisalGrid({ rows }: { rows: AppraisalRow[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {rows.map((r) => (
        <article key={r.id} className="bg-surface border border-border rounded-2xl p-5">
          <header className="flex items-start gap-3">
            <Avatar name={r.name} email={r.email} src={r.avatar_url} size={44} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-text truncate">{r.name || r.email}</div>
              <div className="text-[11px] text-muted truncate">{r.email}</div>
            </div>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${BAND_TONE[r.band] ?? "bg-bg text-muted border-border"}`}>
              {r.band}
            </span>
          </header>

          <div className="mt-4 flex items-baseline gap-1.5">
            <span className="text-3xl font-extrabold text-text">{r.scores.total.toFixed(0)}</span>
            <span className="text-xs text-muted">/ 100</span>
          </div>

          {/* Four sub-score bars */}
          <div className="mt-3 space-y-2">
            <ScoreBar label="Attendance"     value={r.scores.attendance}     max={25} tone="text-success" />
            <ScoreBar label="Delivery"       value={r.scores.delivery}       max={25} tone="text-accent" />
            <ScoreBar label="Responsiveness" value={r.scores.responsiveness} max={25} tone="text-warn" />
            <ScoreBar label="Wellbeing"      value={r.scores.wellbeing}      max={25} tone="text-danger" />
          </div>

          {/* Raw signal recap */}
          <dl className="mt-4 grid grid-cols-3 gap-3 text-[11px]">
            <Stat label="Days present" value={r.days_present} />
            <Stat label="Hours (30d)" value={r.hours_30.toFixed(1)} />
            <Stat label="Tasks done"  value={r.tasks_done} />
            <Stat label="Overdue"     value={r.tasks_overdue} bad={r.tasks_overdue > 0} />
            <Stat label="Updates"     value={r.updates_30} />
            <Stat label="Kudos"       value={r.kudos_in} good={r.kudos_in > 0} />
          </dl>

          {/* Suggested goal */}
          <div className="mt-4 flex items-start gap-2 bg-accent-soft/40 border border-accent/20 rounded-xl px-3 py-2.5">
            <Target size={14} className="text-accent mt-0.5 shrink-0" />
            <div>
              <div className="text-[10.5px] uppercase tracking-wide font-bold text-accent">Suggested goal</div>
              <div className="text-[12.5px] text-text leading-snug">{r.suggested_goal}</div>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ---------- List view ---------- */

// Compact one-row-per-member layout: avatar + identity, total score, the four
// sub-scores as a tight inline bar each, signal counts and band pill. Clicking
// a row reveals the suggested goal + raw signals.
function AppraisalList({ rows }: { rows: AppraisalRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="hidden md:grid grid-cols-[1fr_60px_minmax(280px,1.4fr)_180px_120px_28px] gap-4 px-4 py-2.5 bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
        <div>Member</div>
        <div className="text-right">Score</div>
        <div>Attendance · Delivery · Resp · Wellbeing</div>
        <div>Signals (30d)</div>
        <div className="text-right">Band</div>
        <div></div>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const open = openId === r.id;
          return (
            <li key={r.id}>
              <button
                onClick={() => setOpenId(open ? null : r.id)}
                className="w-full text-left grid grid-cols-[1fr_60px_minmax(280px,1.4fr)_180px_120px_28px] gap-4 items-center px-4 py-3 hover:bg-bg/30 transition-colors md:grid-cols-[1fr_60px_minmax(280px,1.4fr)_180px_120px_28px]"
              >
                {/* Member */}
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={r.name} email={r.email} src={r.avatar_url} size={32} />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-text truncate">{r.name || r.email}</div>
                    <div className="text-[11px] text-muted truncate">{r.email}</div>
                  </div>
                </div>

                {/* Score */}
                <div className="text-right">
                  <div className="text-lg font-extrabold text-text leading-none">{r.scores.total.toFixed(0)}</div>
                  <div className="text-[10px] text-muted">/ 100</div>
                </div>

                {/* Inline sub-score bars */}
                <div className="grid grid-cols-4 gap-1.5 min-w-0">
                  <MiniBar value={r.scores.attendance}     max={25} tone="bg-success" label="A" />
                  <MiniBar value={r.scores.delivery}       max={25} tone="bg-accent"  label="D" />
                  <MiniBar value={r.scores.responsiveness} max={25} tone="bg-warn"    label="R" />
                  <MiniBar value={r.scores.wellbeing}      max={25} tone="bg-danger"  label="W" />
                </div>

                {/* Signal counts */}
                <div className="hidden md:flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted">
                  <span title="Days present"><span className="font-semibold text-text">{r.days_present}</span>d</span>
                  <span title="Hours last 30 days"><span className="font-semibold text-text">{r.hours_30.toFixed(1)}</span>h</span>
                  <span title="Tasks done"><span className="font-semibold text-text">{r.tasks_done}</span>✓</span>
                  {r.tasks_overdue > 0 && (
                    <span className="text-danger" title="Overdue">
                      <span className="font-semibold">{r.tasks_overdue}</span>!
                    </span>
                  )}
                  {r.kudos_in > 0 && (
                    <span className="text-success" title="Kudos">
                      <span className="font-semibold">{r.kudos_in}</span>★
                    </span>
                  )}
                </div>

                {/* Band */}
                <div className="text-right">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap ${BAND_TONE[r.band] ?? "bg-bg text-muted border-border"}`}>
                    {r.band}
                  </span>
                </div>

                {/* Expand chevron */}
                <div className="text-muted text-right">
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </button>

              {open && (
                <div className="px-4 pb-4 pt-1 bg-bg/20 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2">Sub-scores</div>
                    <div className="space-y-2">
                      <ScoreBar label="Attendance"     value={r.scores.attendance}     max={25} tone="text-success" />
                      <ScoreBar label="Delivery"       value={r.scores.delivery}       max={25} tone="text-accent" />
                      <ScoreBar label="Responsiveness" value={r.scores.responsiveness} max={25} tone="text-warn" />
                      <ScoreBar label="Wellbeing"      value={r.scores.wellbeing}      max={25} tone="text-danger" />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2">Raw signals</div>
                      <dl className="grid grid-cols-3 gap-2 text-[11px]">
                        <Stat label="Days present" value={r.days_present} />
                        <Stat label="Hours (30d)"  value={r.hours_30.toFixed(1)} />
                        <Stat label="Tasks done"   value={r.tasks_done} />
                        <Stat label="Overdue"      value={r.tasks_overdue} bad={r.tasks_overdue > 0} />
                        <Stat label="Updates"      value={r.updates_30} />
                        <Stat label="Kudos"        value={r.kudos_in} good={r.kudos_in > 0} />
                      </dl>
                    </div>
                    <div className="flex items-start gap-2 bg-accent-soft/40 border border-accent/20 rounded-xl px-3 py-2.5">
                      <Target size={14} className="text-accent mt-0.5 shrink-0" />
                      <div>
                        <div className="text-[10.5px] uppercase tracking-wide font-bold text-accent">Suggested goal</div>
                        <div className="text-[12.5px] text-text leading-snug">{r.suggested_goal}</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MiniBar({ value, max, tone, label }: { value: number; max: number; tone: string; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div title={`${label}: ${value.toFixed(1)} / ${max}`}>
      <div className="flex items-center justify-between text-[9.5px] text-muted">
        <span>{label}</span>
        <span className="font-semibold">{value.toFixed(0)}</span>
      </div>
      <div className="h-1 bg-bg rounded-full overflow-hidden mt-0.5">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ScoreBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className={`font-semibold ${tone}`}>{value.toFixed(1)} / {max}</span>
      </div>
      <div className="mt-0.5 h-1.5 bg-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${tone.replace("text-", "bg-")}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, good, bad }: { label: string; value: string | number; good?: boolean; bad?: boolean }) {
  const tone = bad ? "text-danger" : good ? "text-success" : "text-text";
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={`text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}


void InsightTiles;
