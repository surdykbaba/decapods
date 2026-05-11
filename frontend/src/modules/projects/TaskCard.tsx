import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MentionInput } from "@/modules/campfire/MentionInput";
import { SmartBody } from "@/modules/campfire/smartBody";
import {
  CheckCircle2, Hourglass, Clock, AlertCircle, Ban,
  Calendar as CalendarIcon, MessageSquare, User as UserIcon, X, Send,
  Paperclip, Download, Trash2, UploadCloud,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar } from "@/components/Avatar";
import { toast } from "@/lib/toast";

export type TaskRow = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  due_on: string | null;
  start_on?: string | null;
  created_at?: string;
  assignee_id?: string | null;
  comments_count?: number;
};

export type ProjectMember = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string;
};

const STATUS_META: Record<string, { label: string; icon: any; cls: string; dot: string }> = {
  todo:        { label: "Not started", icon: Hourglass,    cls: "text-muted",   dot: "bg-muted/40" },
  in_progress: { label: "In progress", icon: Clock,        cls: "text-accent",  dot: "bg-accent" },
  blocked:     { label: "Blocked",     icon: Ban,          cls: "text-danger",  dot: "bg-danger" },
  review:      { label: "In review",   icon: AlertCircle,  cls: "text-warn",    dot: "bg-warn" },
  done:        { label: "Done",        icon: CheckCircle2, cls: "text-success", dot: "bg-success" },
};
const STATUS_OPTIONS = ["todo", "in_progress", "blocked", "review", "done"] as const;

function ageDays(startISO?: string | null, createdISO?: string): number | null {
  const seed = startISO || createdISO;
  if (!seed) return null;
  const d = new Date(seed);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dueTone(iso: string | null, done: boolean): string {
  if (!iso || done) return "text-muted";
  const d = new Date(iso);
  const now = new Date();
  const oneDay = 86_400_000;
  if (d.getTime() < now.getTime() - oneDay) return "text-danger";
  if (d.getTime() < now.getTime() + oneDay) return "text-warn";
  return "text-text";
}

export function useTaskPatch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: Record<string, any> }) =>
      api(`/api/v1/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onMutate: async ({ taskId, patch }) => {
      await qc.cancelQueries({ queryKey: ["project-board", projectId] });
      const prev = qc.getQueryData<any>(["project-board", projectId]);
      if (prev?.columns) {
        const next = { ...prev, columns: { ...prev.columns } };
        for (const col of Object.keys(next.columns)) {
          next.columns[col] = next.columns[col].map((t: TaskRow) =>
            t.id === taskId ? { ...t, ...patch } : t,
          );
        }
        // Move card between columns if status changed.
        if (patch.status) {
          const all: TaskRow[] = [];
          for (const col of Object.keys(next.columns)) all.push(...next.columns[col]);
          const fresh: Record<string, TaskRow[]> = { todo: [], in_progress: [], blocked: [], review: [], done: [] };
          for (const t of all) (fresh[t.status] ||= []).push(t);
          next.columns = fresh;
        }
        qc.setQueryData(["project-board", projectId], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["project-board", projectId], ctx.prev);
      toast.error("Could not update task");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["project-board", projectId] });
    },
  });
}

export function TaskRowItem({
  task, projectId, members, onOpen,
}: {
  task: TaskRow;
  projectId: string;
  members: ProjectMember[];
  onOpen: (taskId: string) => void;
}) {
  const patch = useTaskPatch(projectId);
  const assignee = members.find((m) => m.user_id === task.assignee_id);
  const meta = STATUS_META[task.status] ?? STATUS_META.todo;
  const done = task.status === "done";
  const age = ageDays(task.start_on, task.created_at);

  return (
    <div className="grid grid-cols-[1fr_180px_140px_120px_90px] items-center gap-3 px-4 py-2.5 border-t border-border hover:bg-bg/30 text-sm">
      {/* Title + status dot */}
      <button
        onClick={() => onOpen(task.id)}
        className="flex items-center gap-2.5 text-left min-w-0"
      >
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dot}`} />
        <span className={`truncate ${done ? "line-through text-muted" : "text-text font-medium"}`}>
          {task.title}
        </span>
      </button>

      {/* Assignee */}
      <select
        value={task.assignee_id ?? ""}
        onChange={(e) => patch.mutate({ taskId: task.id, patch: { assignee_id: e.target.value } })}
        className="text-xs bg-transparent border border-transparent hover:border-border rounded px-1.5 py-1 text-text"
      >
        <option value="">Unassigned</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>
        ))}
      </select>

      {/* Status */}
      <select
        value={task.status}
        onChange={(e) => patch.mutate({ taskId: task.id, patch: { status: e.target.value } })}
        className={`text-xs bg-transparent border border-transparent hover:border-border rounded px-1.5 py-1 font-medium ${meta.cls}`}
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s} className="text-text">{STATUS_META[s].label}</option>
        ))}
      </select>

      {/* Due + age */}
      <div className="min-w-0">
        {task.due_on ? (
          <div className={`text-xs ${dueTone(task.due_on, done)}`}>
            <CalendarIcon size={11} className="inline mr-1 -mt-0.5" />
            {fmtDate(task.due_on)}
          </div>
        ) : (
          <div className="text-xs text-muted">—</div>
        )}
        {age !== null && !done && (
          <div className="text-[10px] text-muted/80 mt-0.5">{age}d old</div>
        )}
      </div>

      {/* Comments */}
      <button
        onClick={() => onOpen(task.id)}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent justify-self-end"
        title="Open comments"
      >
        <MessageSquare size={13} />
        <span>{task.comments_count ?? 0}</span>
      </button>

      {/* Avatar overlay on assignee column (visual cue) */}
      {assignee && (
        <div className="hidden" aria-hidden>
          <Avatar name={assignee.name} email={assignee.email} src={assignee.avatar_url} size={20} />
        </div>
      )}
    </div>
  );
}

export function TaskBoardCard({
  task, projectId, members, onOpen,
}: {
  task: TaskRow;
  projectId: string;
  members: ProjectMember[];
  onOpen: (taskId: string) => void;
}) {
  const patch = useTaskPatch(projectId);
  const assignee = members.find((m) => m.user_id === task.assignee_id);
  const meta = STATUS_META[task.status] ?? STATUS_META.todo;
  const age = ageDays(task.start_on, task.created_at);
  const done = task.status === "done";

  return (
    <div className="bg-surface border border-border rounded-xl p-3 hover:border-accent/40 transition-colors">
      <button onClick={() => onOpen(task.id)} className="text-left w-full">
        <div className={`text-sm font-semibold ${done ? "line-through text-muted" : "text-text"}`}>
          {task.title}
        </div>
      </button>

      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px]">
        <select
          value={task.status}
          onChange={(e) => patch.mutate({ taskId: task.id, patch: { status: e.target.value } })}
          className={`bg-bg/40 border border-border rounded px-1.5 py-0.5 font-medium ${meta.cls}`}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s} className="text-text">{STATUS_META[s].label}</option>
          ))}
        </select>
        {task.due_on && (
          <span className={`inline-flex items-center gap-1 ${dueTone(task.due_on, done)}`}>
            <CalendarIcon size={11} />
            {fmtDate(task.due_on)}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        {assignee ? (
          <div className="inline-flex items-center gap-1.5 min-w-0">
            <Avatar name={assignee.name} email={assignee.email} src={assignee.avatar_url} size={20} />
            <span className="text-[11px] text-muted truncate">{assignee.name.split(" ")[0]}</span>
          </div>
        ) : (
          <select
            value=""
            onChange={(e) => patch.mutate({ taskId: task.id, patch: { assignee_id: e.target.value } })}
            className="text-[11px] text-muted bg-transparent border border-dashed border-border rounded px-1.5 py-0.5"
          >
            <option value="">Assign…</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>
            ))}
          </select>
        )}
        <div className="inline-flex items-center gap-2 text-[11px] text-muted">
          {age !== null && !done && <span>{age}d</span>}
          <button onClick={() => onOpen(task.id)} className="inline-flex items-center gap-1 hover:text-accent" title="Comments">
            <MessageSquare size={11} /> {task.comments_count ?? 0}
          </button>
        </div>
      </div>
    </div>
  );
}

type Comment = {
  id: string;
  body: string;
  created_at: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  author_avatar: string;
};

export function TaskDrawer({
  projectId, taskId, members, onClose,
}: {
  projectId: string;
  taskId: string;
  members: ProjectMember[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const patch = useTaskPatch(projectId);

  // Pull this task out of the board cache (so we don't need a single-task API).
  const board = qc.getQueryData<any>(["project-board", projectId]);
  const task: TaskRow | undefined = board
    ? (Object.values(board.columns).flat() as TaskRow[]).find((t) => t.id === taskId)
    : undefined;

  const { data: commentsData } = useQuery<{ items: Comment[] }>({
    queryKey: ["task-comments", taskId],
    queryFn: () => api(`/api/v1/projects/${projectId}/tasks/${taskId}/comments`),
  });
  const comments = commentsData?.items ?? [];

  const [draft, setDraft] = useState("");
  const addComment = useMutation({
    mutationFn: (body: string) =>
      api(`/api/v1/projects/${projectId}/tasks/${taskId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task-comments", taskId] });
      qc.invalidateQueries({ queryKey: ["project-board", projectId] });
      setDraft("");
    },
    onError: (e: any) => toast.error("Could not post comment", e?.message),
  });

  if (!task) return null;
  const assignee = members.find((m) => m.user_id === task.assignee_id);
  const meta = STATUS_META[task.status] ?? STATUS_META.todo;

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside
        className="absolute right-0 top-0 bottom-0 w-full max-w-[480px] bg-surface border-l border-border shadow-card flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted">Task</div>
            <h2 className="text-lg font-extrabold text-text leading-tight mt-0.5">{task.title}</h2>
            <div className={`inline-flex items-center gap-1.5 text-xs mt-1.5 ${meta.cls}`}>
              <span className={`w-2 h-2 rounded-full ${meta.dot}`} /> {meta.label}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg">
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Fields */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select
                value={task.status}
                onChange={(e) => patch.mutate({ taskId: task.id, patch: { status: e.target.value } })}
                className="input"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
            </Field>
            <Field label="Assignee">
              <select
                value={task.assignee_id ?? ""}
                onChange={(e) => patch.mutate({ taskId: task.id, patch: { assignee_id: e.target.value } })}
                className="input"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>
                ))}
              </select>
            </Field>
            <Field label="Start date">
              <input
                type="date"
                value={task.start_on ?? ""}
                onChange={(e) => patch.mutate({ taskId: task.id, patch: { start_on: e.target.value } })}
                className="input"
              />
            </Field>
            <Field label="Due date">
              <input
                type="date"
                value={task.due_on ?? ""}
                onChange={(e) => patch.mutate({ taskId: task.id, patch: { due_on: e.target.value } })}
                className="input"
              />
            </Field>
          </div>

          {task.description && (
            <Field label="Description">
              <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{task.description}</p>
            </Field>
          )}

          {assignee && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <UserIcon size={12} /> Assigned to
              <Avatar name={assignee.name} email={assignee.email} src={assignee.avatar_url} size={20} />
              <span className="text-text">{assignee.name || assignee.email}</span>
            </div>
          )}

          {/* Files */}
          <TaskFiles projectId={projectId} taskId={taskId} />

          {/* Comments */}
          <div className="pt-2 border-t border-border">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-3">
              Comments · {comments.length}
            </div>
            {comments.length === 0 ? (
              <div className="text-sm text-muted italic">No comments yet. Be the first.</div>
            ) : (
              <ul className="space-y-3">
                {comments.map((c) => (
                  <li key={c.id} className="flex gap-2.5">
                    <Avatar name={c.author_name} email={c.author_email} src={c.author_avatar} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-text">{c.author_name || c.author_email || "Someone"}</span>
                        <span className="text-[10px] text-muted">{relTime(c.created_at)}</span>
                      </div>
                      {/* SmartBody handles emoji, sticker shortcodes,
                          @mentions and inline URL embeds — same renderer
                          Campfire uses, so comments behave consistently
                          everywhere. */}
                      <SmartBody className="text-sm text-text mt-0.5" text={c.body} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border">
          <div className="flex items-end gap-2">
            {/* MentionInput gives us emoji + sticker picker, @mention
                autocomplete, and Enter-to-send for free — same widget as
                every Campfire surface, so the comment box behaves
                identically across the app. */}
            <div className="flex-1 min-w-0">
              <MentionInput
                value={draft}
                onChange={setDraft}
                placeholder="Write a comment… (@ to mention, emoji button bottom-right, Enter to send)"
                minRows={2}
                className="input flex-1 resize-none min-h-[60px]"
                onSubmit={() => draft.trim() && addComment.mutate(draft.trim())}
              />
            </div>
            <button
              onClick={() => draft.trim() && addComment.mutate(draft.trim())}
              disabled={!draft.trim() || addComment.isPending}
              className="p-2.5 rounded-lg bg-accent text-white disabled:opacity-50 shrink-0"
              aria-label="Send comment"
              title="Send"
            >
              <Send size={14} />
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] text-muted font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ---------- Task files ---------- */

type TaskFile = {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  uploaded_by_name: string;
  created_at: string;
  download_url: string;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function TaskFiles({ projectId, taskId }: { projectId: string; taskId: string }) {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data } = useQuery<{ items: TaskFile[] }>({
    queryKey: ["task-files", taskId],
    queryFn: () => api(`/api/v1/projects/${projectId}/files?task=${taskId}`),
  });
  const files = data?.items ?? [];

  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/v1/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task-files", taskId] });
      qc.invalidateQueries({ queryKey: ["project-board", projectId] });
      toast.success("File removed");
    },
    onError: (e: any) => toast.error("Could not remove", e?.message),
  });

  // Multipart upload — bypasses the JSON-only api() helper so we can stream a
  // FormData body. Auth token comes from the same auth store.
  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("task_id", taskId);
      fd.append("kind", "other");
      fd.append("visibility", "team");
      const res = await fetch(`/api/v1/projects/${projectId}/files`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = "Upload failed";
        try { msg = (JSON.parse(text)?.error) || text || msg; } catch { msg = text || msg; }
        throw new Error(msg);
      }
      qc.invalidateQueries({ queryKey: ["task-files", taskId] });
      qc.invalidateQueries({ queryKey: ["project-board", projectId] });
      toast.success("File attached");
    } catch (e: any) {
      toast.error("Could not upload", e?.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Download with auth header — anchor tags can't carry the bearer, so fetch
  // the bytes, stream into a blob URL, then synthesise a click.
  async function downloadFile(f: TaskFile) {
    try {
      const res = await fetch(f.download_url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error("Could not download", e?.message);
    }
  }

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] uppercase tracking-wider font-bold text-muted inline-flex items-center gap-1.5">
          <Paperclip size={12} /> Files · {files.length}
        </div>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline disabled:opacity-50"
        >
          <UploadCloud size={12} /> {uploading ? "Uploading…" : "Attach"}
        </button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>

      {files.length === 0 ? (
        <div className="text-sm text-muted italic">
          Nothing attached yet. Drop a wireframe, spec, or screenshot to give context.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border hover:border-accent/40 bg-bg/30 group"
            >
              <Paperclip size={13} className="text-muted shrink-0" />
              <button
                onClick={() => downloadFile(f)}
                className="flex-1 min-w-0 text-left"
                title="Download"
              >
                <div className="text-sm font-medium text-text truncate group-hover:text-accent">{f.name}</div>
                <div className="text-[10.5px] text-muted truncate">
                  {fmtSize(f.size_bytes)} · {f.uploaded_by_name || "—"} · {relTime(f.created_at)}
                </div>
              </button>
              <button
                onClick={() => downloadFile(f)}
                className="p-1 rounded text-muted hover:text-accent"
                title="Download"
                aria-label="Download"
              >
                <Download size={13} />
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete "${f.name}"?`)) remove.mutate(f.id);
                }}
                className="p-1 rounded text-muted hover:text-danger"
                title="Delete"
                aria-label="Delete"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
