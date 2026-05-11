import { useMemo, useState, useEffect } from "react";
import { SmartButton } from "@/components/SmartButton";
import { Avatar } from "@/components/Avatar";
import { MeetingsCard } from "@/modules/me/MeetingsCard";
import { toast } from "@/lib/toast";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth, type Me } from "@/lib/auth";
import {
  CheckCircle2, Clock, AlertTriangle, ListChecks, FileText, Inbox, Github,
  PauseCircle, MessageSquare, ArrowRight, Plus, Calendar, Activity, Zap, X,
  Folder, ChevronRight, ChevronDown, Search, Link as LinkIcon, Briefcase, LayoutGrid, Rows3,
  Sparkles, Bell, XCircle, Pencil,
} from "lucide-react";

type TaskRow = {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "blocked" | "review" | "done";
  priority: number;
  due_on?: string;
  project_id: string;
  project_code?: string;
  project_name: string;
  created_at?: string;
  updated_at?: string;
};

type ProjectRow = {
  id: string; code: string; name: string;
  status: string; health: "green" | "amber" | "red"; role: string; allocation: number;
};

type WorkResponse = {
  counts: {
    active_tasks: number; overdue_tasks: number; blocked_tasks: number;
    active_projects: number; pending_updates: number; hours_this_week: number;
  };
  priorities: TaskRow[];
  projects: ProjectRow[];
};

type UpdateRow = {
  id: string;
  kind: "daily" | "weekly" | "blocker" | "accomplishment" | "next_action" | "risk";
  title: string;
  body?: string;
  for_date: string;
  created_at: string;
  project_name?: string;
};

type TimesheetRow = {
  id: string;
  work_date: string;
  hours: number;
  notes?: string;
  project_id: string;
  project_name: string;
  task_id?: string;
  task_title?: string;
};

type Profile = {
  id: string;
  email: string;
  name: string;
  github_username?: string;
  avatar_url?: string;
  mfa_enabled?: boolean;
  mfa_required?: boolean;
  roles: string[];
  performance: {
    tasks_done: number;
    tasks_overdue: number;
    blocked_now: number;
    updates_last_7: number;
    hours_last_30: number;
  };
};

const STATUS_LABEL: Record<TaskRow["status"], string> = {
  todo: "Not started", in_progress: "In progress", blocked: "Blocked",
  review: "Under review", done: "Completed",
};
const STATUS_COLOR: Record<TaskRow["status"], string> = {
  todo: "#94a3b8", in_progress: "#0F7B97", blocked: "#dc2626",
  review: "#a855f7", done: "#16a34a",
};
const PRIORITY_LABEL = ["", "Lowest", "Low", "Medium", "High", "Highest"];

type Tab = "dashboard" | "tasks" | "updates" | "timesheet" | "profile";

const VALID_TABS: Tab[] = ["dashboard", "tasks", "updates", "timesheet", "profile"];

export function MyWorkPage() {
  const [params, setParams] = useSearchParams();
  const initialTab = (() => {
    const q = params.get("tab");
    return (VALID_TABS as string[]).includes(q ?? "") ? (q as Tab) : "dashboard";
  })();
  const [tab, setTab] = useState<Tab>(initialTab);
  const { user } = useAuth();

  // Keep the URL ?tab in sync so deep-links from notifications land on the
  // right pane; preserves the rest of the query string (e.g. ?new=1).
  useEffect(() => {
    const q = params.get("tab");
    if (q !== tab) {
      const next = new URLSearchParams(params);
      if (tab === "dashboard") next.delete("tab");
      else next.set("tab", tab);
      setParams(next, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Lightweight counts that drive the tab badges. All cheap (already on the
  // /me/work payload or a tiny derived count); polled every minute so the
  // badges stay live without thrashing the page.
  const { data: badgeData } = useQuery<{
    counts: { active_tasks: number; overdue_tasks: number; blocked_tasks: number; pending_updates: number; hours_this_week: number };
    priorities: { id: string; due_on: string | null; status: string }[];
  }>({
    queryKey: ["me", "work", "badges"],
    queryFn: () => api("/api/v1/me/work"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: profileData } = useQuery<{ mfa_enabled?: boolean; mfa_required?: boolean }>({
    queryKey: ["me", "profile", "badges"],
    queryFn: () => api("/api/v1/me/profile"),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  // Badge rule of thumb: only render a number when there's something the
  // user can act on right now. Workload totals (e.g. "you have 3 tasks")
  // belong inside the page, not as an "attention" chip.
  const badges = useMemo(() => {
    const c = badgeData?.counts;
    // Today — count of fires (overdue + blocked). Both demand action today.
    const todayCount = c ? c.overdue_tasks + c.blocked_tasks : 0;
    // My tasks — only the *overdue* slice. Active total is workload info,
    // not a "you owe someone something" signal, so it doesn't earn a chip.
    const tasksCount = c ? c.overdue_tasks : 0;
    // Updates — pending daily updates not yet submitted. Whatever number the
    // API hands us is by definition actionable: each row is "submit me".
    const updatesCount = c ? c.pending_updates : 0;
    // Timesheet — no clean "one thing to do" signal exists. Past versions
    // fired purely on "hours < 10", which lit up every brand-new account.
    // Drop the badge here entirely and surface low-hours inside the tab if
    // we want a nudge.
    const timesheetCount = 0;
    // Profile — MFA setup pending only when the admin has marked the user
    // mfa_required.
    const profileCount = profileData?.mfa_required && !profileData?.mfa_enabled ? 1 : 0;
    return {
      dashboard: todayCount,
      tasks:     tasksCount,
      updates:   updatesCount,
      timesheet: timesheetCount,
      profile:   profileCount,
    };
  }, [badgeData, profileData]);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; badge?: number; badgeTone?: "danger" | "warn" | "accent" }[] = [
    { key: "dashboard", label: "Today",     icon: Zap,            badge: badges.dashboard, badgeTone: "danger" },
    { key: "tasks",     label: "My tasks",  icon: ListChecks,     badge: badges.tasks,     badgeTone: "danger" },
    { key: "updates",   label: "Updates",   icon: MessageSquare,  badge: badges.updates,   badgeTone: "warn"   },
    { key: "timesheet", label: "Timesheet", icon: Clock,          badge: badges.timesheet, badgeTone: "warn"   },
    { key: "profile",   label: "Profile",   icon: Github,         badge: badges.profile,   badgeTone: "danger" },
  ];

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">My work</div>
          <h1 className="h1 mt-1">Hi {(user?.name?.split(" ")[0]) || "there"} 👋</h1>
          <p className="text-sm text-muted mt-1">
            Your tasks, updates, and time — everything you own, none of the org-wide noise.
          </p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {tabs.map((t) => {
          const active = tab === t.key;
          const show = (t.badge ?? 0) > 0;
          // Badge palette — keeps the chip readable against both the
          // active-accent pill background and the muted resting state.
          const tone = t.badgeTone ?? "accent";
          const chipBg = active
            ? "bg-white text-accent"
            : tone === "danger" ? "bg-danger text-white"
            : tone === "warn"   ? "bg-warn   text-white"
            : "bg-accent text-white";
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
            >
              <t.icon size={14} /> {t.label}
              {show && (
                <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold grid place-items-center ${chipBg}`}>
                  {(t.badge ?? 0) > 9 ? "9+" : t.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "dashboard" && <DashboardTab />}
      {tab === "tasks"     && <TasksTab />}
      {tab === "updates"   && <UpdatesTab />}
      {tab === "timesheet" && <TimesheetTab />}
      {tab === "profile"   && <ProfileTab />}
    </div>
  );
}

/* ---------- Dashboard ---------- */

function DashboardTab() {
  const { data, isLoading } = useQuery<WorkResponse>({
    queryKey: ["me", "work"], queryFn: () => api("/api/v1/me/work"),
  });
  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  const c = data.counts;
  // Derived insights — computed once, shared by the briefing, triage panel,
  // and the "next moves" card so the dashboard stays coherent.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const oneDayMs = 86_400_000;
  const triage = data.priorities.map((t) => {
    const due = t.due_on ? new Date(t.due_on).getTime() : null;
    const daysFromToday = due ? Math.round((due - todayMs) / oneDayMs) : null;
    let bucket: "overdue" | "today" | "blocked" | "soon" | "later" = "later";
    if (t.status === "blocked") bucket = "blocked";
    else if (daysFromToday != null && daysFromToday < 0) bucket = "overdue";
    else if (daysFromToday != null && daysFromToday === 0) bucket = "today";
    else if (daysFromToday != null && daysFromToday <= 3) bucket = "soon";
    return { ...t, bucket, daysFromToday };
  });
  const overdue   = triage.filter((t) => t.bucket === "overdue");
  const dueToday  = triage.filter((t) => t.bucket === "today");
  const blocked   = triage.filter((t) => t.bucket === "blocked");
  const dueSoon   = triage.filter((t) => t.bucket === "soon");
  const rest      = triage.filter((t) => t.bucket === "later");
  const orderedTriage = [...overdue, ...dueToday, ...blocked, ...dueSoon, ...rest];

  // Health pulse — qualitative read on how the user is doing right now.
  const health: { label: string; tone: "good" | "warn" | "bad"; sub: string } = (() => {
    if (overdue.length >= 3 || blocked.length >= 2) {
      return { label: "Falling behind", tone: "bad", sub: "Multiple overdue or blocked tasks need attention." };
    }
    if (overdue.length > 0 || blocked.length > 0) {
      return { label: "Pay attention", tone: "warn", sub: "A few items are slipping — clear them today." };
    }
    if (c.active_tasks === 0) {
      return { label: "Inbox zero", tone: "good", sub: "Nothing on your plate — sync with your PM for new work." };
    }
    return { label: "On track", tone: "good", sub: "Healthy task flow. Keep shipping." };
  })();
  const healthCls = { good: "bg-success/10 text-success border-success/30",
                      warn: "bg-warn/10 text-warn border-warn/30",
                      bad:  "bg-danger/10 text-danger border-danger/30" }[health.tone];

  // Adaptive briefing — single sentence that summarises the situation. Skips
  // pieces that don't apply so it never reads like a template.
  const briefingPieces: string[] = [];
  if (overdue.length > 0)  briefingPieces.push(`${overdue.length} overdue`);
  if (dueToday.length > 0) briefingPieces.push(`${dueToday.length} due today`);
  if (blocked.length > 0)  briefingPieces.push(`${blocked.length} blocked`);
  if (dueSoon.length > 0)  briefingPieces.push(`${dueSoon.length} due within 3 days`);
  const briefing = briefingPieces.length === 0
    ? c.active_tasks > 0
      ? `${c.active_tasks} task${c.active_tasks === 1 ? "" : "s"} in flight — no urgent deadlines on the horizon.`
      : "Your queue is clear."
    : briefingPieces.join(" · ");

  // Suggested next moves — 2-4 concrete prompts based on state. Adaptive.
  const suggestions: { icon: React.ReactNode; title: string; body: string; tone: "warn" | "info" | "good" }[] = [];
  if (overdue.length > 0) {
    const worst = overdue[0];
    suggestions.push({
      icon: <AlertTriangle size={14} />,
      title: `Tackle "${worst.title}" first`,
      body: `Overdue by ${Math.abs(worst.daysFromToday ?? 0)} day${Math.abs(worst.daysFromToday ?? 0) === 1 ? "" : "s"}. Clearing oldest-first beats trying to catch up everywhere.`,
      tone: "warn",
    });
  }
  if (blocked.length > 0) {
    suggestions.push({
      icon: <PauseCircle size={14} />,
      title: `Unblock ${blocked.length} task${blocked.length === 1 ? "" : "s"}`,
      body: `Open each one, leave a comment naming what's needed and who owns the resolution. Blocked tasks don't unblock themselves.`,
      tone: "warn",
    });
  }
  if (c.pending_updates > 0) {
    suggestions.push({
      icon: <MessageSquare size={14} />,
      title: "Submit your daily update",
      body: `It's been ${c.pending_updates} day${c.pending_updates === 1 ? "" : "s"} since your last check-in. A two-line update keeps your PM out of your inbox.`,
      tone: "info",
    });
  }
  if (c.hours_this_week < 10 && c.active_tasks > 0) {
    suggestions.push({
      icon: <Clock size={14} />,
      title: "Log your hours",
      body: `Only ${c.hours_this_week.toFixed(1)}h logged this week. Time entries feed the burnout watchlist and capacity planning — keep them current.`,
      tone: "info",
    });
  }
  if (suggestions.length === 0 && c.active_tasks > 0) {
    suggestions.push({
      icon: <CheckCircle2 size={14} />,
      title: "Keep momentum",
      body: "Nothing's slipping. Ship the next thing on the list before the day fills up with meetings.",
      tone: "good",
    });
  }

  return (
    <div className="space-y-5">
      {/* Heads-up panel — recent unread workspace events that landed on this
          user (leave decisions, kudos, milestone assignments, mentions). */}
      <HeadsUpPanel />

      {/* Microsoft calendar — only renders when the workspace has wired the
          Azure AD app. Otherwise stays silent so nobody sees an orphan card. */}
      <MeetingsCard />

      {/* Smart briefing — adaptive headline, health badge, briefing sentence */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted">Today's briefing</div>
            <div className="text-[15px] text-text mt-1.5 leading-snug max-w-2xl">{briefing}</div>
          </div>
          <span className={`pill ${healthCls} whitespace-nowrap`} title={health.sub}>
            <Activity size={11} /> {health.label}
          </span>
        </div>
        <div className="text-[11.5px] text-muted mt-1.5 leading-snug">{health.sub}</div>
      </section>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile label="Active tasks"    value={c.active_tasks}    icon={<ListChecks size={14} />}     tone="info" />
        <KpiTile label="Overdue"         value={c.overdue_tasks}   icon={<AlertTriangle size={14} />}  tone={c.overdue_tasks ? "bad" : "good"} />
        <KpiTile label="Blocked"         value={c.blocked_tasks}   icon={<PauseCircle size={14} />}    tone={c.blocked_tasks ? "warn" : "good"} />
        <KpiTile label="Hours this week" value={`${c.hours_this_week.toFixed(1)}h`} icon={<Clock size={14} />} tone="neutral" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Triage — overdue → today → blocked → soon → rest */}
        <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="h2 flex items-center gap-2"><Zap size={16} className="text-accent" /> Needs you now</h2>
            <div className="flex items-center gap-1.5 flex-wrap">
              {overdue.length > 0  && <span className="pill bg-danger/15 text-danger">{overdue.length} overdue</span>}
              {dueToday.length > 0 && <span className="pill bg-warn/15 text-warn">{dueToday.length} today</span>}
              {blocked.length > 0  && <span className="pill bg-warn/15 text-warn">{blocked.length} blocked</span>}
              {overdue.length === 0 && dueToday.length === 0 && blocked.length === 0 && (
                <span className="text-xs text-muted">{data.priorities.length} item{data.priorities.length === 1 ? "" : "s"}</span>
              )}
            </div>
          </div>
          {data.priorities.length === 0 ? (
            <EmptyHint
              icon={<CheckCircle2 size={22} className="text-success" />}
              title="Inbox zero"
              body="You don't have any open tasks. Take a breather or sync with your PM for new work."
            />
          ) : (
            <ul className="divide-y divide-border">
              {orderedTriage.map((t) => (
                <li key={t.id} className="relative">
                  {/* Left edge accent strip — quick visual cue for bucket */}
                  <span className={`absolute left-0 top-0 bottom-0 w-1 rounded-r ${
                    t.bucket === "overdue" ? "bg-danger"
                    : t.bucket === "blocked" ? "bg-warn"
                    : t.bucket === "today"   ? "bg-accent"
                    : t.bucket === "soon"    ? "bg-accent/40"
                    : "bg-transparent"
                  }`} />
                  <div className="pl-3">
                    <TaskRowItem task={t} compact />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Active projects */}
        <section className="bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2 flex items-center gap-2"><Activity size={16} className="text-accent" /> Your projects</h2>
            <span className="text-xs text-muted">{data.projects.length}</span>
          </div>
          {data.projects.length === 0 ? (
            <EmptyHint
              icon={<Inbox size={22} className="text-muted" />}
              title="Not on any project yet"
              body="A project manager will assign you when there's work to ship."
            />
          ) : (
            <ul className="space-y-2.5">
              {data.projects.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/projects/${p.id}`}
                    className="block bg-bg/60 border border-border rounded-xl px-3 py-2.5 hover:border-accent transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-bold text-text truncate">{p.name}</span>
                      <span className={`pill ${
                        p.health === "green" ? "bg-success/15 text-success"
                        : p.health === "amber" ? "bg-warn/15 text-warn"
                        : "bg-danger/15 text-danger"
                      }`}>{p.health}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted mt-0.5">
                      <span className="truncate">{p.role || "Member"} · {p.code}</span>
                      <span>{Math.round(p.allocation * 100)}%</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {suggestions.length > 0 && (
        <section className="bg-surface border border-border rounded-2xl p-5">
          <h2 className="h2 flex items-center gap-2 mb-3">
            <Sparkles size={16} className="text-accent" /> Suggested next moves
          </h2>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {suggestions.map((s, i) => {
              const toneCls = s.tone === "warn" ? "bg-warn/10 text-warn border-warn/30"
                : s.tone === "info" ? "bg-accent-soft text-accent border-accent/30"
                : "bg-success/10 text-success border-success/30";
              return (
                <li key={i} className="flex items-start gap-3 bg-bg/40 border border-border rounded-xl p-3">
                  <span className={`w-7 h-7 rounded-full grid place-items-center shrink-0 border ${toneCls}`}>
                    {s.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-text">{s.title}</div>
                    <div className="text-[12px] text-muted leading-snug mt-0.5">{s.body}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

type FileRow = {
  id: string;
  kind: string;
  name: string;
  object_key: string;
  uploaded_at: string;
  project_id?: string;
  project_name?: string;
  opportunity_id: string;
  opportunity_title: string;
};

const DOC_KIND_LABELS: Record<string, string> = {
  NDA: "NDA",
  TechnicalProposal: "Technical proposal",
  ScopeDocument: "Scope",
  RFP: "RFP",
  ComplianceForm: "Compliance",
  ProcurementApproval: "Procurement",
  MSA: "MSA",
  Contract: "Contract",
  ExportComplianceForm: "Export form",
  FXApproval: "FX approval",
  GrantAgreement: "Grant",
};

function fileTypeFromName(name: string, objectKey: string): string {
  const m = (name + " " + objectKey).toLowerCase().match(/\.([a-z0-9]{2,5})(\?|$|\b)/);
  return m ? m[1].toUpperCase() : "FILE";
}

function isUrl(key: string): boolean {
  return /^https?:\/\//i.test(key);
}

// Image-extension detection — drives whether we render a thumbnail preview.
function isImageExt(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext.toLowerCase());
}

// Pretty display name. Backend sometimes hands us UUIDs as `name`; if so, fall
// back to the kind label + first 6 chars + extension.
function displayName(file: FileRow): string {
  const raw = (file.name || "").trim();
  const looksLikeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw)
    || /^[a-f0-9]{16,}$/i.test(raw);
  if (raw && !looksLikeUuid) return raw;
  const kindLabel = DOC_KIND_LABELS[file.kind] ?? file.kind;
  const ext = fileTypeFromName(file.name, file.object_key);
  if (ext === "FILE") return kindLabel;
  return `${kindLabel}.${ext.toLowerCase()}`;
}

function relTimeShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

type ProjectGroup = {
  key: string;
  projectId?: string;
  projectName?: string;
  opportunityId: string;
  opportunityTitle: string;
  isProject: boolean; // true if linked to a project, false if opportunity-only
  items: FileRow[];
  lastUpdated: string;
  byKind: { kind: string; label: string; items: FileRow[] }[];
};

function fileExtColor(ext: string, isLink: boolean): string {
  if (isLink) return "bg-accent-soft text-accent border-accent/20";
  const e = ext.toLowerCase();
  if (["pdf"].includes(e)) return "bg-rose-50 text-rose-600 border-rose-100";
  if (["doc","docx","rtf","txt"].includes(e)) return "bg-sky-50 text-sky-600 border-sky-100";
  if (["xls","xlsx","csv"].includes(e)) return "bg-emerald-50 text-emerald-600 border-emerald-100";
  if (["png","jpg","jpeg","gif","webp","svg"].includes(e)) return "bg-violet-50 text-violet-600 border-violet-100";
  if (["zip","rar","7z","tar","gz"].includes(e)) return "bg-amber-50 text-amber-600 border-amber-100";
  return "bg-bg text-muted border-border";
}

export function FileLibraryCard() {
  const { data, isLoading } = useQuery<{ items: FileRow[] }>({
    queryKey: ["me", "files"], queryFn: () => api("/api/v1/me/files"),
  });
  const [view, setView] = useState<"project" | "kind" | "flat">("project");
  const [layout, setLayout] = useState<"scroll" | "grid">("grid");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAllProjects, setShowAllProjects] = useState(false);
  const PROJECT_PREVIEW = 3;

  // Layout classes shared by every file list inside a section.
  // - scroll: horizontal strip; cards have a min width so 3-4 fit before overflow.
  // - grid:   auto-fill with a min card width — always packs the maximum number of
  //           columns that fit the *container*, so it works correctly even when the
  //           list is nested inside a narrower project card. (Viewport breakpoints
  //           like `lg:grid-cols-3` don't help here — the grid lives inside a
  //           padded parent, so the container width is what matters, not the viewport.)
  const listCls = layout === "scroll"
    ? "flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1 [scrollbar-width:thin]"
    : "grid gap-2 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]";
  const itemCls = layout === "scroll"
    ? "snap-start shrink-0 w-[260px]"
    : "min-w-0";

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((f) =>
      f.name.toLowerCase().includes(q) ||
      (DOC_KIND_LABELS[f.kind] ?? f.kind).toLowerCase().includes(q) ||
      (f.project_name ?? "").toLowerCase().includes(q) ||
      (f.opportunity_title ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  // Build project-first grouping, with sub-grouping by kind inside each project
  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const map = new Map<string, ProjectGroup>();
    filtered.forEach((f) => {
      const key = f.project_id ?? `opp:${f.opportunity_id}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          projectId: f.project_id,
          projectName: f.project_name,
          opportunityId: f.opportunity_id,
          opportunityTitle: f.opportunity_title,
          isProject: !!f.project_id,
          items: [],
          lastUpdated: f.uploaded_at,
          byKind: [],
        };
        map.set(key, g);
      }
      g.items.push(f);
      if (new Date(f.uploaded_at).getTime() > new Date(g.lastUpdated).getTime()) {
        g.lastUpdated = f.uploaded_at;
      }
    });
    // Sub-group by kind inside each project
    map.forEach((g) => {
      const k = new Map<string, FileRow[]>();
      g.items.forEach((f) => {
        const arr = k.get(f.kind) ?? [];
        arr.push(f); k.set(f.kind, arr);
      });
      g.byKind = Array.from(k.entries())
        .map(([kind, arr]) => ({
          kind,
          label: DOC_KIND_LABELS[kind] ?? kind,
          items: arr.sort((a, b) => +new Date(b.uploaded_at) - +new Date(a.uploaded_at)),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    });
    return Array.from(map.values()).sort((a, b) => {
      // Projects first, then opportunity-only; within, most recently updated first
      if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
      return +new Date(b.lastUpdated) - +new Date(a.lastUpdated);
    });
  }, [filtered]);

  const kindGroups = useMemo(() => {
    const map = new Map<string, FileRow[]>();
    filtered.forEach((f) => {
      const arr = map.get(f.kind) ?? [];
      arr.push(f); map.set(f.kind, arr);
    });
    return Array.from(map.entries())
      .map(([kind, arr]) => ({
        kind,
        label: DOC_KIND_LABELS[kind] ?? kind,
        items: arr.sort((a, b) => +new Date(b.uploaded_at) - +new Date(a.uploaded_at)),
      }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [filtered]);

  const toggle = (k: string) => setCollapsed((s) => ({ ...s, [k]: !s[k] }));

  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="h2 flex items-center gap-2"><Folder size={16} className="text-accent" /> File &amp; media library</h2>
          <p className="text-xs text-muted mt-0.5">
            {isLoading
              ? "Loading…"
              : `${items.length} document${items.length === 1 ? "" : "s"} across ${projectGroups.filter((g) => g.isProject).length} project${projectGroups.filter((g) => g.isProject).length === 1 ? "" : "s"}`}
          </p>
        </div>
        {items.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files…"
                className="pl-7 pr-2 py-1.5 text-[12px] bg-bg border border-border rounded-full w-[180px] focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-1 p-1 bg-bg border border-border rounded-full">
              {(["project","kind","flat"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setView(g)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize transition-colors ${
                    view === g ? "bg-surface shadow-sm text-text" : "text-muted hover:text-text"
                  }`}
                >
                  {g === "flat" ? "Flat" : `By ${g}`}
                </button>
              ))}
            </div>
            <div className="flex gap-1 p-1 bg-bg border border-border rounded-full" title="Toggle layout">
              <button
                onClick={() => { setLayout("grid"); setCollapsed({}); }}
                className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${
                  layout === "grid" ? "bg-surface shadow-sm text-text" : "text-muted hover:text-text"
                }`}
                aria-label="Grid"
                title="Grid layout"
              >
                <LayoutGrid size={13} />
              </button>
              <button
                onClick={() => { setLayout("scroll"); setCollapsed({}); }}
                className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${
                  layout === "scroll" ? "bg-surface shadow-sm text-text" : "text-muted hover:text-text"
                }`}
                aria-label="Scrollable strip"
                title="Scrollable strip"
              >
                <Rows3 size={13} />
              </button>
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted py-4">Loading documents…</div>
      ) : items.length === 0 ? (
        <EmptyHint
          icon={<Folder size={22} className="text-muted" />}
          title="No documents yet"
          body="Documents you attach to opportunities and projects show up here. Open a project to attach a file or paste a link."
        />
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted py-4 text-center">No files match "{query}".</div>
      ) : view === "project" ? (
        <div className="space-y-3">
          {(showAllProjects ? projectGroups : projectGroups.slice(0, PROJECT_PREVIEW)).map((g) => (
            <ProjectFileGroup
              key={g.key}
              group={g}
              collapsed={!!collapsed[g.key]}
              onToggle={() => toggle(g.key)}
              listCls={listCls}
              itemCls={itemCls}
            />
          ))}
          {projectGroups.length > PROJECT_PREVIEW && (
            <div className="flex justify-center pt-1">
              <button
                onClick={() => setShowAllProjects((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-accent hover:underline px-3 py-1.5 rounded-full border border-border bg-surface hover:bg-bg transition-colors"
              >
                {showAllProjects
                  ? <>Show fewer projects <ChevronDown size={13} className="rotate-180" /></>
                  : <>View {projectGroups.length - PROJECT_PREVIEW} more project{projectGroups.length - PROJECT_PREVIEW === 1 ? "" : "s"} <ChevronDown size={13} /></>}
              </button>
            </div>
          )}
        </div>
      ) : view === "kind" ? (
        <div className="space-y-4">
          {kindGroups.map((kg) => (
            <div key={kg.kind}>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[11px] uppercase tracking-wide font-bold text-muted">{kg.label}</div>
                <div className="px-1.5 py-px rounded-full bg-bg border border-border text-[10px] font-bold text-muted">
                  {kg.items.length}
                </div>
                <div className="flex-1 h-px bg-border" />
              </div>
              <ul className={listCls}>
                {kg.items.map((f) => (
                  <li key={f.id} className={itemCls}>
                    <FileCard file={f} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className={listCls}>
          {[...filtered]
            .sort((a, b) => +new Date(b.uploaded_at) - +new Date(a.uploaded_at))
            .map((f) => (
              <li key={f.id} className={itemCls}>
                <FileCard file={f} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

/* Project group — compact header, kind-filter chip row, then a single media
 * grid of files matching the active kind. Replaces the noisy nested
 * "PROCUREMENT 1 / NDA 1 / RFP 1" sub-section list. */
function ProjectFileGroup({
  group, collapsed, onToggle, listCls, itemCls,
}: {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: () => void;
  listCls: string;
  itemCls: string;
}) {
  const [activeKind, setActiveKind] = useState<string>("all");
  const targetUrl = group.isProject && group.projectId
    ? `/projects/${group.projectId}` : `/pipeline/${group.opportunityId}`;

  const visible = activeKind === "all"
    ? group.items
    : group.items.filter((f) => f.kind === activeKind);

  return (
    <div className="border border-border rounded-2xl overflow-hidden bg-bg/30">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 bg-surface">
        <button
          onClick={onToggle}
          className="text-muted hover:text-text shrink-0"
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <div className={`w-9 h-9 rounded-xl grid place-items-center shrink-0 ${
          group.isProject ? "bg-accent-soft text-accent" : "bg-warn/10 text-warn"
        }`}>
          {group.isProject ? <Briefcase size={15} /> : <FileText size={15} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-bold text-text truncate" title={group.projectName ?? group.opportunityTitle}>
              {group.projectName ?? group.opportunityTitle}
            </span>
            {!group.isProject && (
              <span className="text-[9.5px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-warn/15 text-warn">
                Pre-project
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted truncate">
            {group.items.length} file{group.items.length === 1 ? "" : "s"} · updated {relTimeShort(group.lastUpdated)}
          </div>
        </div>
        <Link
          to={targetUrl}
          className="text-xs font-semibold text-accent hover:underline whitespace-nowrap shrink-0"
        >
          Open {group.isProject ? "project" : "lead"} →
        </Link>
      </div>

      {!collapsed && (
        <>
          {/* Kind filter chip row — only renders when there's more than one kind */}
          {group.byKind.length > 1 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              <KindChip
                label="All"
                count={group.items.length}
                active={activeKind === "all"}
                onClick={() => setActiveKind("all")}
              />
              {group.byKind.map((kg) => (
                <KindChip
                  key={kg.kind}
                  label={kg.label}
                  count={kg.items.length}
                  active={activeKind === kg.kind}
                  onClick={() => setActiveKind(kg.kind)}
                />
              ))}
            </div>
          )}

          {/* Media grid */}
          <div className="p-3">
            <ul className={listCls}>
              {visible.map((f) => (
                <li key={f.id} className={itemCls}>
                  <FileCard file={f} />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function KindChip({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-surface text-muted border-border hover:text-text hover:border-accent/40"
      }`}
    >
      {label}
      <span className={active ? "opacity-75" : "opacity-60"}>{count}</span>
    </button>
  );
}

/* Compact, polished file card. Image previews when the object_key is an image
 * URL; coloured extension badge otherwise. Smart filename so opaque UUID names
 * don't pollute the UI. */
function FileCard({ file }: { file: FileRow }) {
  const ext = fileTypeFromName(file.name, file.object_key);
  const url = isUrl(file.object_key);
  const isImg = isImageExt(ext) && url;
  const name = displayName(file);
  const kindLabel = DOC_KIND_LABELS[file.kind] ?? file.kind;
  const colorCls = fileExtColor(ext, url && !isImg);

  const Body = (
    <div className="h-full flex flex-col bg-surface border border-border rounded-xl overflow-hidden hover:border-accent hover:shadow-soft transition-all group">
      {/* Top row — preview or extension badge */}
      <div className="relative aspect-[16/9] bg-bg/40 border-b border-border overflow-hidden">
        {isImg ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={file.object_key}
            alt={name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className={`w-12 h-12 rounded-xl grid place-items-center text-[10.5px] font-extrabold border ${colorCls}`}>
              {url ? <LinkIcon size={16} /> : ext.slice(0, 4)}
            </div>
          </div>
        )}
        {/* Extension chip (top-right) */}
        <span className={`absolute top-1.5 right-1.5 text-[9.5px] uppercase tracking-wider font-extrabold px-1.5 py-0.5 rounded ${
          isImg ? "bg-black/55 text-white backdrop-blur-sm" : "bg-surface/90 backdrop-blur-sm text-muted border border-border"
        }`}>
          {url && !isImg ? "URL" : ext}
        </span>
      </div>

      {/* Body — name, kind chip, meta */}
      <div className="flex flex-col flex-1 p-2.5 gap-1">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <span className="text-[12.5px] font-semibold text-text leading-snug truncate" title={file.name || name}>
            {name}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-px rounded bg-accent-soft text-accent truncate max-w-[60%]">
            {kindLabel}
          </span>
          <span className="text-[10.5px] text-muted whitespace-nowrap">{relTimeShort(file.uploaded_at)}</span>
        </div>
      </div>
    </div>
  );

  // URLs open in new tab; storage-keyed files route to the source so the user
  // can preview from the opportunity page.
  return url ? (
    <a href={file.object_key} target="_blank" rel="noopener noreferrer" className="block h-full">
      {Body}
    </a>
  ) : (
    <Link to={`/pipeline/${file.opportunity_id}`} className="block h-full">
      {Body}
    </Link>
  );
}

/* ---------- Tasks ---------- */

const TASK_FILTERS: { key: "all" | TaskRow["status"]; label: string }[] = [
  { key: "all",         label: "All" },
  { key: "todo",        label: "Not started" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked",     label: "Blocked" },
  { key: "review",      label: "Under review" },
  { key: "done",        label: "Completed" },
];

function TasksTab() {
  const [filter, setFilter] = useState<"all" | TaskRow["status"]>("all");
  const { data, isLoading } = useQuery<{ items: TaskRow[] }>({
    queryKey: ["me", "tasks", filter], queryFn: () => api(`/api/v1/me/tasks?status=${filter}`),
  });
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {TASK_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${
              filter === f.key ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyHint icon={<ListChecks size={22} className="text-muted" />} title="No tasks here" body="Try a different status filter." />
      ) : (
        <ul className="bg-surface border border-border rounded-2xl divide-y divide-border overflow-hidden">
          {items.map((t) => <TaskRowItem key={t.id} task={t} />)}
        </ul>
      )}
    </div>
  );
}

function TaskRowItem({ task, compact }: { task: TaskRow; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const overdue = task.due_on && task.status !== "done" && new Date(task.due_on) < new Date(new Date().toDateString());
  return (
    <>
      <li className={`flex items-center gap-3 ${compact ? "py-3" : "p-4"} hover:bg-bg/40 transition-colors`}>
        <span
          className="w-3 h-3 rounded-full shrink-0"
          style={{ background: STATUS_COLOR[task.status] }}
          title={STATUS_LABEL[task.status]}
        />
        <button onClick={() => setOpen(true)} className="flex-1 min-w-0 text-left">
          <div className="text-[14px] font-semibold text-text truncate">{task.title}</div>
          <div className="text-[12px] text-muted truncate">
            {task.project_name}
            {task.due_on && (
              <> · <span className={overdue ? "text-danger font-bold" : ""}>
                {overdue ? "Overdue " : "Due "}{new Date(task.due_on).toLocaleDateString("en-US", { day: "numeric", month: "short" })}
              </span></>
            )}
          </div>
        </button>
        <span className={`pill ${
          task.priority <= 1 ? "bg-danger/15 text-danger"
          : task.priority === 2 ? "bg-warn/15 text-warn"
          : "bg-bg text-muted"
        }`}>P{task.priority}</span>
        <span className="hidden md:inline text-[12px] text-text font-semibold">{STATUS_LABEL[task.status]}</span>
        <button onClick={() => setOpen(true)} className="text-muted hover:text-text">
          <ArrowRight size={14} />
        </button>
      </li>
      {open && <TaskDialog task={task} onClose={() => setOpen(false)} />}
    </>
  );
}

const QUICK_PROMPTS: { label: string; emoji: string; setStatus?: TaskRow["status"]; template: string }[] = [
  { label: "Progress update", emoji: "🟢", setStatus: "in_progress", template: "Update: " },
  { label: "I'm blocked",     emoji: "🚧", setStatus: "blocked",     template: "Blocked by: " },
  { label: "Need review",     emoji: "👀", setStatus: "review",      template: "Ready for review — please look at: " },
  { label: "Waiting on info", emoji: "⏳",                            template: "Waiting on: " },
  { label: "Shipped",         emoji: "🚀", setStatus: "done",        template: "Shipped — what landed: " },
];

function ageInDays(iso?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function fmtCommentTime(iso: string): string {
  const d = new Date(iso);
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// Lightweight inline-renderer: turns @mentions into accent-coloured pills so
// blockers like "Blocked by: @Alex" stand out at a glance in the activity feed.
function renderBody(body: string) {
  const parts = body.split(/(@[\p{L}0-9._-]+)/u);
  return parts.map((p, i) =>
    p.startsWith("@")
      ? <span key={i} className="text-accent font-semibold">{p}</span>
      : <span key={i}>{p}</span>,
  );
}

function TaskDialog({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<TaskRow["status"]>(task.status);
  const [note, setNote] = useState("");
  const [blockerReason, setBlockerReason] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");

  const { data: comments } = useQuery<{ items: { id: string; body: string; author: string; created_at: string }[] }>({
    queryKey: ["me-task-comments", task.id], queryFn: () => api(`/api/v1/me/tasks/${task.id}/comments`),
  });

  // Pull workspace members so we can offer an @mention picker in the note
  // textarea. Cached at the page level since several rows can open the dialog.
  const { data: membersData } = useQuery<{ items: { id: string; name: string; email: string }[] }>({
    queryKey: ["members-mention"],
    queryFn: () => api("/api/v1/members"),
    staleTime: 5 * 60_000,
  });
  const members = membersData?.items ?? [];
  const mentionMatches = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return members.slice(0, 6);
    return members.filter((m) => (m.name || m.email).toLowerCase().includes(q)).slice(0, 6);
  }, [members, mentionQuery]);

  function applyPrompt(p: typeof QUICK_PROMPTS[number]) {
    if (p.setStatus) setStatus(p.setStatus);
    if (p.setStatus === "blocked") {
      // Blocker prompt steers the user into the dedicated reason field instead
      // of the free-form note so it's structured for the activity feed.
      setBlockerReason((cur) => cur || "");
      return;
    }
    setNote((cur) => {
      const tpl = p.template;
      if (cur.trim()) return cur + "\n\n" + tpl;
      return tpl;
    });
  }

  function insertMention(name: string) {
    // Replace the last "@<partial>" sequence with the full handle.
    setNote((cur) => {
      const trimmed = cur.replace(/@[\p{L}0-9._-]*$/u, "");
      const handle = "@" + name.replace(/\s+/g, "");
      const sep = trimmed.length > 0 && !trimmed.endsWith(" ") && !trimmed.endsWith("\n") ? " " : "";
      return trimmed + sep + handle + " ";
    });
    setMentionOpen(false);
  }

  function onNoteChange(v: string) {
    setNote(v);
    // Heuristic mention trigger: open the picker when the cursor is just after
    // "@<word>" and there's no whitespace yet. Closes on space, enter, or
    // explicit dismiss.
    const m = v.match(/@([\p{L}0-9._-]*)$/u);
    if (m) {
      setMentionQuery(m[1]);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }
  }

  // Compose the final comment body so a blocker becomes a structured first
  // line that the activity feed and any downstream burnout/risk worker can
  // recognise. Free-form note stays underneath.
  function composeBody(): string {
    const parts: string[] = [];
    if (status === "blocked" && blockerReason.trim()) {
      parts.push(`🚧 Blocked by: ${blockerReason.trim()}`);
    }
    if (note.trim()) parts.push(note.trim());
    return parts.join("\n\n");
  }

  const update = useMutation({
    mutationFn: () => api(`/api/v1/me/tasks/${task.id}/status`, {
      method: "POST", body: JSON.stringify({ status, comment: composeBody() }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["me-task-comments", task.id] });
      onClose();
    },
  });
  const addComment = useMutation({
    mutationFn: () => api(`/api/v1/me/tasks/${task.id}/comments`, {
      method: "POST", body: JSON.stringify({ body: composeBody() }),
    }),
    onSuccess: () => {
      setNote("");
      setBlockerReason("");
      qc.invalidateQueries({ queryKey: ["me-task-comments", task.id] });
    },
  });

  const age = ageInDays(task.created_at);
  const hasMentions = /@[\p{L}0-9._-]+/u.test(composeBody());

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-card w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 p-5 border-b border-border">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold">{task.project_name}</div>
            <h2 className="text-lg font-bold text-text mt-0.5">{task.title}</h2>
            <div className="flex items-center gap-2 mt-1.5 text-xs text-muted flex-wrap">
              <span className="pill" style={{ background: STATUS_COLOR[task.status] + "22", color: STATUS_COLOR[task.status] }}>
                {STATUS_LABEL[task.status]}
              </span>
              <span>· P{task.priority} · {PRIORITY_LABEL[task.priority]}</span>
              {task.due_on && <span>· Due {new Date(task.due_on).toLocaleDateString("en-US", { day:"numeric", month:"short", year:"numeric" })}</span>}
              {age !== null && <span>· {age}d old</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1"><X size={18} /></button>
        </header>

        <div className="overflow-auto flex-1 p-5 space-y-5">
          {task.description && (
            <p className="text-sm text-text leading-relaxed whitespace-pre-wrap">{task.description}</p>
          )}

          {/* Quick prompts — one-tap status + template */}
          <div>
            <div className="label">Quick update</div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPrompt(p)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full border border-border bg-bg/40 text-text hover:border-accent/40 hover:bg-accent-soft/40 transition-colors"
                >
                  <span>{p.emoji}</span>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="label">Status</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {(Object.keys(STATUS_LABEL) as TaskRow["status"][]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`px-3 py-2 rounded-lg border text-sm font-semibold transition-colors ${
                    status === s
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-muted hover:bg-bg"
                  }`}
                >
                  <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: STATUS_COLOR[s] }} />
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Dedicated blocker field — appears only when status is blocked so it
              feels causal rather than always-present clutter. */}
          {status === "blocked" && (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-danger" />
                <div className="text-sm font-bold text-text">What's blocking you?</div>
              </div>
              <textarea
                className="input min-h-[60px] text-sm bg-surface"
                value={blockerReason}
                placeholder="e.g. Waiting on API spec from @Alex · Need staging credentials · Design dependency on PRJ-0007"
                onChange={(e) => setBlockerReason(e.target.value)}
              />
              <div className="text-[11px] text-muted mt-2">
                This gets stamped on the activity feed as a structured blocker so leads can spot it.
                Tag a teammate with <span className="text-accent font-semibold">@name</span> to call them out.
              </div>
            </div>
          )}

          <div className="relative">
            <div className="label flex items-center justify-between">
              <span>Note</span>
              <span className="text-[10px] text-muted normal-case tracking-normal">
                Tip: type <span className="text-accent font-semibold">@</span> to mention a teammate
              </span>
            </div>
            <textarea
              className="input min-h-[90px]"
              value={note}
              placeholder="What changed, what's next, what you learned…"
              onChange={(e) => onNoteChange(e.target.value)}
              onBlur={() => setTimeout(() => setMentionOpen(false), 150)}
            />
            {mentionOpen && mentionMatches.length > 0 && (
              <div className="absolute z-10 left-0 right-0 mt-1 bg-surface border border-border rounded-xl shadow-card overflow-hidden">
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted px-3 py-2 bg-bg/40">
                  Mention a teammate
                </div>
                <ul className="max-h-[200px] overflow-y-auto">
                  {mentionMatches.map((m) => (
                    <li key={m.id}>
                      <button
                        onMouseDown={(e) => { e.preventDefault(); insertMention(m.name || m.email.split("@")[0]); }}
                        className="w-full text-left px-3 py-2 hover:bg-bg flex items-center gap-2 text-sm"
                      >
                        <span className="w-6 h-6 rounded-full bg-accent-soft text-accent text-[10px] font-bold grid place-items-center">
                          {(m.name || m.email)[0]?.toUpperCase()}
                        </span>
                        <span className="text-text truncate">{m.name || m.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasMentions && (
              <div className="text-[11px] text-muted mt-1.5 inline-flex items-center gap-1">
                <Bell size={11} /> Mentioned teammates will see this in their attention feed.
              </div>
            )}
          </div>

          {/* Comment thread */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Activity ({comments?.items?.length ?? 0})</div>
            {comments?.items?.length ? (
              <ul className="space-y-2">
                {comments.items.map((c) => {
                  const isBlocker = c.body.startsWith("🚧 Blocked");
                  return (
                    <li
                      key={c.id}
                      className={`rounded-lg p-3 border ${
                        isBlocker
                          ? "bg-danger/5 border-danger/30"
                          : "bg-bg/60 border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px] text-muted mb-1">
                        <strong className="text-text">{c.author || "—"}</strong>
                        <span title={new Date(c.created_at).toLocaleString()}>{fmtCommentTime(c.created_at)}</span>
                      </div>
                      <p className="text-sm text-text whitespace-pre-wrap">{renderBody(c.body)}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted italic">No comments yet.</p>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 p-4 border-t border-border bg-bg">
          <SmartButton
            variant="outline"
            disabled={!composeBody().trim()}
            loadingLabel="Posting…"
            successLabel="Added"
            icon={<MessageSquare size={14} />}
            onClick={() => addComment.mutateAsync()}
          >
            Add comment
          </SmartButton>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-outline">Cancel</button>
            <SmartButton
              variant="primary"
              disabled={status === task.status && !composeBody().trim()}
              loadingLabel="Saving…"
              onClick={() => update.mutateAsync()}
            >
              Save status
            </SmartButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ---------- Updates ---------- */

const UPDATE_KINDS: { key: UpdateRow["kind"]; label: string; tone: string }[] = [
  { key: "daily",          label: "Daily standup",     tone: "bg-accent-soft text-accent" },
  { key: "weekly",         label: "Weekly summary",    tone: "bg-accent-soft text-accent" },
  { key: "accomplishment", label: "Accomplishment",    tone: "bg-success/15 text-success" },
  { key: "next_action",    label: "Next action",       tone: "bg-bg text-muted" },
  { key: "blocker",        label: "Blocker",           tone: "bg-danger/10 text-danger" },
  { key: "risk",           label: "Risk observed",     tone: "bg-warn/15 text-warn" },
];

function UpdatesTab() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [composeOpen, setComposeOpen] = useState(false);
  const { data, isLoading } = useQuery<{ items: UpdateRow[] }>({
    queryKey: ["me", "updates"], queryFn: () => api("/api/v1/me/updates"),
  });
  const items = data?.items ?? [];

  // Deep-link: /my-work?tab=updates&new=1 (from the daily-update attention bell)
  // auto-opens the composer once, then strips the flag from the URL.
  useEffect(() => {
    if (params.get("new") === "1") {
      setComposeOpen(true);
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="h2">Daily &amp; weekly updates</h2>
          <p className="text-xs text-muted mt-0.5">Standups, blockers, accomplishments — searchable, timestamped.</p>
        </div>
        <button onClick={() => setComposeOpen(true)} className="btn-primary">
          <Plus size={14} /> Submit update
        </button>
      </div>

      {isLoading ? (
        <div className="text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyHint
          icon={<MessageSquare size={22} className="text-muted" />}
          title="No updates yet"
          body="Drop a quick standup or weekly summary so the team has visibility into your work."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((u) => {
            const meta = UPDATE_KINDS.find((k) => k.key === u.kind);
            return (
              <li key={u.id} className="bg-surface border border-border rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`pill ${meta?.tone}`}>{meta?.label ?? u.kind}</span>
                  <span className="text-xs text-muted">{new Date(u.for_date).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
                  {u.project_name && <span className="text-xs text-muted">· {u.project_name}</span>}
                </div>
                <div className="text-[15px] font-bold text-text">{u.title}</div>
                {u.body && <p className="text-sm text-muted mt-1 whitespace-pre-wrap leading-relaxed">{u.body}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {composeOpen && (
        <ComposeUpdateDialog
          onClose={() => setComposeOpen(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["me", "updates"] });
            qc.invalidateQueries({ queryKey: ["me", "work"] });
            setComposeOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ComposeUpdateDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<UpdateRow["kind"]>("daily");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => api("/api/v1/me/updates", {
      method: "POST",
      body: JSON.stringify({ kind, title: title.trim(), body }),
    }),
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.message ?? "Failed to save"),
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-bold text-text">New update</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <div className="label">Type</div>
            <div className="grid grid-cols-3 gap-2">
              {UPDATE_KINDS.map((k) => (
                <button
                  key={k.key}
                  onClick={() => setKind(k.key)}
                  className={`px-2.5 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                    kind === k.key ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-bg"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <div className="label">Headline</div>
            <input
              className="input"
              maxLength={160}
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the one-line summary?"
            />
          </label>
          <label className="block">
            <div className="label">Details (optional)</div>
            <textarea
              className="input min-h-[120px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What did you do, what's next, what's blocking?"
            />
          </label>
          {err && <div className="text-sm text-danger">{err}</div>}
        </div>
        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!title.trim()}
            loadingLabel="Saving…"
            successLabel="Submitted"
            onClick={() => submit.mutateAsync()}
          >
            Submit
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ---------- Timesheet ---------- */

function TimesheetTab() {
  const { data, isLoading } = useQuery<{ items: TimesheetRow[]; hours_this_week: number; hours_this_month: number }>({
    queryKey: ["me", "timesheet"], queryFn: () => api("/api/v1/me/timesheet"),
  });
  const items = data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <KpiTile label="Hours this week"  value={`${(data?.hours_this_week ?? 0).toFixed(1)}h`}  icon={<Clock size={14} />} tone="info" />
        <KpiTile label="Hours this month" value={`${(data?.hours_this_month ?? 0).toFixed(1)}h`} icon={<Calendar size={14} />} tone="neutral" />
        <KpiTile label="Entries"          value={items.length}                                  icon={<ListChecks size={14} />} tone="neutral" />
      </div>
      {isLoading ? (
        <div className="text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyHint icon={<Clock size={22} className="text-muted" />} title="No time logged yet" body="Once your team starts tracking time, your entries will appear here." />
      ) : (
        <div className="bg-surface border border-border rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-bg/40">
              <tr>
                <th className="text-left font-semibold px-4 py-3">Date</th>
                <th className="text-left font-semibold px-4 py-3">Project / task</th>
                <th className="text-right font-semibold px-4 py-3">Hours</th>
                <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-3 whitespace-nowrap">{new Date(r.work_date).toLocaleDateString("en-US", { day:"numeric", month:"short", year:"numeric" })}</td>
                  <td className="px-4 py-3">
                    <div className="text-text font-semibold">{r.project_name}</div>
                    {r.task_title && <div className="text-xs text-muted">{r.task_title}</div>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{r.hours.toFixed(1)}</td>
                  <td className="px-4 py-3 text-muted hidden md:table-cell text-xs">{r.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- Profile ---------- */

function ProfileTab() {
  const qc = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  const currentUser = useAuth((s) => s.user);
  const canEditRoles = !!currentUser?.roles?.some((r) => r === "super_admin" || r === "admin");
  const { data, isLoading } = useQuery<Profile>({
    queryKey: ["me", "profile"], queryFn: () => api("/api/v1/me/profile"),
  });
  const [name, setName] = useState("");
  const [github, setGithub] = useState("");
  const [editingRoles, setEditingRoles] = useState(false);
  const [roleDraft, setRoleDraft] = useState<string[]>([]);
  const { data: rolesCatalog } = useQuery<{ items: { id: string; name: string; description: string }[] }>({
    queryKey: ["roles"],
    queryFn: () => api("/api/v1/members/roles"),
    enabled: canEditRoles && editingRoles,
  });

  const saveRoles = useMutation({
    mutationFn: (roles: string[]) => api(`/api/v1/members/${data!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ roles }),
    }),
    onSuccess: () => {
      toast.success("Roles updated", "Your role assignments have been saved.");
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      setEditingRoles(false);
    },
    onError: (e: unknown) => {
      const msg = (e as { message?: string })?.message ?? "Could not update roles.";
      toast.error("Save failed", msg);
    },
  });

  // Hydrate locally when data arrives — useEffect, not useMemo (the previous version
  // was also re-resetting the inputs on every refetch, clobbering pending edits).
  useEffect(() => {
    if (data) {
      setName(data.name ?? "");
      setGithub(data.github_username ?? "");
    }
    // Only on initial load — refetches shouldn't blow away the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.email]);

  const dirty = !!data && (
    (data.name ?? "") !== name ||
    (data.github_username ?? "") !== github
  );

  const save = useMutation({
    mutationFn: () => api<Partial<Me>>("/api/v1/me/profile", {
      method: "PUT",
      body: JSON.stringify({ name: name.trim(), github_username: github.trim() }),
    }),
    onSuccess: (resp) => {
      // Push the response back into the auth store so the sidebar identity,
      // CampfireBell author labels, and member-directory rows pick up the
      // change without a hard refresh.
      if (resp && currentUser) {
        setUser({ ...currentUser, ...resp } as Me);
      }
      toast.success("Profile updated", "Your changes have been saved.");
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: unknown) => {
      const msg = (e as { message?: string })?.message ?? "Could not save your profile.";
      toast.error("Save failed", msg);
    },
  });

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;
  const p = data.performance;

  // Derived insights — we don't fetch new endpoints, we squeeze meaning out of
  // the fields the profile already returns. Self-management framing only.
  const avgHoursPerWeek = (p.hours_last_30 / (30 / 7));
  const updateStreakPct = Math.min(100, Math.round((p.updates_last_7 / 7) * 100));
  const workloadHealth: { tone: "good" | "warn" | "bad"; label: string } =
    p.tasks_overdue === 0 && p.blocked_now === 0
      ? { tone: "good", label: "On top of things" }
      : p.tasks_overdue > 2 || p.blocked_now > 1
        ? { tone: "bad", label: "Needs attention" }
        : { tone: "warn", label: "A few loose ends" };
  return (
    <div className="max-w-5xl space-y-4">
      {/* ============ Identity hero ============ */}
      <section
        className="relative overflow-hidden rounded-2xl p-5 sm:p-6 text-white"
        style={{ background: "#107B97" }}
      >
        <div className="absolute -top-16 -right-12 w-56 h-56 bg-white/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
          <div className="shrink-0">
            <Avatar name={data.name} email={data.email} src={data.avatar_url} size={88} className="ring-2 ring-white/30" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[1.4rem] sm:text-[1.6rem] font-extrabold tracking-tight leading-tight truncate">
                {data.name || "—"}
              </h2>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-white/30 bg-white/10 text-white">
                <Activity size={11} /> {workloadHealth.label}
              </span>
            </div>
            <div className="text-sm text-white/80 mt-0.5 truncate">{data.email}</div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {!editingRoles && data.roles.map((r) => (
                <span key={r} className="pill bg-white/15 text-white border border-white/20">{r}</span>
              ))}
              {!editingRoles && data.roles.length === 0 && (
                <span className="text-xs text-white/75">No roles assigned.</span>
              )}
              {!editingRoles && canEditRoles && (
                <button
                  onClick={() => { setRoleDraft(data.roles); setEditingRoles(true); }}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/10 text-white border border-white/25 hover:bg-white/25"
                  title="Edit role assignments"
                >
                  <Pencil size={10} /> Edit roles
                </button>
              )}
              {!editingRoles && data.mfa_enabled && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/15 text-white border border-white/25">
                  <Sparkles size={10} /> MFA on
                </span>
              )}
              {!editingRoles && !data.mfa_enabled && data.mfa_required && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/15 text-white border border-white/25">
                  <AlertTriangle size={10} /> MFA required
                </span>
              )}
              {!editingRoles && data.github_username && (
                <a
                  href={`https://github.com/${data.github_username}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/15 text-white border border-white/25 hover:bg-white/25"
                >
                  <Github size={10} /> {data.github_username}
                </a>
              )}
            </div>
            {editingRoles && (
              <div className="mt-3 bg-white/10 border border-white/20 rounded-xl p-3">
                <div className="text-[11px] uppercase tracking-wider font-bold text-white/80 mb-2">
                  Edit role assignments
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(rolesCatalog?.items ?? []).map((r) => {
                    const on = roleDraft.includes(r.name);
                    return (
                      <button
                        key={r.id}
                        onClick={() => setRoleDraft((d) => on ? d.filter((x) => x !== r.name) : [...d, r.name])}
                        className={`inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition ${
                          on
                            ? "bg-white text-[#107B97] border-white"
                            : "bg-white/10 text-white border-white/30 hover:bg-white/20"
                        }`}
                        title={r.description}
                      >
                        {on ? <CheckCircle2 size={11} /> : <Plus size={11} />}
                        {r.name}
                      </button>
                    );
                  })}
                  {!rolesCatalog && <span className="text-[11px] text-white/70">Loading roles…</span>}
                </div>
                <div className="mt-3 flex items-center gap-2 justify-end">
                  <button
                    onClick={() => setEditingRoles(false)}
                    className="text-[12px] font-semibold text-white/80 hover:text-white px-3 py-1.5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => saveRoles.mutate(roleDraft)}
                    disabled={saveRoles.isPending}
                    className="text-[12px] font-bold bg-white text-[#107B97] hover:bg-white/90 px-3 py-1.5 rounded-full disabled:opacity-50"
                  >
                    {saveRoles.isPending ? "Saving…" : "Save roles"}
                  </button>
                </div>
              </div>
            )}
          </div>
          <Link
            to={`/members/${data.id}`}
            className="shrink-0 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white hover:underline self-start"
          >
            View public profile <ArrowRight size={13} />
          </Link>
        </div>
      </section>

      {/* ============ Insight tiles ============ */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <InsightTile
          icon={<CheckCircle2 size={14} />}
          label="Tasks completed"
          value={p.tasks_done.toString()}
          sub="Lifetime — every one shipped."
          tone="good"
        />
        <InsightTile
          icon={<AlertTriangle size={14} />}
          label="Overdue right now"
          value={p.tasks_overdue.toString()}
          sub={p.tasks_overdue === 0 ? "Clear runway." : "Knock these out first."}
          tone={p.tasks_overdue === 0 ? "good" : "bad"}
        />
        <InsightTile
          icon={<PauseCircle size={14} />}
          label="Blocked"
          value={p.blocked_now.toString()}
          sub={p.blocked_now === 0 ? "Nothing waiting on others." : "Unblock or escalate."}
          tone={p.blocked_now === 0 ? "good" : "warn"}
        />
        <InsightTile
          icon={<Clock size={14} />}
          label="Avg hours / week"
          value={`${avgHoursPerWeek.toFixed(1)}h`}
          sub={`${p.hours_last_30.toFixed(1)}h logged over 30 days.`}
          tone="info"
        />
      </section>

      {/* ============ Update cadence — full-width meter ============ */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[13px] font-semibold text-text flex items-center gap-1.5">
              <FileText size={13} className="text-accent" /> Update cadence (last 7 days)
            </div>
            <p className="text-xs text-muted mt-0.5">
              A daily heartbeat keeps blockers visible to your manager early.
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-extrabold text-text leading-none">{p.updates_last_7}<span className="text-sm font-bold text-muted">/7</span></div>
            <div className="text-[11px] font-semibold text-muted">days submitted</div>
          </div>
        </div>
        <div className="mt-3 h-2 rounded-full bg-bg border border-border overflow-hidden">
          <div
            className={`h-full transition-all ${updateStreakPct >= 70 ? "bg-success" : updateStreakPct >= 40 ? "bg-warn" : "bg-danger"}`}
            style={{ width: `${updateStreakPct}%` }}
          />
        </div>
      </section>

      {/* ============ Two-column: edit details + MFA ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-3">
          <h2 className="h2 mb-1">Edit details</h2>
          <p className="text-xs text-muted mb-4">
            Email is set by your workspace admin — reach out if it's wrong.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <div className="label">Display name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Email</div>
              <input className="input bg-bg" value={data.email} readOnly />
            </label>
            <label className="block md:col-span-2">
              <div className="label">GitHub username</div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-bg border border-border rounded-l-xl text-sm text-muted">
                  <Github size={14} /> github.com/
                </span>
                <input
                  className="input rounded-l-none"
                  value={github}
                  onChange={(e) => setGithub(e.target.value)}
                  placeholder="your-handle"
                />
              </div>
              <div className="text-xs text-muted mt-1">
                Linking your GitHub lets the system attribute commits, PRs, and reviews to you.
              </div>
            </label>
          </div>
          <div className="mt-5 flex items-center justify-end gap-3">
            {!dirty && !save.isPending && (
              <span className="text-xs text-muted">No changes yet</span>
            )}
            <SmartButton
              variant="primary"
              disabled={!dirty}
              onClick={() => save.mutateAsync()}
              loadingLabel="Saving…"
              successLabel="Saved"
            >
              Save changes
            </SmartButton>
          </div>
        </section>

        <div className="lg:col-span-2">
          <MfaCard
            enabled={!!data.mfa_enabled}
            required={!!data.mfa_required}
            onChanged={() => qc.invalidateQueries({ queryKey: ["me", "profile"] })}
          />
        </div>
      </div>

      <NotificationPrefsCard />
    </div>
  );
}

/* Stat tile for the Profile insights row. Tone is purely cosmetic — the icon
 * bubble picks up the colour and the rest stays neutral so a screen full of
 * tiles doesn't read like a traffic light. */
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

/* Notification preferences — per category × delivery tier matrix.
 * Reads /me/notification-preferences (which returns the 10 categories with
 * effective tier and an "is_default" flag), and lets the user override per
 * category. Saves immediately on change. */
type Tier = "immediate" | "digest_daily" | "digest_weekly" | "off";
type PrefRow = { category: string; tier: Tier; is_default: boolean; description: string };

const TIER_OPTIONS: { value: Tier; label: string; help: string }[] = [
  { value: "immediate",     label: "Immediate", help: "Email as soon as the event happens." },
  { value: "digest_daily",  label: "Daily",     help: "Roll up into one email each morning." },
  { value: "digest_weekly", label: "Weekly",    help: "Roll up into one email each week." },
  { value: "off",           label: "Off",       help: "Don't email me about this category." },
];

const CATEGORY_LABEL: Record<string, string> = {
  account: "Account & access",
  pipeline: "Pipeline & opportunities",
  delivery: "Project delivery",
  tasks: "Tasks & comments",
  governance: "Governance & compliance",
  risk: "Risk & escalation",
  finance: "Finance",
  vendor: "Vendor delivery",
  relations: "Relationships & engagements",
  exec_digest: "Executive digests",
};

/* ───────────── MFA card + setup modal ─────────────
 *
 * Self-service two-step enrollment. /me/mfa/begin returns an otpauth URL we
 * render as a QR code (using a free public chart service to avoid bundling a
 * QR lib) plus the raw secret for manual entry. /me/mfa/confirm flips the
 * users.mfa_enabled flag once the 6-digit code verifies.
 *
 * Disabling demands a current TOTP — defends against a stolen session
 * silently dropping MFA. When the admin has marked the user mfa_required,
 * the Disable button is grayed out with a note explaining why.
 */
function MfaCard({ enabled, required, onChanged }: { enabled: boolean; required: boolean; onChanged: () => void }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="h2 mb-1 flex items-center gap-2">
            <Sparkles size={14} className="text-accent" /> Two-factor authentication
          </h2>
          <p className="text-xs text-muted max-w-md">
            Adds a 6-digit code from your authenticator app on every sign-in.
            {required && enabled && (
              <span className="text-warn font-semibold"> Required by your admin.</span>
            )}
          </p>
        </div>
        <span className={`pill ${enabled ? "bg-success/15 text-success" : "bg-warn/15 text-warn"}`}>
          {enabled ? "Enabled" : "Not set up"}
        </span>
      </div>

      {/* Required-but-not-enabled banner — louder than the pill alone. */}
      {required && !enabled && (
        <div className="mt-3 bg-warn/10 border border-warn/30 rounded-xl px-3 py-2.5 text-[12.5px] text-warn flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Your admin has made MFA mandatory for your account. Set it up below to keep
            full access to the workspace.
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!enabled && (
          <SmartButton variant="primary" onClick={() => setSetupOpen(true)}>
            Set up MFA
          </SmartButton>
        )}
        {enabled && (
          <>
            <button
              onClick={() => setSetupOpen(true)}
              className="btn-outline text-sm"
              title="Re-enroll with a fresh secret"
            >
              Regenerate code
            </button>
            <button
              onClick={() => setDisableOpen(true)}
              disabled={required}
              className="text-sm px-3 py-2 rounded-lg text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed"
              title={required ? "Required by your admin" : "Turn off MFA"}
            >
              Disable
            </button>
          </>
        )}
      </div>

      {setupOpen && (
        <MfaSetupDialog
          onClose={() => setSetupOpen(false)}
          onConfirmed={() => { setSetupOpen(false); onChanged(); }}
        />
      )}
      {disableOpen && (
        <MfaDisableDialog
          onClose={() => setDisableOpen(false)}
          onDisabled={() => { setDisableOpen(false); onChanged(); }}
        />
      )}
    </section>
  );
}

function MfaSetupDialog({ onClose, onConfirmed }: { onClose: () => void; onConfirmed: () => void }) {
  const { data, isLoading } = useQuery<{ otpauth_url: string; secret: string }>({
    queryKey: ["mfa", "begin"],
    queryFn: () => api("/api/v1/me/mfa/begin", { method: "POST" }),
    refetchOnWindowFocus: false,
  });
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: () => api("/api/v1/me/mfa/confirm", {
      method: "POST", body: JSON.stringify({ code }),
    }),
    onSuccess: () => {
      toast.success("MFA enabled", "You'll be asked for a code on every sign-in.");
      onConfirmed();
    },
    onError: (e: any) => setErr(e?.message ?? "Invalid code — try again."),
  });

  // Render the QR via the open `qrserver.com` chart endpoint. It only sees
  // the otpauth URL which is already a public token — fine to externalise.
  const qrSrc = data?.otpauth_url
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.otpauth_url)}`
    : "";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Set up two-factor</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {isLoading || !data ? (
            <div className="text-center text-sm text-muted py-8">Generating your code…</div>
          ) : (
            <>
              <ol className="space-y-2 text-[12.5px] text-text list-decimal pl-4">
                <li>Open your authenticator app (Google Authenticator, 1Password, Authy, etc.).</li>
                <li>Scan the QR code below — or enter the secret manually.</li>
                <li>Type the 6-digit code the app shows to finish enrolling.</li>
              </ol>

              <div className="flex flex-col items-center gap-2">
                {qrSrc && (
                  <img src={qrSrc} alt="MFA QR code" className="w-[220px] h-[220px] bg-white p-2 rounded-xl border border-border" />
                )}
                <div className="text-[11px] text-muted">Or enter manually:</div>
                <code className="font-mono text-[12px] bg-bg border border-border rounded-md px-2.5 py-1 break-all max-w-full">
                  {data.secret}
                </code>
              </div>

              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">6-digit code</div>
                <input
                  className="input text-center font-mono tracking-[0.4em] text-lg"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(null); }}
                  autoFocus
                  placeholder="• • • • • •"
                />
              </label>
              {err && <div className="text-[12px] text-danger">{err}</div>}
            </>
          )}
        </div>
        <footer className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={code.length !== 6 || confirm.isPending}
            onClick={() => confirm.mutateAsync()}
            loadingLabel="Verifying…"
            successLabel="Enabled"
          >
            Confirm &amp; enable
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function MfaDisableDialog({ onClose, onDisabled }: { onClose: () => void; onDisabled: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const disable = useMutation({
    mutationFn: () => api("/api/v1/me/mfa/disable", {
      method: "POST", body: JSON.stringify({ code }),
    }),
    onSuccess: () => {
      toast.success("MFA disabled");
      onDisabled();
    },
    onError: (e: any) => setErr(e?.message ?? "Invalid code — try again."),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Disable MFA</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <p className="text-[12.5px] text-muted">
            Enter a current 6-digit code from your authenticator to turn off two-factor.
          </p>
          <input
            className="input text-center font-mono tracking-[0.4em] text-lg"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(null); }}
            autoFocus
            placeholder="• • • • • •"
          />
          {err && <div className="text-[12px] text-danger">{err}</div>}
        </div>
        <footer className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="danger"
            disabled={code.length !== 6 || disable.isPending}
            onClick={() => disable.mutateAsync()}
            loadingLabel="Disabling…"
          >
            Disable MFA
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function NotificationPrefsCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ preferences: PrefRow[] }>({
    queryKey: ["me", "notification-prefs"],
    queryFn: () => api("/api/v1/me/notification-preferences"),
  });
  const set = useMutation({
    mutationFn: (b: { category: string; tier: Tier }) =>
      api("/api/v1/me/notification-preferences", {
        method: "PUT",
        body: JSON.stringify(b),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "notification-prefs"] });
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error("Could not save", e.message),
  });

  const rows = (data?.preferences ?? []).slice().sort((a, b) =>
    (CATEGORY_LABEL[a.category] ?? a.category).localeCompare(CATEGORY_LABEL[b.category] ?? b.category),
  );

  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <h2 className="h2 mb-1">Email notifications</h2>
      <p className="text-xs text-muted mb-4">
        Set the cadence for each category. Critical events (overdue, blockers, security) always send
        immediately regardless of preference.
      </p>
      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.category}
              className="flex items-start justify-between gap-3 bg-bg/40 border border-border rounded-xl p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold text-text">{CATEGORY_LABEL[r.category] ?? r.category}</div>
                <div className="text-[11px] text-muted leading-snug">{r.description}</div>
                {r.is_default && (
                  <span className="text-[10px] uppercase tracking-wider font-bold text-muted/70 mt-1 inline-block">
                    using default
                  </span>
                )}
              </div>
              <select
                value={r.tier}
                onChange={(e) => set.mutate({ category: r.category, tier: e.target.value as Tier })}
                disabled={set.isPending}
                className="bg-surface border border-border rounded-full text-[12.5px] font-semibold px-3 py-1.5 focus:outline-none focus:border-accent disabled:opacity-60"
              >
                {TIER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- Heads-up panel ----------
 *
 * Surfaces engine-dispatched events that landed on this user — leave decisions,
 * mentions, milestone assignments, kudos, governance approvals. The bell
 * already carries the same data, but the dashboard panel makes the high-
 * severity ones (rejection, overdue) impossible to miss. Hides itself when
 * there's nothing unread, so it never becomes wallpaper.
 */

type HeadsUpItem = {
  id: string;
  outbox_id?: string;
  kind: string;
  severity: "info" | "warn" | "danger" | "critical";
  title: string;
  body: string;
  link: string;
  at: string;
  read?: boolean;
  payload?: Record<string, any>;
};

function HeadsUpPanel() {
  const qc = useQueryClient();
  const { data } = useQuery<{ items: HeadsUpItem[]; unread: number }>({
    queryKey: ["me", "headsup"],
    queryFn: () => api("/api/v1/notifications"),
    refetchInterval: 60_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "headsup"] }),
  });
  const markAll = useMutation({
    mutationFn: () => api("/api/v1/notifications/read-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "headsup"] }),
  });

  // Only show real engine events (outbox-backed) that are unread. Synthetic
  // items (overdue task, etc.) already render in the triage panel below — no
  // need to double up.
  const items = (data?.items ?? [])
    .filter((it) => it.outbox_id && !it.read)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 5);

  if (items.length === 0) return null;

  return (
    <section className="rounded-2xl p-5 text-white" style={{ background: "#107B97" }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-white" />
          <h2 className="text-sm font-bold text-white">Heads up</h2>
          <span className="pill bg-white/15 text-white border border-white/25 text-[11px]">{items.length} new</span>
        </div>
        <button
          onClick={() => markAll.mutate()}
          className="text-[11.5px] text-white/80 hover:text-white font-medium"
        >
          Mark all read
        </button>
      </div>
      <ul className="space-y-2">
        {items.map((it) => (
          <HeadsUpRow
            key={it.id}
            item={it}
            onDismiss={() => it.outbox_id && markRead.mutate(it.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function severityRank(s: HeadsUpItem["severity"]): number {
  return { critical: 4, danger: 3, warn: 2, info: 1 }[s] ?? 0;
}

function HeadsUpRow({ item, onDismiss }: { item: HeadsUpItem; onDismiss: () => void }) {
  const tone = {
    critical: { bg: "bg-danger/10 border-danger/30", fg: "text-danger", icon: <XCircle size={14} /> },
    danger:   { bg: "bg-danger/10 border-danger/30", fg: "text-danger", icon: <XCircle size={14} /> },
    warn:     { bg: "bg-warn/10 border-warn/30",     fg: "text-warn",   icon: <AlertTriangle size={14} /> },
    info:     { bg: "bg-accent-soft border-accent/30", fg: "text-accent", icon: <Sparkles size={14} /> },
  }[item.severity] ?? { bg: "bg-bg border-border", fg: "text-muted", icon: <Bell size={14} /> };

  const at = new Date(item.at);
  const sinceMin = Math.max(1, Math.round((Date.now() - at.getTime()) / 60_000));
  const since = sinceMin < 60
    ? `${sinceMin}m ago`
    : sinceMin < 1440 ? `${Math.round(sinceMin / 60)}h ago`
    : `${Math.round(sinceMin / 1440)}d ago`;

  return (
    <li className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${tone.bg}`}>
      <span className={`mt-0.5 shrink-0 ${tone.fg}`}>{tone.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-bold text-text">{item.title}</span>
          <span className="text-[10.5px] text-muted">{since}</span>
        </div>
        {item.body && <div className="text-[12px] text-muted mt-0.5">{item.body}</div>}
        {item.link && (
          <Link
            to={item.link}
            className="inline-flex items-center gap-1 mt-1 text-[11.5px] text-accent font-semibold hover:underline"
          >
            Open <ArrowRight size={11} />
          </Link>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 p-1 rounded text-muted hover:text-text hover:bg-bg/60"
        title="Dismiss"
      >
        <X size={13} />
      </button>
    </li>
  );
}

/* ---------- Shared bits ---------- */

function KpiTile({ label, value, icon, tone = "neutral" }: {
  label: string; value: number | string; icon: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "info" | "neutral";
}) {
  const cls = {
    good: "text-success", warn: "text-warn", bad: "text-danger", info: "text-accent", neutral: "text-text",
  }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted font-bold">
        {icon} {label}
      </div>
      <div className={`text-[26px] font-extrabold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function EmptyHint({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="text-center py-8 px-4">
      <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-bg grid place-items-center">{icon}</div>
      <div className="text-sm font-bold text-text">{title}</div>
      <p className="text-xs text-muted mt-1 max-w-xs mx-auto leading-relaxed">{body}</p>
    </div>
  );
}
