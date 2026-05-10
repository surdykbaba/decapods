import { useMemo, useState, useEffect } from "react";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2, Clock, AlertTriangle, ListChecks, FileText, Inbox, Github,
  PauseCircle, MessageSquare, ArrowRight, Plus, Calendar, Activity, Zap, X,
  Folder, ChevronRight, ChevronDown, Search, Link as LinkIcon, FileType2, Briefcase, LayoutGrid, Rows3,
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

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any> }[] = [
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
      <FileLibraryCard />

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

function FileLibraryCard() {
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
          {(showAllProjects ? projectGroups : projectGroups.slice(0, PROJECT_PREVIEW)).map((g) => {
            const isCollapsed = !!collapsed[g.key];
            const targetUrl = g.isProject && g.projectId ? `/projects/${g.projectId}` : `/pipeline/${g.opportunityId}`;
            return (
              <div key={g.key} className="border border-border rounded-xl overflow-hidden bg-bg/30">
                <div className="flex items-center gap-3 px-4 py-3 bg-surface border-b border-border">
                  <button
                    onClick={() => toggle(g.key)}
                    className="text-muted hover:text-text shrink-0"
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                  >
                    {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                  </button>
                  <div className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${
                    g.isProject ? "bg-accent-soft text-accent" : "bg-warn/10 text-warn"
                  }`}>
                    {g.isProject ? <Briefcase size={16} /> : <FileText size={16} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-[14px] font-bold text-text truncate" title={g.projectName ?? g.opportunityTitle}>
                        {g.projectName ?? g.opportunityTitle}
                      </div>
                      {!g.isProject && (
                        <span className="text-[9.5px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-warn/15 text-warn">
                          Pre-project
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted truncate">
                      {g.isProject && <>From: {g.opportunityTitle} · </>}
                      {g.items.length} file{g.items.length === 1 ? "" : "s"} · {g.byKind.length} type{g.byKind.length === 1 ? "" : "s"} · updated {relTimeShort(g.lastUpdated)}
                    </div>
                  </div>
                  <Link
                    to={targetUrl}
                    className="text-xs font-semibold text-accent hover:underline whitespace-nowrap shrink-0"
                  >
                    Open {g.isProject ? "project" : "lead"} →
                  </Link>
                </div>

                {!isCollapsed && (
                  <div className="p-3 space-y-3">
                    {g.byKind.map((kg) => (
                      <div key={kg.kind}>
                        <div className="flex items-center gap-2 mb-1.5 px-1">
                          <FileType2 size={11} className="text-muted" />
                          <div className="text-[10.5px] uppercase tracking-wide font-bold text-muted">{kg.label}</div>
                          <div className="px-1.5 py-px rounded-full bg-bg border border-border text-[9.5px] font-bold text-muted">
                            {kg.items.length}
                          </div>
                          <div className="flex-1 h-px bg-border/60" />
                        </div>
                        <ul className={listCls}>
                          {kg.items.map((f) => (
                            <li key={f.id} className={itemCls}>
                              <FileRowItem file={f} compact />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
                    <FileRowItem file={f} />
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
                <FileRowItem file={f} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function FileRowItem({ file, compact }: { file: FileRow; compact?: boolean }) {
  const ext = fileTypeFromName(file.name, file.object_key);
  const url = isUrl(file.object_key);
  const colorCls = fileExtColor(ext, url);
  return (
    <div className="h-full flex items-center gap-3 bg-surface border border-border rounded-lg p-2.5 hover:border-accent transition-colors">
      <div className={`w-9 h-9 rounded-md grid place-items-center text-[9.5px] font-extrabold shrink-0 border ${colorCls}`}>
        {url ? <LinkIcon size={13} /> : ext.slice(0, 4)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-text truncate" title={file.name}>{file.name}</div>
        <div className="text-[11px] text-muted truncate">
          {!compact && <>{DOC_KIND_LABELS[file.kind] ?? file.kind} · </>}
          {!compact && file.project_name && <>{file.project_name} · </>}
          {relTimeShort(file.uploaded_at)}
        </div>
      </div>
      {url ? (
        <a
          href={file.object_key}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold text-accent hover:underline whitespace-nowrap shrink-0"
        >
          Open ↗
        </a>
      ) : (
        <Link
          to={`/pipeline/${file.opportunity_id}`}
          className="text-xs font-semibold text-accent hover:underline whitespace-nowrap shrink-0"
        >
          Open →
        </Link>
      )}
    </div>
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
    mutationFn: () => api("/api/v1/me/profile", {
      method: "PUT",
      body: JSON.stringify({ name, github_username: github }),
    }),
    onSuccess: () => {
      toast.success("Profile updated", "Your changes have been saved.");
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e: unknown) => {
      const msg = (e as { message?: string })?.message ?? "Could not save your profile.";
      toast.error("Save failed", msg);
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
