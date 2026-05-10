import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import {
  Network, ShieldCheck, ShieldAlert, Clock, CheckCircle2, FileText, Plus,
  ArrowLeft, Globe, Mail, Phone, Trash2, Pencil, X, Link as LinkIcon, FileCheck2,
  Activity, AlertTriangle, ListTodo, Wallet, Users as UsersIcon, History,
  GaugeCircle, Network as NetworkIcon, Send, Copy, RotateCcw, Sparkles,
  TrendingUp,
} from "lucide-react";
import { AGENT_TYPE_LABEL } from "./AgentsPage";

type AgentStatus = "draft" | "onboarded" | "engaged" | "suspended" | "terminated";
type RiskLevel = "low" | "medium" | "high" | "critical";

type Doc = { id: string; kind: string; name: string; object_key: string; uploaded_at: string };

type Agent = {
  id: string;
  name: string;
  organization: string;
  agent_type: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  region: string;
  country: string;
  sector_focus: string[];
  relationship_owner_id: string | null;
  relationship_owner_name: string;
  status: AgentStatus;
  risk_level: RiskLevel;
  pep_flag: boolean;
  conflict_flag: boolean;
  notes: string;
  last_activity_at: string | null;
  created_at: string;
  documents: Doc[];
  mandatory_kinds: string[];
  mandatory_missing: string[];
  can_engage: boolean;
};

type Invitation = {
  id: string;
  token: string;
  email: string;
  message: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  status: "pending" | "accepted" | "expired" | "revoked";
};

const STATUS_META: Record<AgentStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  draft:      { label: "Onboarding",  cls: "bg-warn/15 text-warn",       icon: <Clock size={12} /> },
  onboarded:  { label: "Onboarded",   cls: "bg-accent-soft text-accent", icon: <CheckCircle2 size={12} /> },
  engaged:    { label: "Engaged",     cls: "bg-success/15 text-success", icon: <ShieldCheck size={12} /> },
  suspended:  { label: "Suspended",   cls: "bg-warn/25 text-warn",       icon: <ShieldAlert size={12} /> },
  terminated: { label: "Terminated",  cls: "bg-danger/15 text-danger",   icon: <X size={12} /> },
};
const RISK_META: Record<RiskLevel, { label: string; cls: string }> = {
  low:      { label: "Low risk",      cls: "bg-success/15 text-success" },
  medium:   { label: "Medium risk",   cls: "bg-warn/15 text-warn" },
  high:     { label: "High risk",     cls: "bg-danger/15 text-danger" },
  critical: { label: "Critical risk", cls: "bg-danger text-white" },
};

const DOC_KIND_META: Record<string, { label: string; mandatory?: boolean; description?: string }> = {
  nda:                  { label: "NDA",                       mandatory: true,  description: "Non-disclosure agreement." },
  engagement_agreement: { label: "Engagement agreement",      mandatory: true,  description: "Defines scope, term, fees, termination." },
  agent_declaration:    { label: "Agent declaration form",    mandatory: true,  description: "Self-declaration of capacity and conduct." },
  conflict_of_interest: { label: "Conflict-of-interest form", mandatory: true,  description: "Disclosure of any conflicts." },
  kyc:                  { label: "KYC / identity",            mandatory: true,  description: "Identity verification." },
  anti_bribery:         { label: "Anti-bribery declaration",  mandatory: true,  description: "Compliance with FCPA / UK Bribery Act / equivalent." },
  approval_memo:        { label: "Approval memo",             mandatory: true,  description: "Internal sign-off authorising the engagement." },
  data_protection:      { label: "Data protection agreement",                   description: "NDPR / GDPR addendum." },
  company_registration: { label: "Company registration",                        description: "If the agent represents an entity." },
  tax_info:             { label: "Tax information",                             description: "TIN / equivalent." },
  bank_details:         { label: "Bank details",                                description: "Verified payment account information." },
  other:                { label: "Other",                                       description: "Any additional supporting document." },
};

type Tab = "overview" | "compliance" | "engagements" | "introductions" | "commissions" | "monitoring" | "performance" | "portal" | "audit";

const TABS: { key: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: "overview",      label: "Overview",      icon: Activity },
  { key: "compliance",    label: "Compliance",    icon: FileCheck2 },
  { key: "engagements",   label: "Engagements",   icon: ListTodo },
  { key: "introductions", label: "Introductions", icon: NetworkIcon },
  { key: "commissions",   label: "Commissions",   icon: Wallet },
  { key: "monitoring",    label: "Monitoring",    icon: AlertTriangle },
  { key: "performance",   label: "Performance",   icon: GaugeCircle },
  { key: "portal",        label: "Portal access", icon: UsersIcon },
  { key: "audit",         label: "Audit trail",   icon: History },
];

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export function AgentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Agent>({
    queryKey: ["agent", id], queryFn: () => api(`/api/v1/agents/${id}`),
  });
  const { data: invitesData } = useQuery<{ items: Invitation[] }>({
    queryKey: ["agent-invites", id],
    queryFn: () => api(`/api/v1/agents/${id}/invites`),
    enabled: !!id,
  });
  const invites = invitesData?.items ?? [];

  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen, setEditOpen]     = useState(false);
  const [docOpen, setDocOpen]       = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Partial<Agent>) =>
      api(`/api/v1/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Agent updated");
      qc.invalidateQueries({ queryKey: ["agent", id] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setEditOpen(false);
    },
    onError: (e: Error) => toast.error("Update failed", e.message),
  });

  const addDoc = useMutation({
    mutationFn: (b: { kind: string; name: string; object_key: string }) =>
      api(`/api/v1/agents/${id}/documents`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      toast.success("Document attached");
      qc.invalidateQueries({ queryKey: ["agent", id] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setDocOpen(false);
    },
    onError: (e: Error) => toast.error("Could not attach", e.message),
  });

  const removeDoc = useMutation({
    mutationFn: (docId: string) =>
      api(`/api/v1/agents/${id}/documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", id] }),
  });

  const createInvite = useMutation({
    mutationFn: (b: { email: string; message?: string }) =>
      api<{ token: string; expires_at: string }>(`/api/v1/agents/${id}/invite`, {
        method: "POST", body: JSON.stringify(b),
      }),
    onSuccess: () => {
      toast.success("Invitation created", "Copy the link or open your email client to send it.");
      qc.invalidateQueries({ queryKey: ["agent-invites", id] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? (e.body as any)?.error ?? e.message : (e as Error)?.message;
      toast.error("Could not create invite", msg);
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      api(`/api/v1/agent-invitations/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-invites", id] }),
  });

  if (isLoading || !data) return <div className="text-muted">Loading agent…</div>;

  return (
    <div className="space-y-5 max-w-7xl">
      <Link to="/agents" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft size={14} /> Back to agents
      </Link>

      <AgentHeader v={data} onEdit={() => setEditOpen(true)} onInvite={() => setInviteOpen(true)} />

      <nav className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold transition-colors ${
              tab === t.key ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview"      && <OverviewTab v={data} invites={invites} onAttachDoc={() => setDocOpen(true)} onRemoveDoc={(d) => removeDoc.mutate(d)} onInvite={() => setInviteOpen(true)} onRevokeInvite={(i) => revokeInvite.mutate(i)} />}
      {tab === "compliance"    && <ComplianceTab v={data} onAttachDoc={() => setDocOpen(true)} onRemoveDoc={(d) => removeDoc.mutate(d)} />}
      {tab === "engagements"   && <NextUpStub icon={<ListTodo size={20} />} title="Engagement tracker" body="Per-agent engagements with state machine: draft → under review → approved → active → on hold → completed / terminated. Linked to opportunities and projects, with target stakeholders, expected outcomes and the relationship owner." />}
      {tab === "introductions" && <NextUpStub icon={<NetworkIcon size={20} />} title="Introductions & stakeholder map" body="Log each introduction the agent makes — target organization, decision-makers, meeting date, relationship strength, follow-up owner, outcome. Stakeholder map renders organisations and their key contacts." />}
      {tab === "commissions"   && <NextUpStub icon={<Wallet size={20} />} title="Commission & success-fee tracking" body="Fee model (fixed / retainer / success / milestone), payment triggers, payable amounts, payment + approval status. Commission approval will be hard-gated on engagement approval, complete docset, documented fee basis and management sign-off." />}
      {tab === "monitoring"    && <NextUpStub icon={<AlertTriangle size={20} />} title="Compliance & conflict monitoring" body="PEP risk, conflict-of-interest flags, anti-bribery declarations, unusual fee structures, missing documentation, restricted relationships, high-risk public-sector exposure — surfaced as warnings on engagements." extra={<>This agent is currently graded {STATUS_META[data.status].label}, risk {RISK_META[data.risk_level].label}{data.pep_flag ? " · PEP flagged" : ""}{data.conflict_flag ? " · conflict flagged" : ""}</>} />}
      {tab === "performance"   && <NextUpStub icon={<GaugeCircle size={20} />} title="Performance dashboard" body="Introductions made, qualified opportunities influenced, meetings secured, follow-ups completed, conversion contribution, active relationships, pending actions, closed engagements. Aggregated from the engagement and introduction tables once they're populated." />}
      {tab === "portal"        && <NextUpStub icon={<UsersIcon size={20} />} title="Agent portal access" body="Restricted accounts so agents can view their own engagements, upload required documents, log introductions, submit invoices and respond to compliance requests — scoped to only what's assigned to them." />}
      {tab === "audit"         && <NextUpStub icon={<History size={20} />} title="Audit trail" body="Timeline of onboarding actions, document uploads, engagement approvals, introduction logs, stakeholder updates, fee approvals, invoice submissions, compliance flags and management decisions." />}

      {editOpen && (
        <EditAgentDialog v={data} submitting={update.isPending} onClose={() => setEditOpen(false)} onSave={(p) => update.mutate(p)} />
      )}
      {docOpen && (
        <AddDocDialog submitting={addDoc.isPending} onClose={() => setDocOpen(false)} onAdd={(b) => addDoc.mutate(b)} />
      )}
      {inviteOpen && (
        <InviteAgentDialog
          agentName={data.name}
          defaultEmail={data.contact_email}
          submitting={createInvite.isPending}
          lastResult={createInvite.data ?? null}
          onClose={() => { setInviteOpen(false); createInvite.reset(); }}
          onCreate={(b) => createInvite.mutate(b)}
        />
      )}
    </div>
  );
}

/* ---------------- Header ---------------- */

function AgentHeader({
  v, onEdit, onInvite,
}: { v: Agent; onEdit: () => void; onInvite: () => void }) {
  const sm = STATUS_META[v.status];
  const rm = RISK_META[v.risk_level];
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
            <Network size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-extrabold text-text truncate">{v.name}</h1>
              <span className={`pill ${sm.cls}`}>{sm.icon}{sm.label}</span>
              <span className={`pill ${rm.cls}`}>{rm.label}</span>
              {v.pep_flag    && <span className="pill bg-danger/15 text-danger">PEP</span>}
              {v.conflict_flag && <span className="pill bg-warn/15 text-warn">Conflict</span>}
              {!v.can_engage && (
                <span className="pill bg-warn/15 text-warn">
                  <AlertTriangle size={11} /> Can't engage · {v.mandatory_missing.length} doc{v.mandatory_missing.length === 1 ? "" : "s"} missing
                </span>
              )}
            </div>
            <div className="text-sm text-muted mt-1">
              {AGENT_TYPE_LABEL[v.agent_type as keyof typeof AGENT_TYPE_LABEL] ?? v.agent_type}
              {v.organization && <> · {v.organization}</>}
              {v.region && <> · {v.region}</>}
              {v.country && <> · {v.country}</>}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted mt-2">
              {v.contact_email && <a href={`mailto:${v.contact_email}`} className="inline-flex items-center gap-1 hover:text-accent"><Mail size={12} /> {v.contact_email}</a>}
              {v.contact_phone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {v.contact_phone}</span>}
              {v.relationship_owner_name && <span className="inline-flex items-center gap-1"><Sparkles size={12} /> Owner: {v.relationship_owner_name}</span>}
              <span className="inline-flex items-center gap-1"><Clock size={12} /> Last activity {fmtRel(v.last_activity_at)}</span>
            </div>
            {v.sector_focus.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {v.sector_focus.map((s) => (
                  <span key={s} className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-accent-soft text-accent">{s.replace(/_/g, " ")}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button onClick={onInvite} className="btn-outline" style={{ padding: "0.4rem 0.9rem", fontSize: "12.5px" }}>
            <Send size={12} /> Send invite link
          </button>
          <button onClick={onEdit} className="btn-outline" style={{ padding: "0.4rem 0.9rem", fontSize: "12.5px" }}>
            <Pencil size={12} /> Edit
          </button>
        </div>
      </div>

      {/* Compliance line + KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <Kpi label="Compliance" value={`${v.mandatory_kinds.length - v.mandatory_missing.length}/${v.mandatory_kinds.length}`}
             sub={v.mandatory_missing.length === 0 ? "complete" : "missing docs"} tone={v.mandatory_missing.length === 0 ? "good" : "warn"} />
        <Kpi label="Status" value={sm.label} />
        <Kpi label="Risk"   value={rm.label} tone={v.risk_level === "low" ? "good" : v.risk_level === "critical" ? "bad" : "warn"} />
        <Kpi label="Region" value={v.region || v.country || "—"} />
        <Kpi label="Sectors" value={v.sector_focus.length} sub={v.sector_focus.length ? "tagged" : "untagged"} />
        <Kpi label="Owner"  value={v.relationship_owner_name || "—"} sub={v.relationship_owner_name ? "" : "unassigned"} />
      </div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  const cls = { good: "text-success", warn: "text-warn", bad: "text-danger", neutral: "text-text" }[tone ?? "neutral"];
  return (
    <div className="bg-bg/40 border border-border rounded-xl p-3 min-w-0">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-base font-extrabold mt-0.5 truncate ${cls}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({
  v, invites, onAttachDoc, onRemoveDoc, onInvite, onRevokeInvite,
}: {
  v: Agent;
  invites: Invitation[];
  onAttachDoc: () => void;
  onRemoveDoc: (id: string) => void;
  onInvite: () => void;
  onRevokeInvite: (id: string) => void;
}) {
  const have = new Set(v.documents.map((d) => d.kind));
  const checklist = [
    ...v.mandatory_kinds.map((k) => ({ label: DOC_KIND_META[k]?.label ?? k, done: have.has(k) })),
    { label: "Sectors tagged", done: v.sector_focus.length > 0 },
  ];
  const completed = checklist.filter((s) => s.done).length;
  const pct = Math.round((completed / checklist.length) * 100);
  const pendingInvite = invites.find((i) => i.status === "pending");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-1">
        <h2 className="h2 flex items-center gap-2"><FileCheck2 size={16} className="text-accent" /> Onboarding</h2>
        <div className="mt-3 mb-4">
          <div className="flex items-center justify-between text-xs text-muted mb-1">
            <span>{completed} of {checklist.length} complete</span>
            <span className="font-semibold">{pct}%</span>
          </div>
          <div className="h-2 bg-bg rounded-full overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <ul className="space-y-2">
          {checklist.map((s) => (
            <li key={s.label} className="flex items-center gap-2 text-sm">
              <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${
                s.done ? "bg-success text-white" : "bg-bg border border-border text-muted"
              }`}>
                {s.done ? <CheckCircle2 size={12} /> : null}
              </span>
              <span className={s.done ? "text-text" : "text-muted"}>{s.label}</span>
            </li>
          ))}
        </ul>
        {v.notes && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Notes</div>
            <p className="text-sm text-text whitespace-pre-wrap">{v.notes}</p>
          </div>
        )}
      </section>

      <div className="lg:col-span-2 space-y-4">
        {pendingInvite && (
          <PendingInviteCard
            invite={pendingInvite}
            onCopy={() => copyInviteLink(pendingInvite.token)}
            onRevoke={() => onRevokeInvite(pendingInvite.id)}
            onResend={onInvite}
          />
        )}
        <DocumentsCard v={v} onAttach={onAttachDoc} onRemove={onRemoveDoc} />
      </div>
    </div>
  );
}

function inviteUrl(token: string): string { return `${window.location.origin}/agent-invite/${token}`; }
async function copyInviteLink(token: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl(token));
    toast.success("Link copied", "Paste into an email or chat to send to the agent.");
  } catch {
    toast.error("Copy failed", "Select the link manually and copy it.");
  }
}

function PendingInviteCard({
  invite, onCopy, onRevoke, onResend,
}: { invite: Invitation; onCopy: () => void; onRevoke: () => void; onResend: () => void }) {
  const url = inviteUrl(invite.token);
  const expiresAt = new Date(invite.expires_at);
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000));
  return (
    <section className="bg-accent-soft/40 border border-accent/30 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-accent text-white grid place-items-center shrink-0"><Send size={16} /></div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-text">Self-onboarding invite is live</div>
          <p className="text-xs text-muted mt-0.5">
            Sent to <span className="font-semibold">{invite.email}</span> · expires in {daysLeft} day{daysLeft === 1 ? "" : "s"}.
          </p>
          <div className="mt-3 flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2">
            <LinkIcon size={13} className="text-muted shrink-0" />
            <input readOnly value={url} className="flex-1 bg-transparent text-[12.5px] text-text font-mono truncate focus:outline-none" />
            <button onClick={onCopy} className="text-xs font-semibold text-accent hover:underline whitespace-nowrap inline-flex items-center gap-1"><Copy size={12} /> Copy</button>
          </div>
          <div className="mt-2 flex items-center gap-3 flex-wrap text-[11.5px]">
            <a
              href={`mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent("Complete your onboarding")}&body=${encodeURIComponent(`Please complete your onboarding here:\n\n${url}\n\nThis link expires in ${daysLeft} days.`)}`}
              className="text-accent font-semibold hover:underline inline-flex items-center gap-1"
            >
              <Mail size={12} /> Open in mail client
            </a>
            <button onClick={onResend} className="text-muted hover:text-text font-semibold inline-flex items-center gap-1">
              <RotateCcw size={12} /> Reissue link
            </button>
            <button onClick={onRevoke} className="text-muted hover:text-danger font-semibold inline-flex items-center gap-1">
              <X size={12} /> Revoke
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function DocumentsCard({
  v, onAttach, onRemove,
}: { v: Agent; onAttach: () => void; onRemove: (id: string) => void }) {
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="h2 flex items-center gap-2"><FileText size={16} className="text-accent" /> Documents</h2>
        <SmartButton variant="outline" size="sm" onClick={onAttach} icon={<Plus size={12} />}>Attach</SmartButton>
      </div>
      {v.documents.length === 0 ? (
        <div className="text-sm text-muted text-center py-8 border border-dashed border-border rounded-xl">
          No documents yet — start with the NDA, engagement agreement and KYC to unblock engagement activation.
        </div>
      ) : (
        <ul className="space-y-2">
          {v.documents.map((d) => {
            const isUrl = /^https?:\/\//i.test(d.object_key);
            const meta = DOC_KIND_META[d.kind] ?? { label: d.kind };
            return (
              <li key={d.id} className="flex items-center gap-3 bg-bg/40 border border-border rounded-lg p-3">
                <div className="w-9 h-9 rounded-lg bg-surface border border-border grid place-items-center shrink-0 text-muted">
                  {isUrl ? <LinkIcon size={14} /> : <FileText size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text truncate">{d.name}</div>
                  <div className="text-[11px] text-muted">{meta.label} · {fmtRel(d.uploaded_at)}</div>
                </div>
                {isUrl && <a href={d.object_key} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-accent hover:underline">Open ↗</a>}
                <button onClick={() => onRemove(d.id)} className="text-muted hover:text-danger p-1" aria-label="Remove"><Trash2 size={13} /></button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------------- Compliance tab ---------------- */

function ComplianceTab({
  v, onAttachDoc, onRemoveDoc,
}: { v: Agent; onAttachDoc: () => void; onRemoveDoc: (id: string) => void }) {
  const docsByKind = new Map<string, Doc[]>();
  v.documents.forEach((d) => {
    const arr = docsByKind.get(d.kind) ?? [];
    arr.push(d); docsByKind.set(d.kind, arr);
  });
  const allKinds = Object.entries(DOC_KIND_META);
  const mandatoryDone = allKinds.filter(([, m]) => m.mandatory).filter(([k]) => docsByKind.has(k)).length;
  const mandatoryTotal = allKinds.filter(([, m]) => m.mandatory).length;

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-4 border flex items-start gap-3 ${
        v.can_engage ? "border-success/30 bg-success/10" : "border-warn/30 bg-warn/10"
      }`}>
        <div className={`w-10 h-10 rounded-full grid place-items-center shrink-0 ${
          v.can_engage ? "bg-success/20 text-success" : "bg-warn/20 text-warn"
        }`}>
          {v.can_engage ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-text">
            {v.can_engage
              ? "Compliance clear — agent can be activated for engagements"
              : `Blocked from engagement — ${v.mandatory_missing.length} mandatory document${v.mandatory_missing.length === 1 ? "" : "s"} missing`}
          </div>
          <p className="text-xs text-muted mt-0.5">
            Mandatory: {mandatoryDone} / {mandatoryTotal} on file. Engagement approval is hard-gated on the full compliance pack.
          </p>
        </div>
      </div>

      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="h2 flex items-center gap-2"><FileCheck2 size={16} className="text-accent" /> Document checklist</h2>
          <SmartButton variant="primary" size="sm" onClick={onAttachDoc} icon={<Plus size={12} />}>Attach document</SmartButton>
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {allKinds.map(([kind, meta]) => {
            const has = docsByKind.has(kind);
            const docs = docsByKind.get(kind) ?? [];
            return (
              <li key={kind} className={`border rounded-xl p-3 ${has ? "border-border bg-bg/30" : meta.mandatory ? "border-warn/40 bg-warn/5" : "border-border bg-surface"}`}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${
                      has ? "bg-success text-white" : meta.mandatory ? "bg-warn/20 text-warn" : "bg-bg border border-border text-muted"
                    }`}>
                      {has ? <CheckCircle2 size={12} /> : meta.mandatory ? <AlertTriangle size={11} /> : null}
                    </span>
                    <span className="text-sm font-semibold text-text truncate">{meta.label}</span>
                  </div>
                  {meta.mandatory && !has && <span className="text-[10px] uppercase tracking-wider font-bold text-warn shrink-0">Required</span>}
                </div>
                {meta.description && <p className="text-[11px] text-muted leading-snug ml-7 mb-1">{meta.description}</p>}
                {docs.length > 0 && (
                  <ul className="ml-7 mt-1 space-y-1">
                    {docs.map((d) => {
                      const isUrl = /^https?:\/\//i.test(d.object_key);
                      return (
                        <li key={d.id} className="flex items-center gap-2 text-[12px]">
                          {isUrl ? <LinkIcon size={11} className="text-accent" /> : <FileText size={11} className="text-muted" />}
                          <span className="text-text truncate flex-1">{d.name}</span>
                          <span className="text-[10.5px] text-muted">{fmtRel(d.uploaded_at)}</span>
                          {isUrl && <a href={d.object_key} target="_blank" rel="noopener noreferrer" className="text-accent text-[10.5px] font-semibold">Open ↗</a>}
                          <button onClick={() => onRemoveDoc(d.id)} className="text-muted hover:text-danger" aria-label="Remove"><Trash2 size={11} /></button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/* ---------------- Stub for not-yet-built tabs ---------------- */

function NextUpStub({
  icon, title, body, extra,
}: { icon: React.ReactNode; title: string; body: string; extra?: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">{icon}</div>
      <div className="text-base font-bold text-text">{title}</div>
      <p className="text-sm text-muted mt-1 max-w-2xl mx-auto">
        <span className="inline-flex items-center gap-1.5 align-middle text-[11px] uppercase tracking-wider font-bold text-accent mr-2">
          <TrendingUp size={12} /> Next up
        </span>
        {body}
        {extra && <> · {extra}</>}
      </p>
    </div>
  );
}

/* ---------------- Dialogs ---------------- */

function AddDocDialog({
  submitting, onClose, onAdd,
}: {
  submitting: boolean;
  onClose: () => void;
  onAdd: (b: { kind: string; name: string; object_key: string }) => void;
}) {
  const [kind, setKind] = useState("nda");
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");
  const valid = name.trim() && url.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-bold text-text">Attach an agent document</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="label">Kind</div>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(DOC_KIND_META).map(([k, m]) =>
                <option key={k} value={k}>{m.label}{m.mandatory ? " *" : ""}</option>
              )}
            </select>
          </label>
          <label className="block">
            <div className="label">Display name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anti-bribery declaration 2026" />
          </label>
          <label className="block">
            <div className="label">URL or storage key</div>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// or s3://bucket/key" />
            <div className="text-[11px] text-muted mt-1">Paste a link from Drive / S3 / Dropbox etc.</div>
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton variant="primary" disabled={!valid || submitting} loading={submitting}
            onClick={() => onAdd({ kind, name: name.trim(), object_key: url.trim() })}>Attach</SmartButton>
        </footer>
      </div>
    </div>
  );
}

function InviteAgentDialog({
  agentName, defaultEmail, submitting, lastResult, onClose, onCreate,
}: {
  agentName: string;
  defaultEmail: string;
  submitting: boolean;
  lastResult: { token: string; expires_at: string } | null;
  onClose: () => void;
  onCreate: (b: { email: string; message?: string }) => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [message, setMessage] = useState(
    `Hi — please complete your onboarding for ${agentName} via this secure link. ` +
    `Takes a few minutes: contact info, sector focus, and the standard compliance pack (NDA, engagement agreement, KYC, anti-bribery, conflict declaration, approval memo).`,
  );
  const valid = /\S+@\S+\.\S+/.test(email);
  const url = lastResult ? `${window.location.origin}/agent-invite/${lastResult.token}` : "";
  const handleCopy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast.success("Link copied"); }
    catch { toast.error("Copy failed", "Select and copy manually."); }
  };
  const mailtoHref = lastResult
    ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Complete your onboarding")}&body=${encodeURIComponent(`${message}\n\n${url}\n\nLink expires ${new Date(lastResult.expires_at).toLocaleDateString()}.`)}`
    : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center"><Send size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">{lastResult ? "Invitation ready to send" : "Invite agent to self-onboard"}</h2>
              <p className="text-xs text-muted mt-0.5">
                {lastResult
                  ? "Copy the link or open your mail client to send. The agent doesn't need an account."
                  : "We'll mint a secure link the agent can use to fill in details and attach compliance documents — no signup needed."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>

        {lastResult ? (
          <div className="p-5 space-y-4">
            <div>
              <div className="label">Invite link</div>
              <div className="flex items-center gap-2 bg-bg/50 border border-border rounded-lg px-3 py-2">
                <LinkIcon size={13} className="text-muted shrink-0" />
                <input readOnly value={url} className="flex-1 bg-transparent text-[12.5px] text-text font-mono truncate focus:outline-none" />
                <button onClick={handleCopy} className="text-xs font-semibold text-accent hover:underline whitespace-nowrap inline-flex items-center gap-1"><Copy size={12} /> Copy</button>
              </div>
              <p className="text-[11px] text-muted mt-1">
                Expires {new Date(lastResult.expires_at).toLocaleDateString()} · single-use · revocable any time.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              <div className="font-semibold text-text mb-1">Heads up — email isn't auto-sent yet.</div>
              We mint the secure token; you copy the link or use the mail client button below to dispatch it.
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="block">
              <div className="label">Agent email *</div>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@example.com" autoFocus />
            </label>
            <label className="block">
              <div className="label">Message (optional)</div>
              <textarea className="input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              The link is good for 14 days, single-use, and any older invite for this agent is automatically revoked.
            </div>
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          {lastResult ? (
            <>
              <button onClick={onClose} className="btn-ghost">Done</button>
              <a href={mailtoHref} className="btn-primary inline-flex items-center" style={{ textDecoration: "none" }}>
                <Mail size={13} /> Open in mail client
              </a>
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn-ghost">Cancel</button>
              <SmartButton variant="primary" disabled={!valid || submitting} loading={submitting}
                onClick={() => onCreate({ email: email.trim(), message: message.trim() || undefined })}
                icon={<Send size={13} />}
              >
                Generate invite link
              </SmartButton>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function EditAgentDialog({
  v, submitting, onClose, onSave,
}: {
  v: Agent;
  submitting: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Agent>) => void;
}) {
  const [form, setForm] = useState<Partial<Agent>>({
    name: v.name, organization: v.organization,
    contact_name: v.contact_name, contact_email: v.contact_email, contact_phone: v.contact_phone,
    region: v.region, country: v.country,
    sector_focus: [...v.sector_focus],
    status: v.status, risk_level: v.risk_level,
    pep_flag: v.pep_flag, conflict_flag: v.conflict_flag,
    notes: v.notes,
  });
  const set = <K extends keyof Agent>(k: K, val: Agent[K]) => setForm((f) => ({ ...f, [k]: val }));
  const SECTORS = ["finance","energy","public_sector","telecom","health","manufacturing","agriculture","logistics","education","tech","real_estate","extractives"];
  const toggleSector = (s: string) =>
    setForm((f) => ({
      ...f,
      sector_focus: (f.sector_focus ?? []).includes(s)
        ? (f.sector_focus ?? []).filter((x) => x !== s)
        : [...(f.sector_focus ?? []), s],
    }));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-bold text-text">Edit agent</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block"><div className="label">Name</div><input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="block"><div className="label">Organization</div><input className="input" value={form.organization ?? ""} onChange={(e) => set("organization", e.target.value)} /></label>
            <label className="block"><div className="label">Region</div><input className="input" value={form.region ?? ""} onChange={(e) => set("region", e.target.value)} /></label>
            <label className="block"><div className="label">Country</div><input className="input" value={form.country ?? ""} onChange={(e) => set("country", e.target.value)} /></label>
            <label className="block"><div className="label">Status</div>
              <select className="input" value={form.status ?? v.status} onChange={(e) => set("status", e.target.value as AgentStatus)}>
                <option value="draft">Onboarding</option>
                <option value="onboarded">Onboarded</option>
                <option value="engaged">Engaged</option>
                <option value="suspended">Suspended</option>
                <option value="terminated">Terminated</option>
              </select>
            </label>
            <label className="block"><div className="label">Risk level</div>
              <select className="input" value={form.risk_level ?? v.risk_level} onChange={(e) => set("risk_level", e.target.value as RiskLevel)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block"><div className="label">Contact name</div><input className="input" value={form.contact_name ?? ""} onChange={(e) => set("contact_name", e.target.value)} /></label>
            <label className="block"><div className="label">Contact email</div><input className="input" value={form.contact_email ?? ""} onChange={(e) => set("contact_email", e.target.value)} /></label>
            <label className="block md:col-span-2"><div className="label">Contact phone</div><input className="input" value={form.contact_phone ?? ""} onChange={(e) => set("contact_phone", e.target.value)} /></label>
          </div>
          <div className="flex items-center gap-4 pt-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.pep_flag ?? false} onChange={(e) => set("pep_flag", e.target.checked)} />
              <span>Politically exposed person (PEP)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.conflict_flag ?? false} onChange={(e) => set("conflict_flag", e.target.checked)} />
              <span>Conflict of interest</span>
            </label>
          </div>
          <div>
            <div className="label">Sector focus</div>
            <div className="flex flex-wrap gap-1.5">
              {SECTORS.map((s) => {
                const active = (form.sector_focus ?? []).includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleSector(s)}
                    className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                      active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                    }`}>{s.replace(/_/g, " ")}</button>
                );
              })}
            </div>
          </div>
          <label className="block"><div className="label">Notes</div><textarea className="input" rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} /></label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton variant="primary" loading={submitting} onClick={() => onSave(form)}>Save</SmartButton>
        </footer>
      </div>
    </div>
  );
}

// Re-exports to keep the unused-warnings quiet
export const _icons = { Globe };
