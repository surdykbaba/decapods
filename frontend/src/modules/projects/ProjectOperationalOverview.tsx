import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import {
  AlertTriangle, AlertCircle, FileText, Upload, Plus, ShieldCheck, Github,
  GitPullRequest, GitCommit, Rocket, X, Check, Clock, CircleDot, ArrowRight,
  ListChecks, Bug, FileBarChart2, Wallet, History,
  Flag, CalendarClock, Mail, Target, Archive,
  MoreHorizontal,
} from "lucide-react";

/* ---------- Types ---------- */

type ProjectLink = { label: string; url: string; kind?: string };
type Stakeholder = { id: string; name: string; role: string; kind: "internal" | "external"; email?: string };
type Milestone = { id: string; title: string; due_on: string | null; status: string; created_at: string };
type Invoice = { id: string; number: string; amount: number; currency: string; status: string; issued_on: string | null };
type Repo = { id: string; owner: string; name: string };
type Risk = { id: string; title: string; severity: "low" | "medium" | "high"; owner: string; due_on?: string; mitigation?: string; status: "active" | "mitigating" | "resolved"; at: string };
type Report = { id: string; kind: string; title: string; body?: string; by: string; at: string };
type AuditEntry = { id?: string; at: string; by?: string; kind: string; title: string };
type Checkpoints = Partial<Record<"nda" | "sla" | "contract" | "scope" | "security" | "qa" | "client_acceptance", boolean>>;

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: "green" | "amber" | "red";
  risk_score: number;
  budget: number;
  currency: string;
  description?: string;
  lead_type?: string;
  client_name?: string;
  links: ProjectLink[];
  opportunity_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  metadata?: {
    risks?: Risk[];
    reports?: Report[];
    audit_log?: AuditEntry[];
    checkpoints?: Checkpoints;
    stage_history?: AuditEntry[];
  };
  milestones: Milestone[];
  invoices: Invoice[];
  invoice_total: number;
  invoice_paid: number;
  repos: Repo[];
};

type Task = { id: string; title: string; description: string; priority: number; due_on: string | null; status?: string };
type Board = { columns: { todo: Task[]; in_progress: Task[]; review: Task[]; done: Task[] } };

type OppData = {
  documents?: { id: string; kind: string; name: string }[];
  required_documents?: string[];
  compliance_tags?: string[];
  team_composition?: { name: string; kind: "internal" | "external"; count: number; days: number }[];
};

const CHECKPOINT_DEFS: { key: keyof Checkpoints; label: string; help: string }[] = [
  { key: "nda",                label: "NDA verified",            help: "Signed NDA on file before kickoff." },
  { key: "sla",                label: "SLA verified",            help: "Service-level agreement in force." },
  { key: "contract",           label: "Contract approved",       help: "Engagement contract executed." },
  { key: "scope",              label: "Scope approved",          help: "Statement of work / scope sign-off." },
  { key: "security",           label: "Security review",         help: "Security & data-protection assessment passed." },
  { key: "qa",                 label: "QA approval",             help: "QA gate passed for release readiness." },
  { key: "client_acceptance",  label: "Client acceptance",       help: "Client formally accepted delivery." },
];

/* ---------- Utils ---------- */

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
function relTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function prettyStatus(s: string) { return s.replace(/_/g, " "); }

/* ---------- Section anchors ---------- */

const SECTIONS = [
  { id: "health",     label: "Health" },
  { id: "governance", label: "Governance" },
  { id: "team",       label: "Team" },
  { id: "milestones", label: "Milestones" },
  { id: "calendar",   label: "Calendar" },
  { id: "engineering",label: "Engineering" },
  { id: "reports",    label: "Reports" },
  { id: "risks",      label: "Risks" },
  { id: "finance",    label: "Finance" },
  { id: "audit",      label: "Audit" },
];

/* ============================================================
                   Operational Overview
   ============================================================ */

export function ProjectOperationalOverview({
  project, board, stakeholders,
}: {
  project: Project;
  board: Board | undefined;
  stakeholders: Stakeholder[];
}) {
  const { id } = useParams();
  const qc = useQueryClient();

  const { data: opp } = useQuery<OppData>({
    queryKey: ["opp-for-project", project.opportunity_id],
    queryFn: () => api(`/api/v1/opportunities/${project.opportunity_id}`),
    enabled: !!project.opportunity_id,
  });

  /* Mutations */
  const appendLog = useMutation({
    mutationFn: ({ kind, body }: { kind: "risks" | "reports" | "audit_log"; body: any }) =>
      api(`/api/v1/projects/${id}/log/${kind}`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });
  const patchLog = useMutation({
    mutationFn: ({ kind, itemId, patch }: { kind: string; itemId: string; patch: any }) =>
      api(`/api/v1/projects/${id}/log/${kind}/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });
  const setCheckpoints = useMutation({
    mutationFn: (cp: Checkpoints) => api(`/api/v1/projects/${id}/checkpoints`, { method: "PUT", body: JSON.stringify(cp) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });
  const transition = useMutation({
    mutationFn: ({ to, reason }: { to: string; reason?: string }) =>
      api(`/api/v1/opportunities/${project.opportunity_id}/transition`, {
        method: "POST", body: JSON.stringify({ to, reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });
  const addMilestone = useMutation({
    mutationFn: (m: { title: string; due_on?: string }) =>
      api(`/api/v1/projects/${id}/milestones`, { method: "POST", body: JSON.stringify(m) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });

  /* Dialog state */
  const [riskOpen, setRiskOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  /* Derived data */
  const ccy = project.currency || "NGN";
  const tasks = useMemo<Task[]>(() => {
    if (!board) return [];
    const annotate = (s: Task["status"]) => (t: Task) => ({ ...t, status: s });
    return [
      ...board.columns.todo.map(annotate("todo")),
      ...board.columns.in_progress.map(annotate("in_progress")),
      ...board.columns.review.map(annotate("review")),
      ...board.columns.done.map(annotate("done")),
    ];
  }, [board]);

  const blockers = tasks.filter((t) => t.priority <= 1 && t.status !== "done");
  const qaIssues = tasks.filter((t) => t.status === "review");
  const activeRisks = (project.metadata?.risks ?? []).filter((r) => r.status !== "resolved");
  const delayedMilestones = useMemo(
    () => project.milestones.filter((m) => {
      if (m.status === "done") return false;
      if (!m.due_on) return false;
      return new Date(m.due_on).getTime() < Date.now();
    }),
    [project.milestones]
  );
  const completion = (() => {
    if (!board) return 0;
    const done = board.columns.done.length;
    const total = done + board.columns.todo.length + board.columns.in_progress.length + board.columns.review.length;
    return total === 0 ? 0 : Math.round((done / total) * 100);
  })();

  // Auto-checkpoints from documents/compliance tags + project status, merged with persisted ones
  const auto: Checkpoints = useMemo(() => {
    const docs = new Set((opp?.documents ?? []).map((d) => d.kind));
    const tags = new Set(opp?.compliance_tags ?? []);
    return {
      nda: docs.has("NDA"),
      sla: tags.has("SLA penalties") || tags.has("Right to audit"),
      contract: docs.has("Contract") || docs.has("MSA"),
      scope: docs.has("ScopeDocument"),
      security: tags.has("ISO 27001") || tags.has("SOC 2") || tags.has("Penetration testing"),
      qa: ["qa_review", "client_acceptance", "invoiced", "paid", "closed"].includes(project.status),
      client_acceptance: ["client_acceptance", "invoiced", "paid", "closed"].includes(project.status),
    };
  }, [opp, project.status]);
  const checkpoints: Checkpoints = { ...auto, ...(project.metadata?.checkpoints ?? {}) };
  const checkpointsMissing = CHECKPOINT_DEFS.filter((c) => !checkpoints[c.key]);

  const audit: AuditEntry[] = useMemo(() => {
    const entries: AuditEntry[] = [];
    for (const a of project.metadata?.audit_log ?? []) entries.push(a);
    for (const r of project.metadata?.reports ?? []) entries.push({ at: r.at, kind: "report", title: r.title });
    for (const r of project.metadata?.risks ?? []) entries.push({ at: r.at, kind: "risk", title: `Risk raised: ${r.title}` });
    for (const sh of project.metadata?.stage_history ?? []) entries.push({ at: sh.at, kind: "stage", title: sh.title ?? `${(sh as any).from} → ${(sh as any).to}` });
    return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 30);
  }, [project.metadata]);

  const onTrack = project.health === "green";
  const timelineStatus = (() => {
    if (delayedMilestones.length > 0) return { label: `${delayedMilestones.length} overdue`, tone: "bad" as const };
    if (project.end_date) {
      const remaining = (new Date(project.end_date).getTime() - Date.now()) / 86_400_000;
      if (remaining < 0) return { label: "Past end date", tone: "bad" as const };
      if (remaining < 14) return { label: `${Math.round(remaining)}d left`, tone: "warn" as const };
      return { label: "On schedule", tone: "good" as const };
    }
    return { label: "Open-ended", tone: "neutral" as const };
  })();

  return (
    <div className="space-y-6">
      {/* ========== 1. Operational meta strip ========== */}
      <div className="-mx-8 -mt-2 px-8 pt-3 pb-4 border-b border-border bg-surface relative z-10">
        {/* Eyebrow line: project code · client · source opp */}
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span className="font-mono font-semibold text-text">{project.code}</span>
          <span className="text-muted/60">·</span>
          <span className="truncate">{project.client_name || project.lead_type || "—"}</span>
          {project.opportunity_id && (
            <>
              <span className="text-muted/60">·</span>
              <Link to={`/pipeline/${project.opportunity_id}`} className="text-accent hover:underline whitespace-nowrap">Source opportunity →</Link>
            </>
          )}
        </div>

        {/* Status row + primary action */}
        <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="info" icon={<CircleDot size={11} />}>{prettyStatus(project.status)}</Chip>
            <Chip tone={onTrack ? "good" : project.health === "amber" ? "warn" : "bad"} icon={<ShieldCheck size={11} />}>
              {project.health}
            </Chip>
            <Chip tone={project.risk_score >= 60 ? "bad" : project.risk_score >= 30 ? "warn" : "good"} icon={<AlertTriangle size={11} />}>
              Risk {Math.round(project.risk_score || 0)}
            </Chip>
            <Chip tone="neutral" icon={<ListChecks size={11} />}>{completion}% complete</Chip>
            <Chip tone={timelineStatus.tone} icon={<CalendarClock size={11} />}>{timelineStatus.label}</Chip>
          </div>

          <div className="flex items-center gap-2">
            <UpdateStatusButton
              project={project}
              onTransition={(to, reason) => transition.mutate({ to, reason })}
              busy={transition.isPending}
            />
            <ProjectActionsMenu
              onAddReport={() => setReportOpen(true)}
              onRaiseRisk={() => setRiskOpen(true)}
              onUploadDocument={() => project.opportunity_id ? (window.location.href = `/pipeline/${project.opportunity_id}`) : null}
              hasOpportunity={!!project.opportunity_id}
              onCreateMilestone={() => {
                const title = prompt("Milestone title?");
                if (!title) return;
                const due = prompt("Due date (YYYY-MM-DD, optional)") ?? "";
                addMilestone.mutate({ title, due_on: due || undefined });
              }}
              archiveButton={<ArchiveButton projectId={project.id} projectName={project.name} />}
            />
          </div>
        </div>

        {/* Section anchors — quieter pill row */}
        <nav className="flex items-center gap-1 mt-3 -mx-1 overflow-x-auto pb-0.5">
          {SECTIONS.map((s) => (
            <a
              key={s.id} href={`#${s.id}`}
              className="text-[12px] font-semibold text-muted hover:text-text px-3 py-1 rounded-full hover:bg-surface whitespace-nowrap transition-colors"
            >
              {s.label}
            </a>
          ))}
        </nav>

        {checkpointsMissing.length > 0 && (
          <div className="mt-3 flex items-start gap-2 text-xs bg-warn/10 border border-warn/30 text-warn rounded-md px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong>{checkpointsMissing.length} governance checkpoint{checkpointsMissing.length === 1 ? "" : "s"} incomplete:</strong>{" "}
              {checkpointsMissing.map((c) => c.label).join(" · ")}
            </span>
          </div>
        )}
      </div>

      {/* ========== 2. Delivery Health Dashboard ========== */}
      <Section id="health" title="Delivery health" subtitle="Operational signal at a glance.">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
          <KPI icon={<AlertCircle size={14} />} label="Active blockers"   value={blockers.length}   tone={blockers.length ? "bad" : "good"} />
          <KPI icon={<AlertTriangle size={14} />} label="Open risks"      value={activeRisks.length} tone={activeRisks.length ? "warn" : "good"} />
          <KPI icon={<Clock size={14} />}        label="Delayed milestones" value={delayedMilestones.length} tone={delayedMilestones.length ? "bad" : "good"} />
          <KPI icon={<Bug size={14} />}          label="QA issues"        value={qaIssues.length}    tone={qaIssues.length ? "warn" : "good"} />
          <KPI icon={<GitPullRequest size={14} />} label="PR activity"    value={project.repos.length > 0 ? "Live" : "—"} tone={project.repos.length ? "info" : "neutral"} />
          <KPI icon={<Rocket size={14} />}       label="Deployment"        value={project.repos.length > 0 ? "Synced" : "n/a"} tone={project.repos.length ? "good" : "neutral"} />
          <KPI icon={<Wallet size={14} />}       label="Invoice status"   value={`${fmtMoney(project.invoice_paid, ccy)} / ${fmtMoney(project.invoice_total, ccy)}`} tone="info" />
        </div>
      </Section>

      {/* ========== 3. Governance Checkpoints ========== */}
      <Section id="governance" title="Governance checkpoints" subtitle="Operational compliance gates.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CHECKPOINT_DEFS.map((c) => {
            const on = !!checkpoints[c.key];
            return (
              <button
                key={c.key}
                onClick={() => setCheckpoints.mutate({ ...checkpoints, [c.key]: !on })}
                className={`flex items-start gap-3 text-left p-3 rounded-md border transition-colors ${
                  on ? "border-success/40 bg-success/5" : "border-border hover:bg-bg"
                }`}
              >
                <span className={`w-7 h-7 rounded-full grid place-items-center shrink-0 ${
                  on ? "bg-success/15 text-success" : "bg-bg border border-border text-muted"
                }`}>
                  {on ? <Check size={14} /> : <CircleDot size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text">{c.label}</div>
                  <div className="text-xs text-muted">{c.help}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* ========== 4. Delivery Team ========== */}
        <Section id="team" title="Delivery team" subtitle="Who owns what right now.">
          <TeamPanel project={project} stakeholders={stakeholders} tasks={tasks} opp={opp} />
        </Section>

        {/* ========== 5. Milestones (compact) ========== */}
        <Section id="milestones" title="Milestones" subtitle="Delivery roadmap with overdue alerts.">
          <MilestonesPanel
            milestones={project.milestones}
            onMark={(mid, status) => patchLog.mutate({ kind: "milestone", itemId: mid, patch: { status } })}
          />
        </Section>
      </div>

      {/* ========== 5b. Calendar timeline ========== */}
      <Section id="calendar" title="Calendar" subtitle="Milestones, dated tasks, and key project moments — all on one timeline.">
        <CalendarTimeline
          project={project}
          tasks={tasks}
          stakeholders={stakeholders}
        />
      </Section>

      {/* ========== 6. Engineering ========== */}
      <Section id="engineering" title="Engineering activity" subtitle="Commits, pull requests, deployments." action={
        <button className="btn-outline text-sm">
          <Github size={14} /> {project.repos.length > 0 ? `${project.repos.length} repo${project.repos.length === 1 ? "" : "s"} linked` : "Link a repo"}
        </button>
      }>
        <EngineeringPanel repos={project.repos} />
      </Section>

      {/* ========== 7. Reports feed ========== */}
      <Section id="reports" title="Operational reporting" subtitle="Updates, blockers, decisions, evidence." action={
        <button onClick={() => setReportOpen(true)} className="btn-outline">
          <Plus size={14} /> Add update
        </button>
      }>
        <ReportsPanel reports={project.metadata?.reports ?? []} />
      </Section>

      {/* ========== 8. Risks ========== */}
      <Section id="risks" title="Risk & escalation" subtitle="Active risks, mitigation, escalation owners." action={
        <button onClick={() => setRiskOpen(true)} className="btn-outline !border-danger/40 !text-danger">
          <AlertTriangle size={14} /> Raise risk
        </button>
      }>
        <RisksPanel
          risks={project.metadata?.risks ?? []}
          onResolve={(id) => patchLog.mutate({ kind: "risks", itemId: id, patch: { status: "resolved" } })}
          onMitigate={(id) => patchLog.mutate({ kind: "risks", itemId: id, patch: { status: "mitigating" } })}
        />
      </Section>

      {/* ========== 9. Finance ========== */}
      <Section id="finance" title="Finance execution" subtitle="Invoiced, paid, outstanding, budget utilization.">
        <FinancePanel project={project} ccy={ccy} />
      </Section>

      {/* ========== 10. Audit ========== */}
      <Section id="audit" title="Audit timeline" subtitle="Operational activity in chronological order.">
        <AuditPanel entries={audit} />
      </Section>

      {/* Dialogs */}
      {riskOpen && (
        <RaiseRiskDialog
          submitting={appendLog.isPending}
          onClose={() => setRiskOpen(false)}
          onAdd={(r) => appendLog.mutate({ kind: "risks", body: r }, { onSuccess: () => setRiskOpen(false) })}
        />
      )}
      {reportOpen && (
        <AddReportDialog
          submitting={appendLog.isPending}
          onClose={() => setReportOpen(false)}
          onAdd={(r) => appendLog.mutate({ kind: "reports", body: r }, { onSuccess: () => setReportOpen(false) })}
        />
      )}
    </div>
  );
}

/* ---------- Section primitives ---------- */

function Section({
  id, title, subtitle, action, children,
}: {
  id: string; title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className="card p-5 scroll-mt-32">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-bold text-text">{title}</h2>
          {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Chip({
  children, tone = "neutral", icon,
}: { children: React.ReactNode; tone?: "good" | "warn" | "bad" | "info" | "neutral"; icon?: React.ReactNode }) {
  const cls = {
    good: "bg-success/15 text-success border-success/30",
    warn: "bg-warn/15 text-warn border-warn/30",
    bad:  "bg-danger/15 text-danger border-danger/30",
    info: "bg-accent-soft text-accent border-accent/30",
    neutral: "bg-bg text-muted border-border",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 capitalize text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      {icon}{children}
    </span>
  );
}

function KPI({
  icon, label, value, tone = "neutral",
}: { icon: React.ReactNode; label: string; value: number | string; tone?: "good" | "warn" | "bad" | "info" | "neutral" }) {
  const valueCls = {
    good: "text-success", warn: "text-warn", bad: "text-danger", info: "text-accent", neutral: "text-text",
  }[tone];
  return (
    <div className="border border-border rounded-md p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-muted">
        {icon}{label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${valueCls}`}>{value}</div>
    </div>
  );
}

/* ---------- Team panel ---------- */

type ProjectMember = {
  id: string;
  user_id: string;
  role: string;
  allocation: number;
  email: string;
  name: string;
  user_roles: string[];
};

type AssignableUser = {
  id: string;
  email: string;
  name: string;
  roles: string[];
};

function TeamPanel({
  project, stakeholders, tasks, opp,
}: {
  project: Project; stakeholders: Stakeholder[]; tasks: Task[]; opp?: OppData;
}) {
  const qc = useQueryClient();
  const projectId = project.id;
  const [addOpen, setAddOpen] = useState(false);

  const { data, isLoading } = useQuery<{ items: ProjectMember[] }>({
    queryKey: ["project-members", projectId],
    queryFn: () => api(`/api/v1/projects/${projectId}/members`),
    enabled: !!projectId,
  });
  const members = data?.items ?? [];

  const remove = useMutation({
    mutationFn: (memberId: string) =>
      api(`/api/v1/projects/${projectId}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  // The PM role is whoever's flagged in stakeholders as manager/lead/sponsor.
  // This is intentionally separate from project_members (the delivery team).
  const manager = stakeholders.find((s) => /manager|lead|sponsor/i.test(s.role)) ?? stakeholders[0];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted font-semibold mb-2">Project manager</div>
        {!manager ? (
          <p className="text-sm text-muted italic">No PM assigned. Add a stakeholder with "manager" in their role.</p>
        ) : (
          <div className="flex items-center gap-3">
            <span className={`w-10 h-10 rounded-full grid place-items-center text-sm font-bold ${
              manager.kind === "external" ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
            }`}>
              {(manager.name || "?")[0].toUpperCase()}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text">{manager.name}</div>
              <div className="text-xs text-muted">{manager.role}</div>
            </div>
            {manager.email && (
              <a href={`mailto:${manager.email}`} className="text-muted hover:text-text">
                <Mail size={14} />
              </a>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-muted font-semibold">Delivery team</div>
          <button
            onClick={() => setAddOpen(true)}
            className="text-[11px] font-semibold inline-flex items-center gap-1 text-accent hover:underline"
          >
            + Add member
          </button>
        </div>
        {isLoading ? (
          <div className="text-sm text-muted italic">Loading team…</div>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted italic">
            No engineers staffed yet. Click <strong className="text-text">+ Add member</strong> above to assign one
            from your workspace.
          </p>
        ) : (
          <ul className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2 bg-bg/30">
                <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center text-xs font-bold shrink-0">
                  {(m.name || m.email || "?").charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text truncate">{m.name || m.email}</div>
                  <div className="text-[11px] text-muted truncate">
                    {m.role}
                    {m.allocation < 1 && <span> · {Math.round(m.allocation * 100)}% allocation</span>}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Remove ${m.name || m.email} from this project?`)) {
                      remove.mutate(m.id);
                    }
                  }}
                  className="text-muted hover:text-danger p-1"
                  title="Remove from project"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
        <Stat label="Active tasks" value={tasks.filter(t => t.status !== "done").length} />
        <Stat label="In review"    value={tasks.filter(t => t.status === "review").length} />
        <Stat label="Stakeholders" value={stakeholders.length} />
      </div>

      {addOpen && (
        <AddProjectMemberDialog
          projectId={projectId}
          plannedTeam={(opp?.team_composition ?? [])
            .filter((t) => t.kind === "internal")
            .map((t) => ({ name: t.name, count: t.count }))}
          existingMembers={members}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            qc.invalidateQueries({ queryKey: ["project-members", projectId] });
          }}
        />
      )}
    </div>
  );
}

function AddProjectMemberDialog({
  projectId, plannedTeam, existingMembers, onClose, onAdded,
}: {
  projectId: string;
  plannedTeam: { name: string; count: number }[];
  existingMembers: ProjectMember[];
  onClose: () => void;
  onAdded: () => void;
}) {
  // Roles available are exactly what the planning step provisioned, plus a
  // safety fallback so projects without a plan still work. Each option carries
  // its capacity + current fill so we can lock the option once it's saturated.
  const roleOptions = useMemo(() => {
    const planned = plannedTeam.filter((r) => r.name && r.count > 0);
    if (planned.length > 0) return planned;
    // No plan — fall back to a small generic catalog with 1 slot each so the
    // operator can still staff somebody without revisiting the wizard.
    return [
      { name: "Engineer",  count: 1 },
      { name: "Tech lead", count: 1 },
      { name: "Designer",  count: 1 },
      { name: "QA",        count: 1 },
      { name: "Analyst",   count: 1 },
    ];
  }, [plannedTeam]);

  // How many slots of each role are already filled. Match on case-insensitive
  // role name because the dropdown values are display-cased ("Designer") while
  // the stored role on a member follows whatever was typed at add-time.
  const filled = useMemo(() => {
    const m = new Map<string, number>();
    for (const mem of existingMembers) {
      const key = mem.role.trim().toLowerCase();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [existingMembers]);

  const firstOpen = roleOptions.find((r) => (filled.get(r.name.toLowerCase()) ?? 0) < r.count);
  const [role, setRole] = useState<string>(firstOpen?.name ?? roleOptions[0].name);
  const [picked, setPicked] = useState<AssignableUser | null>(null);
  const [query, setQuery] = useState("");
  const [allocation, setAllocation] = useState(100);

  const roleFilled = filled.get(role.toLowerCase()) ?? 0;
  const rolePlan   = roleOptions.find((r) => r.name.toLowerCase() === role.toLowerCase());
  const roleCap    = rolePlan?.count ?? 1;
  const atCapacity = roleFilled >= roleCap;

  // Reset the candidate when the role changes — a new role needs new candidates.
  useEffect(() => { setPicked(null); /* re-validate on role change */ }, [role]);

  const { data, isLoading } = useQuery<{ items: AssignableUser[] }>({
    queryKey: ["project-assignable", projectId, query],
    queryFn: () =>
      api(`/api/v1/projects/${projectId}/members/assignable?q=${encodeURIComponent(query)}`),
  });
  const allCandidates = data?.items ?? [];

  // Skill match: a user qualifies for a role if any of their workspace roles
  // shares a word with the project role (case-insensitive). "Tech Lead" matches
  // a user with "tech_lead", "Senior Engineer" matches "engineer", etc. A user
  // with super_admin can be staffed onto anything (they're typically the workspace
  // owner standing in for a real engineer during early-stage staffing).
  const candidates = useMemo(() => {
    const tokens = role.toLowerCase().split(/[\s_/\-]+/).filter((t) => t.length >= 3);
    return allCandidates.filter((u) => {
      if (u.roles.includes("super_admin")) return true;
      const roleStr = u.roles.join(" ").toLowerCase();
      return tokens.some((t) => roleStr.includes(t));
    });
  }, [allCandidates, role]);

  const skippedCount = allCandidates.length - candidates.length;

  const add = useMutation({
    mutationFn: (b: { user_id: string; role: string; allocation: number }) =>
      api(`/api/v1/projects/${projectId}/members`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: onAdded,
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Add team member</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4">
          {/* ---- 1. Pick role first so we know which skills to filter for ---- */}
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Role on this project</div>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {roleOptions.map((r) => {
                const used = filled.get(r.name.toLowerCase()) ?? 0;
                const full = used >= r.count;
                return (
                  <option key={r.name} value={r.name} disabled={full}>
                    {r.name} · {used}/{r.count}{full ? " — full" : ""}
                  </option>
                );
              })}
            </select>
            {plannedTeam.length === 0 && (
              <div className="text-[11px] text-muted mt-1">
                No planning team was set on the source opportunity — using a default catalog.
              </div>
            )}
          </label>

          {atCapacity && (
            <div className="bg-warn/10 border border-warn/30 text-warn text-sm rounded-lg px-3 py-2">
              All {roleCap} slot{roleCap === 1 ? "" : "s"} for <span className="font-semibold">{role}</span> are
              filled. Remove someone first, or pick a different role.
            </div>
          )}

          {/* ---- 2. Candidate picker filtered by the chosen role ---- */}
          {!picked ? (
            <>
              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">
                  Find a workspace member with the <span className="font-semibold text-text">{role}</span> skill
                </div>
                <input
                  type="text"
                  className="input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or email…"
                  disabled={atCapacity}
                  autoFocus
                />
              </label>

              <div className="max-h-[240px] overflow-y-auto border border-border rounded-lg">
                {atCapacity ? (
                  <div className="px-3 py-6 text-sm text-muted text-center">
                    Role at capacity.
                  </div>
                ) : isLoading && candidates.length === 0 ? (
                  <div className="px-3 py-6 text-sm text-muted text-center">Loading members…</div>
                ) : candidates.length === 0 ? (
                  <div className="px-3 py-6 text-sm text-muted text-center">
                    No workspace member has the <span className="font-semibold text-text">{role}</span> skill.
                    {allCandidates.length > 0 && (
                      <div className="mt-1 text-[11px]">
                        {allCandidates.length} candidate{allCandidates.length === 1 ? "" : "s"} hidden — assign them the role
                        from <Link to="/settings/members" className="text-accent hover:underline">Settings → Members</Link> first.
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <ul className="divide-y divide-border">
                      {candidates.map((u) => (
                        <li key={u.id}>
                          <button
                            type="button"
                            onClick={() => setPicked(u)}
                            className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg text-left"
                          >
                            <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center text-xs font-bold shrink-0">
                              {(u.name || u.email).charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-text truncate">{u.name || u.email}</div>
                              <div className="text-[11px] text-muted truncate">
                                {u.email}{u.roles.length > 0 && ` · ${u.roles.join(", ")}`}
                              </div>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {skippedCount > 0 && (
                      <div className="border-t border-border px-3 py-2 text-[11px] text-muted bg-bg/30">
                        {skippedCount} member{skippedCount === 1 ? "" : "s"} hidden — they don't have the {role} skill.
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="bg-accent-soft/30 border border-accent/20 rounded-lg p-3 flex items-center gap-3">
                <span className="w-9 h-9 rounded-full bg-accent text-white grid place-items-center text-sm font-bold">
                  {(picked.name || picked.email).charAt(0).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-text truncate">{picked.name || picked.email}</div>
                  <div className="text-[11px] text-muted truncate">{picked.email}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="text-[11px] text-muted hover:text-text underline"
                >
                  Change
                </button>
              </div>

              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">
                  Allocation · <span className="text-text font-semibold">{allocation}%</span>
                </div>
                <input
                  type="range" min={10} max={100} step={5}
                  value={allocation}
                  onChange={(e) => setAllocation(Number(e.target.value))}
                  className="w-full accent-accent"
                />
              </label>
            </>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">
            Cancel
          </button>
          <SmartButton
            variant="primary"
            disabled={!picked || atCapacity || add.isPending}
            loadingLabel="Adding…"
            onClick={() => {
              if (!picked || atCapacity) return;
              add.mutate({ user_id: picked.id, role, allocation: allocation / 100 });
            }}
          >
            Add to project
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted font-semibold">{label}</div>
      <div className="text-lg font-bold text-text mt-0.5">{value}</div>
    </div>
  );
}

/* ---------- Milestones ---------- */

function MilestonesPanel({
  milestones, onMark,
}: { milestones: Milestone[]; onMark: (id: string, status: string) => void }) {
  if (milestones.length === 0) {
    return <p className="text-sm text-muted italic">No milestones yet. Use <strong className="text-text">+ Create milestone</strong> in the header.</p>;
  }
  return (
    <ol className="relative pl-5 space-y-3 before:content-[''] before:absolute before:left-1.5 before:top-2 before:bottom-2 before:w-px before:bg-border">
      {milestones.map((m) => {
        const overdue = m.due_on && new Date(m.due_on).getTime() < Date.now() && m.status !== "done";
        const tone = m.status === "done" ? "good" : overdue ? "bad" : "info";
        return (
          <li key={m.id} className="relative">
            <span className={`absolute -left-5 top-1.5 w-3 h-3 rounded-full border-2 border-surface ${
              tone === "good" ? "bg-success" : tone === "bad" ? "bg-danger" : "bg-accent"
            }`} />
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text">{m.title}</div>
                <div className="text-xs text-muted flex items-center gap-2 mt-0.5">
                  <CalendarClock size={11} /> {fmtDate(m.due_on)}
                  <span className="capitalize">· {m.status}</span>
                  {overdue && <Chip tone="bad">overdue</Chip>}
                </div>
              </div>
              {m.status !== "done" && (
                <button onClick={() => onMark(m.id, "done")} className="text-xs text-success hover:underline">
                  Mark done
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Archive ---------- */

function ProjectActionsMenu({
  onAddReport, onRaiseRisk, onUploadDocument, onCreateMilestone, hasOpportunity, archiveButton,
}: {
  onAddReport: () => void;
  onRaiseRisk: () => void;
  onUploadDocument: () => void;
  onCreateMilestone: () => void;
  hasOpportunity: boolean;
  archiveButton: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-outline"
        aria-label="More project actions"
      >
        <MoreHorizontal size={14} /> More
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-40 bg-surface border border-border rounded-xl shadow-card min-w-[230px] py-1 overflow-hidden">
            <ActionRow icon={<FileText size={14} />}      label="Add report"     onClick={() => { setOpen(false); onAddReport(); }} />
            <ActionRow icon={<Flag size={14} />}          label="Create milestone" onClick={() => { setOpen(false); onCreateMilestone(); }} />
            {hasOpportunity && (
              <ActionRow icon={<Upload size={14} />}      label="Upload document" onClick={() => { setOpen(false); onUploadDocument(); }} />
            )}
            <div className="my-1 border-t border-border" />
            <ActionRow icon={<AlertTriangle size={14} />} label="Raise risk"     onClick={() => { setOpen(false); onRaiseRisk(); }} danger />
            <div className="my-1 border-t border-border" />
            <div className="px-1.5">{archiveButton}</div>
          </div>
        </>
      )}
    </div>
  );
}

function ActionRow({
  icon, label, onClick, danger,
}: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-4 py-2 text-[14px] hover:bg-bg ${
        danger ? "text-danger" : "text-text"
      }`}
    >
      <span className={`shrink-0 ${danger ? "text-danger" : "text-muted"}`}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function ArchiveButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const archive = useMutation({
    mutationFn: () => api(`/api/v1/projects/${projectId}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["archived-projects"] });
      nav("/projects");
    },
  });
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-outline !border-danger/40 !text-danger"
        title="Archive (soft delete) this project"
      >
        <Archive size={14} /> Archive
      </button>
      {open && (
        <Dialog title="Archive project?" icon={<Archive size={20} className="text-danger" />} onClose={() => setOpen(false)}>
          <p className="text-sm text-muted">
            <strong className="text-text">{projectName}</strong> will be hidden from project lists,
            dashboards, and reports. It's a soft delete — the data stays in the database. Only a
            super-admin can restore it (and they'll need to re-enter their password to do so).
          </p>
          <div className="text-xs text-muted bg-bg border border-border rounded-md p-3">
            Restore from <strong>Settings → Archived projects</strong>.
          </div>
          {archive.error && (
            <div className="text-danger text-sm">{(archive.error as Error).message}</div>
          )}
          <DialogActions>
            <button onClick={() => setOpen(false)} className="btn-outline">Cancel</button>
            <SmartButton
              variant="danger"
              loadingLabel="Archiving…"
              successLabel="Archived"
              onClick={() => archive.mutateAsync()}
            >
              Archive project
            </SmartButton>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

/* ---------- Calendar timeline ---------- */

type CalEvent = {
  id: string;
  date: string;            // YYYY-MM-DD
  kind: "kickoff" | "milestone" | "task" | "deadline";
  title: string;
  subtitle?: string;
  status?: string;         // for milestones / tasks
  done?: boolean;
  progressPct?: number;    // 0-100
  assignees: Stakeholder[];
};

function CalendarTimeline({
  project, tasks, stakeholders,
}: {
  project: Project;
  tasks: Task[];
  stakeholders: Stakeholder[];
}) {
  const [showCompleted, setShowCompleted] = useState(false);

  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    const fallbackAssignees = stakeholders.slice(0, 4);

    // Kick-off — synthesised from project start_date or end_date, fallback to today.
    if (project.start_date) {
      out.push({
        id: `kickoff-${project.id}`,
        date: project.start_date,
        kind: "kickoff",
        title: "Project kick-off",
        subtitle: "Engagement begins",
        assignees: fallbackAssignees,
      });
    }
    if (project.end_date) {
      out.push({
        id: `deadline-${project.id}`,
        date: project.end_date,
        kind: "deadline",
        title: "Target delivery",
        subtitle: "Project end date",
        assignees: fallbackAssignees,
      });
    }
    // Milestones
    for (const m of project.milestones) {
      if (!m.due_on) continue;
      out.push({
        id: m.id,
        date: m.due_on,
        kind: "milestone",
        title: m.title,
        subtitle: m.status === "done" ? "Milestone — completed" : "Milestone",
        status: m.status,
        done: m.status === "done",
        progressPct: m.status === "done" ? 100 : (m.status === "in_progress" ? 60 : 25),
        assignees: fallbackAssignees,
      });
    }
    // Dated tasks
    for (const t of tasks) {
      if (!t.due_on) continue;
      out.push({
        id: t.id,
        date: t.due_on,
        kind: "task",
        title: t.title,
        subtitle: priorityLabel(t.priority),
        status: t.status,
        done: t.status === "done",
        assignees: fallbackAssignees,
      });
    }
    return out
      .filter((e) => showCompleted || !e.done)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [project, tasks, stakeholders, showCompleted]);

  // Group by date
  const groups = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date)!.push(e);
    }
    return Array.from(m.entries());
  }, [events]);

  const upcoming = events.filter((e) => new Date(e.date).getTime() >= startOfDay(new Date()).getTime());
  const past = events.length - upcoming.length;

  if (events.length === 0) {
    return (
      <div className="text-sm text-muted italic border border-dashed border-border rounded-md p-8 text-center">
        Nothing scheduled yet. Add a milestone or set a due date on a task to populate the calendar.
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-muted">
          <strong className="text-text">{upcoming.length}</strong> upcoming · {past} in the past
        </div>
        <label className="text-xs text-muted inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          Show completed
        </label>
      </div>

      <ol className="relative pl-12">
        {/* vertical rail */}
        <span className="absolute left-[36px] top-2 bottom-2 w-px bg-border" aria-hidden />

        {groups.map(([date, list]) => {
          const d = new Date(date);
          const dist = daysFromToday(date);
          const isPast = dist < 0;
          const isToday = dist === 0;
          return (
            <li key={date} className="relative mb-5 last:mb-0">
              {/* Date marker on the left */}
              <div className="absolute -left-12 top-0 w-12 -ml-0.5 flex flex-col items-center text-center">
                <div className={`w-9 h-9 rounded-full grid place-items-center text-sm font-bold border-2 ${
                  isPast ? "bg-bg border-border text-muted"
                  : isToday ? "bg-accent text-white border-accent shadow-card"
                  : "bg-surface border-accent/40 text-accent"
                }`}>
                  {d.getDate()}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mt-1">
                  {d.toLocaleDateString("en-US", { month: "short" })}
                </div>
              </div>

              {/* Day header */}
              <div className="text-xs text-muted mb-2 flex items-center gap-2">
                <span className="font-semibold text-text">{d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</span>
                <span>·</span>
                <span>{dist === 0 ? "Today" : dist > 0 ? `in ${dist}d` : `${Math.abs(dist)}d ago`}</span>
                {dist < 0 && list.some((e) => !e.done) && (
                  <Chip tone="bad">overdue</Chip>
                )}
              </div>

              {/* Event cards */}
              <div className="space-y-2">
                {list.map((e) => <CalEventCard key={e.id} event={e} oppId={project.opportunity_id ?? undefined} />)}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function CalEventCard({ event, oppId }: { event: CalEvent; oppId?: string }) {
  const { kind, title, subtitle, done, progressPct } = event;
  const dateObj = new Date(event.date);
  const time = dateObj.getHours() > 0 || dateObj.getMinutes() > 0
    ? dateObj.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  const tone = (() => {
    if (done) return { bg: "border-success/30 bg-success/5", icon: <Check size={14} className="text-success" /> };
    if (kind === "kickoff") return { bg: "border-accent/40 bg-accent/5", icon: <Rocket size={14} className="text-accent" /> };
    if (kind === "deadline") return { bg: "border-danger/30 bg-danger/5", icon: <Flag size={14} className="text-danger" /> };
    if (kind === "milestone") return { bg: "border-accent/30 bg-surface", icon: <Target size={14} className="text-accent" /> };
    return { bg: "border-border bg-surface", icon: <ListChecks size={14} className="text-muted" /> };
  })();

  return (
    <div className={`relative rounded-md border ${tone.bg} p-3 flex items-start gap-3`}>
      <span className="w-7 h-7 rounded-full bg-surface border border-border grid place-items-center shrink-0">
        {tone.icon}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`text-sm font-semibold ${done ? "text-muted line-through" : "text-text"} truncate`}>
            {title}
          </div>
          <Chip tone={calKindTone(kind)}>{kind}</Chip>
        </div>
        <div className="text-xs text-muted mt-0.5 flex items-center gap-2 flex-wrap">
          {subtitle && <span>{subtitle}</span>}
          {time && (
            <>
              <span className="text-muted/60">·</span>
              <span className="inline-flex items-center gap-1"><Clock size={11} /> {time}</span>
            </>
          )}
        </div>
      </div>

      {/* Right side — progress + assignees */}
      <div className="flex items-center gap-3 shrink-0">
        {kind === "milestone" && typeof progressPct === "number" && !done && (
          <ProgressRing pct={progressPct} />
        )}
        {event.assignees.length > 0 && (
          <div className="flex -space-x-1.5">
            {event.assignees.slice(0, 3).map((a) => (
              <span
                key={a.id}
                title={a.name}
                className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold border-2 border-surface ${
                  a.kind === "external" ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
                }`}
              >
                {(a.name || "?")[0].toUpperCase()}
              </span>
            ))}
            {event.assignees.length > 3 && (
              <span className="w-7 h-7 rounded-full grid place-items-center text-[10px] font-semibold bg-bg text-muted border-2 border-surface">
                +{event.assignees.length - 3}
              </span>
            )}
          </div>
        )}
        {oppId && kind === "milestone" && (
          <Link
            to={`/projects/${oppId}`}
            className="text-xs font-medium text-text border border-border bg-surface rounded-full px-3 py-1.5 hover:bg-bg whitespace-nowrap"
          >
            View details
          </Link>
        )}
      </div>
    </div>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 14, c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div className="relative w-9 h-9 shrink-0">
      <svg className="w-9 h-9 -rotate-90">
        <circle cx="18" cy="18" r={r} stroke="rgb(var(--border))" strokeWidth="3" fill="none" />
        <circle
          cx="18" cy="18" r={r}
          stroke="rgb(var(--accent))"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-[10px] font-bold text-text">
        {pct}%
      </div>
    </div>
  );
}

function calKindTone(kind: CalEvent["kind"]): "good" | "warn" | "bad" | "info" | "neutral" {
  if (kind === "milestone") return "info";
  if (kind === "kickoff") return "good";
  if (kind === "deadline") return "bad";
  return "neutral";
}
function priorityLabel(p: number): string {
  return ["", "P1 · Critical", "P2 · High", "P3 · Medium", "P4 · Low", "P5 · Lowest"][p] ?? `P${p}`;
}
function startOfDay(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
function daysFromToday(iso: string): number {
  const a = startOfDay(new Date()).getTime();
  const b = startOfDay(new Date(iso)).getTime();
  return Math.round((b - a) / 86_400_000);
}

/* ---------- Engineering ---------- */

function EngineeringPanel({ repos }: { repos: Repo[] }) {
  if (repos.length === 0) {
    return (
      <div className="text-sm text-muted italic border border-dashed border-border rounded-md p-6 text-center">
        No repositories linked yet. Connect via <Link to="/settings/integrations/github" className="text-accent hover:underline">GitHub integration</Link>.
      </div>
    );
  }
  // Synthesize a believable activity feed when integration is connected but no real events flowed in yet.
  return (
    <div className="space-y-3">
      {repos.map((r) => (
        <div key={r.id} className="border border-border rounded-md p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Github size={14} />
              <span className="text-sm font-medium">{r.owner}/{r.name}</span>
            </div>
            <a
              href={`https://github.com/${r.owner}/${r.name}`} target="_blank" rel="noreferrer"
              className="text-xs text-accent hover:underline"
            >Open ↗</a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-xs">
            <RepoStat icon={<GitCommit size={12} />} label="Commits (7d)" value="—" />
            <RepoStat icon={<GitPullRequest size={12} />} label="Open PRs" value="—" />
            <RepoStat icon={<Rocket size={12} />} label="Deployments" value="—" />
            <RepoStat icon={<AlertCircle size={12} />} label="Failed builds" value="—" />
          </div>
        </div>
      ))}
      <p className="text-xs text-muted">
        Real-time feed activates once webhooks are flowing. Configure in <Link to="/settings/integrations/github" className="text-accent hover:underline">GitHub settings</Link>.
      </p>
    </div>
  );
}
function RepoStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="border border-border rounded-md px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-muted">{icon}{label}</div>
      <div className="text-base font-bold text-text mt-0.5">{value}</div>
    </div>
  );
}

/* ---------- Reports ---------- */

function ReportsPanel({ reports }: { reports: Report[] }) {
  if (reports.length === 0) {
    return <p className="text-sm text-muted italic">No reports yet — log delivery updates, blockers, and decisions here.</p>;
  }
  return (
    <ol className="space-y-3">
      {reports.slice().reverse().map((r) => (
        <li key={r.id} className="border-l-2 border-accent/40 pl-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Chip tone={kindTone(r.kind)}>{prettyStatus(r.kind)}</Chip>
            <span>{relTime(r.at)}</span>
          </div>
          <div className="text-sm font-medium text-text mt-1">{r.title}</div>
          {r.body && <div className="text-sm text-muted mt-0.5 leading-relaxed">{r.body}</div>}
        </li>
      ))}
    </ol>
  );
}
function kindTone(kind: string): "good" | "warn" | "bad" | "info" {
  if (kind.includes("blocker")) return "bad";
  if (kind.includes("decision")) return "info";
  if (kind.includes("evidence")) return "good";
  return "info";
}

/* ---------- Risks ---------- */

function RisksPanel({
  risks, onResolve, onMitigate,
}: {
  risks: Risk[]; onResolve: (id: string) => void; onMitigate: (id: string) => void;
}) {
  if (risks.length === 0) {
    return <p className="text-sm text-muted italic">No risks logged. Use <strong className="text-text">Raise risk</strong> in the header to flag one.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted">
        <tr className="border-b border-border">
          <th className="text-left font-medium px-3 py-2">Risk</th>
          <th className="text-left font-medium px-3 py-2 w-28">Severity</th>
          <th className="text-left font-medium px-3 py-2 w-32">Owner</th>
          <th className="text-left font-medium px-3 py-2 w-32">Due</th>
          <th className="text-left font-medium px-3 py-2 w-32">Status</th>
          <th className="text-right font-medium px-3 py-2 w-32">Actions</th>
        </tr>
      </thead>
      <tbody>
        {risks.map((r) => (
          <tr key={r.id} className="border-b border-border last:border-0">
            <td className="px-3 py-3">
              <div className="font-medium text-text">{r.title}</div>
              {r.mitigation && <div className="text-xs text-muted mt-0.5">{r.mitigation}</div>}
            </td>
            <td className="px-3 py-3">
              <Chip tone={r.severity === "high" ? "bad" : r.severity === "medium" ? "warn" : "good"}>{r.severity}</Chip>
            </td>
            <td className="px-3 py-3 text-text">{r.owner || "—"}</td>
            <td className="px-3 py-3 text-muted">{fmtDate(r.due_on)}</td>
            <td className="px-3 py-3">
              <Chip tone={r.status === "resolved" ? "good" : r.status === "mitigating" ? "warn" : "bad"}>{r.status}</Chip>
            </td>
            <td className="px-3 py-3 text-right">
              {r.status !== "resolved" && (
                <div className="inline-flex gap-2">
                  {r.status !== "mitigating" && (
                    <button onClick={() => onMitigate(r.id)} className="text-xs text-warn hover:underline">Mitigate</button>
                  )}
                  <button onClick={() => onResolve(r.id)} className="text-xs text-success hover:underline">Resolve</button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- Finance ---------- */

function FinancePanel({ project, ccy }: { project: Project; ccy: string }) {
  const outstanding = Math.max(0, project.invoice_total - project.invoice_paid);
  const utilization = project.budget > 0 ? Math.min(120, Math.round((project.invoice_total / project.budget) * 100)) : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI icon={<Wallet size={14} />} label="Invoiced" value={fmtMoney(project.invoice_total, ccy)} tone="info" />
        <KPI icon={<Check size={14} />} label="Paid" value={fmtMoney(project.invoice_paid, ccy)} tone="good" />
        <KPI icon={<Clock size={14} />} label="Outstanding" value={fmtMoney(outstanding, ccy)} tone={outstanding ? "warn" : "good"} />
        <KPI icon={<FileBarChart2 size={14} />} label="Budget" value={fmtMoney(project.budget, ccy)} tone="neutral" />
      </div>
      <div>
        <div className="flex items-center justify-between text-xs text-muted mb-1">
          <span>Budget utilization</span>
          <span className={utilization > 100 ? "text-danger font-medium" : ""}>{utilization}%</span>
        </div>
        <div className="h-2 rounded-full bg-bg overflow-hidden">
          <div
            className={`h-full transition-all ${
              utilization > 100 ? "bg-danger" : utilization > 80 ? "bg-warn" : "bg-success"
            }`}
            style={{ width: `${Math.min(100, utilization)}%` }}
          />
        </div>
      </div>
      {project.invoices.length > 0 && (
        <div className="border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg text-xs text-muted">
              <tr>
                <th className="text-left font-medium px-3 py-2">Invoice</th>
                <th className="text-left font-medium px-3 py-2 w-32">Issued</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {project.invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{inv.number}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(inv.issued_on)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtMoney(inv.amount, inv.currency)}</td>
                  <td className="px-3 py-2 capitalize">
                    <Chip tone={inv.status === "paid" ? "good" : inv.status === "overdue" ? "bad" : "info"}>{inv.status}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- Audit ---------- */

function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted italic">No audit activity yet.</p>;
  }
  return (
    <ol className="space-y-2.5">
      {entries.map((a, i) => (
        <li key={i} className="flex items-start gap-3 text-sm">
          <span className="w-7 h-7 rounded-full bg-bg border border-border grid place-items-center shrink-0 text-muted">
            <History size={12} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-text">{a.title}</div>
            <div className="text-xs text-muted">{relTime(a.at)} · {a.kind}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Update Status ---------- */

function UpdateStatusButton({
  project, onTransition, busy,
}: { project: Project; onTransition: (to: string, reason?: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const next = ([
    "in_progress", "qa_review", "client_acceptance", "invoiced", "paid", "closed",
  ] as const).filter((s) => s !== project.status);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} disabled={!project.opportunity_id || busy} className="btn-outline">
        <ArrowRight size={14} /> Update status
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-40 bg-surface border border-border rounded-md shadow-card p-1 min-w-[200px]">
            {next.map((s) => (
              <button
                key={s}
                onClick={() => { onTransition(s); setOpen(false); }}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-bg rounded capitalize"
              >
                Move to {prettyStatus(s)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Dialogs ---------- */

function RaiseRiskDialog({
  submitting, onClose, onAdd,
}: {
  submitting: boolean;
  onClose: () => void;
  onAdd: (r: Omit<Risk, "id" | "at">) => void;
}) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [mitigation, setMitigation] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    if (!title.trim()) { setErr("Title is required."); return; }
    onAdd({
      title: title.trim(), severity, owner: owner.trim(), due_on: due || undefined,
      mitigation: mitigation.trim() || undefined, status: "active",
    });
  }

  return (
    <Dialog title="Raise risk" onClose={onClose} icon={<AlertTriangle className="text-danger" size={20} />}>
      <label className="block">
        <div className="label">Title</div>
        <input className="input" autoFocus value={title} placeholder="e.g. Vendor data feed outage" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <div className="label">Severity</div>
          <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as any)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="block">
          <div className="label">Due date</div>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <label className="block">
        <div className="label">Owner</div>
        <input className="input" value={owner} placeholder="Name of accountable person" onChange={(e) => setOwner(e.target.value)} />
      </label>
      <label className="block">
        <div className="label">Mitigation plan</div>
        <textarea className="input min-h-[80px]" value={mitigation} placeholder="What we'll do to reduce or contain the risk." onChange={(e) => setMitigation(e.target.value)} />
      </label>
      {err && <div className="text-danger text-sm">{err}</div>}
      <DialogActions>
        <button onClick={onClose} className="btn-outline">Cancel</button>
        <SmartButton variant="danger" loading={submitting} loadingLabel="Saving…" onClick={() => submit()}>
          Raise risk
        </SmartButton>
      </DialogActions>
    </Dialog>
  );
}

function AddReportDialog({
  submitting, onClose, onAdd,
}: {
  submitting: boolean;
  onClose: () => void;
  onAdd: (r: Omit<Report, "id" | "at" | "by">) => void;
}) {
  const [kind, setKind] = useState("delivery_update");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    if (!title.trim()) { setErr("Title is required."); return; }
    onAdd({ kind, title: title.trim(), body: body.trim() });
  }

  return (
    <Dialog title="Add report" onClose={onClose} icon={<FileText size={20} />}>
      <label className="block">
        <div className="label">Type</div>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="delivery_update">Delivery update</option>
          <option value="blocker">Blocker</option>
          <option value="next_action">Next action</option>
          <option value="evidence">Evidence</option>
          <option value="decision">Decision</option>
        </select>
      </label>
      <label className="block">
        <div className="label">Title</div>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="One-line summary" />
      </label>
      <label className="block">
        <div className="label">Detail</div>
        <textarea className="input min-h-[100px]" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changed, who is affected, what's next." />
      </label>
      {err && <div className="text-danger text-sm">{err}</div>}
      <DialogActions>
        <button onClick={onClose} className="btn-outline">Cancel</button>
        <SmartButton variant="primary" loading={submitting} loadingLabel="Saving…" successLabel="Posted" onClick={() => submit()}>
          Post update
        </SmartButton>
      </DialogActions>
    </Dialog>
  );
}

function Dialog({
  title, icon, onClose, children,
}: {
  title: string; icon?: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            {icon}
            <h2 className="text-lg font-semibold text-text">{title}</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">{children}</div>
      </div>
    </div>
  );
}
function DialogActions({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 pt-2 border-t border-border -mx-5 -mb-5 px-5 py-4 bg-bg">{children}</div>;
}
