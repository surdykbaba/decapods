// OKRsPage — Phase 1 of the OKR loop.
//
// One page, two tabs:
//   • Mine     — current-cycle objectives + KRs the caller owns. Inline
//                edit, add objective / add KR, slide confidence + bump
//                progress.
//   • Workspace — every objective in the active cycle. Read-only browse
//                 for transparency; clicking opens the same edit drawer
//                 (admin or owner can save).
//
// The data shape mirrors backend okrs.go: objectives + key_results
// share the okrs table; KRs hang off their parent_id. The SPA groups
// them locally so the API doesn't have to.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Target, Plus, Pencil, Trash2, ChevronDown, ChevronRight,
  TrendingUp, Sparkles, Flag, X, Save,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import { SmartButton } from "@/components/SmartButton";

type Cycle = {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: "planning" | "active" | "closed";
};

type OKR = {
  id: string;
  cycle_id: string;
  parent_id: string | null;
  parent_title?: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  kind: "objective" | "key_result";
  title: string;
  description: string;
  // target_value may arrive as null OR be absent from the JSON entirely
  // (the Go encoder uses omitempty on nil *float pointers). Accept both
  // — every render path uses `!= null` so the loose-equality catches
  // undefined alongside null.
  target_value: number | null | undefined;
  current_value: number;
  unit: string;
  confidence: "green" | "amber" | "red";
  status: "draft" | "in_progress" | "done" | "dropped";
  position: number;
  progress_pct: number;
  // Phase 2 — check-in summary.
  checkin_count: number;
  latest_checkin_at?: string | null;
};

type OKRCheckin = {
  id: string;
  okr_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  current_value: number | null;
  percent: number;
  confidence: "green" | "amber" | "red";
  status?: "draft" | "in_progress" | "done" | "dropped" | null;
  comment: string;
  created_at: string;
};

const CONFIDENCE_META: Record<OKR["confidence"], { label: string; cls: string }> = {
  green: { label: "On track", cls: "bg-success/15 text-success border-success/30" },
  amber: { label: "At risk",  cls: "bg-warn/15 text-warn border-warn/30" },
  red:   { label: "Off track", cls: "bg-danger/15 text-danger border-danger/30" },
};

const STATUS_META: Record<OKR["status"], { label: string; cls: string }> = {
  draft:       { label: "Draft",       cls: "bg-bg text-muted border-border" },
  in_progress: { label: "In progress", cls: "bg-accent-soft text-accent border-accent/30" },
  done:        { label: "Done",        cls: "bg-success/15 text-success border-success/30" },
  dropped:     { label: "Dropped",     cls: "bg-bg text-muted border-border" },
};

// Mechanical pace — compares an OKR's progress against how far the cycle has
// elapsed. Complements (not replaces) the owner-reported confidence pill:
// confidence is "how I feel"; pace is "where the math says you are."
type Pace = "complete" | "ahead" | "on_track" | "behind" | "at_risk" | "not_started";
const PACE_META: Record<Pace, { label: string; cls: string }> = {
  complete:    { label: "Complete",    cls: "bg-success/15 text-success border-success/30" },
  ahead:       { label: "Ahead",       cls: "bg-success/10 text-success border-success/25" },
  on_track:    { label: "On track",    cls: "bg-accent-soft text-accent border-accent/30" },
  behind:      { label: "Behind",      cls: "bg-warn/15 text-warn border-warn/30" },
  at_risk:     { label: "At risk",     cls: "bg-danger/15 text-danger border-danger/30" },
  not_started: { label: "Not started", cls: "bg-bg text-muted border-border" },
};
function paceFor(progressPct: number, elapsedPct: number, status: OKR["status"]): Pace {
  if (status === "done" || progressPct >= 100) return "complete";
  if (elapsedPct <= 0) return "not_started";
  const delta = progressPct - elapsedPct;
  if (delta >= 10)  return "ahead";
  if (delta >= -10) return "on_track";
  if (delta >= -25) return "behind";
  return "at_risk";
}

// cycleProgress — how much of the cycle's calendar window has elapsed and
// how many days are left. Days remaining is signed so the band can read
// "ended 2d ago" once a closed cycle is selected.
function cycleProgress(cycle: Cycle | undefined): { elapsedPct: number; daysRemaining: number; daysTotal: number } {
  if (!cycle) return { elapsedPct: 0, daysRemaining: 0, daysTotal: 0 };
  const start = new Date(cycle.starts_on + "T00:00:00").getTime();
  const end   = new Date(cycle.ends_on   + "T23:59:59").getTime();
  const now   = Date.now();
  const total = Math.max(1, end - start);
  const elapsedPct = Math.max(0, Math.min(100, Math.round(((now - start) / total) * 100)));
  const daysRemaining = Math.ceil((end - now) / 86_400_000);
  const daysTotal     = Math.ceil(total / 86_400_000);
  return { elapsedPct, daysRemaining, daysTotal };
}

export function OKRsPage() {
  const { user } = useAuth();
  // Admin = anyone who has the governance:write surface (CEO / COO / HR / super_admin).
  // Drives the empty-state CTA: admins get a "Create cycle" button right
  // here, non-admins get a clearer "ask leadership" nudge that lists the
  // actual admins to ping.
  const isAdmin = !!user?.roles?.some((r) => r === "super_admin" || r === "ceo" || r === "coo" || r === "hr" || r === "hr_manager");
  const [tab, setTab] = useState<"mine" | "workspace">("mine");
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OKR | null>(null);
  const [creating, setCreating] = useState<{ cycleId: string; kind: OKR["kind"]; parentId?: string; seed?: string } | null>(null);
  // Phase 2 — check-in dialog target + history-popover target.
  const [checkingIn, setCheckingIn] = useState<OKR | null>(null);
  const [historyFor, setHistoryFor] = useState<OKR | null>(null);
  // Inline cycle creation. Admins land on a tasty empty state with a
  // single button that opens this dialog pre-filled with the current
  // quarter — no "ask an admin" handwave, no Settings detour.
  const [creatingCycle, setCreatingCycle] = useState(false);

  const { data: cyclesData } = useQuery<{ items: Cycle[] }>({
    queryKey: ["okrs", "cycles"],
    queryFn: () => api("/api/v1/okrs/cycles"),
    staleTime: 5 * 60_000,
  });
  const cycles = cyclesData?.items ?? [];
  // Pick the active cycle by default (status='active'), falling back to
  // the newest planning cycle, then the most recent overall.
  const defaultCycle = cycles.find((c) => c.status === "active")
    ?? cycles.find((c) => c.status === "planning")
    ?? cycles[0];
  const cycleId = activeCycleId ?? defaultCycle?.id ?? null;
  const cycle = cycles.find((c) => c.id === cycleId);

  const { data: okrsData, isLoading } = useQuery<{ items: OKR[] }>({
    queryKey: ["okrs", "list", cycleId, tab],
    queryFn: () => {
      const p = new URLSearchParams();
      if (cycleId) p.set("cycle_id", cycleId);
      if (tab === "mine" && user?.id) p.set("owner_id", user.id);
      return api(`/api/v1/okrs?${p.toString()}`);
    },
    enabled: !!cycleId,
    staleTime: 30_000,
  });

  // Group: objectives at the top, KRs nested under their parent.
  const grouped = useMemo(() => {
    const items = okrsData?.items ?? [];
    const objs = items.filter((o) => o.kind === "objective").sort((a, b) => a.position - b.position);
    const krsByParent = new Map<string, OKR[]>();
    items.filter((o) => o.kind === "key_result").forEach((kr) => {
      if (!kr.parent_id) return;
      const list = krsByParent.get(kr.parent_id) ?? [];
      list.push(kr);
      krsByParent.set(kr.parent_id, list);
    });
    krsByParent.forEach((list) => list.sort((a, b) => a.position - b.position));
    return { objs, krsByParent };
  }, [okrsData]);

  return (
    <div className="space-y-5 max-w-5xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Performance</div>
          <h1 className="h1 mt-1 flex items-center gap-2"><Target size={22} className="text-accent" /> OKRs</h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Quarterly objectives + the measurable key results that prove them. Set targets, bump
            progress as you ship, and watch the confidence band shift from green to red before
            the cycle ends.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {cycles.length > 0 && (
            <select
              value={cycleId ?? ""}
              onChange={(e) => setActiveCycleId(e.target.value)}
              className="bg-surface border border-border rounded-full px-3 py-1.5 text-[12.5px] font-semibold"
            >
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.status === "active" ? "• active" : c.status === "planning" ? "• planning" : ""}
                </option>
              ))}
            </select>
          )}
          {cycle && (
            <button
              type="button"
              onClick={() => setCreating({ cycleId: cycle.id, kind: "objective" })}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
            >
              <Plus size={14} /> Add objective
            </button>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["mine", "workspace"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-[12.5px] font-semibold rounded-full transition-colors ${
              tab === t ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {t === "mine" ? "Mine" : "Workspace"}
          </button>
        ))}
      </div>

      {/* Cycle empty-state — actually actionable. Admins get a one-click
          "Create your first cycle" button pre-filled with the current
          quarter; non-admins get a clearer "ping leadership" message
          that surfaces the people they can actually ask. Worked example
          underneath so first-time users see what an OKR is, not just
          that the page is blank. */}
      {cycles.length === 0 && (
        <OKRsEmptyState
          isAdmin={isAdmin}
          onCreateCycle={() => setCreatingCycle(true)}
        />
      )}

      {creatingCycle && (
        <CycleDialog onClose={() => setCreatingCycle(false)} />
      )}

      {/* Body */}
      {cycle && (
        <>
          {isLoading ? (
            <div className="text-muted">Loading…</div>
          ) : grouped.objs.length === 0 ? (
            <ObjectivesEmptyState
              cycle={cycle}
              tab={tab}
              onCreate={(seed) => setCreating({ cycleId: cycle.id, kind: "objective", seed })}
              onSwitchToMine={() => setTab("mine")}
            />
          ) : (
            <div className="space-y-4">
              <SummaryBand cycle={cycle} objs={grouped.objs} krsByParent={grouped.krsByParent} />
              <ul className="space-y-3">
                {grouped.objs.map((obj) => (
                  <ObjectiveCard
                    key={obj.id}
                    objective={obj}
                    keyResults={grouped.krsByParent.get(obj.id) ?? []}
                    canEdit={tab === "mine" || obj.owner_id === user?.id}
                    elapsedPct={cycleProgress(cycle).elapsedPct}
                    onEdit={(o) => setEditing(o)}
                    onAddKR={() => setCreating({ cycleId: cycle.id, kind: "key_result", parentId: obj.id })}
                    onCheckin={(o) => setCheckingIn(o)}
                    onHistory={(o) => setHistoryFor(o)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {editing && (
        <EditOKRDialog
          okr={editing}
          cycleObjectives={grouped.objs}
          onClose={() => setEditing(null)}
        />
      )}
      {creating && (
        <CreateOKRDialog
          cycleId={creating.cycleId}
          kind={creating.kind}
          parentId={creating.parentId}
          seedTitle={creating.seed}
          onClose={() => setCreating(null)}
        />
      )}
      {checkingIn && (
        <CheckinDialog
          okr={checkingIn}
          onClose={() => setCheckingIn(null)}
        />
      )}
      {historyFor && (
        <HistoryDialog
          okr={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}

// ObjectiveCard — one objective + its KRs. Inline progress bar driven
// by the avg of the KR progress percentages (objectives don't carry
// their own quantitative target in v1).
// OKRsEmptyState — the "no cycles yet" surface. Designed to actually
// teach the concept (a 3-row mini example showing how Objective + Key
// Results compose) and put the next action one click away.
// SummaryBand — top-of-page rollup. The two donuts deliver the page's most
// useful insight at a glance: contrast Overall achievement against Time
// elapsed. If the time donut races ahead of the achievement donut, the
// team is behind regardless of what the confidence pills claim.
//
// Achievement averages progress_pct across every key result in scope; if
// there are no KRs we fall back to objectives. KR counts use the
// status field (done counts as completed; dropped is excluded; everything
// else is "open").
function SummaryBand({ cycle, objs, krsByParent }: { cycle: Cycle; objs: OKR[]; krsByParent: Map<string, OKR[]> }) {
  const krs: OKR[] = [];
  objs.forEach((o) => { (krsByParent.get(o.id) ?? []).forEach((k) => krs.push(k)); });
  const denom = krs.length > 0 ? krs : objs;
  const avg = denom.length > 0
    ? Math.round(denom.reduce((s, x) => s + (x.progress_pct ?? 0), 0) / denom.length)
    : 0;
  const completedKRs = krs.filter((k) => k.status === "done").length;
  const openKRs      = krs.filter((k) => k.status === "draft" || k.status === "in_progress").length;
  const { elapsedPct, daysRemaining } = cycleProgress(cycle);
  // Pace headline — the punchline of the band. Tells the user what the two
  // donuts together mean ("on pace", "behind by 14 points", "ended").
  const delta = avg - elapsedPct;
  const ended = daysRemaining < 0;
  const pace: { tone: "good" | "warn" | "danger" | "muted"; line: string } =
    ended                            ? { tone: "muted",  line: `Cycle ended ${Math.abs(daysRemaining)}d ago` } :
    krs.length + objs.length === 0   ? { tone: "muted",  line: "Nothing tracked yet — add your first objective." } :
    elapsedPct === 0                 ? { tone: "muted",  line: `Cycle begins in ${Math.abs(daysRemaining)}d` } :
    delta >= 10                      ? { tone: "good",   line: `Ahead by ${delta} pts with ${daysRemaining}d left` } :
    delta >= -10                     ? { tone: "good",   line: `On pace with ${daysRemaining}d left` } :
    delta >= -25                     ? { tone: "warn",   line: `Behind by ${Math.abs(delta)} pts with ${daysRemaining}d left` } :
                                       { tone: "danger", line: `At risk — ${Math.abs(delta)} pts off pace with ${daysRemaining}d left` };
  const paceCls = {
    good:   "bg-success/10 text-success border-success/25",
    warn:   "bg-warn/15 text-warn border-warn/30",
    danger: "bg-danger/15 text-danger border-danger/30",
    muted:  "bg-bg text-muted border-border",
  }[pace.tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
        <DonutStat
          label="Overall achievement"
          value={avg}
          sub={krs.length > 0 ? "Average of your key results" : "Average across objectives"}
          tone={avg >= elapsedPct ? "accent" : avg >= elapsedPct - 15 ? "warn" : "danger"}
        />
        <DonutStat
          label="Time elapsed"
          value={elapsedPct}
          sub={ended
            ? `Ended ${cycle.ends_on}`
            : daysRemaining > 0 ? `${daysRemaining}d remaining` : "Ending today"}
          tone="accent"
        />
        <div className="space-y-2.5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <CountStat value={krs.length}    label="Total KRs" />
            <CountStat value={openKRs}       label="Open" />
            <CountStat value={completedKRs}  label="Completed" tone="good" />
          </div>
          <div className="text-[11px] text-muted flex items-center justify-between gap-2">
            <span><span className="text-success font-semibold">Start</span> {cycle.starts_on}</span>
            <span><span className="text-accent font-semibold">End</span> {cycle.ends_on}</span>
          </div>
        </div>
      </div>
      <div className={`mt-4 text-[12px] font-semibold rounded-xl px-3 py-2 inline-flex items-center gap-2 border ${paceCls}`}>
        <TrendingUp size={12} /> {pace.line}
      </div>
    </div>
  );
}

function DonutStat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone: "accent" | "warn" | "danger" }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const dash = (pct / 100) * c;
  const stroke = tone === "danger" ? "var(--danger, #dc2626)" : tone === "warn" ? "var(--warn, #d97706)" : "var(--accent, #2563eb)";
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-[68px] h-[68px] shrink-0">
        <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
          <circle cx="32" cy="32" r={r} stroke="currentColor" strokeWidth="6" fill="none" className="text-border" />
          <circle cx="32" cy="32" r={r} stroke={stroke} strokeWidth="6" strokeLinecap="round" fill="none"
                  strokeDasharray={`${dash} ${c - dash}`} />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-[14px] font-extrabold text-text">{pct}%</div>
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-bold text-text leading-tight">{label}</div>
        <div className="text-[11px] text-muted leading-snug mt-0.5">{sub}</div>
      </div>
    </div>
  );
}

function CountStat({ value, label, tone }: { value: number; label: string; tone?: "good" }) {
  return (
    <div className="bg-bg/40 border border-border rounded-xl py-2">
      <div className={`text-xl font-extrabold leading-none ${tone === "good" ? "text-success" : "text-text"}`}>{value}</div>
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-1">{label}</div>
    </div>
  );
}

function OKRsEmptyState({ isAdmin, onCreateCycle }: { isAdmin: boolean; onCreateCycle: () => void }) {
  // Surface the workspace admins so a non-admin reader knows exactly who
  // to ping. We only pull the picker list when we actually need it (i.e.
  // when the user is NOT admin and the page would otherwise read as a
  // dead-end). Cheap query, served from the existing members endpoint.
  const { data: members } = useQuery<{ items: { id: string; name: string; email: string; roles: string[]; status: string }[] }>({
    queryKey: ["okrs-empty-admins"],
    queryFn: () => api("/api/v1/members"),
    enabled: !isAdmin,
    staleTime: 10 * 60_000,
  });
  const admins = (members?.items ?? []).filter((m) =>
    m.status === "active"
    && m.roles.some((r) => r === "super_admin" || r === "ceo" || r === "coo" || r === "hr" || r === "hr_manager"),
  ).slice(0, 4);

  return (
    <section className="bg-surface border border-border rounded-2xl overflow-hidden">
      {/* Hero band — accent gradient with the Target icon. Sets the tone
          (this is performance management, not a system error). */}
      <div className="relative px-6 sm:px-10 py-8 sm:py-10 text-center" style={{ background: "linear-gradient(135deg, rgba(15,123,151,0.08), rgba(15,123,151,0.02))" }}>
        <div className="mx-auto w-14 h-14 rounded-2xl bg-accent grid place-items-center text-white shadow-soft mb-4">
          <Target size={26} strokeWidth={2.4} />
        </div>
        <h2 className="text-xl font-extrabold text-text">
          {isAdmin ? "Spin up your first OKR cycle" : "Your team hasn't started an OKR cycle yet"}
        </h2>
        <p className="text-[13px] text-muted mt-2 max-w-md mx-auto leading-relaxed">
          {isAdmin
            ? "An OKR cycle is the quarter (or month, sprint, half — your call) that frames every objective. Pick a window and we'll do the rest."
            : "OKRs let leadership set quarterly objectives and let you log key-result progress against them. Ask one of the admins below to open the first cycle and you'll start seeing the workspace's goals here."}
        </p>
        {isAdmin ? (
          <button
            type="button"
            onClick={onCreateCycle}
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-5 py-2.5 rounded-full hover:bg-[rgb(var(--accent-hover))] shadow-soft press-fx"
          >
            <Plus size={14} /> Create your first cycle
          </button>
        ) : admins.length > 0 ? (
          <div className="mt-5 inline-flex items-center gap-2 flex-wrap justify-center">
            <span className="text-[11.5px] uppercase tracking-wider font-bold text-muted">Ping</span>
            {admins.map((a) => (
              <a
                key={a.id}
                href={`mailto:${a.email}?subject=Can%20we%20open%20the%20first%20OKR%20cycle%3F`}
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full bg-surface border border-border hover:border-accent/50 hover:text-accent transition-colors"
              >
                {a.name || a.email}
              </a>
            ))}
          </div>
        ) : (
          <div className="mt-5 text-[12px] text-muted italic">No admins found in this workspace yet.</div>
        )}
      </div>

      {/* Worked example — actually shows what an OKR is. Three quick rows
          that mimic the real cards once cycles exist. Reads as a teaser,
          not a screenshot. */}
      <div className="px-6 sm:px-10 py-6 border-t border-border space-y-4">
        <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">Worked example</div>
        <div className="border border-border rounded-xl p-4 bg-bg/40">
          <div className="flex items-start gap-2.5">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-accent-soft text-accent shrink-0 font-bold text-[12px]">O</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-bold text-text">Ship the new payroll module to all clients</div>
              <div className="text-[11.5px] text-muted mt-0.5">Quarterly objective · owned by Engineering</div>
            </div>
            <span className="pill bg-success/15 text-success text-[10px] uppercase tracking-wider">Confidence · Green</span>
          </div>
          <div className="mt-3 pl-9 space-y-2">
            <div className="flex items-center gap-3 text-[12.5px]">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-accent-soft text-accent shrink-0 font-bold text-[10px]">KR</span>
              <span className="flex-1 text-text">Move <span className="font-semibold">12 tenants</span> to v2 by 30 Jun</span>
              <span className="text-[10.5px] font-semibold text-muted tabular-nums">8 / 12 · 67%</span>
            </div>
            <div className="flex items-center gap-3 text-[12.5px]">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-accent-soft text-accent shrink-0 font-bold text-[10px]">KR</span>
              <span className="flex-1 text-text">Keep monthly support tickets under <span className="font-semibold">25</span></span>
              <span className="text-[10.5px] font-semibold text-muted tabular-nums">18 / 25 · on track</span>
            </div>
            <div className="flex items-center gap-3 text-[12.5px]">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-accent-soft text-accent shrink-0 font-bold text-[10px]">KR</span>
              <span className="flex-1 text-text">NPS ≥ <span className="font-semibold">40</span> across the cohort</span>
              <span className="text-[10.5px] font-semibold text-warn tabular-nums">32 / 40 · 80%</span>
            </div>
          </div>
        </div>
        <p className="text-[12px] text-muted italic">
          That's it — one objective, a handful of measurable key results, and a weekly check-in to keep the confidence honest.
        </p>
      </div>
    </section>
  );
}

// ObjectivesEmptyState — the empty body when a cycle exists but no
// objectives have been added yet. Splits into two states:
//
//  Mine tab — first-author surface. Ready-to-use template cards (Ship /
//  Grow / Reduce) seed the create dialog with a sentence stem so the
//  blank-canvas problem vanishes. Cycle countdown reminds the user how
//  much runway the cycle has.
//
//  Workspace tab — "be first" nudge. Surfaces the cycle countdown plus
//  a button that flips back to Mine so the user can set theirs (the
//  fastest way to populate the Workspace view is for one person to ship
//  the first objective).
function ObjectivesEmptyState({
  cycle, tab, onCreate, onSwitchToMine,
}: {
  cycle: Cycle;
  tab: "mine" | "workspace";
  onCreate: (seedTitle?: string) => void;
  onSwitchToMine: () => void;
}) {
  // Days remaining until the cycle ends. Helps anchor the "how big should
  // my objective be?" mental math — a 90-day cycle frames bigger bets
  // than a 14-day one.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endMs = new Date(cycle.ends_on + "T00:00:00").getTime();
  const startMs = new Date(cycle.starts_on + "T00:00:00").getTime();
  const totalDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  const daysLeft = Math.max(0, Math.round((endMs - today.getTime()) / 86_400_000));
  const elapsedPct = Math.min(100, Math.max(0, Math.round(((today.getTime() - startMs) / (endMs - startMs)) * 100)));
  const status: "fresh" | "mid" | "late" = elapsedPct < 33 ? "fresh" : elapsedPct < 66 ? "mid" : "late";

  // Template cards — five archetypes covering the OKR vocabulary 99% of
  // workspaces actually use. Each tap pre-fills the title field; the
  // user finishes the sentence.
  const templates: { emoji: string; tone: string; label: string; seed: string; sub: string }[] = [
    { emoji: "🚀", tone: "bg-success/10 text-success border-success/30",   label: "Ship",     seed: "Ship ",     sub: "Land a feature / milestone" },
    { emoji: "📈", tone: "bg-accent-soft text-accent border-accent/30",    label: "Grow",     seed: "Grow ",     sub: "Move a number up" },
    { emoji: "📉", tone: "bg-warn/10 text-warn border-warn/30",            label: "Reduce",   seed: "Reduce ",   sub: "Bring a number down" },
    { emoji: "🛡️", tone: "bg-bg/60 text-muted border-border",              label: "Maintain", seed: "Maintain ", sub: "Hold quality / SLA" },
    { emoji: "✨", tone: "bg-accent-soft text-accent border-accent/30",    label: "Launch",   seed: "Launch ",   sub: "Public release / GA" },
  ];

  return (
    <section className="bg-surface border border-border rounded-2xl overflow-hidden">
      {/* Hero — cycle name, status pill, days-left countdown with a
          progress bar so the user feels the runway shrink. */}
      <div className="relative px-6 sm:px-8 py-6" style={{ background: "linear-gradient(135deg, rgba(15,123,151,0.08), rgba(15,123,151,0.02))" }}>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-12 h-12 rounded-2xl bg-accent grid place-items-center text-white shadow-soft shrink-0">
            <Target size={22} strokeWidth={2.4} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-extrabold text-text">{cycle.name}</h2>
              <span className={`pill text-[10px] uppercase tracking-wider font-bold ${
                cycle.status === "active" ? "bg-success/15 text-success"
                : cycle.status === "planning" ? "bg-accent-soft text-accent"
                : "bg-bg/60 text-muted"
              }`}>{cycle.status}</span>
              <span className={`text-[11px] font-bold ${status === "late" ? "text-danger" : status === "mid" ? "text-warn" : "text-muted"}`}>
                {daysLeft === 0 ? "Ends today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                <span className="text-muted/70 font-normal"> · {totalDays}d total</span>
              </span>
            </div>
            <div className="mt-2 h-1 bg-bg/60 rounded-full overflow-hidden max-w-md">
              <div
                className={`h-full rounded-full transition-[width] ${
                  status === "late" ? "bg-danger" : status === "mid" ? "bg-warn" : "bg-accent"
                }`}
                style={{ width: `${elapsedPct}%` }}
              />
            </div>
            <p className="text-[12.5px] text-muted mt-3 max-w-lg">
              {tab === "mine"
                ? "Set 1–3 objectives that capture your priorities for this cycle. Each one gets 2–4 measurable key results underneath that prove it's done."
                : "When teammates publish objectives they'll appear here. Start the snowball — be the first to share yours and the rest of the workspace usually follows."}
            </p>
          </div>
        </div>
      </div>

      {tab === "mine" ? (
        <div className="px-6 sm:px-8 py-6 border-t border-border space-y-4">
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2 inline-flex items-center gap-1.5">
              <Sparkles size={11} /> Start from a template
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {templates.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => onCreate(t.seed)}
                  className={`text-left rounded-xl border p-3 hover-lift press-fx transition-colors ${t.tone}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg leading-none">{t.emoji}</span>
                    <div className="font-bold text-[13.5px]">{t.label}…</div>
                  </div>
                  <div className="text-[11.5px] opacity-80 mt-1">{t.sub}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <p className="text-[11.5px] text-muted italic max-w-md">
              Tip: keep the objective qualitative ("Grow active users") and let the key results be the numbers ("from 1,200 → 2,000 MAU"). Tighter scoring, less arguing.
            </p>
            <button
              type="button"
              onClick={() => onCreate()}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-[rgb(var(--accent-hover))] shadow-soft press-fx"
            >
              <Plus size={14} /> Start blank
            </button>
          </div>
        </div>
      ) : (
        <div className="px-6 sm:px-8 py-6 border-t border-border">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-bold text-text inline-flex items-center gap-2">
                <Sparkles size={13} className="text-accent" /> Be the first to publish
              </div>
              <p className="text-[12px] text-muted mt-0.5">
                Switch to the Mine tab and ship the first objective — teammates usually follow within the day.
              </p>
            </div>
            <button
              type="button"
              onClick={onSwitchToMine}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3.5 py-1.5 rounded-full hover:bg-[rgb(var(--accent-hover))] shadow-soft press-fx shrink-0"
            >
              <Plus size={12} /> Set my first objective
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// CycleDialog — admin's "open a new cycle" form. Pre-fills the name with
// the current quarter ("Q2 2026"), start/end with that quarter's window,
// and status with 'active' so the first cycle isn't stuck in planning.
// Custom dates / names override the suggestion — the dialog isn't trying
// to be clever, just helpful on first paint.
function CycleDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date();
  const year = today.getFullYear();
  const q = Math.floor(today.getMonth() / 3) + 1;
  const qStart = new Date(year, (q - 1) * 3, 1);
  const qEnd = new Date(year, q * 3, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const [name, setName] = useState(`Q${q} ${year}`);
  const [starts, setStarts] = useState(iso(qStart));
  const [ends, setEnds] = useState(iso(qEnd));
  const [status, setStatus] = useState<"active" | "planning" | "closed">("active");
  const [preset, setPreset] = useState<"this-quarter" | "next-quarter" | "month" | "custom">("this-quarter");

  function applyPreset(p: typeof preset) {
    setPreset(p);
    if (p === "custom") return;
    let s: Date, e: Date, label: string;
    if (p === "this-quarter") {
      s = qStart; e = qEnd; label = `Q${q} ${year}`;
    } else if (p === "next-quarter") {
      const nq = q === 4 ? 1 : q + 1;
      const ny = q === 4 ? year + 1 : year;
      s = new Date(ny, (nq - 1) * 3, 1);
      e = new Date(ny, nq * 3, 0);
      label = `Q${nq} ${ny}`;
    } else {
      // Current month
      s = new Date(year, today.getMonth(), 1);
      e = new Date(year, today.getMonth() + 1, 0);
      label = today.toLocaleString(undefined, { month: "long", year: "numeric" });
    }
    setStarts(iso(s));
    setEnds(iso(e));
    setName(label);
  }

  const create = useMutation({
    mutationFn: () => api("/api/v1/okrs/cycles", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), starts_on: starts, ends_on: ends, status }),
    }),
    onSuccess: () => {
      toast.success("Cycle created", "Now add your first objective and the key results that prove it.");
      qc.invalidateQueries({ queryKey: ["okrs", "cycles"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't create cycle", e?.message),
  });

  const ready = name.trim().length >= 2 && starts && ends && starts <= ends;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">New cycle</div>
            <h2 className="text-base font-bold text-text mt-0.5">Open an OKR window</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-3">
          {/* Preset shortcuts — current quarter / next quarter / this
              month / custom. One tap lands the dates + name. */}
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">Preset</div>
            <div className="flex flex-wrap gap-1.5">
              {([
                { k: "this-quarter", label: `This quarter · Q${q}` },
                { k: "next-quarter", label: q === 4 ? `Next quarter · Q1` : `Next quarter · Q${q + 1}` },
                { k: "month",        label: "This month" },
                { k: "custom",       label: "Custom" },
              ] as const).map((p) => (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => applyPreset(p.k)}
                  className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${
                    preset === p.k
                      ? "bg-accent text-white border-accent"
                      : "bg-bg/40 text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <div className="label">Name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Q2 2026" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Starts on</div>
              <input type="date" className="input" value={starts} onChange={(e) => setStarts(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Ends on</div>
              <input type="date" className="input" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </label>
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1.5">
              {(["active", "planning", "closed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border capitalize ${
                    status === s
                      ? "bg-accent-soft text-accent border-accent/30"
                      : "bg-bg/40 text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-muted mt-1">
              <span className="font-semibold">Active</span> opens the cycle for objective + KR entry right away.
              Pick <span className="font-semibold">planning</span> to draft objectives quietly first.
            </div>
          </div>
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!ready || create.isPending}
            loadingLabel="Creating…"
            onClick={() => create.mutate()}
          >
            <Plus size={13} /> Create cycle
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function ObjectiveCard({
  objective, keyResults, canEdit, elapsedPct, onEdit, onAddKR, onCheckin, onHistory,
}: {
  objective: OKR;
  keyResults: OKR[];
  canEdit: boolean;
  elapsedPct: number;
  onEdit: (o: OKR) => void;
  onAddKR: () => void;
  onCheckin: (o: OKR) => void;
  onHistory: (o: OKR) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const avgPct = keyResults.length === 0 ? 0
    : Math.round(keyResults.reduce((s, k) => s + k.progress_pct, 0) / keyResults.length);
  const conf = CONFIDENCE_META[objective.confidence];
  return (
    <li className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
        >
          {expanded ? <ChevronDown size={14} className="mt-1 shrink-0 text-muted" /> : <ChevronRight size={14} className="mt-1 shrink-0 text-muted" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-bold text-text">{objective.title}</span>
              {(() => {
                const p = paceFor(avgPct, elapsedPct, objective.status);
                if (p === "not_started") return null;
                const meta = PACE_META[p];
                return <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${meta.cls}`} title="Pace = progress vs cycle elapsed">{meta.label}</span>;
              })()}
              <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${conf.cls}`} title="Owner confidence">{conf.label}</span>
              <span className="text-[11px] text-muted">{objective.owner_name || objective.owner_email}</span>
              {/* Parent-alignment chip — only when this objective is
                  aligned upward (cascaded from a team/org objective). */}
              {objective.parent_id && objective.parent_title && (
                <span
                  className="pill bg-accent-soft text-accent border border-accent/30 text-[10px] uppercase tracking-wide font-bold inline-flex items-center gap-1"
                  title={`Aligned to: ${objective.parent_title}`}
                >
                  ↗ {objective.parent_title.length > 28 ? objective.parent_title.slice(0, 28) + "…" : objective.parent_title}
                </span>
              )}
            </div>
            {objective.description && (
              <p className="text-[12px] text-muted leading-snug mt-0.5 line-clamp-2">{objective.description}</p>
            )}
            {/* Stale-checkin nudge: when 7+ days since the last check-in
                (or never) and this is the owner's own row. */}
            <CheckinStatus okr={objective} canEdit={canEdit} onCheckin={onCheckin} onHistory={onHistory} />
          </div>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => onCheckin(objective)}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
                title="Log a weekly check-in"
              >
                <TrendingUp size={11} /> Check in
              </button>
              <button
                type="button"
                onClick={() => onEdit(objective)}
                className="text-[11.5px] text-muted hover:text-accent p-1.5"
                title="Edit"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={onAddKR}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
              >
                <Plus size={11} /> Add KR
              </button>
            </>
          )}
        </div>
      </header>

      {/* Progress strip — objective avg */}
      <div className="px-4 pb-2">
        <div className="flex items-center justify-between gap-2 text-[11px] mb-1">
          <span className="text-muted">Avg progress · {keyResults.length} KR{keyResults.length === 1 ? "" : "s"}</span>
          <span className="font-semibold text-text">{avgPct}%</span>
        </div>
        <div className="h-1.5 bg-bg/60 rounded-full overflow-hidden">
          <div className={`h-full ${avgPct === 100 ? "bg-success" : avgPct >= 50 ? "bg-accent" : "bg-warn"}`} style={{ width: `${avgPct}%` }} />
        </div>
      </div>

      {expanded && (
        <ul className="px-4 pb-4 space-y-2">
          {keyResults.length === 0 ? (
            <li className="text-[12px] text-muted italic py-2">No key results yet. Add 2–4 to make this objective measurable.</li>
          ) : keyResults.map((kr) => (
            <KRRow
              key={kr.id}
              kr={kr}
              canEdit={canEdit}
              elapsedPct={elapsedPct}
              onEdit={() => onEdit(kr)}
              onCheckin={() => onCheckin(kr)}
              onHistory={() => onHistory(kr)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// KRRow — one key result. Shows the title, current/target, a slim
// progress bar, and a confidence pill.
function KRRow({
  kr, canEdit, elapsedPct, onEdit, onCheckin, onHistory,
}: {
  kr: OKR;
  canEdit: boolean;
  elapsedPct: number;
  onEdit: () => void;
  onCheckin: () => void;
  onHistory: () => void;
}) {
  const conf = CONFIDENCE_META[kr.confidence];
  const status = STATUS_META[kr.status];
  const pace = paceFor(kr.progress_pct, elapsedPct, kr.status);
  return (
    <li className="bg-bg/40 border border-border rounded-xl px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Flag size={11} className="text-muted shrink-0" />
            <span className="text-[12.5px] font-semibold text-text">{kr.title}</span>
            {pace !== "not_started" && (
              <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${PACE_META[pace].cls}`} title="Pace = progress vs cycle elapsed">
                {PACE_META[pace].label}
              </span>
            )}
            <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${conf.cls}`} title="Owner confidence">{conf.label}</span>
            {kr.status !== "in_progress" && (
              <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${status.cls}`}>{status.label}</span>
            )}
          </div>
          {kr.description && (
            <p className="text-[11.5px] text-muted leading-snug mt-0.5 line-clamp-2">{kr.description}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 text-[12px]">
          {kr.target_value != null ? (
            <span className="text-text">
              <span className="font-bold">{formatNum(kr.current_value)}</span>
              <span className="text-muted"> / {formatNum(kr.target_value)}</span>
              {kr.unit && <span className="text-muted"> {kr.unit}</span>}
            </span>
          ) : (
            <span className="text-muted">{kr.status === "done" ? "Done" : "—"}</span>
          )}
          <span className="text-[11px] text-muted">·</span>
          <span className="font-semibold text-text">{kr.progress_pct}%</span>
          {canEdit && (
            <button
              type="button"
              onClick={onCheckin}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              title="Log a weekly check-in"
            >
              <TrendingUp size={11} /> Check in
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="text-muted hover:text-accent p-1"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="h-1 mt-1.5 bg-bg/60 rounded-full overflow-hidden">
        <div className={`h-full ${kr.progress_pct === 100 ? "bg-success" : kr.progress_pct >= 50 ? "bg-accent" : "bg-warn"}`} style={{ width: `${kr.progress_pct}%` }} />
      </div>
      <CheckinStatus okr={kr} canEdit={canEdit} onCheckin={() => onCheckin()} onHistory={() => onHistory()} compact />
    </li>
  );
}

// CheckinStatus — single line below an OKR header / KR row showing how
// recently it was checked in on. Renders nothing when there are no
// check-ins AND the user can't edit; otherwise nudges the owner when
// the most recent is stale (>7 days) and exposes a "history" link.
function CheckinStatus({
  okr, canEdit, onCheckin, onHistory, compact,
}: {
  okr: OKR;
  canEdit: boolean;
  onCheckin: (o: OKR) => void;
  onHistory: (o: OKR) => void;
  compact?: boolean;
}) {
  if (okr.checkin_count === 0 && !canEdit) return null;
  const latest = okr.latest_checkin_at ? new Date(okr.latest_checkin_at) : null;
  const ageDays = latest ? Math.floor((Date.now() - latest.getTime()) / 86_400_000) : null;
  const stale = canEdit && (ageDays === null || ageDays >= 7);
  const fmt = ageDays === null
    ? "No check-ins yet"
    : ageDays === 0 ? "Checked in today"
    : ageDays === 1 ? "Checked in yesterday"
    : `Checked in ${ageDays}d ago`;
  return (
    <div className={`${compact ? "mt-1" : "mt-1.5"} flex items-center gap-2 flex-wrap text-[10.5px]`}>
      <span className={stale ? "text-warn font-semibold" : "text-muted"}>
        {stale && "⚠ "}{fmt}
        {okr.checkin_count > 0 && <span className="text-muted/70"> · {okr.checkin_count} update{okr.checkin_count === 1 ? "" : "s"}</span>}
      </span>
      {okr.checkin_count > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onHistory(okr); }}
          className="text-accent hover:underline"
        >
          See history
        </button>
      )}
      {stale && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCheckin(okr); }}
          className="text-accent hover:underline"
        >
          Update now
        </button>
      )}
    </div>
  );
}

function formatNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

// ─────────────────────────────────────────────────────────────────────
// Create / Edit dialogs
// ─────────────────────────────────────────────────────────────────────

// CreateOKRDialog — the smart new-objective / new-key-result form.
//
// Smart bits beyond the old "title + description + confidence" trio:
//   • Template chips — four objective starters (Ship · Grow · Reduce ·
//     Maintain) that pre-fill a sentence-stem the user can finish.
//     Lowers blank-canvas friction.
//   • Owner picker — defaults to the calling user; admins can hand off
//     to anyone in the workspace at create time.
//   • Status chips — Draft / In progress / Done so the dialog isn't
//     making "draft" a separate workflow nobody discovers.
//   • Quantitative inference for KRs — typing a number in the title
//     ("Move 12 tenants to v2") auto-suggests target + unit chips
//     pulled from the parsed string.
//   • Live preview card mirrors the final rendering so the user sees
//     what they're shipping before clicking Add.
//   • Inline "add 3 key results" reveal for objectives — once the
//     objective is added we open a quick-add row that the user can
//     fill 0–3 KRs into without re-opening the dialog.
function CreateOKRDialog({
  cycleId, kind, parentId, seedTitle, onClose,
}: {
  cycleId: string;
  kind: OKR["kind"];
  parentId?: string;
  seedTitle?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isObjective = kind === "objective";

  const [title, setTitle] = useState(seedTitle ?? "");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [confidence, setConfidence] = useState<OKR["confidence"]>("green");
  const [status, setStatus] = useState<OKR["status"]>("in_progress");
  const [ownerId, setOwnerId] = useState<string>(user?.id ?? "");
  // Inline KR drafts shown after the objective lands. Three empty rows
  // is the friction sweet-spot — fewer feels stingy, more reads as
  // homework. The user can leave them empty and we'll skip the save.
  const [krDrafts, setKrDrafts] = useState<string[]>(["", "", ""]);
  const [phase, setPhase] = useState<"compose" | "add-krs">("compose");
  const [objectiveID, setObjectiveID] = useState<string | null>(null);

  // Members picker — only fetched when actually needed (the dialog is
  // opened), staletime keeps it cached across re-opens within 5 min.
  const { data: membersData } = useQuery<{ items: { id: string; name: string; email: string; status: string }[] }>({
    queryKey: ["okrs-members-pick"],
    queryFn: () => api("/api/v1/members?status=active"),
    staleTime: 5 * 60_000,
  });
  const members = (membersData?.items ?? []).filter((m) => m.status === "active");

  // Templates for the title field. Tap one to pre-seed the input with a
  // sentence-stem. "Ship X this quarter" is the catch-all; the others
  // map to common OKR archetypes (growth, reduction, quality).
  const objectiveTemplates: { label: string; emoji: string; seed: string }[] = [
    { label: "Ship",     emoji: "🚀", seed: "Ship " },
    { label: "Grow",     emoji: "📈", seed: "Grow " },
    { label: "Reduce",   emoji: "📉", seed: "Reduce " },
    { label: "Maintain", emoji: "🛡️", seed: "Maintain " },
  ];

  // Quantitative inference for KRs — if the user types "12 tenants" or
  // "$50k" we'll suggest target=12 and unit="tenants" (or "$"). Skip
  // if they've already typed an explicit target/unit. Re-runs on every
  // title edit but the regex is cheap.
  useEffect(() => {
    if (isObjective) return;
    if (target || unit) return;
    const m = /(?:^|\s)(\$|₦|€|£)?(\d[\d.,]*)\s*([a-zA-Z%]{1,16})?/.exec(title);
    if (m) {
      const num = parseFloat(m[2].replace(/,/g, ""));
      if (Number.isFinite(num)) {
        setTarget(String(num));
        const u = (m[1] ?? m[3] ?? "").trim();
        if (u) setUnit(u);
      }
    }
  }, [title, isObjective, target, unit]);

  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/v1/okrs", {
        method: "POST",
        body: JSON.stringify({
          cycle_id: cycleId,
          kind,
          parent_id: parentId,
          owner_id: ownerId || undefined,
          title: title.trim(),
          description: description.trim(),
          target_value: kind === "key_result" && target.trim() !== "" ? parseFloat(target) : undefined,
          unit: kind === "key_result" ? unit.trim() : undefined,
          confidence,
          status,
        }),
      }),
    onSuccess: (resp) => {
      toast.success(isObjective ? "Objective added" : "Key result added");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      // For objectives, flip to the KR-quick-add step instead of closing.
      // The user usually wants to drop the 3 KRs that prove the
      // objective right after — same flow they'd otherwise re-open
      // the dialog three times for.
      if (isObjective && resp?.id) {
        setObjectiveID(resp.id);
        setPhase("add-krs");
      } else {
        onClose();
      }
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  const saveKR = useMutation({
    mutationFn: (body: string) =>
      api("/api/v1/okrs", {
        method: "POST",
        body: JSON.stringify({
          cycle_id: cycleId,
          kind: "key_result",
          parent_id: objectiveID,
          title: body.trim(),
          confidence: "green",
          status: "in_progress",
        }),
      }),
  });

  async function commitKRs() {
    const valid = krDrafts.map((s) => s.trim()).filter((s) => s.length > 0);
    for (const body of valid) {
      try { await saveKR.mutateAsync(body); } catch { /* keep going */ }
    }
    qc.invalidateQueries({ queryKey: ["okrs"] });
    toast.success(`${valid.length} key result${valid.length === 1 ? "" : "s"} added`);
    onClose();
  }

  // Live-preview model — read the form state into a fake OKR-like shape
  // so the user sees the card they'll get on save.
  const previewTarget = isObjective ? null : (target.trim() ? parseFloat(target) : null);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg max-h-[92vh] overflow-hidden flex flex-col">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">
              {phase === "add-krs" ? "Step 2 of 2" : isObjective ? "Step 1 of 2" : "New entry"}
            </div>
            <h2 className="text-base font-bold text-text mt-0.5">
              {phase === "add-krs" ? "Add the key results that prove it" : (isObjective ? "New objective" : "New key result")}
            </h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>

        {phase === "compose" ? (
          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
            {isObjective && (
              <div>
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">Start with a template</div>
                <div className="flex flex-wrap gap-1.5">
                  {objectiveTemplates.map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setTitle((cur) => cur || t.seed)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-semibold rounded-full bg-bg/40 border border-border hover:border-accent/40 hover:bg-accent-soft/40 transition-colors"
                    >
                      <span>{t.emoji}</span> {t.label} …
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Title</div>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={isObjective ? "Ship 3 priority features this quarter" : "Move 12 tenants to v2"}
                className="input"
              />
              {!isObjective && title && !target && (
                <div className="text-[10.5px] text-muted mt-1 italic">
                  Tip: add a number ("ship 12 tenants") and we'll auto-fill the target.
                </div>
              )}
            </label>

            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Description <span className="text-muted/70 font-normal">(optional)</span></div>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder={isObjective ? "Why does this matter? Who depends on it?" : "How will we measure it?"}
                className="input resize-none"
              />
            </label>

            {!isObjective && (
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <label className="block">
                  <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Target</div>
                  <input
                    type="number"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="100"
                    className="input"
                  />
                  <div className="text-[10.5px] text-muted mt-1">Empty = done/not-done KR.</div>
                </label>
                <label className="block">
                  <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Unit</div>
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    placeholder="%, ₦, signups"
                    className="input"
                  />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {["%", "₦", "$", "users", "tenants"].map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setUnit(u)}
                        className={`text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${
                          unit === u ? "bg-accent text-white border-accent" : "bg-bg/40 text-muted border-border hover:border-accent/40"
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Owner</div>
                <select
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  className="input"
                >
                  <option value={user?.id ?? ""}>{(user?.name || user?.email || "Me") + " (me)"}</option>
                  {members.filter((m) => m.id !== user?.id).map((m) => (
                    <option key={m.id} value={m.id}>{m.name || m.email}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Status</div>
                <div className="flex flex-wrap gap-1">
                  {(["draft", "in_progress"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                        status === s ? "bg-accent text-white border-accent" : "bg-bg/40 text-muted border-border hover:border-accent/40"
                      }`}
                    >
                      {s === "draft" ? "Draft" : "In progress"}
                    </button>
                  ))}
                </div>
                <div className="text-[10.5px] text-muted mt-1">
                  Draft stays hidden from the workspace tab until you switch it to "in progress".
                </div>
              </div>
            </div>

            <ConfidencePicker value={confidence} onChange={setConfidence} />

            {/* Live preview — mirror the eventual rendering so the user
                sees their objective the way the team will. */}
            {title.trim() && (
              <div className="border border-accent/30 bg-accent-soft/20 rounded-xl p-3">
                <div className="text-[10px] uppercase tracking-wider font-bold text-accent mb-1.5">Preview</div>
                <div className="flex items-start gap-2.5">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-accent text-white shrink-0 font-bold text-[12px]">{isObjective ? "O" : "KR"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-bold text-text">{title.trim()}</div>
                    {description.trim() && <div className="text-[12px] text-muted mt-0.5">{description.trim()}</div>}
                    <div className="mt-1.5 flex items-center gap-2 text-[10.5px] flex-wrap">
                      <span className={`pill text-[10px] uppercase tracking-wider ${
                        confidence === "green" ? "bg-success/15 text-success"
                        : confidence === "amber" ? "bg-warn/15 text-warn"
                        : "bg-danger/15 text-danger"
                      }`}>{confidence === "green" ? "On track" : confidence === "amber" ? "At risk" : "Off track"}</span>
                      {previewTarget != null && (
                        <span className="text-muted font-semibold">target {formatNum(previewTarget)} {unit}</span>
                      )}
                      <span className="text-muted">·</span>
                      <span className="text-muted">{(members.find((m) => m.id === ownerId)?.name) || user?.name || "me"}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          // Phase 2 — KR quick-add. The objective just landed; let the user
          // drop the measurable KRs without ever leaving the dialog.
          <div className="p-5 space-y-3 flex-1 overflow-y-auto">
            <p className="text-[12.5px] text-muted">
              Great. Add up to <span className="font-bold text-text">3 key results</span> that will tell you when this objective is met.
              Skip any you don't have yet — you can always add more from the objective card later.
            </p>
            {krDrafts.map((k, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-accent-soft text-accent shrink-0 font-bold text-[10.5px]">KR{i + 1}</span>
                <input
                  className="input flex-1"
                  value={k}
                  onChange={(e) => {
                    const next = [...krDrafts];
                    next[i] = e.target.value;
                    setKrDrafts(next);
                  }}
                  placeholder={
                    i === 0 ? "Move 12 tenants to v2 by 30 Jun"
                    : i === 1 ? "Keep monthly support tickets under 25"
                    : "NPS ≥ 40 across the cohort"
                  }
                />
              </div>
            ))}
            <div className="text-[11px] text-muted">
              Numbers in the title get auto-detected as targets once the KR lands — same trick as the main form.
            </div>
          </div>
        )}

        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          {phase === "compose" ? (
            <>
              <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
              <SmartButton variant="primary" disabled={!title.trim() || save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
                <Plus size={13} /> {isObjective ? "Add objective" : "Add"}
              </SmartButton>
            </>
          ) : (
            <>
              <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Skip — done</button>
              <SmartButton
                variant="primary"
                disabled={saveKR.isPending || krDrafts.every((k) => !k.trim())}
                loadingLabel="Saving…"
                onClick={commitKRs}
              >
                <Plus size={13} /> Add {krDrafts.filter((k) => k.trim()).length} key result{krDrafts.filter((k) => k.trim()).length === 1 ? "" : "s"}
              </SmartButton>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// CheckinDialog — weekly progress update. For quantitative KRs we
// surface a "current value" field + auto-derive percent; qualitative
// rows just collect confidence + comment + optional status change.
function CheckinDialog({ okr, onClose }: { okr: OKR; onClose: () => void }) {
  const qc = useQueryClient();
  const isQuantitative = okr.target_value != null;
  const [current, setCurrent] = useState(String(okr.current_value));
  const [percent, setPercent] = useState(okr.progress_pct);
  const [confidence, setConfidence] = useState<OKR["confidence"]>(okr.confidence);
  const [status, setStatus] = useState<OKR["status"]>(okr.status);
  const [comment, setComment] = useState("");
  // Auto-recompute percent from current when quantitative.
  const derivedPct = useMemo(() => {
    const tv = okr.target_value;
    if (!isQuantitative || tv == null || tv === 0) return percent;
    const p = Math.round((parseFloat(current) / tv) * 100);
    return Math.max(0, Math.min(100, p));
  }, [current, isQuantitative, okr.target_value, percent]);

  const save = useMutation({
    mutationFn: () => api(`/api/v1/okrs/${okr.id}/checkins`, {
      method: "POST",
      body: JSON.stringify({
        ...(isQuantitative ? { current_value: parseFloat(current) || 0 } : {}),
        percent: isQuantitative ? undefined : percent,
        confidence,
        status,
        comment: comment.trim(),
      }),
    }),
    onSuccess: () => {
      toast.success("Check-in saved", "The OKR's progress + confidence are updated.");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Weekly check-in</div>
            <h2 className="text-base font-bold text-text leading-tight mt-0.5 truncate">{okr.title}</h2>
            {okr.parent_title && <div className="text-[11px] text-muted mt-0.5">↗ {okr.parent_title}</div>}
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          {isQuantitative ? (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Current value</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  className="input flex-1"
                  autoFocus
                />
                {okr.unit && <span className="text-[12.5px] text-muted">{okr.unit}</span>}
                <span className="text-muted">/</span>
                <span className="text-[12.5px] font-semibold text-text">{formatNum(okr.target_value ?? 0)}</span>
              </div>
              <div className="text-[10.5px] text-muted mt-1">
                That'll set progress to <span className="font-semibold text-text">{derivedPct}%</span>.
              </div>
            </div>
          ) : (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Progress</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={percent}
                  onChange={(e) => setPercent(parseInt(e.target.value, 10))}
                  className="flex-1"
                />
                <span className="text-[12.5px] font-bold text-text w-10 text-right">{percent}%</span>
              </div>
            </div>
          )}
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1">
              {(["draft", "in_progress", "done", "dropped"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                    status === s ? STATUS_META[s].cls + " border" : "bg-bg text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Comment (optional)</div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="input resize-none text-sm"
              placeholder={confidence === "red" ? "What's blocking? Who can unblock?" : "What moved the needle this week?"}
            />
          </label>
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton variant="primary" disabled={save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
            <Save size={13} /> Save check-in
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// HistoryDialog — reverse-chronological log of every check-in on this OKR.
// Useful for 1:1s + cycle-end retrospective.
function HistoryDialog({ okr, onClose }: { okr: OKR; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ items: OKRCheckin[] }>({
    queryKey: ["okrs", "checkins", okr.id],
    queryFn: () => api(`/api/v1/okrs/${okr.id}/checkins`),
  });
  const items = data?.items ?? [];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Check-in history</div>
            <h2 className="text-base font-bold text-text leading-tight mt-0.5 truncate">{okr.title}</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted">No check-ins yet on this OKR.</div>
          ) : (
            <ul className="space-y-3">
              {items.map((ck) => (
                <li key={ck.id} className="bg-bg/40 border border-border rounded-xl px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap text-[11.5px]">
                    <span className="font-bold text-text">{ck.user_name || ck.user_email.split("@")[0]}</span>
                    <span className="text-muted">{new Date(ck.created_at).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${CONFIDENCE_META[ck.confidence].cls}`}>
                      {CONFIDENCE_META[ck.confidence].label}
                    </span>
                    <span className="text-[12px] font-semibold text-text">{ck.percent}%</span>
                    {ck.current_value !== null && (
                      <span className="text-[12px] text-muted">· value {formatNum(ck.current_value)}</span>
                    )}
                    {ck.status && ck.status !== "in_progress" && (
                      <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${STATUS_META[ck.status].cls}`}>
                        {STATUS_META[ck.status].label}
                      </span>
                    )}
                  </div>
                  {ck.comment && (
                    <p className="text-[12.5px] text-text/80 mt-1.5 whitespace-pre-wrap leading-snug">{ck.comment}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function EditOKRDialog({ okr, cycleObjectives, onClose }: { okr: OKR; cycleObjectives: OKR[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(okr.title);
  const [description, setDescription] = useState(okr.description);
  const [current, setCurrent] = useState(String(okr.current_value));
  const [target, setTarget] = useState(okr.target_value === null ? "" : String(okr.target_value));
  const [unit, setUnit] = useState(okr.unit);
  const [confidence, setConfidence] = useState<OKR["confidence"]>(okr.confidence);
  const [status, setStatus] = useState<OKR["status"]>(okr.status);
  const [parentId, setParentId] = useState<string>(okr.parent_id ?? "");
  const isKR = okr.kind === "key_result";
  const parentOptions = cycleObjectives.filter((o) => o.id !== okr.id && o.kind === "objective");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/okrs/${okr.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description,
          current_value: parseFloat(current) || 0,
          target_value: target.trim() === "" ? "" : parseFloat(target),
          unit,
          confidence,
          status,
          ...(isKR ? {} : { parent_id: parentId }),
        }),
      }),
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });
  const del = useMutation({
    mutationFn: () => api(`/api/v1/okrs/${okr.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text">{isKR ? "Edit key result" : "Edit objective"}</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Title</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Description</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input resize-none" />
          </label>
          {!isKR && (
            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Aligns to parent objective</div>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="input">
                <option value="">— No parent —</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              <div className="text-[11px] text-muted mt-1">Cascades roll up under the chosen parent in the workspace view.</div>
            </label>
          )}
          {isKR && (
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Current</div>
                <input type="number" value={current} onChange={(e) => setCurrent(e.target.value)} className="input" />
              </label>
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Target</div>
                <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className="input" />
              </label>
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Unit</div>
                <input value={unit} onChange={(e) => setUnit(e.target.value)} className="input" />
              </label>
            </div>
          )}
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1">
              {(["draft", "in_progress", "done", "dropped"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                    status === s ? STATUS_META[s].cls + " border" : "bg-bg text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 bg-bg/30">
          <button
            onClick={() => { if (confirm("Delete this OKR? It can't be undone.")) del.mutate(); }}
            disabled={del.isPending}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-danger hover:underline"
          >
            <Trash2 size={11} /> Delete
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
            <SmartButton variant="primary" disabled={save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
              <Save size={13} /> Save
            </SmartButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ConfidencePicker — three-button R/A/G row used by create + edit.
function ConfidencePicker({
  value, onChange,
}: {
  value: OKR["confidence"];
  onChange: (v: OKR["confidence"]) => void;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5 inline-flex items-center gap-1">
        <TrendingUp size={11} /> Confidence
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {(["green", "amber", "red"] as const).map((c) => {
          const meta = CONFIDENCE_META[c];
          const on = value === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={`text-[11px] font-bold uppercase tracking-wide px-2 py-1.5 rounded-lg border transition-all ${
                on ? meta.cls + " scale-[1.02]" : "border-border text-muted hover:text-text"
              }`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default OKRsPage;
