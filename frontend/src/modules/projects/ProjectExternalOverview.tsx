import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Target, Plus, ChevronDown, CheckCircle2, ArrowRight, ExternalLink,
} from "lucide-react";

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
  lead_type: string;
  client_name: string;
  links: ProjectLink[];
  opportunity_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

type Task = {
  id: string;
  title: string;
  description: string;
  priority: number;
  due_on: string | null;
  assignee_id?: string | null;
  status?: string;
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

type TeamLine = { name: string; kind: "internal" | "external"; daily_rate: number; count: number; days: number };

type OppData = {
  estimated_value: number;
  budget: number;
  delivery_deadline?: string;
  technical_scope?: string;
  team_composition?: TeamLine[];
  compliance_tags?: string[];
  documents?: { id: string; kind: string; name: string }[];
  required_documents?: string[];
};

const STAGES_PIPELINE: { key: string; label: string }[] = [
  { key: "planning",          label: "1. Discovery & planning" },
  { key: "in_progress",       label: "2. Build & deliver" },
  { key: "qa_review",         label: "3. Operational execution" },
  { key: "client_acceptance", label: "4. Client acceptance" },
  { key: "invoiced",          label: "5. Invoiced" },
  { key: "paid",              label: "6. Paid & closed" },
  { key: "closed",            label: "Closed" },
];

function fmtMoney(n: number, ccy = "USD"): string {
  if (!n && n !== 0) return "—";
  try { return n.toLocaleString("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 }); }
  catch { return `${ccy} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`; }
}
function fmtMonthly(n: number, ccy = "USD"): string {
  return `${fmtMoney(n, ccy)}/month`;
}
function fmtDateLong(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${d.toLocaleDateString("en-US", { month: "long" })} ${day}${suffix} ${d.getFullYear()}`;
}
function yearsBetween(start?: string | null, end?: string | null): string {
  if (!start || !end) return "—";
  const a = new Date(start).getTime(), b = new Date(end).getTime();
  if (isNaN(a) || isNaN(b)) return "—";
  const diff = (b - a) / (1000 * 60 * 60 * 24 * 365);
  if (diff < 1) return `${Math.round(diff * 12)} months`;
  return `${diff.toFixed(1)} years`;
}

export function ProjectExternalOverview({
  project, board, stakeholders,
}: {
  project: Project;
  board: Board | undefined;
  stakeholders: Stakeholder[];
}) {
  useParams();
  useQueryClient();

  const { data: opp } = useQuery<OppData>({
    queryKey: ["opp-for-project", project.opportunity_id],
    queryFn: () => api(`/api/v1/opportunities/${project.opportunity_id}`),
    enabled: !!project.opportunity_id,
  });

  const ccy = project.currency || "USD";

  const stageMatch = STAGES_PIPELINE.find((s) => s.key === project.status) ?? STAGES_PIPELINE[0];
  const stageIdx = STAGES_PIPELINE.findIndex((s) => s.key === project.status);
  const stageProgressPct = Math.max(8, Math.round(((stageIdx + 1) / 5) * 100));

  // Budget breakdown — derived from team_composition; pad with sensible buckets if absent.
  const budgetItems = useMemo(() => {
    const team = opp?.team_composition ?? [];
    const internalCost = team.filter(t => t.kind === "internal").reduce((s, t) => s + t.count * t.days * t.daily_rate, 0);
    const externalCost = team.filter(t => t.kind === "external").reduce((s, t) => s + t.count * t.days * t.daily_rate, 0);
    const total = (project.budget || internalCost + externalCost) || 1;

    type Item = { label: string; amount: number; pct: number; tone: "lime" | "muted" };
    const items: Item[] = [];
    items.push({ label: "Overall budget", amount: total, pct: 34, tone: "lime" });
    if (internalCost > 0) items.push({ label: "Internal team", amount: internalCost, pct: Math.min(95, Math.round((internalCost / total) * 100)), tone: "muted" });
    if (externalCost > 0) items.push({ label: "External workforce", amount: externalCost, pct: Math.min(95, Math.round((externalCost / total) * 100)), tone: "muted" });
    items.push({ label: "Tools",    amount: total * 0.06, pct: 16, tone: "muted" });
    items.push({ label: "Software", amount: total * 0.04, pct: 12, tone: "muted" });
    return items;
  }, [opp, project.budget]);

  // Goals — pull from technical_scope (one per line) or compliance tags as fallback.
  const goals = useMemo(() => {
    const lines = (opp?.technical_scope ?? "")
      .split(/\n/).map(s => s.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines.slice(0, 4).map((l) => {
        const [head, ...rest] = l.split(/[:.—–]/);
        return {
          title: head.trim(),
          body: rest.length ? rest.join(":").trim() : "",
        };
      });
    }
    return (opp?.compliance_tags ?? []).slice(0, 4).map((t) => ({ title: t, body: "" }));
  }, [opp]);

  // Approvals — from opportunity documents.
  const approvals = useMemo(() => {
    const docs = opp?.documents ?? [];
    const required = opp?.required_documents ?? [];
    const ownerName = stakeholders[0]?.name ?? "Unassigned";
    const reviewer = project.client_name || "Client";
    const out = required.map((kind) => {
      const attached = docs.find((d) => d.kind === kind);
      return {
        label: prettyDocKind(kind),
        owner: ownerName,
        reviewer,
        done: !!attached,
      };
    });
    return out.slice(0, 6);
  }, [opp, stakeholders, project.client_name]);

  const roi = opp?.estimated_value ?? project.budget;
  const roiPeriod = yearsBetween(project.start_date, project.end_date) || "1.5 years";
  const expences = project.budget;

  return (
    <div className="space-y-5">
      {/* Project description + Project stage row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title="Project overview">
          <p className="text-sm text-muted leading-relaxed line-clamp-3">
            {project.description || "No description captured yet."}
          </p>
          {project.opportunity_id && (
            <Link
              to={`/pipeline/${project.opportunity_id}`}
              className="inline-flex items-center gap-1 mt-4 text-sm text-text font-semibold border border-border bg-bg rounded-full px-4 py-1.5 hover:bg-surface"
            >
              Read more
            </Link>
          )}
        </SectionCard>

        <SectionCard padded={false}>
          <div className="px-5 py-4 flex items-center gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1.5">Members</div>
              <AvatarStack stakeholders={stakeholders} />
            </div>
            <div className="flex-1" />
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1.5">Project stage</div>
              <button className="inline-flex items-center gap-2 text-sm font-medium border border-border rounded-full px-3.5 py-1.5">
                <span className="w-2 h-2 rounded-full bg-accent" />
                {stageMatch.label}
                <ChevronDown size={14} className="text-muted" />
              </button>
            </div>
            <ProgressRing pct={stageProgressPct} />
          </div>

          <div className="border-t border-border flex items-center text-sm">
            <Pillbar />
          </div>
        </SectionCard>
      </div>

      {/* ROI + Budget + Approvals row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Return on investment" action={<ModifyBtn />}>
          <div className="grid grid-cols-3 gap-4 mt-3">
            <Stat label="Most likely expences" value={fmtMoney(expences, ccy)} />
            <Stat label="Project deadline" value={fmtDateLong(project.end_date || opp?.delivery_deadline)} />
            <Stat label="ROI period" value={roiPeriod} />
          </div>
          <div className="mt-4 text-xs text-muted">
            Based on the contract value of <strong className="text-text">{fmtMoney(roi, ccy)}</strong>.
          </div>
        </SectionCard>

        <SectionCard title="Budget" action={<ModifyBtn />}>
          <ul className="space-y-3 mt-1">
            {budgetItems.map((b, i) => (
              <li key={i}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text font-medium">{b.label}</span>
                  <span className="text-muted text-xs">{fmtMonthly(b.amount, ccy)}</span>
                </div>
                <div className="mt-1 h-2.5 bg-bg rounded-full overflow-hidden relative">
                  <div
                    className={`h-full ${b.tone === "lime" ? "bg-lime" : "bg-muted/40"} rounded-full transition-all`}
                    style={{ width: `${b.pct}%` }}
                  />
                  <span className="absolute inset-0 flex items-center pl-2 text-[10px] font-bold text-text/80">
                    {b.pct}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Approvals" action={<ModifyBtn />}>
          {approvals.length === 0 ? (
            <p className="text-sm text-muted italic">No approvals defined yet.</p>
          ) : (
            <ul className="divide-y divide-border -mx-1">
              {approvals.map((a, i) => (
                <li key={i} className="flex items-center gap-3 py-2.5 px-1">
                  <span className={`w-9 h-9 rounded-full grid place-items-center shrink-0 ${
                    a.done ? "bg-success/15 text-success" : "bg-bg border border-border text-muted"
                  }`}>
                    <CheckCircle2 size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text truncate">{a.label}</div>
                    <div className="text-xs text-muted truncate flex items-center gap-1.5">
                      <span>{a.owner}</span>
                      <ArrowRight size={10} />
                      <span>{a.reviewer}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Goals & objectives */}
      <SectionCard
        title="Project goals & objectives"
        action={
          <button className="inline-flex items-center gap-1 text-sm border border-border bg-bg rounded-full px-3.5 py-1.5 hover:bg-surface">
            <Plus size={14} /> Add
          </button>
        }
      >
        {goals.length === 0 ? (
          <p className="text-sm text-muted italic">
            Nothing captured yet. Add a few bullet points to <em>technical scope</em> on the source opportunity to see them here.
          </p>
        ) : (
          <ul className="space-y-4 mt-1">
            {goals.map((g, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-full bg-bg border border-border grid place-items-center shrink-0">
                  <Target size={16} className="text-muted" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text">{g.title}</div>
                  {g.body && (
                    <p className="text-sm text-muted mt-0.5 leading-relaxed line-clamp-2">{g.body}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {project.opportunity_id && (
          <Link
            to={`/pipeline/${project.opportunity_id}`}
            className="inline-flex items-center gap-1 mt-4 text-sm text-text font-semibold border border-border bg-bg rounded-full px-4 py-1.5 hover:bg-surface"
          >
            Read more
          </Link>
        )}
      </SectionCard>

      {/* Useful links */}
      {project.links.length > 0 && (
        <SectionCard title="Project links">
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {project.links.map((l, i) => (
              <li key={i}>
                <a
                  href={l.url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 border border-border rounded-md p-3 hover:border-accent transition-colors"
                >
                  <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center">
                    <ExternalLink size={14} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text truncate">{l.label}</div>
                    <div className="text-xs text-muted truncate">{tryHost(l.url)}</div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Tasks rollup if board has any (kept lightweight here — full task work happens on Tasks tab) */}
      {board && (board.columns.todo.length + board.columns.in_progress.length + board.columns.review.length + board.columns.done.length) > 0 && (
        <SectionCard
          title="Tasks at a glance"
          action={<Link to="board" className="text-sm text-accent hover:underline">View all →</Link>}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-1">
            <MiniStat label="To-do" value={board.columns.todo.length} />
            <MiniStat label="In progress" value={board.columns.in_progress.length} />
            <MiniStat label="In review" value={board.columns.review.length} />
            <MiniStat label="Done" value={board.columns.done.length} tone="success" />
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function SectionCard({
  title, action, children, padded = true,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="card overflow-hidden">
      {(title || action) && (
        <header className={`flex items-center justify-between ${padded ? "px-5 pt-5" : "px-5 py-4"}`}>
          {title && <h2 className="text-base font-bold text-text">{title}</h2>}
          {action}
        </header>
      )}
      <div className={padded ? "p-5 pt-3" : ""}>{children}</div>
    </section>
  );
}

function ModifyBtn() {
  return (
    <button className="text-sm text-text font-medium border border-border bg-bg rounded-full px-3.5 py-1.5 hover:bg-surface">
      Modify
    </button>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted font-semibold">{label}</div>
      <div className="text-base font-bold text-text mt-1">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "success" }) {
  return (
    <div className="border border-border rounded-md p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-2xl font-bold mt-0.5 ${tone === "success" ? "text-success" : "text-text"}`}>
        {value}
      </div>
    </div>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 22, c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div className="relative w-12 h-12 shrink-0">
      <svg className="w-12 h-12 -rotate-90">
        <circle cx="24" cy="24" r={r} stroke="rgb(var(--border))" strokeWidth="4" fill="none" />
        <circle
          cx="24" cy="24" r={r}
          stroke="rgb(var(--accent))"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-[11px] font-bold text-text">
        {pct}%
      </div>
    </div>
  );
}

function Pillbar() {
  const tabs = ["Project goals", "Team members", "Milestones", "Tasks", "Resources"];
  const [active, setActive] = useState(0);
  return (
    <div className="flex items-center gap-1 px-2 py-2 overflow-x-auto w-full">
      {tabs.map((t, i) => (
        <button
          key={t}
          onClick={() => setActive(i)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            i === active ? "bg-accent text-white" : "text-muted hover:text-text"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function AvatarStack({ stakeholders }: { stakeholders: Stakeholder[] }) {
  const visible = stakeholders.slice(0, 4);
  const extra = Math.max(0, stakeholders.length - 4);
  return (
    <div className="flex -space-x-2">
      {visible.map((s) => (
        <span
          key={s.id}
          title={s.name}
          className={`w-9 h-9 rounded-full grid place-items-center text-sm font-bold border-2 border-surface ${
            s.kind === "external" ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
          }`}
        >
          {(s.name || "?")[0].toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="w-9 h-9 rounded-full grid place-items-center text-xs font-semibold bg-accent text-white border-2 border-surface">
          +{extra}
        </span>
      )}
    </div>
  );
}

function tryHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

function prettyDocKind(kind: string): string {
  const map: Record<string, string> = {
    NDA: "NDA",
    TechnicalProposal: "Technical proposal",
    ScopeDocument: "Scope document",
    RFP: "RFP / tender pack",
    ComplianceForm: "Compliance form",
    ProcurementApproval: "Procurement approval",
    MSA: "Master service agreement",
    Contract: "Contract",
    ExportComplianceForm: "Export compliance form",
    FXApproval: "FX approval",
    GrantAgreement: "Grant agreement",
  };
  return map[kind] ?? kind;
}

export type { Project };
