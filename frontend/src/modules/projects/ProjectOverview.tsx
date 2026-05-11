import { useState } from "react";
import { useOutletContext, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare, Users as UsersIcon, UploadCloud, Plus, Rocket, CheckCircle2, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar } from "@/components/Avatar";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { TaskRowItem, TaskDrawer, type TaskRow, type ProjectMember } from "./TaskCard";

/* ---------- types ---------- */

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  description?: string;
  budget?: number;
  currency?: string;
  client_name?: string;
  start_date?: string | null;
  end_date?: string | null;
  opportunity_id?: string | null;
};
type Stakeholder = {
  id: string; name: string; role: string; kind: "internal" | "external"; email?: string;
};
type Board = { columns: Record<string, TaskRow[]> };
type AuditEntry = { id: string; action: string; actor_name: string; created_at: string; entity: string; entity_id?: string };

type ShellCtx = {
  project: Project | undefined;
  stakeholders: Stakeholder[];
  owner: Stakeholder | undefined;
};

/* ---------- helpers ---------- */

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}
function healthCopy(h: string | undefined): { title: string; emoji: string } {
  if (h === "red")   return { title: "This Project needs attention!", emoji: "🚨" };
  if (h === "amber") return { title: "This Project is at risk",        emoji: "⚠️" };
  return { title: "This Project on track!", emoji: "🚀" };
}

/* ---------- main ---------- */

export function ProjectOverview() {
  const { id } = useParams();
  const { project, owner } = useOutletContext<ShellCtx>();
  const qc = useQueryClient();

  const { data: board } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`), enabled: !!id,
  });
  const { data: audit } = useQuery<{ items: AuditEntry[] }>({
    queryKey: ["project-audit", id],
    queryFn: () => api(`/api/v1/audit?entity=project&id=${id}`),
    enabled: !!id,
  });

  const [taskOpen, setTaskOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const { data: membersData } = useQuery<{ items: ProjectMember[] }>({
    queryKey: ["project-members", id],
    queryFn: () => api(`/api/v1/projects/${id}/members`),
    enabled: !!id,
  });
  const members = membersData?.items ?? [];

  const allTasks: TaskRow[] = board
    ? Object.values(board.columns).flat()
    : [];
  const recentTasks = allTasks
    .slice()
    .sort((a, b) => {
      const da = a.due_on ? new Date(a.due_on).getTime() : Infinity;
      const db = b.due_on ? new Date(b.due_on).getTime() : Infinity;
      return da - db;
    })
    .slice(0, 5);

  const addTask = useMutation({
    mutationFn: (b: { title: string; description?: string; priority: number; due_on?: string; start_on?: string; assignee_id?: string }) =>
      api(`/api/v1/projects/${id}/tasks`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-board", id] });
      toast.success("Task created");
      setTaskOpen(false);
    },
    onError: (e: any) => toast.error("Could not create task", e?.message),
  });

  const summary = healthCopy(project?.health);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-5">
      {/* ============== LEFT COLUMN ============== */}
      <div className="space-y-5">
        {/* Quick-action cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ActionCard
            icon={<CheckSquare size={18} />}
            title="Create Task"
            body="Organize task to your project"
            onClick={() => setTaskOpen(true)}
          />
          <ActionCard
            icon={<UsersIcon size={18} />}
            title="Invite Team"
            body="Staff a member onto this project"
            onClick={() => setInviteOpen(true)}
          />
          <ActionCard
            icon={<UploadCloud size={18} />}
            title="Upload a File"
            body="Upload file to your projects"
            onClick={() => setFileOpen(true)}
          />
        </div>

        {/* Description */}
        <section className="bg-surface border border-border rounded-2xl p-5">
          <h2 className="text-base font-bold text-text mb-1.5">Project Descriptions</h2>
          <p className="text-sm text-muted leading-relaxed">
            {project?.description?.trim() ||
              "Provides a clear overview of a project's purpose, scope, objectives, and key details. It serves as a guide for all stakeholders involved, ensuring alignment and clarity throughout the project lifecycle."}
          </p>
        </section>

        {/* Recent Tasks */}
        <section className="bg-surface border border-border rounded-2xl overflow-hidden">
          <header className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-base font-bold text-text">Recent Tasks</h2>
            <span className="text-[11px] text-muted">
              {recentTasks.length} of {allTasks.length}
            </span>
          </header>
          {recentTasks.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted">
              No tasks yet. Click <strong className="text-text">+ Add Task</strong> below to create one.
            </div>
          ) : (
            <div>
              <div className="hidden sm:grid grid-cols-[1fr_180px_140px_120px_90px] gap-3 px-4 py-2 text-[10.5px] uppercase tracking-wider font-bold text-muted bg-bg/40">
                <div>Task</div>
                <div>Assignee</div>
                <div>Status</div>
                <div>Due / age</div>
                <div className="justify-self-end">💬</div>
              </div>
              {recentTasks.map((t) => (
                <TaskRowItem
                  key={t.id}
                  task={t}
                  projectId={id!}
                  members={members}
                  onOpen={setOpenTaskId}
                />
              ))}
            </div>
          )}
          <div className="px-5 py-3 border-t border-border flex items-center justify-between">
            <button
              onClick={() => setTaskOpen(true)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              <Plus size={14} /> Add Task
            </button>
            <Link to="list" className="text-xs text-muted hover:text-accent">View all in List →</Link>
          </div>
        </section>
      </div>

      {/* ============== RIGHT RAIL ============== */}
      <div className="space-y-5">
        {/* Summary card with the accent top stripe */}
        <section className="bg-surface border border-border rounded-2xl overflow-hidden">
          <div className="h-1 bg-accent" />
          <div className="p-5">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Summary</div>
            <h3 className="text-lg font-extrabold text-text mb-2">
              {summary.title}
            </h3>
            <p className="text-sm text-muted leading-relaxed">
              {project?.description?.trim() ||
                "This project focuses on delivering a streamlined and efficient solution to meet business needs."}
              {!project?.description && (
                <>
                  <br /><br />
                  Carefully planned to achieve success. {summary.emoji}
                </>
              )}
            </p>
            {owner && (
              <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
                <Avatar name={owner.name} email={owner.email} size={36} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text truncate">{owner.name}</div>
                  <div className="text-[11px] text-muted truncate">{owner.role || "Project owner"}</div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Recent activity timeline */}
        <section className="bg-surface border border-border rounded-2xl overflow-hidden">
          <header className="px-5 py-4 border-b border-border">
            <h2 className="text-base font-bold text-text">Recent Activity</h2>
          </header>
          <ActivityList entries={audit?.items ?? []} />
          {(audit?.items?.length ?? 0) > 5 && (
            <Link
              to={`/settings/audit?entity=project&id=${id}`}
              className="block text-center px-5 py-3 border-t border-border text-sm font-semibold text-accent hover:underline"
            >
              View All
            </Link>
          )}
        </section>
      </div>

      {/* Dialogs */}
      {taskOpen && id && (
        <AddTaskDialog
          projectId={id}
          submitting={addTask.isPending}
          onClose={() => setTaskOpen(false)}
          onAdd={(b) => addTask.mutate(b)}
        />
      )}
      {inviteOpen && id && (
        <InviteToProjectDialog
          projectId={id}
          onClose={() => setInviteOpen(false)}
        />
      )}
      {openTaskId && id && (
        <TaskDrawer
          projectId={id}
          taskId={openTaskId}
          members={members}
          onClose={() => setOpenTaskId(null)}
        />
      )}
      {fileOpen && id && (
        <UploadProjectFileDialog
          projectId={id}
          onClose={() => setFileOpen(false)}
          onUploaded={() => { setFileOpen(false); qc.invalidateQueries({ queryKey: ["project-files", id] }); }}
        />
      )}
    </div>
  );
}

/* ---------- pieces ---------- */

function ActionCard({
  icon, title, body, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-surface border border-border rounded-2xl p-4 flex items-center gap-3 text-left hover:border-accent/50 hover:bg-bg/30 transition-colors group"
    >
      <span className="relative w-12 h-12 rounded-xl bg-accent-soft/60 text-accent grid place-items-center shrink-0">
        {icon}
        <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-md bg-accent text-white grid place-items-center text-[10px] font-bold">
          <Plus size={11} />
        </span>
      </span>
      <div className="min-w-0">
        <div className="text-sm font-bold text-text">{title}</div>
        <div className="text-[11px] text-muted truncate">{body}</div>
      </div>
    </button>
  );
}

function ActivityList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        No recorded activity on this project yet.
      </div>
    );
  }
  const items = entries.slice(0, 5);
  return (
    <ul className="px-5 py-3 space-y-3">
      {items.map((e, i) => (
        <li key={e.id} className="flex items-start gap-3 relative">
          {i !== items.length - 1 && (
            <span className="absolute left-[7px] top-5 bottom-[-12px] w-px bg-border" aria-hidden />
          )}
          <span className="w-4 h-4 rounded-full bg-success/20 text-success grid place-items-center mt-0.5 shrink-0">
            <CheckCircle2 size={10} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text">{humanAction(e.action)}</div>
            <div className="text-[11px] text-muted">
              {e.actor_name ? `${e.actor_name} · ` : ""}{relTime(e.created_at)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function humanAction(action: string): string {
  const map: Record<string, string> = {
    "project.created":       "Project created",
    "project.archived":      "Project archived",
    "project.restored":      "Project restored",
    "project.updated":       "Project details updated",
    "milestone.created":     "Milestone created",
    "milestone.completed":   "Milestone completed",
    "task.created":          "Task added",
    "task.removed":          "Task removed",
    "task.completed":        "Task completed",
    "task.status_changed":   "Task status changed",
    "risk.raised":           "Risk raised",
    "report.added":          "Status report added",
    "document.attached":     "Document attached",
    "member.added":          "Team member added",
    "member.removed":        "Team member removed",
  };
  return map[action] ?? action.replace(/_/g, " ");
}

/* ---------- dialogs ---------- */

// AddTaskDialog — title / description / priority / due date / assignee.
// Assignee picker is sourced from the project's team (project_members). If the
// person you want isn't on the team, the InviteToProjectDialog adds them first.
function AddTaskDialog({
  projectId, submitting, onClose, onAdd,
}: {
  projectId: string;
  submitting: boolean;
  onClose: () => void;
  onAdd: (b: { title: string; description?: string; priority: number; due_on?: string; start_on?: string; assignee_id?: string }) => void;
}) {
  type Member = { user_id: string; name: string; email: string; role: string };
  const { data } = useQuery<{ items: Member[] }>({
    queryKey: ["project-members", projectId],
    queryFn: () => api(`/api/v1/projects/${projectId}/members`),
  });
  const members = data?.items ?? [];

  const [title, setTitle]       = useState("");
  const [description, setDesc]  = useState("");
  const [priority, setPriority] = useState(3);
  const [startOn, setStartOn]   = useState("");
  const [dueOn, setDueOn]       = useState("");
  const [assignee, setAssignee] = useState("");

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Create task</h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Title</div>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Wire up checkout endpoint" />
          </label>
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Description</div>
            <textarea className="input min-h-[80px]" value={description} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Assignee</div>
            <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name || m.email}{m.role ? ` · ${m.role}` : ""}
                </option>
              ))}
            </select>
            {members.length === 0 && (
              <div className="text-[11px] text-muted mt-1">
                No one on the team yet — close this and use <span className="font-semibold">Invite to project</span> first.
              </div>
            )}
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Priority</div>
              <select className="input" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                <option value={1}>Lowest</option>
                <option value={2}>Low</option>
                <option value={3}>Medium</option>
                <option value={4}>High</option>
                <option value={5}>Highest</option>
              </select>
            </label>
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Start date</div>
              <input type="date" className="input" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
            </label>
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Due date</div>
              <input type="date" className="input" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </label>
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!title.trim() || submitting}
            loadingLabel="Creating…"
            icon={<Plus size={14} />}
            onClick={() => onAdd({
              title: title.trim(),
              description: description.trim() || undefined,
              priority,
              due_on: dueOn || undefined,
              start_on: startOn || undefined,
              assignee_id: assignee || undefined,
            })}
          >
            Create task
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// InviteToProjectDialog — the real staffing dialog. Lists the current team
// (with role + remove) and lets you bring a workspace member onto the project
// with a chosen role. Workspace members already on the team are filtered from
// the picker so we don't duplicate; the backend's add handler tolerates the
// re-activation case but the UX is cleaner this way.
function InviteToProjectDialog({
  projectId, onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  type Member = {
    id: string; user_id: string; name: string; email: string; role: string;
    allocation: number;
  };
  type Assignable = { id: string; name: string; email: string; role?: string };

  const { data: teamData } = useQuery<{ items: Member[] }>({
    queryKey: ["project-members", projectId],
    queryFn: () => api(`/api/v1/projects/${projectId}/members`),
  });
  const { data: assignableData } = useQuery<{ items: Assignable[] }>({
    queryKey: ["project-members-assignable", projectId],
    queryFn: () => api(`/api/v1/projects/${projectId}/members/assignable`),
  });
  const team = teamData?.items ?? [];
  const teamIds = new Set(team.map((m) => m.user_id));
  const available = (assignableData?.items ?? []).filter((m) => !teamIds.has(m.id));

  const [pickUser, setPickUser] = useState("");
  const [role, setRole] = useState("contributor");
  const [allocation, setAllocation] = useState<number | "">("");

  const add = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({
          user_id: pickUser,
          role: role.trim() || "contributor",
          allocation: typeof allocation === "number" ? allocation : 0,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      qc.invalidateQueries({ queryKey: ["project-members-assignable", projectId] });
      setPickUser("");
      setRole("contributor");
      setAllocation("");
      toast.success("Added to project");
    },
    onError: (e: any) => toast.error("Could not add member", e?.message),
  });

  const remove = useMutation({
    mutationFn: (memberId: string) =>
      api(`/api/v1/projects/${projectId}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      qc.invalidateQueries({ queryKey: ["project-members-assignable", projectId] });
      toast.success("Removed from project");
    },
    onError: (e: any) => toast.error("Could not remove", e?.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-bold text-text inline-flex items-center gap-2">
            <Rocket size={18} className="text-accent" /> Invite to the project
          </h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg">
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-5">
          {/* Current team */}
          <section>
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">
              On the team · {team.length}
            </div>
            {team.length === 0 ? (
              <div className="text-sm text-muted italic">No one assigned yet.</div>
            ) : (
              <ul className="divide-y divide-border border border-border rounded-xl overflow-hidden">
                {team.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={m.name} email={m.email} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-text truncate">{m.name || m.email}</div>
                      <div className="text-[11px] text-muted truncate">
                        {m.role}{m.allocation > 0 ? ` · ${m.allocation}%` : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => remove.mutate(m.id)}
                      disabled={remove.isPending}
                      className="p-1.5 rounded text-muted hover:text-danger hover:bg-bg disabled:opacity-50"
                      title="Remove from project"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Add someone */}
          <section className="border-t border-border pt-5">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">
              Add a workspace member
            </div>
            {available.length === 0 ? (
              <div className="text-sm text-muted">
                Everyone in the workspace is already on this project.{" "}
                <Link to="/members" onClick={onClose} className="text-accent underline">
                  Invite a new member
                </Link>
                {" "}first if you need fresh hands.
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block">
                  <div className="text-[11px] text-muted font-medium mb-1">Member</div>
                  <select
                    className="input"
                    value={pickUser}
                    onChange={(e) => setPickUser(e.target.value)}
                  >
                    <option value="">Pick someone…</option>
                    {available.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.email}{m.role ? ` · ${m.role}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-[11px] text-muted font-medium mb-1">Project role</div>
                    <input
                      className="input"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      placeholder="e.g. engineer, designer"
                    />
                  </label>
                  <label className="block">
                    <div className="text-[11px] text-muted font-medium mb-1">Allocation %</div>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={100}
                      value={allocation}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAllocation(v === "" ? "" : Math.max(0, Math.min(100, Number(v))));
                      }}
                      placeholder="0 – 100"
                    />
                  </label>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <Link
                    to="/members"
                    onClick={onClose}
                    className="text-xs text-muted hover:text-text mr-auto"
                  >
                    Need someone new? Invite to workspace →
                  </Link>
                  <SmartButton
                    variant="primary"
                    disabled={!pickUser || add.isPending}
                    loadingLabel="Adding…"
                    icon={<Plus size={14} />}
                    onClick={() => add.mutate()}
                  >
                    Add to project
                  </SmartButton>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ───────────── UploadProjectFileDialog ─────────────
 *
 * Detailed project-file uploader. Captures real metadata so the Files tab
 * isn't just a heap of binary blobs:
 *
 *   • drag-and-drop or click-to-pick (single file)
 *   • display name (auto-fills from filename)
 *   • multi-line description
 *   • kind chip-picker (Architecture, Change request, Scope, Design,
 *     Contract, Spec, Meeting notes, Reference, Other)
 *   • visibility picker (Workspace / Project team / Leads only / Private)
 *   • tags (comma-separated free text, capped server-side)
 *
 * Uses native FormData so the browser handles multipart encoding; the api
 * helper is bypassed for this one request because it auto-sets a JSON
 * content-type that would break multipart boundary detection.
 */
function UploadProjectFileDialog({
  projectId, onClose, onUploaded,
}: {
  projectId: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  type Kind = "architecture" | "change_request" | "scope" | "design" | "contract" | "spec" | "meeting_notes" | "reference" | "other";
  type Visibility = "workspace" | "team" | "leads" | "private";

  const KINDS: { value: Kind; label: string; hint: string }[] = [
    { value: "architecture",   label: "Architecture",   hint: "Diagrams, system schemas" },
    { value: "change_request", label: "Change request", hint: "New scope from the client" },
    { value: "scope",          label: "Scope",          hint: "SOWs, deliverable lists" },
    { value: "design",         label: "Design",         hint: "Mockups, prototypes" },
    { value: "contract",       label: "Contract",       hint: "MSA, SOW, addenda" },
    { value: "spec",           label: "Spec",           hint: "Tech / product specs" },
    { value: "meeting_notes",  label: "Meeting notes",  hint: "Workshops, syncs" },
    { value: "reference",      label: "Reference",      hint: "Standards, examples" },
    { value: "other",          label: "Other",          hint: "Anything else" },
  ];
  const VIS: { value: Visibility; label: string; hint: string }[] = [
    { value: "workspace", label: "Workspace",    hint: "Everyone in the company can see this file" },
    { value: "team",      label: "Project team", hint: "Only members staffed on this project (recommended)" },
    { value: "leads",     label: "Leads only",   hint: "PMs and leadership only" },
    { value: "private",   label: "Private",      hint: "Only you (and admins for compliance)" },
  ];

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<Kind>("other");
  const [visibility, setVisibility] = useState<Visibility>("team");
  const [tags, setTags] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useState<HTMLInputElement | null>(null);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) {
      setErr("File exceeds 25 MB cap.");
      return;
    }
    setErr(null);
    setFile(f);
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
    // Auto-suggest a kind from the extension to save the user a click. The
    // chips are still freely editable.
    const ext = f.name.toLowerCase().split(".").pop() ?? "";
    if (kind === "other") {
      if (["pdf"].includes(ext) && /contract|sla|nda|msa|sow/i.test(f.name)) setKind("contract");
      else if (/change.?request|cr.?[-_]?\d+/i.test(f.name)) setKind("change_request");
      else if (/architecture|schema|diagram|c4/i.test(f.name)) setKind("architecture");
      else if (/scope|sow/i.test(f.name)) setKind("scope");
      else if (["fig", "sketch", "xd", "psd"].includes(ext) || /mock|design/i.test(f.name)) setKind("design");
      else if (/minutes|notes|meeting/i.test(f.name)) setKind("meeting_notes");
    }
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Pick a file first.");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", name.trim() || file.name);
      fd.append("description", description.trim());
      fd.append("kind", kind);
      fd.append("visibility", visibility);
      fd.append("tags", tags.trim());

      // Bypass api() — it forces Content-Type: application/json which
      // breaks multipart. Reach into the auth store directly for the token.
      const { token } = useAuth.getState();
      const res = await fetch("/api/v1/projects/" + projectId + "/files", {
        method: "POST",
        headers: token ? { Authorization: "Bearer " + token } : {},
        body: fd,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        let msg = "Upload failed";
        try { msg = JSON.parse(body).error ?? msg; } catch { /* plain text */ }
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: () => { toast.success("File uploaded"); onUploaded(); },
    onError: (e: any) => setErr(e?.message ?? "Could not upload."),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-xl max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-bold text-text inline-flex items-center gap-2">
            <UploadCloud size={18} className="text-accent" /> Upload to project
          </h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg">
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-5">
          {/* Drop zone */}
          {!file ? (
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                pick(e.dataTransfer.files?.[0]);
              }}
              className={`block border-2 border-dashed rounded-xl px-5 py-8 text-center cursor-pointer transition-colors ${
                drag ? "border-accent bg-accent-soft/40" : "border-border hover:border-accent/40 hover:bg-bg/30"
              }`}
            >
              <input
                ref={(r) => inputRef[1](r)}
                type="file"
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0] ?? undefined)}
              />
              <UploadCloud className="mx-auto text-accent mb-2" size={28} />
              <div className="text-sm font-semibold text-text">
                Drag & drop a file or <span className="text-accent underline">click to browse</span>
              </div>
              <div className="text-[11px] text-muted mt-1">Up to 25 MB · any format</div>
            </label>
          ) : (
            <div className="border border-border rounded-xl px-3 py-2.5 flex items-center gap-3 bg-bg/40">
              <span className="w-10 h-10 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
                <UploadCloud size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-text truncate">{file.name}</div>
                <div className="text-[11px] text-muted">
                  {(file.size / 1024 / 1024).toFixed(2)} MB · {file.type || "unknown type"}
                </div>
              </div>
              <button
                onClick={() => { setFile(null); setName(""); }}
                className="p-1.5 rounded hover:bg-surface text-muted hover:text-danger"
                title="Pick a different file"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Display name</div>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Architecture v2 · Client-portal microservices"
            />
          </label>

          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Description (optional)</div>
            <textarea
              className="input min-h-[80px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's inside? Why does it matter? Anything the next person should know before opening it."
            />
          </label>

          <div>
            <div className="text-[11px] text-muted font-medium mb-1.5">Type</div>
            <div className="grid grid-cols-3 gap-1.5">
              {KINDS.map((k) => {
                const active = kind === k.value;
                return (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    title={k.hint}
                    className={`px-2.5 py-2 rounded-lg border text-[11.5px] font-semibold text-left transition-colors ${
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-muted hover:bg-bg/40 hover:text-text"
                    }`}
                  >
                    {k.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-muted font-medium mb-1.5">Visibility</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {VIS.map((v) => {
                const active = visibility === v.value;
                return (
                  <button
                    key={v.value}
                    type="button"
                    onClick={() => setVisibility(v.value)}
                    className={`px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-text hover:bg-bg/40"
                    }`}
                  >
                    <div className="text-[12.5px] font-semibold">{v.label}</div>
                    <div className="text-[11px] text-muted leading-snug">{v.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Tags (comma-separated)</div>
            <input
              className="input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="phase-1, milestone-3, client-approved"
            />
            <div className="text-[10.5px] text-muted mt-1">Up to 8 tags. Helps the Files tab filter and search.</div>
          </label>

          {err && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 sticky bottom-0 bg-surface">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!file || upload.isPending}
            loadingLabel="Uploading…"
            icon={<UploadCloud size={14} />}
            onClick={() => upload.mutateAsync()}
          >
            Upload file
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// Kept parked for the file-upload action which currently links to the Files tab
// instead. Re-wire when in-place uploads land.
function InfoDialog({
  icon, title, body, onClose,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text inline-flex items-center gap-2">{icon} {title}</h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg"><X size={16} /></button>
        </header>
        <div className="p-5 text-sm text-muted leading-relaxed">{body}</div>
        <footer className="px-5 py-3 border-t border-border flex items-center justify-end">
          <button onClick={onClose} className="text-sm font-semibold text-accent hover:underline">Got it</button>
        </footer>
      </div>
    </div>
  );
}

void InfoDialog;
