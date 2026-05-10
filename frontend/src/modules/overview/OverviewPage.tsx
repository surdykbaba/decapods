import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Bell, Plus, X, Sparkles, MapPin, Clock, Send, Folder, Share2, ChevronLeft, ChevronRight,
  Copy, Briefcase, Trophy, Gauge, AlertTriangle,
} from "lucide-react";

type WorkResp = {
  counts: {
    active_tasks: number;
    overdue_tasks: number;
    blocked_tasks: number;
    active_projects: number;
    pending_updates: number;
    hours_this_week: number;
  };
  priorities: { id: string; title: string; due_on?: string | null; priority?: number; project_id?: string; project_name?: string; status?: string; description?: string }[];
  projects: { id: string; code: string; name: string; status: string }[];
};

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
};

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: "green" | "amber" | "red";
  client_name: string;
  end_date: string | null;
  tasks: number;
  tasks_done: number;
  milestones: number;
  updated_at: string;
};

type Opp = {
  id: string; title: string; stage: string;
  estimated_value: number; risk_level: string;
  docs_attached: number; docs_required: number;
  updated_at: string;
};

const ACTIVE_STAGES = new Set(["new_request","under_review","approved","contracting","planning","in_progress","qa_review","client_acceptance","invoiced"]);
const PIPELINE_STAGES: { key: string; label: string; color: string }[] = [
  { key: "new_request",       label: "New",          color: "#1e212a" },
  { key: "under_review",      label: "Review",       color: "#ef4444" },
  { key: "approved",          label: "Approved",     color: "#3b82f6" },
  { key: "contracting",       label: "Contracting",  color: "#a855f7" },
  { key: "planning",          label: "Planning",     color: "#f59e0b" },
  { key: "in_progress",       label: "In progress",  color: "#10b981" },
  { key: "qa_review",         label: "QA",           color: "#06b6d4" },
  { key: "client_acceptance", label: "Acceptance",   color: "#0ea5e9" },
];

function fmtBigMoney(n: number): string {
  if (!n) return "₦0";
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `₦${Math.round(n).toLocaleString()}`;
}

const STAGE_FLOW = [
  { key: "planning",    label: "Initiated",     pct: 8 },
  { key: "in_progress", label: "In planning",   pct: 30 },
  { key: "qa_review",   label: "In development",pct: 65 },
  { key: "client_acceptance", label: "Testing", pct: 85 },
  { key: "invoiced",    label: "Delivered",     pct: 100 },
] as const;

function fmtMonthDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function priorityChip(p?: number): { label: string; cls: string } {
  if (!p || p >= 4) return { label: "Backlog", cls: "bg-bg text-muted border-border" };
  if (p === 1) return { label: "Blocking", cls: "bg-lime-soft text-success border-lime/40" };
  if (p === 2) return { label: "Essential", cls: "bg-accent-soft text-accent border-accent/30" };
  return { label: "Urgent", cls: "bg-warn/10 text-warn border-warn/30" };
}

export function OverviewPage() {
  const { user } = useAuth();

  const { data: work } = useQuery<WorkResp>({
    queryKey: ["me-work"], queryFn: () => api(`/api/v1/me/work`),
  });
  const { data: notifResp } = useQuery<{ items: Notification[]; unread: number }>({
    queryKey: ["notifications"], queryFn: () => api(`/api/v1/notifications`),
  });
  const { data: projectsList } = useQuery<{ items: Project[] }>({
    queryKey: ["projects"], queryFn: () => api(`/api/v1/projects`),
  });
  const { data: oppsResp } = useQuery<{ items: Opp[] }>({
    queryKey: ["opps"], queryFn: () => api(`/api/v1/opportunities`),
  });

  const opps = oppsResp?.items ?? [];
  const exec = useMemo(() => {
    const active = opps.filter((o) => ACTIVE_STAGES.has(o.stage));
    const won = opps.filter((o) => o.stage === "paid" || o.stage === "closed");
    const activeValue = active.reduce((s, o) => s + (o.estimated_value || 0), 0);
    const wonValue = won.reduce((s, o) => s + (o.estimated_value || 0), 0);
    const docsAttached = active.reduce((s, o) => s + (o.docs_attached || 0), 0);
    const docsRequired = active.reduce((s, o) => s + (o.docs_required || 0), 0);
    const docsPct = docsRequired === 0 ? 100 : Math.round((docsAttached / docsRequired) * 100);
    const conversionRate = opps.length > 0 ? Math.round((won.length / opps.length) * 100) : 0;
    const needsAttention = active.filter((o) => {
      const days = (Date.now() - new Date(o.updated_at).getTime()) / 86_400_000;
      return o.risk_level === "high" || days >= 14 || (o.docs_required > o.docs_attached);
    }).length;
    const stageBreakdown = PIPELINE_STAGES.map((s) => {
      const items = opps.filter((o) => o.stage === s.key);
      return { ...s, count: items.length, value: items.reduce((sum, o) => sum + (o.estimated_value || 0), 0) };
    });
    const maxStageValue = Math.max(1, ...stageBreakdown.map((s) => s.value));
    return { active, won, activeValue, wonValue, docsAttached, docsRequired, docsPct, conversionRate, needsAttention, stageBreakdown, maxStageValue };
  }, [opps]);

  const todos = (work?.priorities ?? []).slice(0, 4);
  const recentNotif = (notifResp?.items ?? [])[0];
  const projects = projectsList?.items ?? [];
  const focus = useMemo(() => {
    return projects.find((p) => p.status === "in_progress") ?? projects[0];
  }, [projects]);

  // Next event = most upcoming milestone across projects
  const nextEvent = useMemo(() => {
    type Ev = { date: string; title: string; project: string };
    if (!focus) return null;
    // We don't fetch all milestones here; surface a synthetic "expo" as a placeholder
    // when we don't have real milestone data on the list endpoint.
    if (!focus.end_date) return null;
    return { date: focus.end_date, title: `${focus.name} — target delivery`, project: focus.code } as Ev;
  }, [focus]);

  const stageIdx = focus ? STAGE_FLOW.findIndex((s) => s.key === focus.status) : -1;
  const stagePct = stageIdx >= 0 ? STAGE_FLOW[stageIdx].pct : 0;

  const initial = (user?.name ?? user?.email ?? "?")[0]?.toUpperCase();
  const role = user?.roles?.[0]?.replace(/_/g, " ") ?? "Member";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* ============ Left column ============ */}
      <div className="lg:col-span-3 space-y-5">
        {/* Profile card */}
        <div className="flex items-center gap-3">
          <span className="w-12 h-12 rounded-full bg-accent-soft text-accent grid place-items-center font-bold">
            {initial}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold text-text truncate">{user?.name || "Signed in"}</div>
            <div className="text-[11px] uppercase tracking-wider text-muted font-semibold truncate">{role}</div>
          </div>
          <Link to="#" className="w-9 h-9 rounded-full bg-surface border border-border grid place-items-center text-muted hover:text-text">
            <Bell size={15} />
          </Link>
        </div>

        {/* To-do */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-text">To do list</h3>
            <button className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
              <Plus size={13} />
            </button>
          </div>
          {todos.length === 0 ? (
            <p className="text-sm text-muted italic">Nothing on your list — add a task on a project.</p>
          ) : (
            <ul className="space-y-3">
              {todos.map((t, i) => {
                const pri = priorityChip(t.priority);
                const dismissed = t.status === "done";
                return (
                  <li key={t.id} className="border-l-2 border-border pl-3">
                    <div className="flex items-start gap-2">
                      {dismissed ? (
                        <X size={14} className="text-muted mt-1 shrink-0" />
                      ) : (
                        <Plus size={14} className="text-muted mt-1 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-text leading-snug">{t.title}</div>
                        <div className="text-[11px] text-muted mt-1 flex items-center gap-2 flex-wrap">
                          {t.due_on && <span>{fmtMonthDay(t.due_on)}</span>}
                          <span className={`pill border ${pri.cls}`}>{pri.label}</span>
                        </div>
                        {i === 1 && t.description && (
                          <p className="text-xs text-muted mt-2 leading-relaxed">{t.description}</p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Notifications */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-text">Notifications</h3>
            <button className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
              <Send size={12} />
            </button>
          </div>
          {!recentNotif ? (
            <p className="text-sm text-muted italic">All caught up.</p>
          ) : (
            <>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center text-sm font-bold">
                  {(recentNotif.title || "?")[0].toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text truncate">{recentNotif.title}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                    {recentNotif.kind.replace(/[._]/g, " ")}
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted leading-relaxed line-clamp-3">{recentNotif.body}</p>
              <div className="text-[11px] text-muted mt-2 flex items-center gap-1.5">
                <span>{relTime(recentNotif.created_at)}</span>
                {recentNotif.read_at ? <span>· Read ✓</span> : <span>· Unread</span>}
              </div>
            </>
          )}
        </Card>

        <Link
          to="/dashboard"
          className="block text-center bg-surface border border-border rounded-full py-3 text-sm font-semibold text-text hover:bg-bg"
        >
          Manage your dashboard
        </Link>
      </div>

      {/* ============ Center column ============ */}
      <div className="lg:col-span-6 space-y-5">
        {/* Executive KPIs (merged from /dashboard) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ExecKpi
            icon={<Briefcase size={14} />}
            label="Pipeline value"
            value={fmtBigMoney(exec.activeValue)}
            sub={`${exec.active.length} active`}
            tone="info"
          />
          <ExecKpi
            icon={<Trophy size={14} />}
            label="Won this period"
            value={fmtBigMoney(exec.wonValue)}
            sub={`${exec.won.length} closed · ${exec.conversionRate}% conv.`}
            tone="good"
          />
          <ExecKpi
            icon={<AlertTriangle size={14} />}
            label="Need attention"
            value={String(exec.needsAttention)}
            sub={exec.needsAttention === 0 ? "All on track" : "Review below"}
            tone={exec.needsAttention === 0 ? "good" : "warn"}
          />
          <ExecKpi
            icon={<Gauge size={14} />}
            label="Doc compliance"
            value={`${exec.docsPct}%`}
            sub={`${exec.docsAttached}/${exec.docsRequired} attached`}
            tone={exec.docsPct >= 80 ? "good" : exec.docsPct >= 50 ? "warn" : "bad"}
          />
        </div>

        {/* Hero focus card */}
        <div className="card overflow-hidden">
          <div
            className="relative h-[320px] bg-gradient-to-br from-accent/10 via-bg to-lime-soft/40 grid place-items-center"
            style={{
              backgroundImage:
                "radial-gradient(circle at 30% 30%, rgba(15,123,151,0.18), transparent 50%), radial-gradient(circle at 70% 70%, rgba(197,242,85,0.35), transparent 50%)",
            }}
          >
            <div className="absolute top-4 left-4 flex flex-col gap-2">
              <button className="w-9 h-9 rounded-full bg-surface/80 backdrop-blur-sm border border-border grid place-items-center text-muted hover:text-text">
                <Share2 size={14} />
              </button>
              <button className="w-9 h-9 rounded-full bg-surface/80 backdrop-blur-sm border border-border grid place-items-center text-muted hover:text-text">
                <ChevronLeft size={14} />
              </button>
            </div>
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-[0.2em] text-muted font-bold">Today's focus</div>
              <div className="text-2xl font-bold text-text mt-2">{focus?.name ?? "No active project"}</div>
              <div className="text-sm text-muted mt-1">
                {focus ? `${focus.client_name || "Internal"} · ${focus.tasks_done}/${focus.tasks} tasks` : "Spin up a project from the pipeline."}
              </div>
            </div>
            <div className="absolute bottom-4 right-4 flex items-center gap-2">
              <div className="flex -space-x-2">
                <span className="w-9 h-9 rounded-full bg-accent-soft text-accent text-xs font-bold border-2 border-surface grid place-items-center">{initial}</span>
                <span className="w-9 h-9 rounded-full bg-warn/15 text-warn text-xs font-bold border-2 border-surface grid place-items-center">+{(focus?.milestones ?? 0)}</span>
              </div>
              <button className="w-9 h-9 rounded-full bg-surface border border-border grid place-items-center text-muted hover:text-text">
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-bold text-text">{nextEvent?.title ?? "No upcoming meetings"}</div>
                <div className="text-sm text-muted mt-0.5">
                  {focus?.code} · {focus?.status.replace(/_/g, " ")}
                </div>
              </div>
              <button className="inline-flex items-center gap-1.5 bg-lime-soft text-success font-semibold rounded-full px-4 py-2 text-sm hover:opacity-90">
                <Copy size={13} /> Copy the link
              </button>
            </div>
          </div>
        </div>

        {/* Project overview timeline */}
        {focus && (
          <div className="rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg, #0c4a3a, #1e6b4b)" }}>
            <h3 className="text-base font-bold">Project overview</h3>
            <p className="text-sm text-white/70 mt-1 max-w-prose">
              {focus.name} — currently {focus.status.replace(/_/g, " ")}, with {focus.tasks_done}/{focus.tasks} tasks done.
            </p>
            <div className="mt-5">
              <div className="grid grid-cols-5 gap-2 text-[10px] uppercase tracking-wider font-semibold mb-2">
                {STAGE_FLOW.map((s, i) => (
                  <div key={s.key} className={`${i <= stageIdx ? "text-white" : "text-white/50"}`}>
                    {s.label}
                  </div>
                ))}
              </div>
              <div className="relative h-9 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${stagePct}%`,
                    background: "linear-gradient(90deg, rgba(197,242,85,0.95), rgba(197,242,85,0.7))",
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-end pr-3">
                  <div className="flex items-center gap-2 bg-white/15 rounded-full px-3 py-1">
                    <span className="w-6 h-6 rounded-full bg-accent-soft text-accent text-[10px] font-bold grid place-items-center">{initial}</span>
                    <div className="text-[11px] text-white">
                      <div className="font-semibold">{user?.name?.split(" ")[0] ?? "You"}</div>
                      <div className="text-white/70">Owns this</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex justify-between text-[11px] text-white/70 mt-3">
                {STAGE_FLOW.slice(0, 3).map((_, i) => {
                  const today = new Date();
                  const proj = new Date(today);
                  proj.setDate(today.getDate() - (i * 8));
                  return <span key={i}>{proj.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>;
                })}
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="bg-white/10 rounded-md p-3">
                <div className="text-[10px] uppercase tracking-wider text-white/70 font-semibold">Current step</div>
                <div className="font-semibold mt-1">
                  {STAGE_FLOW[stageIdx]?.label ?? "Not started"}
                </div>
                <div className="text-xs text-white/70 mt-1">
                  Notes on interactions and responsiveness, and link to file for review.
                </div>
              </div>
              <div className="bg-white/10 rounded-md p-3 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-white/70 font-semibold">Scale</div>
                  <div className="text-base font-bold mt-1">{focus.tasks_done}/{focus.tasks}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-white/70 font-semibold">Due</div>
                  <div className="text-base font-bold mt-1">{focus.end_date ? fmtMonthDay(focus.end_date) : "—"}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Pipeline by stage (merged from /dashboard) */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-text">Pipeline by stage</h3>
            <Link to="/pipeline" className="text-xs text-accent hover:underline font-medium">Open board →</Link>
          </div>
          {opps.length === 0 ? (
            <p className="text-sm text-muted italic py-4 text-center">
              Nothing yet. <Link to="/pipeline/new" className="text-accent hover:underline">Create an opportunity →</Link>
            </p>
          ) : (
            <ul className="space-y-2.5">
              {exec.stageBreakdown.filter((s) => s.count > 0).map((s) => (
                <li key={s.key} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-sm">
                  <span className="inline-flex items-center gap-2 truncate">
                    <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    <span className="text-text font-medium truncate">{s.label}</span>
                  </span>
                  <div className="h-2 bg-bg rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${(s.value / exec.maxStageValue) * 100}%`, background: s.color }}
                    />
                  </div>
                  <span className="text-right text-text font-semibold whitespace-nowrap">
                    {s.count} <span className="text-muted font-normal">· {fmtBigMoney(s.value)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ============ Right column ============ */}
      <div className="lg:col-span-3 space-y-5">
        {/* AI suggestions (dark card) */}
        <div className="rounded-2xl p-4 text-white" style={{ background: "linear-gradient(135deg, #1f2538, #131826)" }}>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold mb-2">
            <Sparkles size={12} className="text-lime" /> AI suggestions
          </div>
          <p className="text-sm leading-relaxed">
            {(work?.counts.overdue_tasks ?? 0) > 0
              ? `You have ${work?.counts.overdue_tasks} overdue task${work?.counts.overdue_tasks === 1 ? "" : "s"} — bump them to High Priority and set a due date this week?`
              : "Would you like to set this task to High Priority and add a due date for this week?"}{" "}
            <button className="text-lime font-semibold hover:underline ml-1">Yes</button>{" / "}
            <button className="text-white/70 hover:underline">No</button>
          </p>
        </div>

        {/* Scheduling */}
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-text">Scheduling</h3>
            {nextEvent && (
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-muted font-semibold">Friday</div>
                <div className="text-2xl font-bold text-text leading-none">
                  {new Date(nextEvent.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </div>
            )}
          </div>
          {!nextEvent ? (
            <p className="text-sm text-muted italic mt-3">No scheduled events. Add a milestone or due date.</p>
          ) : (
            <>
              <p className="text-sm text-muted mt-2">You have one scheduled event today — don't miss it!</p>
              <div className="mt-3 rounded-lg overflow-hidden border border-border">
                <div
                  className="h-32 bg-gradient-to-br from-accent-soft to-lime-soft"
                  style={{
                    backgroundImage:
                      "linear-gradient(135deg, rgba(15,123,151,0.2), rgba(197,242,85,0.4))",
                  }}
                />
                <div className="p-3 text-center">
                  <div className="text-sm font-bold text-text">{nextEvent.title}</div>
                  <div className="text-xs text-muted mt-1 flex items-center justify-center gap-3">
                    <span className="inline-flex items-center gap-1"><MapPin size={11} /> {nextEvent.project}</span>
                    <span className="inline-flex items-center gap-1"><Clock size={11} /> 10:30 AM</span>
                  </div>
                </div>
              </div>
              <button className="block w-full mt-3 text-center text-sm font-semibold text-success hover:underline">
                Mark this event
              </button>
            </>
          )}
        </Card>

        {/* File & media library */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-text">File &amp; media library</h3>
            <div className="flex gap-1">
              <button className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
                <Plus size={12} />
              </button>
              <button className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
                <Share2 size={12} />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <button className="w-9 h-9 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
              <ChevronLeft size={14} />
            </button>
            <div className="flex-1 mx-3">
              <div className="aspect-square rounded-2xl bg-lime-soft border border-lime/40 grid place-items-center relative overflow-hidden">
                <Folder size={56} className="text-success" fill="currentColor" />
                <div className="absolute top-3 right-3 bg-surface text-text font-bold text-xs px-2 py-1 rounded-full">
                  {(focus?.tasks ?? 0) + (focus?.milestones ?? 0)} files
                </div>
              </div>
              <div className="text-center mt-3">
                <div className="text-base font-bold text-text">Visual Vault</div>
                <p className="text-xs text-muted leading-relaxed mt-1">
                  A curated collection of all creative essentials — images, photos, icons and visual elements. Everything visual lives here.
                </p>
              </div>
            </div>
            <button className="w-9 h-9 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text">
              <ChevronRight size={14} />
            </button>
          </div>
          <Link
            to={focus ? `/projects/${focus.id}` : "/projects"}
            className="block text-center mt-3 bg-success text-white rounded-full py-2.5 text-sm font-semibold hover:opacity-90"
          >
            Open the folder
          </Link>
        </Card>
      </div>
    </div>
  );
}

function ExecKpi({
  icon, label, value, sub, tone = "neutral",
}: {
  icon: React.ReactNode; label: string; value: string; sub: string;
  tone?: "good" | "warn" | "bad" | "info" | "neutral";
}) {
  const valCls = {
    good: "text-success", warn: "text-warn", bad: "text-danger",
    info: "text-accent", neutral: "text-text",
  }[tone];
  const iconCls = {
    good: "bg-success/15 text-success",
    warn: "bg-warn/15 text-warn",
    bad: "bg-danger/15 text-danger",
    info: "bg-accent-soft text-accent",
    neutral: "bg-bg text-muted",
  }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-muted">
        <span className={`w-6 h-6 rounded-full grid place-items-center ${iconCls}`}>{icon}</span>
        {label}
      </div>
      <div className={`text-2xl font-bold mt-2 ${valCls}`}>{value}</div>
      <div className="text-[11px] text-muted mt-1 truncate">{sub}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-surface border border-border rounded-2xl p-4">{children}</div>;
}

function relTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  return `${day}d`;
}
