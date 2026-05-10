import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2, Clock, AlertTriangle, ListChecks, FileText, Inbox, Github,
  PauseCircle, MessageSquare, ArrowRight, Plus, Loader, Calendar, Activity, Zap, X,
  Folder, Share2, ChevronLeft, ChevronRight,
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

export function MyWorkPage() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { user } = useAuth();

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
    { key: "dashboard", label: "Today",     icon: Zap },
    { key: "tasks",     label: "My tasks",  icon: ListChecks },
    { key: "updates",   label: "Updates",   icon: MessageSquare },
    { key: "timesheet", label: "Timesheet", icon: Clock },
    { key: "profile",   label: "Profile",   icon: Github },
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
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              tab === t.key ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
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
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile label="Active tasks"    value={c.active_tasks}    icon={<ListChecks size={14} />}     tone="info" />
        <KpiTile label="Overdue"         value={c.overdue_tasks}   icon={<AlertTriangle size={14} />}  tone={c.overdue_tasks ? "bad" : "good"} />
        <KpiTile label="Blocked"         value={c.blocked_tasks}   icon={<PauseCircle size={14} />}    tone={c.blocked_tasks ? "warn" : "good"} />
        <KpiTile label="Hours this week" value={`${c.hours_this_week.toFixed(1)}h`} icon={<Clock size={14} />} tone="neutral" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Today's priorities */}
        <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2 flex items-center gap-2"><Zap size={16} className="text-accent" /> Today's priorities</h2>
            <span className="text-xs text-muted">{data.priorities.length} item{data.priorities.length === 1 ? "" : "s"}</span>
          </div>
          {data.priorities.length === 0 ? (
            <EmptyHint
              icon={<CheckCircle2 size={22} className="text-success" />}
              title="Inbox zero"
              body="You don't have any open tasks. Take a breather or sync with your PM for new work."
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.priorities.map((t) => <TaskRowItem key={t.id} task={t} compact />)}
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

      {/* File & media library */}
      <FileLibraryCard projects={data.projects} />

      {c.pending_updates > 0 && (
        <div className="rounded-2xl bg-accent-soft border border-accent/20 px-4 py-3 flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-accent text-white grid place-items-center"><MessageSquare size={15} /></span>
          <div className="flex-1">
            <div className="text-sm font-semibold text-text">Submit your daily update</div>
            <div className="text-xs text-muted">It's been {c.pending_updates} day{c.pending_updates === 1 ? "" : "s"} since your last check-in.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileLibraryCard({ projects }: { projects: ProjectRow[] }) {
  const [idx, setIdx] = useState(0);
  if (projects.length === 0) {
    return (
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2 flex items-center gap-2"><Folder size={16} className="text-accent" /> File &amp; media library</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
          <div className="md:col-span-1 aspect-[16/9] rounded-2xl bg-lime-soft/60 border border-lime/40 grid place-items-center">
            <Folder size={48} className="text-success/70" fill="currentColor" />
          </div>
          <div className="md:col-span-2">
            <div className="text-base font-bold text-text">Nothing in your vault yet</div>
            <p className="text-sm text-muted leading-relaxed mt-1">
              Once you're assigned to a project, its document vault — briefs, designs, contracts —
              shows up here for quick access.
            </p>
            <Link
              to="/projects"
              className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-accent hover:underline"
            >
              Browse all projects <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      </section>
    );
  }
  const p = projects[idx % projects.length];
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="h2 flex items-center gap-2"><Folder size={16} className="text-accent" /> File &amp; media library</h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => alert("Hook this up to project file storage when ready.")}
            className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text"
            aria-label="Add file"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(window.location.origin + `/projects/${p.id}`)}
            className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text"
            aria-label="Share folder"
          >
            <Share2 size={12} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIdx((i) => (i - 1 + projects.length) % projects.length)}
            disabled={projects.length <= 1}
            className="w-9 h-9 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text disabled:opacity-40"
            aria-label="Previous project"
          >
            <ChevronLeft size={14} />
          </button>
          <Link
            to={`/projects/${p.id}`}
            className="flex-1 aspect-[16/9] rounded-2xl bg-lime-soft border border-lime/40 grid place-items-center relative overflow-hidden hover:border-lime transition-colors"
          >
            <Folder size={56} className="text-success" fill="currentColor" />
            <div className="absolute top-3 right-3 bg-surface text-text font-bold text-xs px-2 py-1 rounded-full">
              {p.code} · vault
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setIdx((i) => (i + 1) % projects.length)}
            disabled={projects.length <= 1}
            className="w-9 h-9 rounded-full bg-bg border border-border grid place-items-center text-muted hover:text-text disabled:opacity-40"
            aria-label="Next project"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="flex flex-col">
          <div className="text-base font-bold text-text leading-tight">{p.name}</div>
          <p className="text-xs text-muted leading-relaxed mt-1.5">
            A curated vault for this engagement — briefs, designs, contracts, and references.
            Open the project to manage attached documents.
          </p>
          <Link
            to={`/projects/${p.id}`}
            className="mt-auto inline-flex items-center justify-center gap-1.5 bg-success text-white rounded-full py-2.5 text-sm font-semibold hover:opacity-90"
          >
            Open the folder <ArrowRight size={13} />
          </Link>
          {projects.length > 1 && (
            <div className="mt-2 text-[11px] text-muted text-center">
              {idx + 1} / {projects.length}
            </div>
          )}
        </div>
      </div>
    </section>
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

function TaskDialog({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<TaskRow["status"]>(task.status);
  const [note, setNote] = useState("");

  const { data: comments } = useQuery<{ items: { id: string; body: string; author: string; created_at: string }[] }>({
    queryKey: ["me-task-comments", task.id], queryFn: () => api(`/api/v1/me/tasks/${task.id}/comments`),
  });

  const update = useMutation({
    mutationFn: () => api(`/api/v1/me/tasks/${task.id}/status`, {
      method: "POST", body: JSON.stringify({ status, comment: note.trim() }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["me-task-comments", task.id] });
      onClose();
    },
  });
  const addComment = useMutation({
    mutationFn: () => api(`/api/v1/me/tasks/${task.id}/comments`, {
      method: "POST", body: JSON.stringify({ body: note.trim() }),
    }),
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: ["me-task-comments", task.id] });
    },
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-card w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 p-5 border-b border-border">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold">{task.project_name}</div>
            <h2 className="text-lg font-bold text-text mt-0.5">{task.title}</h2>
            <div className="flex items-center gap-2 mt-1.5 text-xs text-muted">
              <span className="pill" style={{ background: STATUS_COLOR[task.status] + "22", color: STATUS_COLOR[task.status] }}>
                {STATUS_LABEL[task.status]}
              </span>
              <span>· P{task.priority} · {PRIORITY_LABEL[task.priority]}</span>
              {task.due_on && <span>· Due {new Date(task.due_on).toLocaleDateString("en-US", { day:"numeric", month:"short", year:"numeric" })}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1"><X size={18} /></button>
        </header>

        <div className="overflow-auto flex-1 p-5 space-y-5">
          {task.description && (
            <p className="text-sm text-text leading-relaxed whitespace-pre-wrap">{task.description}</p>
          )}

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

          <label className="block">
            <div className="label">Note / comment</div>
            <textarea
              className="input min-h-[90px]"
              value={note}
              placeholder="Optional update — what changed, what's next, what's blocking you?"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          {/* Comment thread */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Activity ({comments?.items?.length ?? 0})</div>
            {comments?.items?.length ? (
              <ul className="space-y-2">
                {comments.items.map((c) => (
                  <li key={c.id} className="bg-bg/60 border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between text-[11px] text-muted mb-1">
                      <strong className="text-text">{c.author || "—"}</strong>
                      <span>{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-text whitespace-pre-wrap">{c.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted italic">No comments yet.</p>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 p-4 border-t border-border bg-bg">
          <button
            disabled={!note.trim() || addComment.isPending}
            onClick={() => addComment.mutate()}
            className="btn-outline"
          >
            <MessageSquare size={14} /> Add comment
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-outline">Cancel</button>
            <button
              onClick={() => update.mutate()}
              disabled={update.isPending || status === task.status && !note.trim()}
              className="btn-primary"
            >
              {update.isPending ? "Saving…" : "Save status"}
            </button>
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
  const [composeOpen, setComposeOpen] = useState(false);
  const { data, isLoading } = useQuery<{ items: UpdateRow[] }>({
    queryKey: ["me", "updates"], queryFn: () => api("/api/v1/me/updates"),
  });
  const items = data?.items ?? [];

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
          <button
            onClick={() => submit.mutate()}
            disabled={!title.trim() || submit.isPending}
            className="btn-primary"
          >
            {submit.isPending ? "Saving…" : "Submit"}
          </button>
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
  const { data, isLoading } = useQuery<Profile>({
    queryKey: ["me", "profile"], queryFn: () => api("/api/v1/me/profile"),
  });
  const [name, setName] = useState("");
  const [github, setGithub] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate locally when data arrives
  useMemo(() => {
    if (data) {
      setName(data.name ?? "");
      setGithub(data.github_username ?? "");
    }
    return null;
  }, [data]);

  const save = useMutation({
    mutationFn: () => api("/api/v1/me/profile", {
      method: "PUT",
      body: JSON.stringify({ name, github_username: github }),
    }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
    },
  });

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;
  const p = data.performance;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-2">
        <h2 className="h2 mb-4">Profile</h2>
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
          <div>
            <div className="label">Roles</div>
            <div className="flex flex-wrap gap-1.5">
              {data.roles.map((r) => <span key={r} className="pill bg-accent-soft text-accent">{r}</span>)}
              {data.roles.length === 0 && <span className="text-xs text-muted">No roles assigned.</span>}
            </div>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          {savedAt && <span className="text-xs text-success font-semibold">Saved ✓</span>}
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      <section className="bg-surface border border-border rounded-2xl p-5">
        <h2 className="h2 mb-1">Personal stats</h2>
        <p className="text-xs text-muted mb-4">Self-management view, not a leaderboard.</p>
        <ul className="space-y-3">
          <PerfRow label="Tasks completed (lifetime)"   value={p.tasks_done}     tone="good" />
          <PerfRow label="Currently overdue"            value={p.tasks_overdue}  tone={p.tasks_overdue ? "bad" : "good"} />
          <PerfRow label="Currently blocked"            value={p.blocked_now}    tone={p.blocked_now ? "warn" : "good"} />
          <PerfRow label="Updates submitted (last 7d)"  value={p.updates_last_7} tone="info" />
          <PerfRow label="Hours logged (last 30d)"      value={`${p.hours_last_30.toFixed(1)}h`} tone="neutral" />
        </ul>
      </section>
    </div>
  );
}

function PerfRow({ label, value, tone }: { label: string; value: React.ReactNode; tone: "good" | "warn" | "bad" | "info" | "neutral" }) {
  const cls = {
    good: "text-success", warn: "text-warn", bad: "text-danger", info: "text-accent", neutral: "text-text",
  }[tone];
  return (
    <li className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className={`font-bold ${cls}`}>{value}</span>
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
