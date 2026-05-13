import { useMemo, useState, useEffect } from "react";
import { SmartButton } from "@/components/SmartButton";
import { Avatar } from "@/components/Avatar";
import { MeetingsCard } from "@/modules/me/MeetingsCard";
import { MailCard, MessageReader } from "@/modules/me/MailCard";
import { MyCheckinsTab } from "@/modules/me/MyCheckinsTab";
import { ExternalEmailBadge, useWorkspaceDomain, isExternalEmail } from "@/components/ExternalEmailBadge";
import { toast } from "@/lib/toast";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2, Clock, AlertTriangle, ListChecks, FileText, Inbox, Github,
  PauseCircle, MessageSquare, ArrowRight, Plus, Calendar, Activity, Zap, X,
  Folder, ChevronRight, ChevronDown, ChevronUp, Search, Link as LinkIcon, Briefcase, LayoutGrid, Rows3,
  Sparkles, Bell, XCircle, Pencil, Smile,
  Mail as MailIcon, Paperclip, Reply, AtSign, Users as UsersIcon, AlertCircle,
  RefreshCw, ExternalLink,
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

type Tab = "dashboard" | "tasks" | "inbox" | "checkins" | "profile";

const VALID_TABS: Tab[] = ["dashboard", "tasks", "inbox", "checkins", "profile"];

export function MyWorkPage() {
  const [params, setParams] = useSearchParams();
  const initialTab = (() => {
    const q = params.get("tab");
    return (VALID_TABS as string[]).includes(q ?? "") ? (q as Tab) : "dashboard";
  })();
  const [tab, setTab] = useState<Tab>(initialTab);
  const { user } = useAuth();
  const qc = useQueryClient();

  // Microsoft OAuth callback bounces back with ?ms=connected (or an error
  // code). Lifted up to the page so the feedback fires regardless of which
  // tab is active — MeetingsCard isn't mounted on Profile, so handling it
  // there was swallowing the toast on success.
  useEffect(() => {
    const ms = params.get("ms");
    if (!ms) return;
    const detail = params.get("detail");
    // Also surface to the console so a stuck toast / blocked notification
    // doesn't hide the actual failure reason.
    console.log("[microsoft-oauth]", { ms, detail });
    if (ms === "connected") {
      toast.success("Microsoft connected", "Your calendar will appear in a moment.");
      qc.invalidateQueries({ queryKey: ["me", "ms-status"] });
      qc.invalidateQueries({ queryKey: ["me", "meetings"] });
      // Strip on success only — keeps the URL clean once the user has seen
      // the success state. On failure we leave the params so the admin can
      // copy the URL bar and reproduce / share the exact error.
      const next = new URLSearchParams(params);
      next.delete("ms"); next.delete("detail");
      setParams(next, { replace: true });
    } else if (ms === "not_configured") {
      toast.error("Microsoft not configured", "Ask an admin to set the Azure AD credentials in Settings → Integrations.");
    } else {
      toast.error("Microsoft connection failed", detail ? `${ms} · ${detail}` : "Try again, or check the admin's Azure AD setup.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // Inbox unread count for the tab badge. Cheap — we already cache /me/mail
  // for the Inbox tab itself, so this reuses the same query key.
  const { data: mailData } = useQuery<{ connected: boolean; items?: { is_read: boolean }[] }>({
    queryKey: ["me", "mail"],
    queryFn: () => api("/api/v1/me/mail?top=25"),
    refetchInterval: 2 * 60_000,
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
    // Profile — MFA setup pending only when the admin has marked the user
    // mfa_required.
    const profileCount = profileData?.mfa_required && !profileData?.mfa_enabled ? 1 : 0;
    // Inbox — unread message count when Microsoft is connected. Skips the
    // badge entirely when not connected so it doesn't nag.
    const inboxCount = (mailData?.connected && mailData.items)
      ? mailData.items.filter((m) => !m.is_read).length
      : 0;
    return {
      dashboard: todayCount,
      tasks:     tasksCount,
      inbox:     inboxCount,
      profile:   profileCount,
    };
  }, [badgeData, profileData, mailData]);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; badge?: number; badgeTone?: "danger" | "warn" | "accent" }[] = [
    { key: "dashboard", label: "Today",     icon: Zap,            badge: badges.dashboard, badgeTone: "danger" },
    { key: "tasks",     label: "My tasks",  icon: ListChecks,     badge: badges.tasks,     badgeTone: "danger" },
    { key: "inbox",     label: "Inbox",     icon: Inbox,          badge: badges.inbox,     badgeTone: "accent" },
    { key: "checkins",  label: "Check-ins", icon: Calendar,       badge: 0 },
    { key: "profile",   label: "Profile",   icon: Github,         badge: badges.profile,   badgeTone: "danger" },
  ];

  // The header "Check in" CTA used to live here. Removed at the user's
  // request — the Check-ins tab already exposes a primary "Check in
  // now" button in the slot card, and the duplicate up here was
  // crowding the avatar / online badge in the top-right corner.

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">My work</div>
          <h1 className="h1 mt-1">Hi {(user?.name?.split(" ")[0]) || "there"} 👋</h1>
          <p className="text-sm text-muted mt-1">
            Your tasks, mood and time — everything you own, none of the org-wide noise.
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
      {tab === "inbox"     && <InboxTab />}
      {tab === "checkins"  && <MyCheckinsTab />}
      {tab === "profile"   && <ProfileTab />}
    </div>
  );
}

/* ---------- Dashboard ---------- */

// useCollapsible — small hook each widget calls to give itself an in-place
// hide/show chevron. State is persisted in a per-user-per-id localStorage
// map so a collapse choice on one device survives reloads. Hiding a widget
// entirely is a separate concern (the Customise dialog) — collapse is a
// quick "I don't need this right now" without leaving the layout.
function useCollapsible(id: string) {
  const STORAGE_KEY = "me-today-collapsed";
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return !!map[id];
    } catch { return false; }
  });
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
        map[id] = next;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      } catch { /* ignore */ }
      return next;
    });
  }
  return [collapsed, toggle] as const;
}

// CollapseChevron — the standard "click me to hide/show this card" button.
// Shared so the affordance reads identically across every widget.
function CollapseChevron({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center w-7 h-7 rounded-full text-muted hover:text-text hover:bg-bg/40 transition-colors"
      aria-label={collapsed ? "Expand" : "Collapse"}
      title={collapsed ? "Expand" : "Hide"}
    >
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  );
}

// Widget vocabulary for the Today tab. Each entry is one card the user
// can toggle in / out and re-order. Widgets are render-fn-driven so adding
// a new one is a single object plus a switch case in renderWidget below —
// no scaffolding per widget.
type WidgetKey =
  | "hero"
  | "heads_up"
  | "meetings"
  | "needs_now"
  | "projects"
  | "next_moves"
  | "kudos_received"
  | "birthdays_today"
  | "mood_pulse"
  | "overtime";

const WIDGET_META: Record<WidgetKey, { label: string; help: string }> = {
  hero:            { label: "Welcome hero",       help: "Time-of-day greeting + your today snapshot." },
  heads_up:        { label: "Heads-up",           help: "Recent workspace events that landed on you." },
  meetings:        { label: "Meetings",           help: "Your Microsoft / Google calendar for today." },
  needs_now:       { label: "Needs you now",      help: "Overdue, due today, blocked, and soon-due tasks." },
  projects:        { label: "Your projects",      help: "Quick links to projects you're allocated to." },
  next_moves:      { label: "Suggested next moves", help: "Adaptive prompts based on what's slipping." },
  kudos_received:  { label: "Kudos you received", help: "Recognition colleagues sent your way." },
  birthdays_today: { label: "Birthdays today",    help: "Wish your teammates a happy birthday." },
  mood_pulse:      { label: "Mood pulse",         help: "Quick-pick mood for the current check-in slot." },
  overtime:        { label: "Overtime watch",     help: "Hours logged this week vs the standard 40h week." },
};

const DEFAULT_LAYOUT: WidgetKey[] = [
  "hero", "heads_up", "meetings", "needs_now", "projects",
  "kudos_received", "birthdays_today", "mood_pulse", "overtime", "next_moves",
];

const ALL_WIDGETS: WidgetKey[] = [
  "hero", "heads_up", "meetings", "needs_now", "projects",
  "next_moves", "kudos_received", "birthdays_today", "mood_pulse", "overtime",
];

const LAYOUT_KEY = "me-today-layout";

function DashboardTab() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery<WorkResponse>({
    queryKey: ["me", "work"], queryFn: () => api("/api/v1/me/work"),
  });
  // Optional widget data — fetched at the top so the layout stays
  // declarative and we don't pay for queries the user has hidden.
  const { data: kudosData } = useQuery<{ items: { id: string; from: { id: string; name: string; email: string }; badge: string; message: string; created_at: string }[] }>({
    queryKey: ["me", "kudos-received"],
    queryFn: () => api("/api/v1/campfire/kudos?limit=20"),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const { data: membersData } = useQuery<{ items: { id: string; name: string; email: string; status: string; birthday?: string | null }[] }>({
    queryKey: ["me", "members-for-birthdays"],
    queryFn: () => api("/api/v1/members"),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });

  // Layout state — array of WidgetKey in render order. Hidden widgets are
  // not in the array. Persisted to localStorage per device so a user's
  // hand-picked dashboard survives reloads + tab navigations.
  const [layout, setLayout] = useState<WidgetKey[]>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((k) => ALL_WIDGETS.includes(k))) return arr;
      }
    } catch { /* fall through */ }
    return DEFAULT_LAYOUT;
  });
  function saveLayout(next: WidgetKey[]) {
    setLayout(next);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  }
  const [customising, setCustomising] = useState(false);

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
  // healthCls and briefing fed the now-removed Today's Briefing section.
  // Kept the upstream computation in case we revive the briefing later;
  // void here so tsc stops flagging the unused values.
  void health;

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
  void briefing; // unused since the briefing card was removed

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

  // myKudos — kudos where the recipient is the caller. Computed here so
  // both the widget body + the empty-state check share one source.
  const myKudos = (kudosData?.items ?? []).filter((k) =>
    (k as any).to?.id === user?.id // eslint-disable-line @typescript-eslint/no-explicit-any
  );
  // Today's birthdays — month + day match against members.birthday. Empty
  // when no one in the workspace has shared a birthday.
  const todaysBirthdays = (() => {
    const now = new Date();
    const m = now.getMonth();
    const d = now.getDate();
    return (membersData?.items ?? []).filter((mem) => {
      if (mem.status !== "active" || !mem.birthday) return false;
      const bd = new Date(mem.birthday + (mem.birthday.length === 10 ? "T00:00:00Z" : ""));
      if (isNaN(bd.getTime())) return false;
      return bd.getUTCMonth() === m && bd.getUTCDate() === d;
    });
  })();

  // renderWidget — single dispatch so adding a new widget is one switch
  // case + the metadata entry above. Each case returns null when there's
  // nothing to show so hidden-but-empty widgets don't reserve space.
  // `wd` re-binds `data` as non-nullable since the early-return above
  // proved it. TypeScript can't narrow across the closure boundary.
  const wd: WorkResponse = data;
  function renderWidget(key: WidgetKey): React.ReactNode {
    switch (key) {
      case "hero":
        return <HeroCard key="hero" user={user} data={wd} overdue={overdue.length} dueToday={dueToday.length} blocked={blocked.length} />;
      case "heads_up":
        return <HeadsUpPanel key="heads_up" />;
      case "meetings":
        return <MeetingsCard key="meetings" />;
      case "needs_now":
        return <NeedsNowCard key="needs_now" data={wd} overdue={overdue} dueToday={dueToday} blocked={blocked} orderedTriage={orderedTriage} />;
      case "projects":
        return <ProjectsCard key="projects" projects={wd.projects} />;
      case "next_moves":
        return suggestions.length > 0 ? <NextMovesCard key="next_moves" suggestions={suggestions} /> : null;
      case "kudos_received":
        return myKudos.length > 0 ? <KudosReceivedCard key="kudos_received" kudos={myKudos} /> : null;
      case "birthdays_today":
        return todaysBirthdays.length > 0 ? <BirthdaysCard key="birthdays_today" birthdays={todaysBirthdays} /> : null;
      case "mood_pulse":
        return <MoodPulseCard key="mood_pulse" />;
      case "overtime":
        return <OvertimeCard key="overtime" hoursThisWeek={wd.counts.hours_this_week} />;
    }
  }

  return (
    <div className="space-y-5">
      {/* Customise — quiet header strip with the Edit-layout pencil. The
          button is always visible so a user who's hidden every widget can
          still bring them back. */}
      <div className="flex items-center justify-end -mb-2">
        <button
          type="button"
          onClick={() => setCustomising(true)}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-muted hover:text-accent press-fx"
          title="Add or hide widgets, change order"
        >
          <Pencil size={11} /> Customise layout
        </button>
      </div>

      {layout.map((key) => renderWidget(key))}

      {customising && (
        <CustomiseLayoutDialog
          layout={layout}
          onClose={() => setCustomising(false)}
          onSave={(next) => { saveLayout(next); setCustomising(false); }}
          onReset={() => { saveLayout(DEFAULT_LAYOUT); setCustomising(false); }}
        />
      )}
    </div>
  );
}

// HeroCard — rebranded welcome strip. Time-of-day greeting + a one-line
// snapshot ("3 due today · 1 blocked"). Replaces the static "Hi Sadiq 👋"
// header text with something that actually reads the user's state.
function HeroCard({
  user, data, overdue, dueToday, blocked,
}: {
  user: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: WorkResponse;
  overdue: number; dueToday: number; blocked: number;
}) {
  const [collapsed, toggle] = useCollapsible("hero");
  const h = new Date().getHours();
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const emoji = h < 12 ? "🌅" : h < 17 ? "☀️" : "🌙";
  const first = (user?.name?.split(" ")[0]) || "there";
  const pieces: string[] = [];
  if (overdue > 0)  pieces.push(`${overdue} overdue`);
  if (dueToday > 0) pieces.push(`${dueToday} due today`);
  if (blocked > 0)  pieces.push(`${blocked} blocked`);
  const summary = pieces.length === 0
    ? data.counts.active_tasks > 0
      ? `${data.counts.active_tasks} task${data.counts.active_tasks === 1 ? "" : "s"} in flight, nothing on fire.`
      : "Your queue is clear — perfect time to plan the week."
    : pieces.join(" · ");
  const tone = overdue > 0 || blocked > 0
    ? "from-warn/20 to-warn/5 border-warn/40"
    : "from-accent-soft to-accent-soft/30 border-accent/30";
  return (
    <section className={`relative overflow-hidden bg-gradient-to-br ${tone} border rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div aria-hidden className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/20 pointer-events-none" />
      {collapsed ? (
        <div className="relative flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 text-[12px] font-bold text-text/80">
            <span>{emoji}</span> {greeting}, {first}
            <span className="text-muted font-normal">· {summary}</span>
          </div>
          <CollapseChevron collapsed={collapsed} onClick={toggle} />
        </div>
      ) : (
        <div className="relative flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-text/70">My day</div>
            <h2 className="text-2xl font-extrabold text-text leading-tight mt-1">
              <span className="mr-1.5">{emoji}</span>
              {greeting}, {first}.
            </h2>
            <p className="text-[13px] text-text/80 mt-1">{summary}</p>
          </div>
          <div className="flex items-start gap-3 shrink-0">
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold">This week</div>
              <div className="text-2xl font-extrabold text-text">{data.counts.hours_this_week.toFixed(1)}h</div>
              <div className="text-[10.5px] text-muted">logged</div>
            </div>
            <CollapseChevron collapsed={collapsed} onClick={toggle} />
          </div>
        </div>
      )}
    </section>
  );
}

// NeedsNowCard — triage panel (overdue → today → blocked → soon → rest).
// Full-width when alone; the parent layout doesn't bundle it with Projects
// anymore because users can hide either one independently now.
function NeedsNowCard({
  data, overdue, dueToday, blocked, orderedTriage,
}: {
  data: WorkResponse;
  overdue: any[]; dueToday: any[]; blocked: any[]; orderedTriage: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const [collapsed, toggle] = useCollapsible("needs_now");
  return (
    <section className={`bg-surface border border-border rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 flex-wrap ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2"><Zap size={16} className="text-accent" /> Needs you now</h2>
        <div className="flex items-center gap-1.5 flex-wrap">
          {overdue.length > 0  && <span className="pill bg-danger/15 text-danger">{overdue.length} overdue</span>}
          {dueToday.length > 0 && <span className="pill bg-warn/15 text-warn">{dueToday.length} today</span>}
          {blocked.length > 0  && <span className="pill bg-warn/15 text-warn">{blocked.length} blocked</span>}
          {overdue.length === 0 && dueToday.length === 0 && blocked.length === 0 && (
            <span className="text-xs text-muted">{data.priorities.length} item{data.priorities.length === 1 ? "" : "s"}</span>
          )}
          <CollapseChevron collapsed={collapsed} onClick={toggle} />
        </div>
      </div>
      {collapsed ? null : data.priorities.length === 0 ? (
        <EmptyHint
          icon={<CheckCircle2 size={22} className="text-success" />}
          title="Inbox zero"
          body="You don't have any open tasks. Take a breather or sync with your PM for new work."
        />
      ) : (
        <ul className="divide-y divide-border">
          {orderedTriage.map((t) => (
            <li key={t.id} className="relative">
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
  );
}

// ProjectsCard — quick links to allocated projects with health pill.
function ProjectsCard({ projects }: { projects: WorkResponse["projects"] }) {
  const [collapsed, toggle] = useCollapsible("projects");
  return (
    <section className={`bg-surface border border-border rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2"><Activity size={16} className="text-accent" /> Your projects</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{projects.length}</span>
          <CollapseChevron collapsed={collapsed} onClick={toggle} />
        </div>
      </div>
      {collapsed ? null : projects.length === 0 ? (
        <EmptyHint
          icon={<Inbox size={22} className="text-muted" />}
          title="Not on any project yet"
          body="A project manager will assign you when there's work to ship."
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {projects.map((p) => (
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
  );
}

// NextMovesCard — adaptive "what to do next" prompts.
function NextMovesCard({
  suggestions,
}: {
  suggestions: { icon: React.ReactNode; title: string; body: string; tone: "warn" | "info" | "good" }[];
}) {
  const [collapsed, toggle] = useCollapsible("next_moves");
  return (
    <section className={`bg-surface border border-border rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2">
          <Sparkles size={16} className="text-accent" /> Suggested next moves
        </h2>
        <CollapseChevron collapsed={collapsed} onClick={toggle} />
      </div>
      {collapsed ? null : (
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
      )}
    </section>
  );
}

// KudosReceivedCard — recent recognition from colleagues. Hidden when the
// caller hasn't received any yet.
function KudosReceivedCard({
  kudos,
}: {
  kudos: { id: string; from: { id: string; name: string; email: string }; badge: string; message: string; created_at: string }[];
}) {
  const [collapsed, toggle] = useCollapsible("kudos_received");
  const BADGES: Record<string, { label: string; emoji: string }> = {
    delivery_champion: { label: "Delivery champion", emoji: "🏆" },
    problem_solver:    { label: "Problem solver",    emoji: "🧠" },
    team_player:       { label: "Team player",       emoji: "🤝" },
    fast_responder:    { label: "Fast responder",    emoji: "⚡" },
    client_hero:       { label: "Client hero",       emoji: "🌟" },
    custom:            { label: "Thanks",            emoji: "🙌" },
  };
  return (
    <section className={`bg-gradient-to-br from-warn/10 to-accent-soft border border-warn/30 rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2 text-warn">
          🎉 Kudos you received
          <span className="text-[12px] text-muted font-medium">· {kudos.length} total</span>
        </h2>
        <CollapseChevron collapsed={collapsed} onClick={toggle} />
      </div>
      {collapsed ? null : <>
      <ul className="space-y-2">
        {kudos.slice(0, 4).map((k) => {
          const meta = BADGES[k.badge] ?? { label: k.badge, emoji: "🙌" };
          return (
            <li key={k.id} className="bg-surface/70 border border-border/60 rounded-xl px-3 py-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] font-bold text-text">{k.from.name || k.from.email.split("@")[0]}</span>
                <span className="pill bg-bg text-text border border-border text-[10px] uppercase tracking-wide font-bold">
                  <span className="mr-0.5">{meta.emoji}</span> {meta.label}
                </span>
                <span className="text-[11px] text-muted ml-auto">{relTimeShort(k.created_at)}</span>
              </div>
              {k.message && <p className="text-[12.5px] text-text/80 mt-0.5 leading-snug line-clamp-2">{k.message}</p>}
            </li>
          );
        })}
      </ul>
      {kudos.length > 4 && (
        <div className="text-[11.5px] text-muted text-center mt-2">
          + {kudos.length - 4} more · open <Link to="/colleagues" className="text-accent hover:underline">Colleagues</Link>
        </div>
      )}
      </>}
    </section>
  );
}

// BirthdaysCard — celebrate teammates whose birthday is today.
function BirthdaysCard({
  birthdays,
}: {
  birthdays: { id: string; name: string; email: string }[];
}) {
  const [collapsed, toggle] = useCollapsible("birthdays_today");
  return (
    <section className={`bg-gradient-to-br from-warn/15 to-accent-soft/40 border border-warn/30 rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2">
          🎂 Happy birthday today
          <span className="text-[12px] text-muted font-medium">· {birthdays.length}</span>
        </h2>
        <CollapseChevron collapsed={collapsed} onClick={toggle} />
      </div>
      {collapsed ? null : <>
      <ul className="flex flex-wrap gap-2">
        {birthdays.map((b) => (
          <li key={b.id}>
            <Link
              to={`/colleagues?openId=${b.id}`}
              className="inline-flex items-center gap-2 bg-surface/70 border border-border/60 hover:border-accent/40 rounded-full pl-1 pr-3 py-1 transition-colors"
            >
              <span className="w-6 h-6 rounded-full bg-bg grid place-items-center text-[10px] font-bold text-muted">
                {(b.name || b.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="text-[12.5px] font-semibold text-text">{b.name || b.email.split("@")[0]}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[11.5px] text-muted mt-2">Tap a name to open their drawer and send a kudo.</p>
      </>}
    </section>
  );
}

// MoodPulseCard — fast-track to the slot-aware Check-in tab. Hides nothing;
// always visible so a user with a tough morning gets a one-click path to
// log it.
function MoodPulseCard() {
  const [collapsed, toggle] = useCollapsible("mood_pulse");
  return (
    <section className={`bg-surface border border-border rounded-2xl ${collapsed ? "px-5 py-3" : "p-5"} ${collapsed ? "flex items-center justify-between gap-2" : "flex items-center justify-between gap-4 flex-wrap"}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="h2 flex items-center gap-2"><Smile size={16} className="text-accent" /> Mood pulse</h2>
          {collapsed && <CollapseChevron collapsed={collapsed} onClick={toggle} />}
        </div>
        {!collapsed && <>
        <p className="text-[12.5px] text-muted mt-1">
          Up to three quick check-ins per day — morning, afternoon, evening. One tap to log.
        </p>
        </>}
      </div>
      {!collapsed && (
      <div className="flex items-center gap-2">
        <Link
          to="/my-work?tab=checkins"
          className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 press-fx"
        >
          <Smile size={13} /> Check in
        </Link>
        <CollapseChevron collapsed={collapsed} onClick={toggle} />
      </div>
      )}
    </section>
  );
}

// OvertimeCard — compares hours_this_week against a 40h standard week.
// Surfaces over/under as a single sentence + a slim progress bar. Tinted
// amber/danger when materially over (>5h / >10h respectively) so chronic
// over-work doesn't hide behind a green pill.
function OvertimeCard({ hoursThisWeek }: { hoursThisWeek: number }) {
  const [collapsed, toggle] = useCollapsible("overtime");
  const STANDARD_WEEK = 40;
  const delta = hoursThisWeek - STANDARD_WEEK;
  const pct = Math.min(150, (hoursThisWeek / STANDARD_WEEK) * 100);
  const tone =
    delta >= 10 ? "bg-danger/10 border-danger/30 text-danger"
    : delta >= 5  ? "bg-warn/10 border-warn/30 text-warn"
    : delta >= 0  ? "bg-success/10 border-success/30 text-success"
    : "bg-bg/40 border-border text-muted";
  const barCls =
    delta >= 10 ? "bg-danger"
    : delta >= 5  ? "bg-warn"
    : "bg-success";
  const headline =
    delta >= 5  ? `${delta.toFixed(1)}h over a standard week`
    : delta > 0 ? `${delta.toFixed(1)}h over — fine but watch it`
    : delta === 0 ? "Right on the standard 40h week"
    : `${Math.abs(delta).toFixed(1)}h under standard so far`;
  return (
    <section className={`border rounded-2xl ${tone} ${collapsed ? "px-5 py-3" : "p-5"}`}>
      <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}>
        <h2 className="h2 flex items-center gap-2">
          <Clock size={16} /> Overtime watch
          <span className="text-[12px] font-medium opacity-80">· {hoursThisWeek.toFixed(1)}h this week</span>
        </h2>
        <CollapseChevron collapsed={collapsed} onClick={toggle} />
      </div>
      {collapsed ? null : (
        <>
          <div className="text-[13px] font-semibold">{headline}</div>
          <div className="mt-2 h-2 bg-bg/40 rounded-full overflow-hidden">
            <div className={`h-full ${barCls} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-1 text-[10.5px] text-muted">
            <span>0h</span>
            <span>40h · standard</span>
            <span>50h+</span>
          </div>
          <p className="text-[11.5px] text-muted mt-2 leading-snug">
            Based on a 40h Mon-Fri baseline. Hours come from your logged time entries — if you've worked but
            haven't logged, the number won't reflect it.
          </p>
        </>
      )}
    </section>
  );
}

// CustomiseLayoutDialog — modal that lets the user toggle widgets on/off
// and re-order them with up/down arrows. Keeping it as a list (not a
// drag-and-drop canvas) avoids a dependency for one screen and still
// gives every user full control over their dashboard.
function CustomiseLayoutDialog({
  layout, onClose, onSave, onReset,
}: {
  layout: WidgetKey[];
  onClose: () => void;
  onSave: (next: WidgetKey[]) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<WidgetKey[]>(layout);
  const enabled = new Set(draft);
  function toggle(k: WidgetKey) {
    if (enabled.has(k)) setDraft(draft.filter((x) => x !== k));
    else setDraft([...draft, k]);
  }
  function move(k: WidgetKey, dir: -1 | 1) {
    const i = draft.indexOf(k);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  }
  // Hidden widgets render at the bottom so the user can pull them in.
  const hidden = ALL_WIDGETS.filter((k) => !enabled.has(k));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-text">Customise your Today</h2>
            <p className="text-[11.5px] text-muted">Pick the widgets you want — drag-friendly up/down per row.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-3 space-y-1.5 overflow-y-auto flex-1">
          {draft.map((k, i) => (
            <div key={k} className="flex items-center gap-2 bg-bg/40 border border-border rounded-xl px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-text">{WIDGET_META[k].label}</div>
                <div className="text-[11px] text-muted leading-snug">{WIDGET_META[k].help}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => move(k, -1)}
                  disabled={i === 0}
                  className="text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed p-1"
                  title="Move up"
                >
                  <ChevronRight size={14} className="-rotate-90" />
                </button>
                <button
                  onClick={() => move(k, 1)}
                  disabled={i === draft.length - 1}
                  className="text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed p-1"
                  title="Move down"
                >
                  <ChevronRight size={14} className="rotate-90" />
                </button>
                <button
                  onClick={() => toggle(k)}
                  className="text-muted hover:text-danger p-1"
                  title="Remove"
                >
                  <XCircle size={14} />
                </button>
              </div>
            </div>
          ))}
          {hidden.length > 0 && (
            <>
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted px-1 pt-3">Hidden — tap to add</div>
              {hidden.map((k) => (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  className="w-full text-left flex items-center gap-2 bg-bg/20 hover:bg-bg/50 border border-border border-dashed rounded-xl px-3 py-2 transition-colors"
                >
                  <Plus size={13} className="text-accent" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-text">{WIDGET_META[k].label}</div>
                    <div className="text-[11px] text-muted leading-snug">{WIDGET_META[k].help}</div>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 bg-bg/30">
          <button onClick={onReset} className="text-[12px] font-semibold text-muted hover:text-text">Reset to default</button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
            <button onClick={() => onSave(draft)} className="text-[12.5px] font-bold bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent/90">Save layout</button>
          </div>
        </footer>
      </div>
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


/* ---------- Inbox ---------- */

type InboxMsg = {
  id: string;
  subject: string;
  from: string;
  from_name: string;
  preview: string;
  web_link: string;
  received: string;
  is_read: boolean;
  has_attachments: boolean;
  importance: string;
};

type InboxResp = {
  connected: boolean;
  connected_account?: string;
  items?: InboxMsg[];
  error?: string;
};

type InboxFilter = "all" | "unread" | "needs_reply" | "from_team" | "external" | "high" | "attachments";

const REPLY_RE = /^\s*re[\s:]/i;
const ASK_RE   = /\?|\bcould you\b|\bcan you\b|\bplease\b|\bneed\b|\baction required\b|\bASAP\b/i;

function isNeedsReply(m: InboxMsg): boolean {
  if (m.is_read) return false;
  return REPLY_RE.test(m.subject) || ASK_RE.test(m.subject) || ASK_RE.test(m.preview);
}

function inboxBucket(m: InboxMsg, workspaceDomain: string): Set<InboxFilter> {
  const out = new Set<InboxFilter>(["all"]);
  if (!m.is_read) out.add("unread");
  if (isNeedsReply(m)) out.add("needs_reply");
  if (isExternalEmail(m.from, workspaceDomain)) out.add("external");
  else if (workspaceDomain) out.add("from_team");
  if (m.importance === "high") out.add("high");
  if (m.has_attachments) out.add("attachments");
  return out;
}

function fmtRelInbox(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function inboxInitials(name: string, email: string): string {
  const s = (name || email || "?").trim();
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function InboxTab() {
  const qc = useQueryClient();
  const workspaceDomain = useWorkspaceDomain();

  const { data: status } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["me", "ms-status"],
    queryFn: () => api("/api/v1/me/microsoft/status"),
  });
  const { data, isLoading, isFetching, refetch } = useQuery<InboxResp>({
    queryKey: ["me", "mail", "inbox-tab"],
    queryFn: () => api("/api/v1/me/mail?top=50"),
    enabled: !!status?.connected,
    refetchInterval: 2 * 60_000,
  });

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // Page-size picker — the inbox pulls 50 messages and the row list
  // grows past a comfortable scroll on small screens. Persist the
  // choice so a user who likes a denser view doesn't reset it every
  // visit. "all" returns every row in the filtered window.
  type PageSize = 10 | 20 | 50 | 100 | "all";
  const [pageSize, setPageSize] = useState<PageSize>(() => {
    const v = localStorage.getItem("me:inbox:page_size");
    if (v === "all") return "all";
    const n = Number(v);
    return ([10, 20, 50, 100] as const).includes(n as any) ? (n as PageSize) : 20;
  });
  const [page, setPage] = useState(1);
  useEffect(() => { localStorage.setItem("me:inbox:page_size", String(pageSize)); }, [pageSize]);
  // Reset to page 1 when the filter or search changes — otherwise the
  // user can land on page 4 of a list that suddenly has 1 page of rows.
  useEffect(() => { setPage(1); }, [filter, search, pageSize]);

  const items = data?.items ?? [];

  // Precompute buckets per message once so chip counts + filtering stay snappy
  // on a 50-row list, and we only walk the array once for counts.
  const enriched = useMemo(
    () => items.map((m) => ({ m, buckets: inboxBucket(m, workspaceDomain) })),
    [items, workspaceDomain],
  );

  const counts: Record<InboxFilter, number> = useMemo(() => {
    const c: Record<InboxFilter, number> = {
      all: 0, unread: 0, needs_reply: 0, from_team: 0, external: 0, high: 0, attachments: 0,
    };
    for (const { buckets } of enriched) {
      for (const b of buckets) c[b] += 1;
    }
    return c;
  }, [enriched]);

  const latestAgo = items[0] ? fmtRelInbox(items[0].received) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched
      .filter(({ buckets }) => buckets.has(filter))
      .filter(({ m }) => {
        if (!q) return true;
        return (m.subject + " " + m.from_name + " " + m.from + " " + m.preview)
          .toLowerCase().includes(q);
      })
      .map(({ m }) => m);
  }, [enriched, filter, search]);

  if (!status?.connected) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="h2">Inbox</h2>
          <p className="text-sm text-muted mt-1">
            Connect your Microsoft mailbox on the Today tab to pull email here.
          </p>
        </div>
        <div className="bg-surface border border-border rounded-2xl p-8 text-center">
          <Inbox size={28} className="mx-auto text-muted mb-3" />
          <div className="text-sm font-semibold text-text">Inbox isn't connected yet</div>
          <p className="text-xs text-muted mt-1 max-w-sm mx-auto">
            Head to the Today tab and click Connect Microsoft. Your mail will appear here as soon as it's linked.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="h2 inline-flex items-center gap-2"><MailIcon size={20} className="text-accent" /> Inbox</h2>
          <p className="text-sm text-muted mt-1">
            {data?.connected_account ? `${data.connected_account} · ` : ""}
            {counts.unread} unread of {counts.all}
            {latestAgo && <> · last delivery {latestAgo} ago</>}
          </p>
        </div>
        <button
          onClick={() => { refetch(); qc.invalidateQueries({ queryKey: ["me", "mail"] }); }}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-surface border border-border text-muted hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} /> Refresh
        </button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InboxTile
          icon={<Reply size={14} className="text-accent" />}
          label="Needs reply"
          value={counts.needs_reply}
          sub="Unread asks, Re: threads, action language"
          tone={counts.needs_reply > 0 ? "warn" : "muted"}
        />
        <InboxTile
          icon={<AlertCircle size={14} className="text-danger" />}
          label="High importance"
          value={counts.high}
          sub={counts.high === 0 ? "Nothing flagged" : "Senders flagged these"}
          tone={counts.high > 0 ? "danger" : "muted"}
        />
        <InboxTile
          icon={<UsersIcon size={14} className="text-success" />}
          label="From the team"
          value={counts.from_team}
          sub={workspaceDomain ? `@${workspaceDomain}` : "Workspace domain unknown"}
          tone="success"
        />
        <InboxTile
          icon={<AtSign size={14} className="text-warn" />}
          label="External"
          value={counts.external}
          sub={counts.external > 0 ? "Outside your domain" : "All in-house"}
          tone="warn"
        />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full">
          {([
            { k: "all",         label: `All · ${counts.all}` },
            { k: "unread",      label: `Unread · ${counts.unread}` },
            { k: "needs_reply", label: `Needs reply · ${counts.needs_reply}` },
            { k: "high",        label: `High · ${counts.high}` },
            { k: "external",    label: `External · ${counts.external}` },
            { k: "from_team",   label: `Team · ${counts.from_team}` },
            { k: "attachments", label: `Attachments · ${counts.attachments}` },
          ] as { k: InboxFilter; label: string }[]).map((f) => (
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
        <div className="relative">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, sender…"
            className="pl-8 pr-3 py-1.5 text-sm bg-surface border border-border rounded-full w-64 no-cap"
          />
        </div>
      </div>

      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="px-5 py-8 text-sm text-muted">Loading mail…</div>
        ) : data?.error ? (
          <div className="px-5 py-6 text-[13px] text-danger inline-flex items-center gap-2">
            <AlertTriangle size={13} /> {data.error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Inbox size={26} className="mx-auto text-muted mb-3" />
            <div className="text-sm font-semibold text-text">
              {search.trim()
                ? `Nothing matches "${search}".`
                : filter === "all"
                  ? "Inbox zero — nothing new."
                  : "Nothing in this view right now."}
            </div>
            <p className="text-xs text-muted mt-1 max-w-sm mx-auto">
              {filter !== "all" && !search.trim()
                ? "Try a different filter or clear search."
                : "Use the filters above to narrow what's pulling at you."}
            </p>
          </div>
        ) : (
          (() => {
            const size = pageSize === "all" ? filtered.length : pageSize;
            const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(filtered.length / size));
            const safePage = Math.min(page, totalPages);
            const start = (safePage - 1) * size;
            const slice = pageSize === "all" ? filtered : filtered.slice(start, start + size);
            const showFrom = filtered.length === 0 ? 0 : start + 1;
            const showTo = pageSize === "all" ? filtered.length : Math.min(start + size, filtered.length);
            return (
              <>
                <ul className="divide-y divide-border animate-fade-in">
                  {slice.map((m) => (
                    <InboxRow
                      key={m.id}
                      m={m}
                      workspaceDomain={workspaceDomain}
                      onOpen={() => setOpenId(m.id)}
                    />
                  ))}
                </ul>
                <footer className="px-3 sm:px-5 py-3 border-t border-border flex items-center justify-between gap-3 flex-wrap text-[12px]">
                  <div className="flex items-center gap-2 text-muted">
                    <span>Showing {showFrom}–{showTo} of {filtered.length}</span>
                    <span className="hidden sm:inline">·</span>
                    <label className="hidden sm:inline-flex items-center gap-1.5">
                      Rows per page
                      <select
                        value={String(pageSize)}
                        onChange={(e) => setPageSize(e.target.value === "all" ? "all" : (Number(e.target.value) as PageSize))}
                        className="bg-surface border border-border rounded-md px-1.5 py-1 text-[12px] no-cap"
                      >
                        {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                        <option value="all">All</option>
                      </select>
                    </label>
                  </div>
                  {pageSize !== "all" && totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={safePage <= 1}
                        className="px-2 py-1 rounded-md text-muted hover:text-text hover:bg-bg/40 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                      >‹ Prev</button>
                      <span className="px-2 text-muted">
                        Page <span className="font-semibold text-text">{safePage}</span> of {totalPages}
                      </span>
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={safePage >= totalPages}
                        className="px-2 py-1 rounded-md text-muted hover:text-text hover:bg-bg/40 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                      >Next ›</button>
                    </div>
                  )}
                </footer>
              </>
            );
          })()
        )}
      </section>

      {openId && <MessageReader id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function InboxTile({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
  tone: "warn" | "danger" | "success" | "muted";
}) {
  const bubble = {
    warn:    "bg-warn/10 text-warn",
    danger:  "bg-danger/10 text-danger",
    success: "bg-success/10 text-success",
    muted:   "bg-bg text-muted",
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

function InboxRow({
  m, workspaceDomain, onOpen,
}: {
  m: InboxMsg;
  workspaceDomain: string;
  onOpen: () => void;
}) {
  const isReply = REPLY_RE.test(m.subject);
  const needsReply = !m.is_read && (isReply || ASK_RE.test(m.subject + " " + m.preview));
  const external = isExternalEmail(m.from, workspaceDomain);
  return (
    <li className={m.is_read ? "" : "bg-accent-soft/30"}>
      <button
        onClick={onOpen}
        className="w-full text-left px-5 py-3 hover:bg-bg/40 transition-colors"
      >
        <div className="flex items-start gap-3">
          <span className={`w-9 h-9 rounded-full font-bold text-[12px] grid place-items-center shrink-0 ${
            external ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
          }`}>
            {inboxInitials(m.from_name, m.from)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-[13px] truncate ${m.is_read ? "text-text" : "font-bold text-text"}`}>
                {m.from_name || m.from}
              </span>
              <ExternalEmailBadge email={m.from} size="xs" />
              {m.importance === "high" && (
                <span className="pill bg-danger/10 text-danger text-[10px] inline-flex items-center gap-1">
                  <AlertCircle size={9} /> High
                </span>
              )}
              {needsReply && (
                <span className="pill bg-warn/15 text-warn text-[10px] inline-flex items-center gap-1">
                  <Reply size={9} /> Needs reply
                </span>
              )}
              <span className="ml-auto text-[10.5px] text-muted whitespace-nowrap shrink-0">
                {fmtRelInbox(m.received)}
              </span>
            </div>

            <div className={`text-[12.5px] truncate mt-0.5 ${m.is_read ? "text-muted" : "text-text font-semibold"}`}>
              {isReply && <span className="text-accent/70 mr-1">Re:</span>}
              {m.subject.replace(REPLY_RE, "") || "(no subject)"}
            </div>

            {m.preview && (
              <div className="text-[11.5px] text-muted truncate mt-0.5">{m.preview}</div>
            )}

            <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-muted">
              {m.has_attachments && (
                <span className="inline-flex items-center gap-1"><Paperclip size={10} /> attachments</span>
              )}
              {m.web_link && (
                <a
                  href={m.web_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 hover:text-accent"
                >
                  <ExternalLink size={10} /> Outlook
                </a>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}

// MailCard still used by the Today briefing — no-op silences the unused-import
// warning if the linter ever reshuffles things.
void MailCard;

/* ---------- Profile ---------- */

function ProfileTab() {
  const qc = useQueryClient();
  const currentUser = useAuth((s) => s.user);
  const canEditRoles = !!currentUser?.roles?.some((r) => r === "super_admin" || r === "admin");
  const { data, isLoading } = useQuery<Profile>({
    queryKey: ["me", "profile"], queryFn: () => api("/api/v1/me/profile"),
  });
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

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;
  const p = data.performance;

  // The edit form + MFA + insight tiles moved to the public profile page,
  // so we only need the cadence meter's derived value here now.
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

      {/* Stats strip and Edit details + MFA moved to the public profile page
          (/members/:id) where the workload metrics already live. The CTA in
          the hero ("View public profile →") deep-links there for editing
          identity and managing two-factor auth. */}

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

      <NotificationPrefsCard />
    </div>
  );
}

/* Notification preferences — per category × delivery tier matrix.
 * Reads /me/notification-preferences (which returns the 10 categories with
 * effective tier and an "is_default" flag), and lets the user override per
 * category. Saves immediately on change. */
type Tier = "immediate" | "digest_daily" | "digest_weekly" | "off";
type PrefRow = { category: string; tier: Tier; is_default: boolean; description: string };

// Tier options removed — the UI is a binary on/off switch now. ON saves
// `immediate`, OFF saves `off`. Server still accepts digest_daily /
// digest_weekly for API callers that want them.

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
export function MfaCard({ enabled, required, onChanged }: { enabled: boolean; required: boolean; onChanged: () => void }) {
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
        Turn each category on or off. Critical events (overdue, blockers, security) always send
        regardless of these toggles.
      </p>
      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const on = r.tier !== "off";
            return (
              <li
                key={r.category}
                className="flex items-start justify-between gap-3 bg-bg/40 border border-border rounded-xl p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-text">{CATEGORY_LABEL[r.category] ?? r.category}</div>
                  <div className="text-[11px] text-muted leading-snug">{r.description}</div>
                </div>
                <ToggleSwitch
                  on={on}
                  disabled={set.isPending}
                  onChange={(next) =>
                    set.mutate({ category: r.category, tier: next ? "immediate" : "off" })
                  }
                  ariaLabel={`${on ? "Turn off" : "Turn on"} ${CATEGORY_LABEL[r.category] ?? r.category}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Compact iOS-style on/off switch. Used for notification preferences; can be
// reused anywhere we want a binary control instead of a multi-option select.
function ToggleSwitch({
  on, onChange, disabled, ariaLabel,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        on ? "bg-accent" : "bg-muted/40"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow-soft transform transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
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


function EmptyHint({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="text-center py-8 px-4">
      <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-bg grid place-items-center">{icon}</div>
      <div className="text-sm font-bold text-text">{title}</div>
      <p className="text-xs text-muted mt-1 max-w-xs mx-auto leading-relaxed">{body}</p>
    </div>
  );
}
