import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import {
  Check, ListChecks, Link2, Mail, MoreHorizontal, Plus, Copy, Clock, Users as UsersIcon, ExternalLink, Activity,
} from "lucide-react";
import { ProjectExternalOverview } from "./ProjectExternalOverview";
import { ProjectOperationalOverview } from "./ProjectOperationalOverview";

type ProjectLink = { label: string; url: string; kind?: string };

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  budget: number;
  currency: string;
  description?: string;
  links: ProjectLink[];
  opportunity_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  lead_type?: string;
  client_name?: string;
};

type Task = {
  id: string;
  title: string;
  description: string;
  priority: number;
  due_on: string | null;
  assignee_id?: string | null;
};

type Board = {
  columns: { todo: Task[]; in_progress: Task[]; review: Task[]; done: Task[] };
};

type Stakeholder = {
  id: string;
  name: string;
  role: string;
  kind: "internal" | "external";
  email?: string;
  phone?: string;
};

const PHASES: { key: string; label: string; covers: string[] }[] = [
  { key: "planning",   label: "Planning & Research", covers: ["planning"] },
  { key: "design",     label: "Design & Prototyping", covers: [] /* future */ },
  { key: "delivery",   label: "Build & Delivery",     covers: ["in_progress"] },
  { key: "qa",         label: "Testing & Revisions",  covers: ["qa_review"] },
  { key: "launch",     label: "Launch & Hand-off",    covers: ["client_acceptance", "invoiced", "paid", "closed"] },
];

function fmtMoney(n: number, ccy = "NGN"): string {
  if (!n && n !== 0) return "—";
  const sym = ({ USD: "$", EUR: "€", GBP: "£", NGN: "₦", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA" } as Record<string, string>)[ccy] ?? ccy;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function ProjectOverview() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"todo" | "done">("todo");
  const [linksOpen, setLinksOpen] = useState(false);

  const { data: project } = useQuery<Project>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`), enabled: !!id,
  });
  const { data: board } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`), enabled: !!id,
  });
  const { data: stakeholdersData } = useQuery<{ items: Stakeholder[] }>({
    queryKey: ["project-stakeholders", id], queryFn: () => api(`/api/v1/projects/${id}/stakeholders`), enabled: !!id,
  });

  const updateLinks = useMutation({
    mutationFn: (links: ProjectLink[]) => api(`/api/v1/projects/${id}/links`, {
      method: "PUT", body: JSON.stringify({ links }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });
  const addTask = useMutation({
    mutationFn: (t: { title: string; description?: string; priority: number }) =>
      api(`/api/v1/projects/${id}/tasks`, { method: "POST", body: JSON.stringify(t) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-board", id] }),
  });

  const todoTasks = useMemo(() => {
    if (!board) return [];
    return [...board.columns.todo, ...board.columns.in_progress, ...board.columns.review];
  }, [board]);
  const doneTasks = board?.columns.done ?? [];

  const bottlenecks = todoTasks.filter((t) => t.priority <= 2);
  const soon = todoTasks.filter((t) => t.priority > 2);

  const manager = (stakeholdersData?.items ?? []).find((s) => /manager|lead|sponsor/i.test(s.role)) ?? stakeholdersData?.items?.[0];
  const teamSize = (stakeholdersData?.items ?? []).length;

  if (!project) return <div className="text-muted">Loading…</div>;

  // The operational dashboard is the new default — it covers delivery
  // execution, governance, milestones, engineering, finance and audit in one place.
  return (
    <ProjectOperationalOverview
      project={project as any}
      board={board}
      stakeholders={stakeholdersData?.items ?? []}
    />
  );

  // Legacy layouts still available for reference.
  // eslint-disable-next-line no-unreachable
  if (project.lead_type && project.lead_type !== "internal") {
    return (
      <ProjectExternalOverview
        project={project as any}
        board={board}
        stakeholders={stakeholdersData?.items ?? []}
      />
    );
  }

  const ccy = project.currency || "USD";
  // Mock payment values until finance is wired through.
  const paid = Math.round(project.budget * 0.55);
  const due = paid - project.budget;
  const onTrack = project.health === "green";

  return (
    <div className="space-y-5">
      {/* Title row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted">
            <span className="capitalize">{project.status.replace(/_/g, " ")}</span>
            <span>·</span>
            <span>{teamSize} stakeholders</span>
            {project.start_date && <><span>·</span><span>Starts {fmtDate(project.start_date)}</span></>}
            {project.end_date && <><span>·</span><span>Ends {fmtDate(project.end_date)}</span></>}
          </div>
        </div>
        <div className="flex items-stretch gap-3">
          <KeyStat label="Status" value={
            <span className={`inline-flex items-center gap-1 ${onTrack ? "text-success" : "text-warn"}`}>
              <Clock size={14} /> {onTrack ? "On track" : (project.health === "amber" ? "Watch" : "At risk")}
            </span>
          } />
          <KeyStat label="Budget" value={<span>{fmtMoney(project.budget, ccy)}</span>} />
          <KeyStat label="Paid"   value={<span className="text-success">{fmtMoney(paid, ccy)}</span>} />
          <KeyStat label="Pay-due" value={<span className={due < 0 ? "text-danger" : ""}>{fmtMoney(due, ccy)}</span>} />
        </div>
      </div>

      {/* Progress chevron tracker */}
      <Card title="Progress">
        <div className="flex flex-wrap items-stretch gap-2 mt-1">
          {PHASES.map((ph, i) => {
            const active = ph.covers.includes(project.status);
            const done = PHASES.slice(0, i).some((p) => p.covers.includes(project.status));
            const tone = active
              ? "bg-success/15 text-success border-success/40"
              : done
                ? "bg-bg text-text border-border"
                : "bg-bg text-muted border-border";
            return (
              <div
                key={ph.key}
                className={`flex-1 min-w-[160px] flex items-center justify-center text-sm font-medium px-4 py-3 border ${tone}`}
                style={{
                  clipPath: i === 0
                    ? "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%)"
                    : i === PHASES.length - 1
                    ? "polygon(0 0, 100% 0, 100% 100%, 0 100%, 14px 50%)"
                    : "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%)",
                }}
              >
                {done && <Check size={14} className="mr-1.5" />}
                {ph.label}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Work process — 2 cols */}
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h2 className="h2">Work process</h2>
              <button
                className="btn-outline"
                onClick={() => {
                  const title = prompt("Task title?");
                  if (!title) return;
                  const description = prompt("One-line description (optional)") ?? "";
                  addTask.mutate({ title, description, priority: 2 });
                }}
              >
                <Plus size={14} /> Add task
              </button>
            </div>
            <div className="flex items-center gap-1 border-b border-border -mt-1 mb-4">
              <TabButton on={tab === "todo"} onClick={() => setTab("todo")} icon={<ListChecks size={14} />}>
                To-do list <span className="ml-1 text-muted">{todoTasks.length}</span>
              </TabButton>
              <TabButton on={tab === "done"} onClick={() => setTab("done")} icon={<Check size={14} />}>
                Done <span className="ml-1 text-muted">{doneTasks.length}</span>
              </TabButton>
            </div>

            {tab === "todo" ? (
              <div className="space-y-5">
                <TaskGroup label="Bottlenecks" tasks={bottlenecks} empty="No high-priority blockers." />
                <TaskGroup label="Soon"        tasks={soon}        empty="Backlog is clear." />
              </div>
            ) : (
              <div className="space-y-3">
                {doneTasks.length === 0 ? (
                  <div className="text-sm text-muted italic py-6 text-center">Nothing completed yet.</div>
                ) : (
                  doneTasks.map((t) => <TaskRow key={t.id} task={t} done />)
                )}
              </div>
            )}
          </Card>
        </div>

        {/* Sidebar — 1 col */}
        <div className="space-y-5">
          {/* Brief */}
          {project.description && (
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <Activity size={16} className="text-muted" />
                <h2 className="h2">Brief</h2>
              </div>
              <p className="text-sm text-text leading-relaxed">{project.description}</p>
              {project.opportunity_id && (
                <Link to={`/pipeline/${project.opportunity_id}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-3">
                  Open source opportunity <ExternalLink size={11} />
                </Link>
              )}
            </Card>
          )}

          {/* Project links */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Link2 size={16} className="text-muted" />
                <h2 className="h2">Project links</h2>
              </div>
              <button
                className="btn-outline !px-3 !py-1.5 text-xs"
                onClick={() => setLinksOpen(true)}
                title="Edit links"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            {project.links.length === 0 ? (
              <p className="text-sm text-muted">No links yet — add Figma, Drive, or repo URLs so the team can find them.</p>
            ) : (
              <ul className="space-y-2">
                {project.links.map((l, i) => <LinkRow key={i} link={l} />)}
              </ul>
            )}
          </Card>

          {/* Project manager */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <UsersIcon size={16} className="text-muted" />
              <h2 className="h2">Project manager</h2>
            </div>
            {!manager ? (
              <p className="text-sm text-muted">No manager assigned yet. Add one in stakeholders.</p>
            ) : (
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full grid place-items-center text-sm font-bold ${
                  manager.kind === "external" ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
                }`}>
                  {(manager.name || "?")[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text truncate">{manager.name}</div>
                  {manager.email && (
                    <a href={`mailto:${manager.email}`} className="text-xs text-muted hover:underline inline-flex items-center gap-1 truncate">
                      <Mail size={11} /> {manager.email}
                    </a>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {linksOpen && (
        <LinksDialog
          links={project.links}
          onClose={() => setLinksOpen(false)}
          onSave={(links) => {
            updateLinks.mutate(links, { onSuccess: () => setLinksOpen(false) });
          }}
        />
      )}
    </div>
  );
}

function KeyStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-md px-3 py-2 min-w-[100px]">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function TabButton({
  on, onClick, icon, children,
}: {
  on: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
        on ? "border-accent text-accent font-semibold" : "border-transparent text-muted hover:text-text"
      }`}
    >
      {icon} {children}
    </button>
  );
}

function TaskGroup({ label, tasks, empty }: { label: string; tasks: Task[]; empty: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">{label}</div>
        <span className="text-xs text-muted">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="text-sm text-muted italic py-2">{empty}</div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ task, done }: { task: Task; done?: boolean }) {
  const priorityLabel = ["", "P1 · Critical", "P2 · High", "P3 · Medium", "P4 · Low", "P5 · Lowest"][task.priority] ?? "P3";
  const priorityCls = task.priority <= 1 ? "bg-danger/15 text-danger"
                    : task.priority === 2 ? "bg-warn/15 text-warn"
                    : "bg-success/15 text-success";
  return (
    <li className="flex items-start gap-3 border border-border rounded-md p-3 hover:border-accent/50 transition-colors">
      <span className={`mt-0.5 w-4 h-4 rounded-full border-2 ${
        done ? "bg-success border-success" : "border-border"
      } grid place-items-center shrink-0`}>
        {done && <Check size={10} className="text-white" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${done ? "text-muted line-through" : "text-text"}`}>{task.title}</div>
        {task.description && <div className="text-xs text-muted mt-0.5 line-clamp-2">{task.description}</div>}
        <div className="flex items-center gap-2 mt-1.5">
          <span className={`pill ${priorityCls}`}>{priorityLabel}</span>
          {task.due_on && (
            <span className="text-[11px] text-muted inline-flex items-center gap-1">
              <Clock size={11} /> Due {fmtDate(task.due_on)}
            </span>
          )}
        </div>
      </div>
      <button className="text-muted hover:text-text p-1" aria-label="Task options">
        <MoreHorizontal size={16} />
      </button>
    </li>
  );
}

function LinkRow({ link }: { link: ProjectLink }) {
  const host = (() => {
    try { return new URL(link.url).host.replace(/^www\./, ""); } catch { return link.url; }
  })();
  function copy() {
    navigator.clipboard?.writeText(link.url);
  }
  return (
    <li className="flex items-center gap-3 p-2 -mx-2 rounded-md hover:bg-bg group">
      <span className="w-8 h-8 rounded-full bg-bg border border-border grid place-items-center shrink-0">
        <Link2 size={14} className="text-muted" />
      </span>
      <div className="flex-1 min-w-0">
        <a href={link.url} target="_blank" rel="noreferrer"
           className="text-sm font-medium text-text hover:text-accent truncate inline-block max-w-full">
          {link.label}
        </a>
        <div className="text-[11px] text-muted truncate">{host}</div>
      </div>
      <button onClick={copy} className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 text-xs text-muted hover:text-text border border-border rounded px-2 py-1">
        <Copy size={11} /> Copy
      </button>
    </li>
  );
}

function LinksDialog({
  links, onClose, onSave,
}: {
  links: ProjectLink[];
  onClose: () => void;
  onSave: (links: ProjectLink[]) => void;
}) {
  const [draft, setDraft] = useState<ProjectLink[]>(links.length ? links : [{ label: "", url: "" }]);

  function update(i: number, patch: Partial<ProjectLink>) {
    setDraft((d) => d.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }
  function add() { setDraft((d) => [...d, { label: "", url: "" }]); }
  function remove(i: number) { setDraft((d) => d.filter((_, idx) => idx !== i)); }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-semibold text-text">Project links</h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1">×</button>
        </header>
        <div className="p-5 space-y-3 max-h-[60vh] overflow-auto">
          {draft.map((l, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 border border-border rounded-md p-3">
              <input className="input" placeholder="Label (e.g. Figma board)" value={l.label} onChange={(e) => update(i, { label: e.target.value })} />
              <input className="input" placeholder="https://…" value={l.url} onChange={(e) => update(i, { url: e.target.value })} />
              <div className="flex justify-end">
                <button className="text-xs text-muted hover:text-danger" onClick={() => remove(i)}>Remove</button>
              </div>
            </div>
          ))}
          <button onClick={add} className="btn-outline w-full">
            <Plus size={14} /> Add another
          </button>
        </div>
        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <button onClick={() => onSave(draft.filter((l) => l.label.trim() && l.url.trim()))} className="btn-primary">
            Save links
          </button>
        </footer>
      </div>
    </div>
  );
}
