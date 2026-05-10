import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import { confirmAction } from "@/lib/confirm";
import { DangerZone } from "@/components/DangerZone";
import {
  Handshake, ShieldCheck, ShieldAlert, Clock, CheckCircle2, FileText, Plus,
  ArrowLeft, Globe, Mail, Phone, Trash2, Pencil, X, Link as LinkIcon, FileCheck2,
  Activity, AlertTriangle, ListTodo, Wallet, TrendingUp, Users as UsersIcon, History,
  GaugeCircle, FolderKanban, Send, Copy, RotateCcw,
} from "lucide-react";

type VendorStatus = "draft" | "onboarded" | "sla_signed" | "suspended";
type RiskLevel = "low" | "medium" | "high" | "critical";

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

type VendorDoc = {
  id: string;
  kind: string;
  name: string;
  object_key: string;
  uploaded_at: string;
};

type Vendor = {
  id: string;
  name: string;
  legal_name: string;
  kind: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  website: string;
  country: string;
  competencies: string[];
  status: VendorStatus;
  sla_signed_at: string | null;
  sla_expires_at: string | null;
  notes: string;
  documents: VendorDoc[];
  service_category: string;
  risk_level: RiskLevel;
  last_activity_at: string | null;
  mandatory_missing: string[];
  can_be_assigned: boolean;
  mandatory_kinds: string[];
  assigned_projects: { id: string; name: string }[];
  open_deliverables: { id: string; title: string }[];
  performance_score: number | null;
  outstanding_balance: number;
};

const STATUS_META: Record<VendorStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  draft:      { label: "Onboarding",   cls: "bg-warn/15 text-warn",       icon: <Clock size={12} /> },
  onboarded:  { label: "Onboarded",    cls: "bg-accent-soft text-accent", icon: <CheckCircle2 size={12} /> },
  sla_signed: { label: "SLA signed",   cls: "bg-success/15 text-success", icon: <ShieldCheck size={12} /> },
  suspended:  { label: "Suspended",    cls: "bg-danger/15 text-danger",   icon: <ShieldAlert size={12} /> },
};

const RISK_META: Record<RiskLevel, { label: string; cls: string }> = {
  low:      { label: "Low risk",      cls: "bg-success/15 text-success" },
  medium:   { label: "Medium risk",   cls: "bg-warn/15 text-warn" },
  high:     { label: "High risk",     cls: "bg-danger/15 text-danger" },
  critical: { label: "Critical risk", cls: "bg-danger text-white" },
};

// Full enterprise document set per the spec. `mandatory:true` blocks project assignment.
const DOC_KIND_META: Record<string, { label: string; mandatory?: boolean; description?: string }> = {
  profile:               { label: "Company profile",         mandatory: true, description: "Company overview, capability statement." },
  tax_cert:              { label: "Tax / TIN certificate",   mandatory: true, description: "Active tax compliance certificate." },
  service_agreement:     { label: "Master service agreement",mandatory: true, description: "Signed master services agreement." },
  sla:                   { label: "Signed SLA",              mandatory: true, description: "Service level agreement, signed by both parties." },
  nda:                   { label: "NDA",                                       description: "Non-disclosure agreement." },
  data_protection:       { label: "Data protection agreement",                 description: "NDPR / GDPR data-handling addendum." },
  security_clearance:    { label: "Security clearance",                        description: "Personnel clearance for restricted projects." },
  bank_details:          { label: "Bank details",                              description: "Verified payment account information." },
  insurance:             { label: "Insurance certificate",                     description: "Professional indemnity / liability cover." },
  company_registration:  { label: "Company registration",                      description: "CAC / equivalent incorporation certificate." },
  vendor_approval_form:  { label: "Vendor approval form",                      description: "Internal approval / due-diligence form." },
  portfolio:             { label: "Portfolio / past work",                     description: "Case studies or work samples." },
  reference:             { label: "Reference letter",                          description: "Prior client reference." },
};

type Tab = "overview" | "compliance" | "projects" | "deliverables" | "performance" | "risk" | "finance" | "portal" | "audit";

const TABS: { key: Tab; label: string; icon: React.ComponentType<any> }[] = [
  { key: "overview",     label: "Overview",     icon: Activity },
  { key: "compliance",   label: "Compliance",   icon: FileCheck2 },
  { key: "projects",     label: "Projects",     icon: FolderKanban },
  { key: "deliverables", label: "Deliverables", icon: ListTodo },
  { key: "performance",  label: "Performance",  icon: GaugeCircle },
  { key: "risk",         label: "Risk",         icon: AlertTriangle },
  { key: "finance",      label: "Finance",      icon: Wallet },
  { key: "portal",       label: "Portal access",icon: UsersIcon },
  { key: "audit",        label: "Audit trail",  icon: History },
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

export function VendorDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = (user?.roles ?? []).includes("super_admin");
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Vendor>({
    queryKey: ["vendor", id], queryFn: () => api(`/api/v1/vendors/${id}`),
  });

  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen,    setEditOpen]    = useState(false);
  const [docOpen,     setDocOpen]     = useState(false);
  const [slaOpen,     setSlaOpen]     = useState(false);
  const [inviteOpen,  setInviteOpen]  = useState(false);

  // List existing invites so the user can see status / copy the live link / revoke.
  const { data: invitesData } = useQuery<{ items: Invitation[] }>({
    queryKey: ["vendor-invites", id],
    queryFn: () => api(`/api/v1/vendors/${id}/invites`),
    enabled: !!id,
  });
  const invites = invitesData?.items ?? [];

  const createInvite = useMutation({
    mutationFn: (b: { email: string; message?: string }) =>
      api<{ token: string; expires_at: string }>(`/api/v1/vendors/${id}/invite`, {
        method: "POST", body: JSON.stringify(b),
      }),
    onSuccess: () => {
      toast.success("Invitation created", "Copy the link or open your email client to send it.");
      qc.invalidateQueries({ queryKey: ["vendor-invites", id] });
    },
    onError: (e: Error) => toast.error("Could not create invite", e.message),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      api(`/api/v1/vendor-invitations/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Invitation revoked");
      qc.invalidateQueries({ queryKey: ["vendor-invites", id] });
    },
  });

  const update = useMutation({
    mutationFn: (patch: Partial<Vendor>) =>
      api(`/api/v1/vendors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Vendor updated");
      qc.invalidateQueries({ queryKey: ["vendor", id] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      setEditOpen(false);
    },
    onError: (e: Error) => toast.error("Update failed", e.message),
  });

  const addDoc = useMutation({
    mutationFn: (b: { kind: string; name: string; object_key: string }) =>
      api(`/api/v1/vendors/${id}/documents`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      toast.success("Document attached");
      qc.invalidateQueries({ queryKey: ["vendor", id] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      setDocOpen(false);
    },
    onError: (e: Error) => toast.error("Could not attach", e.message),
  });

  const removeDoc = useMutation({
    mutationFn: (docId: string) =>
      api(`/api/v1/vendors/${id}/documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor", id] }),
  });

  const signSLA = useMutation({
    mutationFn: (b: { effective_date?: string; expires_date?: string; document_url?: string; document_name?: string }) =>
      api(`/api/v1/vendors/${id}/sla/sign`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      toast.success("SLA signed", "Vendor is now ready to be staffed onto projects.");
      qc.invalidateQueries({ queryKey: ["vendor", id] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      setSlaOpen(false);
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? (e.body as any)?.error ?? e.message : (e as Error)?.message;
      toast.error("Could not sign SLA", msg);
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/vendors/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast.success("Vendor deleted");
      navigate("/vendors");
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not delete vendor", msg);
    },
  });

  if (isLoading || !data) return <div className="text-muted">Loading vendor…</div>;

  return (
    <div className="space-y-5 max-w-7xl">
      <Link to="/vendors" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft size={14} /> Back to vendors
      </Link>

      <VendorHeader
        v={data}
        onEdit={() => setEditOpen(true)}
        onSignSla={() => setSlaOpen(true)}
        onInvite={() => setInviteOpen(true)}
      />

      {/* Tab strip */}
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

      {tab === "overview"     && <OverviewTab v={data} invites={invites} onAttachDoc={() => setDocOpen(true)} onRemoveDoc={(d) => removeDoc.mutate(d)} onInvite={() => setInviteOpen(true)} onRevokeInvite={(i) => revokeInvite.mutate(i)} />}
      {tab === "compliance"   && <ComplianceTab v={data} onAttachDoc={() => setDocOpen(true)} onRemoveDoc={(d) => removeDoc.mutate(d)} />}
      {tab === "projects"     && <NextUpStub icon={<FolderKanban size={20} />} title="Assigned project scope" body="Per-project scope, deliverables, owner and dependency view. Lands when the vendor-to-project assignment table goes live." />}
      {tab === "deliverables" && <NextUpStub icon={<ListTodo size={20} />} title="Outsourced deliverables tracker" body="State machine: not started → in progress → submitted → under review → changes requested / approved / rejected. With evidence attachments, comment threads, and a bulk review board." />}
      {tab === "performance"  && <NextUpStub icon={<GaugeCircle size={20} />} title="Performance dashboard" body="On-time delivery rate, quality score, SLA compliance, rework, escalations, average response time. Aggregated from the deliverables and risk tables once they're populated." />}
      {tab === "risk"         && <NextUpStub icon={<AlertTriangle size={20} />} title="Risk register" body="Track delivery / compliance / security / financial / dependency risks per vendor with severity, mitigation, escalation owner and resolution status. Pre-flagged: this vendor is currently graded " extra={<span className={`pill ${RISK_META[data.risk_level].cls}`}>{RISK_META[data.risk_level].label}</span>} />}
      {tab === "finance"      && <NextUpStub icon={<Wallet size={20} />} title="Finance & milestone payments" body="Contract value, milestone schedule, invoices submitted vs approved vs paid, outstanding balance, blocked payments. Payment approval will be hard-gated to deliverable acceptance." />}
      {tab === "portal"       && <NextUpStub icon={<UsersIcon size={20} />} title="Vendor portal access" body="Restricted accounts so vendors can submit deliverables, respond to comments, raise blockers and submit invoices — scoped to only what they're assigned to." />}
      {tab === "audit"        && <NextUpStub icon={<History size={20} />} title="Vendor activity & audit trail" body="Timeline of onboarding actions, document uploads, project assignments, deliverable submissions, reviews, approvals, invoices, payments and escalations." />}

      {isSuperAdmin && (
        <DangerZone
          entityLabel="vendor"
          name={data.name}
          deleting={remove.isPending}
          onDelete={async () => {
            const ok = await confirmAction({
              title: "Delete vendor?",
              body: `Permanently remove "${data.name}". This cannot be undone — their documents, SLA records, invitations and project links will be detached. Audit history is retained.`,
              confirmLabel: "Delete vendor",
              danger: true,
            });
            if (ok) remove.mutate();
          }}
        />
      )}

      {editOpen && (
        <EditVendorDialog
          v={data}
          submitting={update.isPending}
          onClose={() => setEditOpen(false)}
          onSave={(patch) => update.mutate(patch)}
        />
      )}
      {docOpen && (
        <AddDocDialog
          submitting={addDoc.isPending}
          onClose={() => setDocOpen(false)}
          onAdd={(b) => addDoc.mutate(b)}
        />
      )}
      {slaOpen && (
        <SignSLADialog
          submitting={signSLA.isPending}
          onClose={() => setSlaOpen(false)}
          onSign={(b) => signSLA.mutate(b)}
        />
      )}
      {inviteOpen && (
        <InviteVendorDialog
          vendorName={data.name}
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

/* ---------- Header with KPI strip + actions ---------- */

function VendorHeader({
  v, onEdit, onSignSla, onInvite,
}: { v: Vendor; onEdit: () => void; onSignSla: () => void; onInvite: () => void }) {
  const sm = STATUS_META[v.status];
  const rm = RISK_META[v.risk_level];
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
            <Handshake size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-extrabold text-text truncate">{v.name}</h1>
              <span className={`pill ${sm.cls}`}>{sm.icon}{sm.label}</span>
              <span className={`pill ${rm.cls}`}>{rm.label}</span>
              {!v.can_be_assigned && (
                <span className="pill bg-warn/15 text-warn">
                  <AlertTriangle size={11} /> Blocked from assignment · {v.mandatory_missing.length} doc{v.mandatory_missing.length === 1 ? "" : "s"} missing
                </span>
              )}
            </div>
            <div className="text-sm text-muted mt-1">
              {v.legal_name && <>{v.legal_name} · </>}
              {v.kind}{v.country && <> · {v.country}</>}
              {v.service_category && <> · {v.service_category.replace(/_/g, " ")}</>}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted mt-2">
              {v.contact_email && <a href={`mailto:${v.contact_email}`} className="inline-flex items-center gap-1 hover:text-accent"><Mail size={12} /> {v.contact_email}</a>}
              {v.contact_phone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {v.contact_phone}</span>}
              {v.website && <a href={v.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-accent"><Globe size={12} /> {v.website}</a>}
              <span className="inline-flex items-center gap-1"><Clock size={12} /> Last activity {fmtRel(v.last_activity_at ?? null)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button onClick={onInvite} className="btn-outline" style={{ padding: "0.4rem 0.9rem", fontSize: "12.5px" }}>
            <Send size={12} /> Send invite link
          </button>
          <button onClick={onEdit} className="btn-outline" style={{ padding: "0.4rem 0.9rem", fontSize: "12.5px" }}>
            <Pencil size={12} /> Edit
          </button>
          {v.status !== "sla_signed" && (
            <SmartButton variant="primary" size="sm" onClick={onSignSla} icon={<ShieldCheck size={13} />}>
              Sign SLA
            </SmartButton>
          )}
        </div>
      </div>

      {/* KPI strip — section 1 of the spec */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <Kpi label="Assigned projects"  value={v.assigned_projects.length} />
        <Kpi label="Open deliverables"  value={v.open_deliverables.length} />
        <Kpi label="Performance"        value={v.performance_score != null ? `${Math.round(v.performance_score)}%` : "—"}
             sub={v.performance_score != null ? "rolling 90d" : "no data yet"} />
        <Kpi label="Outstanding"        value={v.outstanding_balance > 0 ? v.outstanding_balance.toLocaleString() : "—"}
             sub={v.outstanding_balance > 0 ? "across invoices" : "nothing due"} />
        <Kpi label="Compliance"         value={`${v.mandatory_kinds.length - v.mandatory_missing.length}/${v.mandatory_kinds.length}`}
             sub={v.mandatory_missing.length === 0 ? "complete" : "missing docs"} tone={v.mandatory_missing.length === 0 ? "good" : "warn"} />
        <Kpi label="SLA"
             value={v.status === "sla_signed" ? "Signed" : "Pending"}
             sub={v.status === "sla_signed" && v.sla_expires_at ? `expires ${new Date(v.sla_expires_at).toLocaleDateString()}` : ""}
             tone={v.status === "sla_signed" ? "good" : "warn"} />
      </div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" | "neutral" }) {
  const cls = { good: "text-success", warn: "text-warn", neutral: "text-text" }[tone ?? "neutral"];
  return (
    <div className="bg-bg/40 border border-border rounded-xl p-3">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-lg font-extrabold mt-0.5 ${cls}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ---------- Overview tab ---------- */

function OverviewTab({
  v, invites, onAttachDoc, onRemoveDoc, onInvite, onRevokeInvite,
}: {
  v: Vendor;
  invites: Invitation[];
  onAttachDoc: () => void;
  onRemoveDoc: (id: string) => void;
  onInvite: () => void;
  onRevokeInvite: (id: string) => void;
}) {
  const pendingInvite = invites.find((i) => i.status === "pending");
  // Onboarding checklist mirrors the mandatory doc set + competencies + SLA.
  const have = new Set(v.documents.map((d) => d.kind));
  const checklist = [
    ...v.mandatory_kinds.map((k) => ({
      label: DOC_KIND_META[k]?.label ?? k,
      done: have.has(k),
    })),
    { label: "Competencies tagged", done: v.competencies.length > 0 },
    { label: "SLA signed",          done: v.status === "sla_signed" },
  ];
  const completed = checklist.filter((s) => s.done).length;
  const pct = Math.round((completed / checklist.length) * 100);

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
        {v.competencies.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2">Competencies</div>
            <div className="flex flex-wrap gap-1.5">
              {v.competencies.map((c) => (
                <span key={c} className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-accent-soft text-accent">{c}</span>
              ))}
            </div>
          </div>
        )}
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

function inviteUrl(token: string): string {
  return `${window.location.origin}/vendor-invite/${token}`;
}
async function copyInviteLink(token: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl(token));
    toast.success("Link copied", "Paste it into an email or chat to send to the vendor.");
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
        <div className="w-10 h-10 rounded-full bg-accent text-white grid place-items-center shrink-0">
          <Send size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-text">Self-onboarding invite is live</div>
          <p className="text-xs text-muted mt-0.5">
            Sent to <span className="font-semibold">{invite.email}</span> · expires in {daysLeft} day{daysLeft === 1 ? "" : "s"}.
            They can fill in their details and attach documents without an account.
          </p>
          <div className="mt-3 flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2">
            <LinkIcon size={13} className="text-muted shrink-0" />
            <input readOnly value={url} className="flex-1 bg-transparent text-[12.5px] text-text font-mono truncate focus:outline-none" />
            <button onClick={onCopy} className="text-xs font-semibold text-accent hover:underline whitespace-nowrap inline-flex items-center gap-1">
              <Copy size={12} /> Copy
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 flex-wrap text-[11.5px]">
            <a
              href={`mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent("Complete your vendor onboarding")}&body=${encodeURIComponent(`Please complete your vendor onboarding here:\n\n${url}\n\nThis link expires in ${daysLeft} days.`)}`}
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

/* ---------- Compliance tab — full doc checklist ---------- */

function ComplianceTab({
  v, onAttachDoc, onRemoveDoc,
}: { v: Vendor; onAttachDoc: () => void; onRemoveDoc: (id: string) => void }) {
  const docsByKind = new Map<string, VendorDoc[]>();
  v.documents.forEach((d) => {
    const arr = docsByKind.get(d.kind) ?? [];
    arr.push(d); docsByKind.set(d.kind, arr);
  });

  const allKinds = Object.entries(DOC_KIND_META);
  const mandatoryDone = allKinds.filter(([, m]) => m.mandatory).filter(([k]) => docsByKind.has(k)).length;
  const mandatoryTotal = allKinds.filter(([, m]) => m.mandatory).length;

  return (
    <div className="space-y-4">
      {/* Compliance summary banner */}
      <div className={`rounded-2xl p-4 border flex items-start gap-3 ${
        v.can_be_assigned ? "border-success/30 bg-success/10" : "border-warn/30 bg-warn/10"
      }`}>
        <div className={`w-10 h-10 rounded-full grid place-items-center shrink-0 ${
          v.can_be_assigned ? "bg-success/20 text-success" : "bg-warn/20 text-warn"
        }`}>
          {v.can_be_assigned ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-text">
            {v.can_be_assigned
              ? "Compliance clear — vendor can be assigned to projects"
              : `Blocked from assignment — ${v.mandatory_missing.length} mandatory document${v.mandatory_missing.length === 1 ? "" : "s"} missing`}
          </div>
          <p className="text-xs text-muted mt-0.5">
            Mandatory: {mandatoryDone} / {mandatoryTotal} on file. Mandatory documents must be attached before any project assignment is allowed.
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

/* ---------- Documents card (used by Overview tab) ---------- */

function DocumentsCard({
  v, onAttach, onRemove,
}: { v: Vendor; onAttach: () => void; onRemove: (id: string) => void }) {
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="h2 flex items-center gap-2"><FileText size={16} className="text-accent" /> Documents</h2>
        <SmartButton variant="outline" size="sm" onClick={onAttach} icon={<Plus size={12} />}>Attach</SmartButton>
      </div>
      {v.documents.length === 0 ? (
        <div className="text-sm text-muted text-center py-8 border border-dashed border-border rounded-xl">
          No documents yet — start with the company profile and tax certificate to unblock project assignment.
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

/* ---------- Honest stub for not-yet-built tabs ---------- */

function NextUpStub({
  icon, title, body, extra,
}: { icon: React.ReactNode; title: string; body: string; extra?: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
        {icon}
      </div>
      <div className="text-base font-bold text-text">{title}</div>
      <p className="text-sm text-muted mt-1 max-w-2xl mx-auto">
        <span className="inline-flex items-center gap-1.5 align-middle text-[11px] uppercase tracking-wider font-bold text-accent mr-2">
          <TrendingUp size={12} /> Next up
        </span>
        {body}
        {extra && <> {extra}.</>}
      </p>
    </div>
  );
}

/* ---------- Dialogs ---------- */

function InviteVendorDialog({
  vendorName, defaultEmail, submitting, lastResult, onClose, onCreate,
}: {
  vendorName: string;
  defaultEmail: string;
  submitting: boolean;
  lastResult: { token: string; expires_at: string } | null;
  onClose: () => void;
  onCreate: (b: { email: string; message?: string }) => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [message, setMessage] = useState(
    `Hi — please complete your onboarding for ${vendorName} via this secure link. ` +
    `It takes a few minutes: contact info, competencies, and a few standard documents (company profile, tax cert, MSA, SLA).`
  );
  const valid = /\S+@\S+\.\S+/.test(email);
  const url = lastResult ? `${window.location.origin}/vendor-invite/${lastResult.token}` : "";

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Copy failed", "Select the link and copy it manually.");
    }
  };

  const mailtoHref = lastResult
    ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Complete your vendor onboarding")}&body=${encodeURIComponent(`${message}\n\n${url}\n\nThis link expires on ${new Date(lastResult.expires_at).toLocaleDateString()}.`)}`
    : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center"><Send size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">{lastResult ? "Invitation ready to send" : "Invite vendor to self-onboard"}</h2>
              <p className="text-xs text-muted mt-0.5">
                {lastResult
                  ? "Copy the link or open your email client to send it. The vendor doesn't need an account."
                  : "We'll mint a secure link for the vendor. They can fill their details, attach documents, and complete onboarding without signing in."}
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
                <button onClick={handleCopy} className="text-xs font-semibold text-accent hover:underline whitespace-nowrap inline-flex items-center gap-1">
                  <Copy size={12} /> Copy
                </button>
              </div>
              <p className="text-[11px] text-muted mt-1">
                Expires {new Date(lastResult.expires_at).toLocaleDateString()} · single-use · revocable any time.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              <div className="font-semibold text-text mb-1">Heads up — email isn't auto-sent yet.</div>
              We mint the secure token; you copy the link or use the mail-client button below to dispatch it. Direct SMTP delivery from the app will land in a follow-up.
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="block">
              <div className="label">Vendor email *</div>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="hello@vendor.com"
                autoFocus
              />
            </label>
            <label className="block">
              <div className="label">Message (optional)</div>
              <textarea
                className="input"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="text-[11px] text-muted mt-1">Pre-filled with a friendly default. Edit it however you like.</div>
            </label>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              The link is good for 5 days, single-use, and any older invite for this vendor is automatically revoked.
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
              <SmartButton
                variant="primary"
                disabled={!valid || submitting}
                loading={submitting}
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

function AddDocDialog({
  submitting, onClose, onAdd,
}: {
  submitting: boolean;
  onClose: () => void;
  onAdd: (b: { kind: string; name: string; object_key: string }) => void;
}) {
  const [kind, setKind] = useState("profile");
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");
  const valid = name.trim() && url.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-bold text-text">Attach a vendor document</h2>
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
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CAC certificate 2026" />
          </label>
          <label className="block">
            <div className="label">URL or storage key</div>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// or s3://bucket/key" />
            <div className="text-[11px] text-muted mt-1">Paste a link from Drive / S3 / Dropbox etc.</div>
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!valid || submitting}
            loading={submitting}
            onClick={() => onAdd({ kind, name: name.trim(), object_key: url.trim() })}
          >
            Attach
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function SignSLADialog({
  submitting, onClose, onSign,
}: {
  submitting: boolean;
  onClose: () => void;
  onSign: (b: { effective_date?: string; expires_date?: string; document_url?: string; document_name?: string }) => void;
}) {
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [expires, setExpires]     = useState("");
  const [docUrl, setDocUrl]       = useState("");
  const [docName, setDocName]     = useState("Signed SLA");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center gap-3 p-5 border-b border-border">
          <div className="w-9 h-9 rounded-full bg-success/15 text-success grid place-items-center"><ShieldCheck size={16} /></div>
          <div>
            <h2 className="text-base font-bold text-text">Mark SLA as signed</h2>
            <p className="text-xs text-muted mt-0.5">Optional: paste a link to the signed PDF — it'll be saved as a vendor document.</p>
          </div>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Effective date</div>
              <input className="input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Expires (optional)</div>
              <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <div className="label">Signed SLA URL (optional)</div>
            <input className="input" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} placeholder="https://" />
          </label>
          {docUrl && (
            <label className="block">
              <div className="label">Document name</div>
              <input className="input" value={docName} onChange={(e) => setDocName(e.target.value)} />
            </label>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="primary"
            loading={submitting}
            onClick={() => onSign({
              effective_date: effective || undefined,
              expires_date:   expires   || undefined,
              document_url:   docUrl    || undefined,
              document_name:  docUrl    ? docName : undefined,
            })}
            icon={<ShieldCheck size={13} />}
          >
            Sign SLA
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function EditVendorDialog({
  v, submitting, onClose, onSave,
}: {
  v: Vendor;
  submitting: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Vendor>) => void;
}) {
  const [form, setForm] = useState<Partial<Vendor>>({
    name: v.name, legal_name: v.legal_name, kind: v.kind,
    contact_name: v.contact_name, contact_email: v.contact_email, contact_phone: v.contact_phone,
    website: v.website, country: v.country, notes: v.notes,
    competencies: [...v.competencies], status: v.status,
    service_category: v.service_category, risk_level: v.risk_level,
  });
  const set = <K extends keyof Vendor>(k: K, val: Vendor[K]) => setForm((f) => ({ ...f, [k]: val }));
  const COMP = ["engineering","design","compliance","security","data","infrastructure","legal","finance","training","research","translation","logistics"];
  const CATS = ["engineering", "design", "compliance_advisory", "training", "research", "logistics", "infrastructure", "legal", "finance", "translation"];
  const toggleComp = (c: string) =>
    setForm((f) => ({
      ...f,
      competencies: (f.competencies ?? []).includes(c)
        ? (f.competencies ?? []).filter((x) => x !== c)
        : [...(f.competencies ?? []), c],
    }));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-bold text-text">Edit vendor</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block"><div className="label">Name</div><input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="block"><div className="label">Legal name</div><input className="input" value={form.legal_name ?? ""} onChange={(e) => set("legal_name", e.target.value)} /></label>
            <label className="block"><div className="label">Country</div><input className="input" value={form.country ?? ""} onChange={(e) => set("country", e.target.value)} /></label>
            <label className="block"><div className="label">Service category</div>
              <select className="input" value={form.service_category ?? ""} onChange={(e) => set("service_category", e.target.value)}>
                <option value="">— none —</option>
                {CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label className="block"><div className="label">Status</div>
              <select className="input" value={form.status ?? v.status} onChange={(e) => set("status", e.target.value as VendorStatus)}>
                <option value="draft">Onboarding</option>
                <option value="onboarded">Onboarded</option>
                <option value="sla_signed">SLA signed</option>
                <option value="suspended">Suspended</option>
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
            <label className="block md:col-span-2"><div className="label">Website</div><input className="input" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} /></label>
            <label className="block"><div className="label">Contact name</div><input className="input" value={form.contact_name ?? ""} onChange={(e) => set("contact_name", e.target.value)} /></label>
            <label className="block"><div className="label">Contact email</div><input className="input" value={form.contact_email ?? ""} onChange={(e) => set("contact_email", e.target.value)} /></label>
            <label className="block md:col-span-2"><div className="label">Contact phone</div><input className="input" value={form.contact_phone ?? ""} onChange={(e) => set("contact_phone", e.target.value)} /></label>
          </div>
          <div>
            <div className="label">Competencies</div>
            <div className="flex flex-wrap gap-1.5">
              {COMP.map((c) => {
                const active = (form.competencies ?? []).includes(c);
                return (
                  <button key={c} type="button" onClick={() => toggleComp(c)}
                    className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                      active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                    }`}>{c}</button>
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
