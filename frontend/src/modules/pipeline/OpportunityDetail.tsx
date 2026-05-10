import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import {
  AlertTriangle, Check, FileText, Upload, X, Shield, ArrowRight, Link as LinkIcon,
  ThumbsUp, RotateCcw, GitBranch, Eye, Download, ExternalLink, Clock, Pencil, Save, Trash2,
} from "lucide-react";

type NextStage = { from: string; to: string; label?: string; roles?: string[] };

const STAGE_ORDER = [
  "new_request", "under_review", "approved", "contracting", "planning",
  "in_progress", "qa_review", "client_acceptance", "invoiced", "paid", "closed",
];
function isBackward(from: string, to: string): boolean {
  const i = STAGE_ORDER.indexOf(from);
  const j = STAGE_ORDER.indexOf(to);
  return i >= 0 && j >= 0 && j < i;
}

type DocKind = string;

type Document = {
  id: string;
  kind: DocKind;
  name: string;
  object_key: string;
  uploaded_at: string;
};

type Opportunity = {
  id: string;
  title: string;
  stage: string;
  lead_type: string;
  estimated_value: number;
  budget: number;
  priority: number;
  risk_level: string;
  technical_scope?: string;
  proposal_summary?: string;
  documents: Document[];
  required_documents: DocKind[];
  next_stages: NextStage[];
  metadata?: { stage_history?: StageHistoryEntry[] };
  project_id?: string | null;
  currency?: string;
};

type Stakeholder = {
  id: string;
  name: string;
  role: string;
  kind: "internal" | "external";
  email?: string;
  phone?: string;
  notes?: string;
};

type StageHistoryEntry = {
  at: string;
  by: string;
  from: string;
  to: string;
  reason?: string;
};

type Violation = { code: string; message: string; field?: string };

const DOC_LABELS: Record<string, { label: string; help: string }> = {
  NDA:                  { label: "Non-disclosure agreement",   help: "Signed NDA covering this engagement." },
  TechnicalProposal:    { label: "Technical proposal",         help: "Solution approach, architecture, deliverables." },
  ScopeDocument:        { label: "Scope document",             help: "Statement of work and deliverables boundary." },
  RFP:                  { label: "RFP / tender pack",          help: "The original request for proposals." },
  ComplianceForm:       { label: "Compliance form",            help: "Vendor compliance & due-diligence form." },
  ProcurementApproval:  { label: "Procurement approval",       help: "Approval letter from procurement authority." },
  MSA:                  { label: "Master service agreement",   help: "Umbrella commercial agreement." },
  Contract:             { label: "Contract",                   help: "Signed engagement contract." },
  ExportComplianceForm: { label: "Export compliance form",     help: "Cross-border / export controls clearance." },
  FXApproval:           { label: "FX approval",                help: "FX / repatriation approval." },
  GrantAgreement:       { label: "Grant agreement",            help: "Signed grant agreement with the donor." },
};

function fmtCurrency(n: number, ccy: string = "NGN"): string {
  if (!n && n !== 0) return "—";
  const sym = ({ USD: "$", EUR: "€", GBP: "£", NGN: "₦", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA" } as Record<string, string>)[ccy] ?? ccy;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
}

function prettyStage(s: string) {
  return s.replace(/_/g, " ");
}

export function OpportunityDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Opportunity>({
    queryKey: ["opp", id], queryFn: () => api(`/api/v1/opportunities/${id}`),
  });

  const [uploadKind, setUploadKind] = useState<DocKind | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [violations, setViolations] = useState<Violation[] | null>(null);
  const [addStakeholderOpen, setAddStakeholderOpen] = useState(false);

  const { data: stakeholdersData } = useQuery<{ items: Stakeholder[] }>({
    queryKey: ["opp-stakeholders", id],
    queryFn: () => api(`/api/v1/opportunities/${id}/stakeholders`),
    enabled: !!id,
  });

  const addStakeholder = useMutation({
    mutationFn: (sh: Omit<Stakeholder, "id">) =>
      api(`/api/v1/opportunities/${id}/stakeholders`, {
        method: "POST",
        body: JSON.stringify(sh),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opp-stakeholders", id] }),
  });
  const removeStakeholder = useMutation({
    mutationFn: (shId: string) =>
      api(`/api/v1/stakeholders/${shId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opp-stakeholders", id] }),
  });

  const submit = useMutation({
    mutationFn: () => api(`/api/v1/opportunities/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      setViolations(null);
      qc.invalidateQueries({ queryKey: ["opp", id] });
      qc.invalidateQueries({ queryKey: ["opps"] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && (err.body as any)?.violations) {
        setViolations((err.body as any).violations as Violation[]);
      } else {
        setViolations([{ code: "error", message: (err as Error)?.message ?? "Submission failed" }]);
      }
    },
  });

  const transition = useMutation({
    mutationFn: ({ to, reason }: { to: string; reason?: string }) =>
      api(`/api/v1/opportunities/${id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to, reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opp", id] });
      qc.invalidateQueries({ queryKey: ["opps"] });
    },
  });

  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const nav = useNavigate();

  // Hard rule from the backend: closed opps and opps that already spawned a
  // project are protected. We mirror the gate in the UI so the trash icon
  // doesn't even appear when deletion would 409.
  const canDelete = !!data && data.stage !== "closed" && !data.project_id;
  const blockedReason = !data ? ""
    : data.stage === "closed"
      ? "Closed opportunities are kept as completion history and can't be deleted."
      : data.project_id
        ? "A project has already been spawned from this opportunity. Archive the project first."
        : "";

  const deleteOpp = useMutation({
    mutationFn: () => api(`/api/v1/opportunities/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Opportunity deleted", "It has been removed from the pipeline.");
      qc.invalidateQueries({ queryKey: ["opps"] });
      nav("/pipeline");
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError
        ? ((err.body as { error?: string })?.error ?? err.message)
        : (err as Error)?.message ?? "Delete failed";
      toast.error("Could not delete", msg);
    },
  });

  const updateOpp = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api(`/api/v1/opportunities/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opp", id] });
      qc.invalidateQueries({ queryKey: ["opps"] });
      setEditOpen(false);
    },
  });

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  const have = new Set(data.documents.map((d) => d.kind));
  const missing = data.required_documents.filter((k) => !have.has(k));
  const ready = missing.length === 0 && data.stage === "new_request";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6 max-w-7xl">
      <div className="space-y-6 min-w-0">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <TruncatedTitle title={data.title} />
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Pill>{data.lead_type}</Pill>
            <Pill tone="info">{prettyStage(data.stage)}</Pill>
            <Pill tone={data.risk_level === "high" ? "bad" : data.risk_level === "medium" ? "warn" : "good"}>
              {data.risk_level} risk
            </Pill>
            <span className="text-xs text-muted">P{data.priority}</span>
            <button
              onClick={() => setEditOpen(true)}
              className="ml-1 inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:bg-accent-soft px-2 py-1 rounded-full"
              title="Edit basics"
            >
              <Pencil size={12} /> Edit details
            </button>
            {canDelete ? (
              <button
                onClick={() => setDeleteOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-danger hover:bg-danger/10 px-2 py-1 rounded-full"
                title="Delete this opportunity"
              >
                <Trash2 size={12} /> Delete
              </button>
            ) : blockedReason ? (
              <span
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted/60 px-2 py-1 rounded-full cursor-help"
                title={blockedReason}
              >
                <Trash2 size={12} /> Delete locked
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {data.stage === "new_request" && (
            <SmartButton
              variant="primary"
              disabled={!ready}
              loadingLabel="Submitting…"
              successLabel="Submitted"
              iconRight={<ArrowRight size={14} />}
              onClick={() => submit.mutateAsync()}
            >
              Submit for review
            </SmartButton>
          )}
          {data.stage === "new_request" && !ready && (
            <div className="text-xs text-muted">
              {missing.length} {missing.length === 1 ? "document" : "documents"} still required
            </div>
          )}
        </div>
      </header>

      {(data.next_stages ?? []).length > 0 && (() => {
        const forward = (data.next_stages ?? []).filter((a) => !isBackward(a.from, a.to));
        const backward = (data.next_stages ?? []).filter((a) => isBackward(a.from, a.to));
        return (
        <div className="card p-4 flex items-center gap-4 border-accent/30 bg-accent-soft/40">
          <div className="w-9 h-9 rounded-full bg-surface border border-border grid place-items-center shrink-0">
            <GitBranch size={16} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text">
              {data.stage === "under_review" ? "This is awaiting your review"
                : `Currently in ${prettyStage(data.stage)}`}
            </div>
            <div className="text-xs text-muted">
              {data.stage === "under_review"
                ? "Approve to move it forward, or send it back to the requester."
                : "Move it to the next stage when you're ready, or reject it back."}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {backward.length > 0 && (
              <button
                disabled={transition.isPending}
                onClick={() => setRejectOpen(true)}
                className="btn-outline !border-danger/40 !text-danger hover:!bg-danger/10"
                title="Send this back with a reason"
              >
                <RotateCcw size={14} /> Reject / send back
              </button>
            )}
            {forward.map((a, i) => {
              const isApprove = a.to === "approved";
              const tone: "primary" | "outline" = isApprove ? "primary" : (i === 0 ? "primary" : "outline");
              return (
                <SmartButton
                  key={`${a.from}-${a.to}`}
                  variant={tone}
                  icon={isApprove ? <ThumbsUp size={14} /> : undefined}
                  successLabel="Done"
                  onClick={() => transition.mutateAsync({ to: a.to })}
                  title={a.roles && a.roles.length ? `Allowed roles: ${a.roles.join(", ")}` : "Open to any reviewer"}
                >
                  {a.label || `Move to ${prettyStage(a.to)}`}
                </SmartButton>
              );
            })}
          </div>
        </div>
        );
      })()}
      {transition.error && (
        <div className="text-sm text-danger">
          Couldn't transition: {(transition.error as Error).message}
        </div>
      )}

      {/* Smart insights / next steps */}
      <SmartInsights data={data} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthStat data={data} />
        <Stat label="Estimated value" value={fmtCurrency(data.estimated_value)} />
        <Stat label="Internal budget" value={fmtCurrency(data.budget)} />
        <MarginStat data={data} />
      </div>

      <StageVelocity data={data} />

      <Card
        title={
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-muted" /> Required documents
          </div>
        }
        action={
          <span className="text-sm text-muted">
            {data.documents.length} of {data.required_documents.length} attached
          </span>
        }
      >
        <p className="text-sm text-muted mb-4">
          Governance requires these documents for a <strong>{data.lead_type}</strong> client before this can move
          to review. Attach each one to unblock submission.
        </p>
        <ul className="divide-y divide-border">
          {data.required_documents.map((kind) => {
            const attached = data.documents.find((d) => d.kind === kind);
            const meta = DOC_LABELS[kind] ?? { label: kind, help: "" };
            return (
              <li key={kind} className="flex items-center gap-3 py-3">
                <span className={`w-8 h-8 rounded-full grid place-items-center shrink-0 ${
                  attached ? "bg-success/15 text-success" : "bg-warn/15 text-warn"
                }`}>
                  {attached ? <Check size={16} /> : <FileText size={16} />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text">{meta.label}</div>
                  <div className="text-xs text-muted truncate">
                    {attached ? `Attached: ${attached.name}` : meta.help}
                  </div>
                </div>
                {attached ? (
                  <button
                    className="btn-outline"
                    onClick={() => setPreviewDoc(attached)}
                    title="Preview this document"
                  >
                    <Eye size={14} /> Preview
                  </button>
                ) : (
                  <button className="btn-outline" onClick={() => setUploadKind(kind)}>
                    <Upload size={14} /> Attach
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Project conversion banner — appears once an opportunity hits planning. */}
      {data.project_id && (
        <div className="card p-4 flex items-center gap-4 border-success/40 bg-success/10">
          <div className="w-9 h-9 rounded-full bg-surface border border-border grid place-items-center shrink-0">
            <Check size={16} className="text-success" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text">Converted to a delivery project</div>
            <div className="text-xs text-muted">
              At <em>planning</em>, this opportunity became an active project — delivery team, sprints, and
              capacity are tracked there.
            </div>
          </div>
          <a
            href={`/projects/${data.project_id}`}
            className="btn-primary"
          >
            Open project <ArrowRight size={14} />
          </a>
        </div>
      )}

      {/* Stakeholders */}
      <Card
        title="Stakeholders"
        action={
          <button className="btn-outline" onClick={() => setAddStakeholderOpen(true)}>
            <Upload size={14} className="rotate-180" /> Add
          </button>
        }
      >
        {(stakeholdersData?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted">
            No stakeholders captured yet. Add internal owners, sponsors, vendor contacts — they'll be carried
            into the delivery project automatically when this hits planning.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(stakeholdersData?.items ?? []).map((sh) => (
              <li key={sh.id} className="flex items-center gap-3 py-3">
                <div className={`w-9 h-9 rounded-full grid place-items-center text-xs font-bold shrink-0 ${
                  sh.kind === "external" ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"
                }`}>
                  {(sh.name || "?")[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text truncate">{sh.name}</span>
                    {sh.kind === "external" && <span className="pill bg-warn/15 text-warn">external</span>}
                  </div>
                  <div className="text-xs text-muted truncate">
                    {sh.role}{sh.email ? ` · ${sh.email}` : ""}{sh.phone ? ` · ${sh.phone}` : ""}
                  </div>
                  {sh.notes && <div className="text-xs text-muted/80 mt-0.5 italic">"{sh.notes}"</div>}
                </div>
                <button
                  className="text-muted hover:text-danger p-1"
                  onClick={() => removeStakeholder.mutate(sh.id)}
                  aria-label="Remove stakeholder"
                  title="Remove"
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(data.proposal_summary || data.technical_scope) && (
        <Card title="Brief">
          {data.proposal_summary && (
            <p className="text-sm text-text leading-relaxed">{data.proposal_summary}</p>
          )}
          {data.technical_scope && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="label">Technical scope</div>
              <p className="text-sm whitespace-pre-wrap text-text leading-relaxed">{data.technical_scope}</p>
            </div>
          )}
        </Card>
      )}

      {violations && (
        <ViolationDialog
          violations={violations}
          docLabels={DOC_LABELS}
          onClose={() => setViolations(null)}
          onAttach={(kind) => { setViolations(null); setUploadKind(kind); }}
        />
      )}

      {uploadKind && (
        <UploadDocumentDialog
          oppId={id!}
          kind={uploadKind}
          label={(DOC_LABELS[uploadKind]?.label) ?? uploadKind}
          onClose={() => setUploadKind(null)}
          onUploaded={() => {
            setUploadKind(null);
            qc.invalidateQueries({ queryKey: ["opp", id] });
      qc.invalidateQueries({ queryKey: ["opps"] });
          }}
        />
      )}

      {previewDoc && (
        <PreviewDocumentDialog
          doc={previewDoc}
          label={(DOC_LABELS[previewDoc.kind]?.label) ?? previewDoc.kind}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {addStakeholderOpen && (
        <AddStakeholderDialog
          submitting={addStakeholder.isPending}
          onClose={() => setAddStakeholderOpen(false)}
          onAdd={(sh) => {
            addStakeholder.mutate(sh, {
              onSuccess: () => setAddStakeholderOpen(false),
            });
          }}
        />
      )}

      {deleteOpen && (
        <DeleteOpportunityDialog
          title={data.title}
          stage={data.stage}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => deleteOpp.mutateAsync()}
        />
      )}

      {editOpen && (
        <EditOpportunityDialog
          data={data}
          submitting={updateOpp.isPending}
          error={updateOpp.error ? (updateOpp.error as Error).message : null}
          onClose={() => setEditOpen(false)}
          onSave={(patch) => updateOpp.mutate(patch)}
        />
      )}

      {rejectOpen && (
        <RejectDialog
          stage={data.stage}
          options={(data.next_stages ?? []).filter((a) => isBackward(a.from, a.to))}
          submitting={transition.isPending}
          onClose={() => setRejectOpen(false)}
          onSubmit={(to, reason) => {
            transition.mutate({ to, reason });
            setRejectOpen(false);
          }}
        />
      )}

      </div>

      {/* Right rail — unified Activity (transitions + edits) */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <ActivityRail data={data} currency={data.currency || "NGN"} />
      </aside>
    </div>
  );
}

/* Hard-confirm dialog for deleting an opportunity. Mirrors the GitHub-style
 * "type the name to confirm" pattern so an accidental click on the trash icon
 * doesn't wipe a real lead. */
function DeleteOpportunityDialog({
  title, stage, onClose, onConfirm,
}: {
  title: string;
  stage: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === title.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden"
      >
        <header className="flex items-center gap-3 p-5 border-b border-border">
          <div className="w-9 h-9 rounded-full bg-danger/15 text-danger grid place-items-center shrink-0">
            <Trash2 size={16} />
          </div>
          <div>
            <h2 className="text-base font-bold text-text">Delete this opportunity?</h2>
            <p className="text-xs text-muted mt-0.5">
              Currently in <span className="font-semibold">{prettyStage(stage)}</span>. This soft-deletes the lead — it disappears from the pipeline immediately.
            </p>
          </div>
        </header>
        <div className="p-5 space-y-3">
          <div className="text-sm text-text">
            What gets removed:
            <ul className="list-disc list-inside text-xs text-muted mt-1 space-y-0.5">
              <li>The opportunity card and its stage history</li>
              <li>Attached documents stay in storage but are no longer surfaced here</li>
              <li>Any pending approvals for this lead are cancelled</li>
            </ul>
          </div>
          <label className="block">
            <div className="text-xs text-muted mb-1.5">
              Type <span className="font-mono font-bold text-text">{title}</span> to confirm:
            </div>
            <input
              autoFocus
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={title}
            />
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="danger"
            disabled={!matches}
            onClick={async () => {
              await onConfirm();
              onClose();
            }}
            loadingLabel="Deleting…"
            successLabel="Deleted"
            icon={<Trash2 size={13} />}
          >
            Delete opportunity
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function EditOpportunityDialog({
  data, submitting, error, onClose, onSave,
}: {
  data: any;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    title: data.title ?? "",
    lead_type: data.lead_type ?? "private",
    source: data.source ?? "",
    proposal_summary: data.proposal_summary ?? "",
    technical_scope: data.technical_scope ?? "",
    estimated_value: Number(data.estimated_value ?? 0),
    budget: Number(data.budget ?? 0),
    priority: Number(data.priority ?? 3),
    risk_level: data.risk_level ?? "low",
    delivery_deadline: (data.delivery_deadline ?? "").slice(0, 10),
    expected_manpower: Number(data.expected_manpower ?? 0),
    currency: data.currency ?? "NGN",
    reason: "",
  });

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    if (!form.title.trim()) return;
    onSave({
      title: form.title.slice(0, 225),
      lead_type: form.lead_type,
      source: form.source,
      proposal_summary: form.proposal_summary,
      technical_scope: form.technical_scope,
      estimated_value: form.estimated_value,
      budget: form.budget,
      priority: form.priority,
      risk_level: form.risk_level,
      delivery_deadline: form.delivery_deadline,
      expected_manpower: form.expected_manpower,
      currency: form.currency,
      reason: form.reason.trim(),
    });
  }

  const titleErr = !form.title.trim() ? "Title is required." : (form.title.length > 225 ? "Max 225 characters." : null);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-card w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 p-5 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0">
              <Pencil size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-text">Edit opportunity</h2>
              <p className="text-xs text-muted">Update the basic details. Stage, documents and stakeholders are managed elsewhere.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>

        <div className="overflow-auto flex-1 p-5 space-y-5">
          <label className="block">
            <div className="label flex items-center justify-between">
              <span>Project title</span>
              <span className={`text-[10px] font-mono ${form.title.length > 225 ? "text-danger" : "text-muted"}`}>
                {form.title.length}/225
              </span>
            </div>
            <input
              className="input"
              value={form.title}
              maxLength={225}
              autoFocus
              onChange={(e) => set("title", e.target.value.slice(0, 225))}
            />
            {titleErr && <div className="text-xs text-danger mt-1">{titleErr}</div>}
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <div className="label">Lead type</div>
              <select
                className="input"
                value={form.lead_type}
                onChange={(e) => set("lead_type", e.target.value)}
              >
                <option value="private">Private</option>
                <option value="government">Government</option>
                <option value="foreign">Foreign</option>
                <option value="ngo">NGO</option>
                <option value="internal">Internal</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Source</div>
              <input className="input" value={form.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. RFP portal" />
            </label>
          </div>

          <label className="block">
            <div className="label">Summary</div>
            <input className="input" value={form.proposal_summary} onChange={(e) => set("proposal_summary", e.target.value)} placeholder="One-line description." />
          </label>

          <label className="block">
            <div className="label">Technical scope</div>
            <textarea className="input min-h-[120px]" value={form.technical_scope} onChange={(e) => set("technical_scope", e.target.value)} />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="block">
              <div className="label">Currency</div>
              <select className="input" value={form.currency} onChange={(e) => set("currency", e.target.value)}>
                {["NGN","USD","EUR","GBP","ZAR","KES","GHS","XAF"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Estimated value</div>
              <input
                type="number" min={0} step="0.01"
                className="input"
                value={form.estimated_value === 0 ? "" : form.estimated_value}
                onChange={(e) => set("estimated_value", e.target.value === "" ? 0 : Number(e.target.value))}
                placeholder="0.00"
              />
            </label>
            <label className="block">
              <div className="label">Internal budget</div>
              <input
                type="number" min={0} step="0.01"
                className="input"
                value={form.budget === 0 ? "" : form.budget}
                onChange={(e) => set("budget", e.target.value === "" ? 0 : Number(e.target.value))}
                placeholder="0.00"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="block">
              <div className="label">Priority</div>
              <select className="input" value={form.priority} onChange={(e) => set("priority", Number(e.target.value))}>
                <option value={1}>1 — Lowest</option>
                <option value={2}>2 — Low</option>
                <option value={3}>3 — Medium</option>
                <option value={4}>4 — High</option>
                <option value={5}>5 — Highest</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Risk level</div>
              <select className="input" value={form.risk_level} onChange={(e) => set("risk_level", e.target.value)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Target delivery</div>
              <input type="date" className="input" value={form.delivery_deadline} onChange={(e) => set("delivery_deadline", e.target.value)} />
            </label>
          </div>

          <label className="block max-w-[200px]">
            <div className="label">Team size</div>
            <input
              type="number" min={0}
              className="input"
              value={form.expected_manpower}
              onChange={(e) => set("expected_manpower", Math.max(0, Number(e.target.value) || 0))}
            />
          </label>

          <label className="block">
            <div className="label">Why are you making this change? <span className="text-muted normal-case">(optional but recommended)</span></div>
            <textarea
              className="input min-h-[72px]"
              value={form.reason}
              placeholder="e.g. Renegotiated price after compliance review · timeline shifted by 2 weeks · added a senior engineer to derisk delivery"
              onChange={(e) => set("reason", e.target.value)}
            />
            <div className="text-xs text-muted mt-1">
              Saved on the opportunity's change log so anyone reviewing later can see the why.
            </div>
          </label>

          {error && (
            <div className="text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 p-4 border-t border-border bg-bg">
          <div className="text-xs text-muted">Stage, documents and stakeholders are edited from their own panels.</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-outline">Cancel</button>
            <SmartButton
              variant="primary"
              loading={submitting}
              disabled={!!titleErr}
              loadingLabel="Saving…"
              icon={<Save size={14} />}
              onClick={() => submit()}
            >
              Save changes
            </SmartButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

function RejectDialog({
  stage, options, submitting, onClose, onSubmit,
}: {
  stage: string;
  options: NextStage[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (to: string, reason: string) => void;
}) {
  const [target, setTarget] = useState<string>(options[0]?.to ?? "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    if (!target) { setErr("Pick a stage to send it back to."); return; }
    if (!reason.trim()) { setErr("Write a short reason — the requester needs to know what to fix."); return; }
    onSubmit(target, reason.trim());
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-danger/10 text-danger grid place-items-center shrink-0">
            <RotateCcw size={20} />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text">Reject / send back</h2>
            <p className="text-sm text-muted mt-0.5">
              Currently in <em>{prettyStage(stage)}</em>. Pick where to send it and explain why.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {options.length > 1 ? (
            <div>
              <div className="label">Send back to</div>
              <div className="grid gap-2">
                {options.map((o) => (
                  <button
                    key={o.to}
                    type="button"
                    onClick={() => setTarget(o.to)}
                    className={`text-left border rounded-md p-3 text-sm transition-colors ${
                      target === o.to ? "border-accent bg-accent-soft" : "border-border hover:bg-bg"
                    }`}
                  >
                    <div className="font-medium text-text">{o.label || `Send back to ${prettyStage(o.to)}`}</div>
                    <div className="text-xs text-muted mt-0.5 capitalize">→ {prettyStage(o.to)}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : options.length === 1 ? (
            <div className="text-sm text-text bg-bg border border-border rounded-md p-3">
              Will be sent to <strong className="capitalize">{prettyStage(options[0].to)}</strong>.
            </div>
          ) : null}

          <label className="block">
            <div className="label">Reason</div>
            <textarea
              autoFocus
              className="input min-h-[110px]"
              value={reason}
              placeholder="What needs to change before it can move forward?"
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="text-xs text-muted mt-1">
              Saved on the opportunity's history so anyone reviewing later can see why.
            </div>
          </label>

          {err && <div className="text-danger text-sm">{err}</div>}
        </div>

        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <SmartButton
            variant="danger"
            loading={submitting}
            loadingLabel="Sending…"
            successLabel="Sent"
            onClick={() => submit()}
          >
            Send back
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function PreviewDocumentDialog({
  doc, label, onClose,
}: {
  doc: Document;
  label: string;
  onClose: () => void;
}) {
  const key = doc.object_key || "";
  const isUrl = /^https?:\/\//i.test(key);
  const lower = key.toLowerCase();
  const ext = (() => {
    const m = lower.match(/\.([a-z0-9]{2,5})(\?|$)/);
    return m ? m[1] : "";
  })();
  const isImage = ["png","jpg","jpeg","gif","webp","svg"].includes(ext);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 grid place-items-center p-4"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 p-4 border-b border-border">
          <div className="min-w-0">
            <div className="text-sm text-muted">{label}</div>
            <div className="text-base font-semibold text-text truncate">{doc.name}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isUrl && (
              <>
                <a href={key} target="_blank" rel="noreferrer" className="btn-outline">
                  <ExternalLink size={14} /> Open in new tab
                </a>
                <a href={key} download className="btn-outline" title="Download">
                  <Download size={14} />
                </a>
              </>
            )}
            <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 bg-bg overflow-auto">
          {isUrl && isImage ? (
            <div className="h-full grid place-items-center p-4">
              <img src={key} alt={doc.name} className="max-w-full max-h-full object-contain" />
            </div>
          ) : isUrl ? (
            <iframe
              src={key}
              title={doc.name}
              className="w-full h-full border-0 bg-white"
            />
          ) : (
            <div className="h-full grid place-items-center p-8 text-center">
              <div className="max-w-sm">
                <div className="w-12 h-12 mx-auto rounded-full bg-warn/15 text-warn grid place-items-center mb-3">
                  <FileText size={20} />
                </div>
                <div className="text-sm font-medium text-text">Preview unavailable</div>
                <p className="text-sm text-muted mt-1">
                  This document was attached as a local upload, but file storage isn't wired up
                  in this preview build, so the binary isn't retrievable.
                </p>
                <div className="text-xs text-muted/80 mt-3 font-mono break-all">
                  {key || "(no reference)"}
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 p-3 border-t border-border bg-bg text-xs text-muted">
          <div className="truncate">
            <span className="font-medium text-text">Reference:</span> <span className="font-mono">{key || "—"}</span>
          </div>
          <div className="shrink-0">
            Attached {new Date(doc.uploaded_at).toLocaleString()}
          </div>
        </footer>
      </div>
    </div>
  );
}

type InsightTone = "good" | "warn" | "danger" | "info";

type Insight = {
  tone: InsightTone;
  icon: React.ComponentType<any>;
  title: string;
  body: string;
  cta?: { label: string; onClick: () => void };
};

function daysSinceISO(iso?: string | null): number {
  if (!iso) return 0;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function lastStageEntry(data: any): { at: string; from: string; to: string } | null {
  const list = data?.metadata?.stage_history;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[list.length - 1];
}

function daysInCurrentStage(data: any): number {
  const last = lastStageEntry(data);
  // Use last transition timestamp, otherwise fall back to created_at if available, else 0.
  const ref = last?.at ?? data?.created_at ?? null;
  return daysSinceISO(ref);
}

function healthScore(data: any): { score: number; reasons: string[] } {
  let score = 100;
  const reasons: string[] = [];

  // Document compliance impact (max -40)
  if (data.required_documents?.length) {
    const missing = Math.max(0, (data.required_documents.length || 0) - (data.documents?.length || 0));
    if (missing > 0) {
      const penalty = Math.min(40, missing * 8);
      score -= penalty;
      reasons.push(`${missing} required document${missing === 1 ? "" : "s"} still missing (-${penalty})`);
    }
  }

  // Margin impact (max -20)
  if (data.estimated_value > 0) {
    const marginPct = Math.round(((data.estimated_value - (data.budget || 0)) / data.estimated_value) * 100);
    if (marginPct < 10) { score -= 20; reasons.push(`Thin margin at ${marginPct}% (-20)`); }
    else if (marginPct < 30) { score -= 8; reasons.push(`Margin tight at ${marginPct}% (-8)`); }
  }

  // Stale-stage impact (max -25)
  const days = daysInCurrentStage(data);
  if (data.stage !== "closed" && data.stage !== "paid") {
    if (days >= 14) { score -= 25; reasons.push(`Stalled ${days}d in ${prettyStage(data.stage)} (-25)`); }
    else if (days >= 7) { score -= 12; reasons.push(`${days}d in ${prettyStage(data.stage)} (-12)`); }
  }

  // Risk level impact (max -15)
  if (data.risk_level === "high" && data.stage !== "closed") {
    score -= 15; reasons.push("High-risk classification (-15)");
  } else if (data.risk_level === "medium" && data.stage !== "closed") {
    score -= 5; reasons.push("Medium-risk classification (-5)");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function SmartInsights({ data }: { data: any }) {
  const insights: Insight[] = [];
  const days = daysInCurrentStage(data);
  const missing = Math.max(0, (data.required_documents?.length ?? 0) - (data.documents?.length ?? 0));
  const marginPct = data.estimated_value > 0
    ? Math.round(((data.estimated_value - (data.budget || 0)) / data.estimated_value) * 100)
    : null;

  // --- generate insights ---
  if (data.stage === "new_request") {
    if (missing > 0) {
      insights.push({
        tone: "warn", icon: FileText,
        title: `Attach ${missing} required document${missing === 1 ? "" : "s"} to unblock submission`,
        body: `${data.lead_type} clients require ${data.required_documents.length} documents before review.`,
      });
    } else {
      insights.push({
        tone: "good", icon: Check,
        title: "Ready to submit",
        body: "All required documents are attached. Hit Submit for review when you're ready.",
      });
    }
  }

  if (data.stage === "under_review" && data.next_stages?.length) {
    insights.push({
      tone: "info", icon: ThumbsUp,
      title: "Awaiting your review",
      body: days > 3
        ? `Sitting in review for ${days} days — approve, reject, or chase the reviewer.`
        : "Approve or send it back with a reason from the action panel above.",
    });
  }

  if (days >= 14 && data.stage !== "closed" && data.stage !== "paid") {
    insights.push({
      tone: "danger", icon: AlertTriangle,
      title: `Stalled in ${prettyStage(data.stage)} for ${days} days`,
      body: "Consider escalating to the assignee or rejecting back to the previous stage.",
    });
  } else if (days >= 7 && data.stage !== "closed" && data.stage !== "paid") {
    insights.push({
      tone: "warn", icon: Clock,
      title: `${days} days in ${prettyStage(data.stage)}`,
      body: "Movement is slowing — chase the responsible party before this becomes stale.",
    });
  }

  if (marginPct !== null && marginPct < 10) {
    insights.push({
      tone: "danger", icon: AlertTriangle,
      title: `Margin is ${marginPct}% — too thin`,
      body: "Either raise the estimated value, trim the budget, or accept the loss before submitting.",
    });
  } else if (marginPct !== null && marginPct < 30 && marginPct >= 10) {
    insights.push({
      tone: "warn", icon: AlertTriangle,
      title: `Margin is ${marginPct}% — confirm assumptions`,
      body: "Tight margin: verify team-rate inputs and contingency before approval.",
    });
  }

  if (data.risk_level === "high" && data.stage !== "closed") {
    insights.push({
      tone: "warn", icon: Shield,
      title: "High-risk engagement",
      body: "Compliance officer review is recommended; ensure the document checklist is complete and accurate.",
    });
  }

  if (data.stage === "approved" && !data.metadata?.project_id) {
    insights.push({
      tone: "info", icon: ArrowRight,
      title: "Move to planning to convert",
      body: "Once you transition to planning, a delivery project will be created automatically.",
    });
  }

  if (insights.length === 0) {
    insights.push({
      tone: "good", icon: Check,
      title: "Healthy — no action needed",
      body: "Nothing's blocked or aging here. Great state to be in.",
    });
  }

  return (
    <section className="rounded-2xl border border-accent/15 bg-gradient-to-br from-accent-soft via-bg/40 to-bg p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-accent text-white grid place-items-center">
          <Sparkles />
        </span>
        <h3 className="text-[14px] font-bold text-text">Smart insights</h3>
        <span className="text-xs text-muted ml-auto">{insights.length} {insights.length === 1 ? "signal" : "signals"}</span>
      </div>
      <ul className="space-y-2">
        {insights.slice(0, 4).map((i, idx) => {
          const Icon = i.icon;
          const tones: Record<InsightTone, string> = {
            good:   "bg-success/10 text-success",
            info:   "bg-accent-soft text-accent",
            warn:   "bg-warn/10 text-warn",
            danger: "bg-danger/10 text-danger",
          };
          return (
            <li key={idx} className="flex items-start gap-3 bg-surface/80 border border-border rounded-xl p-3">
              <span className={`w-7 h-7 rounded-full grid place-items-center shrink-0 ${tones[i.tone]}`}>
                <Icon size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text">{i.title}</div>
                <div className="text-xs text-muted leading-relaxed mt-0.5">{i.body}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Sparkles(props: { size?: number }) {
  return (
    <svg width={props.size ?? 14} height={props.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z" />
      <path d="M19 14l.7 1.8L21 17l-1.3.5L19 19l-.7-1.5L17 17l1.3-1.2L19 14z" />
    </svg>
  );
}

function HealthStat({ data }: { data: any }) {
  const { score, reasons } = healthScore(data);
  const tone = score >= 80 ? "text-success" : score >= 50 ? "text-warn" : "text-danger";
  const ringColor = score >= 80 ? "#16a34a" : score >= 50 ? "#d97706" : "#dc2626";
  const c = 2 * Math.PI * 18;
  const dash = (score / 100) * c;
  return (
    <div className="card p-4">
      <div className="label">Health</div>
      <div className="flex items-center gap-3 mt-1">
        <div className="relative w-12 h-12">
          <svg viewBox="0 0 44 44" className="-rotate-90 w-full h-full">
            <circle cx="22" cy="22" r="18" stroke="rgb(var(--border))" strokeWidth="4" fill="none" />
            <circle cx="22" cy="22" r="18" stroke={ringColor} strokeWidth="4" fill="none" strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round" />
          </svg>
          <div className={`absolute inset-0 grid place-items-center text-[12px] font-bold ${tone}`}>{score}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-base font-semibold ${tone}`}>
            {score >= 80 ? "Strong" : score >= 50 ? "Watching" : "At risk"}
          </div>
          <div className="text-[11px] text-muted truncate" title={reasons.join("\n")}>
            {reasons.length ? reasons[0] : "All factors look good."}
          </div>
        </div>
      </div>
    </div>
  );
}

function MarginStat({ data }: { data: any }) {
  const value = data.estimated_value || 0;
  const budget = data.budget || 0;
  const days = daysInCurrentStage(data);
  if (value <= 0) {
    return <Stat label="Days in stage" value={`${days}d`} />;
  }
  const margin = value - budget;
  const pct = Math.round((margin / value) * 100);
  const tone = pct >= 30 ? "text-success" : pct >= 10 ? "text-warn" : "text-danger";
  return (
    <div className="card p-4">
      <div className="label">Margin · {days}d in stage</div>
      <div className={`text-base font-semibold mt-0.5 ${tone}`}>
        {pct}% <span className="text-[11px] text-muted font-normal">({fmtCurrency(margin)})</span>
      </div>
    </div>
  );
}

function StageVelocity({ data }: { data: any }) {
  const history: { at: string; from: string; to: string }[] = data?.metadata?.stage_history ?? [];
  if (history.length === 0) return null;

  // Build per-stage durations
  const segments: { stage: string; days: number }[] = [];
  let prevTs = data.created_at ? new Date(data.created_at).getTime() : null;
  history.forEach((h) => {
    const at = new Date(h.at).getTime();
    if (prevTs && !isNaN(at)) {
      const d = Math.max(0, Math.floor((at - prevTs) / 86_400_000));
      segments.push({ stage: h.from, days: d });
    }
    prevTs = at;
  });
  // Tail segment from last transition to now
  if (prevTs) {
    const d = Math.max(0, Math.floor((Date.now() - prevTs) / 86_400_000));
    segments.push({ stage: data.stage, days: d });
  }
  if (segments.length === 0) return null;

  const total = segments.reduce((s, x) => s + x.days, 0) || 1;
  const colors: Record<string, string> = {
    new_request: "#1e212a", under_review: "#ef4444", approved: "#3b82f6",
    contracting: "#a855f7", planning: "#f59e0b", in_progress: "#10b981",
    qa_review: "#06b6d4", client_acceptance: "#0ea5e9", invoiced: "#8b5cf6",
    paid: "#22c55e", closed: "#6b7280",
  };

  return (
    <Card title="Stage velocity">
      <p className="text-xs text-muted mb-3">
        How long this opportunity has spent in each stage so far. Total: <strong className="text-text">{total} day{total === 1 ? "" : "s"}</strong>.
      </p>
      <div className="flex h-3 rounded-full overflow-hidden bg-bg">
        {segments.map((s, i) => (
          <div
            key={i}
            title={`${prettyStage(s.stage)} · ${s.days}d`}
            style={{
              width: `${Math.max(2, (s.days / total) * 100)}%`,
              background: colors[s.stage] ?? "#6b7280",
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 mt-3 text-xs">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: colors[s.stage] ?? "#6b7280" }} />
            <span className="capitalize text-text">{prettyStage(s.stage)}</span>
            <span className="text-muted">· {s.days}d</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const TITLE_LIMIT = 225;

type ActivityEvent =
  | { kind: "stage"; at: string; from: string; to: string; reason?: string; back: boolean }
  | { kind: "edit"; at: string; reason?: string; changes: { field: string; from: any; to: any }[] };

const FIELD_LABELS: Record<string, string> = {
  title: "Title", source: "Source", category: "Category", lead_type: "Lead type",
  estimated_value: "Estimated value", budget: "Internal budget", priority: "Priority",
  risk_level: "Risk level", delivery_deadline: "Target delivery",
  technical_scope: "Technical scope", proposal_summary: "Summary",
  expected_manpower: "Team size", dependencies: "Dependencies",
  compliance_tags: "Compliance tags", currency: "Currency",
  team_composition: "Team composition",
};

function fmtVal(field: string, v: any, ccy: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "estimated_value" || field === "budget") return fmtCurrency(Number(v), ccy);
  if (field === "priority") return `P${v}`;
  if (field === "team_composition") {
    try {
      const list = typeof v === "string" ? JSON.parse(v || "[]") : v;
      if (!Array.isArray(list) || list.length === 0) return "(none)";
      return list.map((l: any) => `${l.count}× ${l.name}`).join(", ");
    } catch { return String(v).slice(0, 60); }
  }
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function ActivityRail({ data, currency }: { data: any; currency: string }) {
  const stage = data?.metadata?.stage_history ?? [];
  const edits = data?.metadata?.change_history ?? [];

  const events: ActivityEvent[] = [
    ...stage.map((h: any) => ({
      kind: "stage" as const, at: h.at, from: h.from, to: h.to, reason: h.reason,
      back: isBackward(h.from, h.to),
    })),
    ...edits.map((e: any) => ({
      kind: "edit" as const, at: e.at, reason: e.reason, changes: e.changes ?? [],
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="rounded-2xl bg-gradient-to-b from-accent-soft to-bg p-5 border border-accent/15 shadow-soft">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-full bg-accent text-white grid place-items-center">
          <Clock size={14} />
        </div>
        <h3 className="text-[15px] font-bold text-text">Activity</h3>
        <span className="ml-auto text-xs text-muted">{events.length}</span>
      </div>

      {events.length === 0 ? (
        <div className="text-sm text-muted py-4 text-center">
          No activity yet. Stage moves and field edits will appear here.
        </div>
      ) : (
        <ol className="relative">
          <span className="absolute left-[13px] top-2 bottom-2 w-px bg-accent/25" />
          {events.map((ev, i) => (
            <li key={i} className={`relative pl-9 ${i === events.length - 1 ? "" : "pb-4"}`}>
              {ev.kind === "stage" ? (
                <StageEvent ev={ev} latest={i === 0} />
              ) : (
                <EditEvent ev={ev} currency={currency} />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StageEvent({ ev, latest }: { ev: Extract<ActivityEvent, { kind: "stage" }>; latest: boolean }) {
  return (
    <>
      <span className={`absolute left-0 top-0.5 w-7 h-7 rounded-full grid place-items-center shrink-0 ring-4 ring-bg ${
        ev.back ? "bg-danger/15 text-danger" :
        latest ? "bg-accent text-white" :
        "bg-success/15 text-success"
      }`}>
        {ev.back ? <RotateCcw size={13} /> : <Check size={13} />}
      </span>
      <div className="text-[13px] text-text leading-tight">
        <span className="capitalize text-muted">{prettyStage(ev.from)}</span>{" "}
        <span className="text-muted/60">→</span>{" "}
        <span className={`capitalize font-bold ${ev.back ? "text-danger" : "text-text"}`}>
          {prettyStage(ev.to)}
        </span>
      </div>
      {ev.reason && (
        <div className="text-[13px] text-text/80 mt-1 italic bg-surface/70 border border-border/60 rounded-lg px-2.5 py-1.5">
          "{ev.reason}"
        </div>
      )}
      <div className="text-[11px] text-muted/80 mt-1">
        {new Date(ev.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </div>
    </>
  );
}

function EditEvent({ ev, currency }: { ev: Extract<ActivityEvent, { kind: "edit" }>; currency: string }) {
  const summary = ev.changes.length === 1
    ? `Edited ${FIELD_LABELS[ev.changes[0].field] ?? ev.changes[0].field}`
    : `Edited ${ev.changes.length} fields`;
  return (
    <>
      <span className="absolute left-0 top-0.5 w-7 h-7 rounded-full grid place-items-center shrink-0 ring-4 ring-bg bg-warn/15 text-warn">
        <Pencil size={12} />
      </span>
      <div className="text-[13px] font-bold text-text leading-tight">{summary}</div>
      <ul className="mt-1.5 space-y-1">
        {ev.changes.map((c, i) => (
          <li key={i} className="text-[12.5px] bg-surface/70 border border-border/60 rounded-lg px-2.5 py-1.5">
            <div className="text-[11px] uppercase tracking-wide font-bold text-muted">
              {FIELD_LABELS[c.field] ?? c.field}
            </div>
            <div className="text-text">
              <span className="text-muted line-through">{fmtVal(c.field, c.from, currency)}</span>
              <span className="text-muted/60 mx-1.5">→</span>
              <span className="font-semibold">{fmtVal(c.field, c.to, currency)}</span>
            </div>
          </li>
        ))}
      </ul>
      {ev.reason && (
        <div className="text-[12.5px] text-text/80 mt-1.5 italic bg-surface/70 border border-border/60 rounded-lg px-2.5 py-1.5">
          "{ev.reason}"
        </div>
      )}
      <div className="text-[11px] text-muted/80 mt-1">
        {new Date(ev.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </div>
    </>
  );
}

function TruncatedTitle({ title }: { title: string }) {
  const [expanded, setExpanded] = useState(false);
  // Hard limit on titles is 225 chars (enforced in the wizard + backend); any legacy
  // record longer than that gets clipped on display with an opt-in "show full" toggle.
  const isLong = title.length > TITLE_LIMIT;
  const displayed = !expanded && isLong ? title.slice(0, TITLE_LIMIT).trimEnd() + "…" : title;
  return (
    <div className="space-y-1.5">
      <h1
        className={`text-[1.6rem] md:text-[2rem] font-extrabold tracking-tight leading-snug break-words ${
          !expanded && isLong ? "line-clamp-3" : ""
        }`}
        title={isLong ? title : undefined}
      >
        {displayed}
      </h1>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-semibold text-accent hover:underline"
        >
          {expanded ? "Show less" : `Show full title (${title.length} chars · capped at ${TITLE_LIMIT})`}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className="text-base font-semibold text-text mt-0.5">{value}</div>
    </div>
  );
}

function ViolationDialog({
  violations, docLabels, onClose, onAttach,
}: {
  violations: Violation[];
  docLabels: Record<string, { label: string; help: string }>;
  onClose: () => void;
  onAttach: (kind: string) => void;
}) {
  const missingDocs = violations.filter((v) => v.code === "missing_document" && v.field);
  const others = violations.filter((v) => v.code !== "missing_document");
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-6"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-warn/15 text-warn grid place-items-center shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-text">Submission blocked by governance</h2>
            <p className="text-sm text-muted mt-0.5">
              Resolve the items below to send this for review.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>
        <div className="overflow-auto flex-1 p-5 space-y-4">
          {missingDocs.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide font-semibold text-muted mb-2">Missing documents</div>
              <ul className="space-y-2">
                {missingDocs.map((v, i) => {
                  const meta = docLabels[v.field!] ?? { label: v.field!, help: "" };
                  return (
                    <li key={i} className="flex items-center gap-3 border border-border rounded-md p-3">
                      <FileText size={16} className="text-muted shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text">{meta.label}</div>
                        {meta.help && <div className="text-xs text-muted">{meta.help}</div>}
                      </div>
                      <button className="btn-primary" onClick={() => onAttach(v.field!)}>
                        <Upload size={14} /> Attach
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide font-semibold text-muted mb-2">Other issues</div>
              <ul className="space-y-1">
                {others.map((v, i) => (
                  <li key={i} className="text-sm text-text flex items-start gap-2">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                    {v.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Close</button>
        </footer>
      </div>
    </div>
  );
}

function UploadDocumentDialog({
  oppId, kind, label, onClose, onUploaded,
}: {
  oppId: string;
  kind: string;
  label: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  type Mode = "file" | "link";
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function isValidUrl(v: string): boolean {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch { return false; }
  }

  async function attach() {
    setErr(null);
    let payloadName = name.trim();
    let objectKey = "";

    if (mode === "file") {
      if (!file) { setErr("Choose a file to attach."); return; }
      if (!payloadName) payloadName = file.name;
      objectKey = `local://${oppId}/${kind}/${Date.now()}-${encodeURIComponent(file.name)}`;
    } else {
      const trimmed = link.trim();
      if (!trimmed) { setErr("Paste the document URL."); return; }
      if (!isValidUrl(trimmed)) { setErr("That doesn't look like a valid http(s) URL."); return; }
      if (!payloadName) {
        try { payloadName = new URL(trimmed).pathname.split("/").pop() || trimmed; }
        catch { payloadName = trimmed; }
      }
      objectKey = trimmed;
    }

    setBusy(true);
    try {
      await api(`/api/v1/opportunities/${oppId}/documents`, {
        method: "POST",
        body: JSON.stringify({ kind, name: payloadName, object_key: objectKey }),
      });
      onUploaded();
    } catch (e: any) {
      setErr(e.message ?? "Attach failed");
    } finally {
      setBusy(false);
    }
  }

  function fmtSize(b: number) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-6"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-semibold text-text">Attach {label}</h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1 p-1 bg-bg rounded-md">
            <button
              type="button"
              onClick={() => { setMode("file"); setErr(null); }}
              className={`flex items-center justify-center gap-1.5 text-sm py-2 rounded transition-colors ${
                mode === "file" ? "bg-surface shadow-sm text-text font-medium" : "text-muted hover:text-text"
              }`}
            >
              <Upload size={14} /> Upload file
            </button>
            <button
              type="button"
              onClick={() => { setMode("link"); setErr(null); }}
              className={`flex items-center justify-center gap-1.5 text-sm py-2 rounded transition-colors ${
                mode === "link" ? "bg-surface shadow-sm text-text font-medium" : "text-muted hover:text-text"
              }`}
            >
              <LinkIcon size={14} /> Paste link
            </button>
          </div>

          {mode === "file" ? (
            <FileDrop file={file} onPick={(f) => { setFile(f); if (!name) setName(""); }} fmtSize={fmtSize} />
          ) : (
            <label className="block">
              <div className="label">Document URL</div>
              <input
                className="input"
                autoFocus
                value={link}
                placeholder="https://drive.example.com/file/abc123"
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") attach(); }}
              />
              <div className="text-xs text-muted mt-1">
                Paste a SharePoint, Drive, S3, or any http(s) link. We store the reference, not the file.
              </div>
            </label>
          )}

          <label className="block">
            <div className="label">Display name <span className="text-muted normal-case">(optional)</span></div>
            <input
              className="input"
              value={name}
              placeholder={mode === "file" ? (file?.name ?? `e.g. ${label} v1.pdf`) : `e.g. ${label}`}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") attach(); }}
            />
          </label>

          {err && <div className="text-danger text-sm">{err}</div>}

          <p className="text-xs text-muted">
            File storage isn't wired up in this preview — uploads record a placeholder reference, links are stored
            as-is. Governance only checks that something of the right kind is attached.
          </p>
        </div>

        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <SmartButton
            variant="primary"
            loading={busy}
            loadingLabel="Attaching…"
            successLabel="Attached"
            onClick={() => attach()}
          >
            Attach
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function FileDrop({
  file, onPick, fmtSize,
}: {
  file: File | null;
  onPick: (f: File | null) => void;
  fmtSize: (b: number) => string;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md p-6 cursor-pointer transition-colors ${
        drag ? "border-accent bg-accent-soft" : "border-border hover:bg-bg"
      }`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0]; if (f) onPick(f);
      }}
    >
      {file ? (
        <>
          <FileText size={28} className="text-accent" />
          <div className="text-sm font-medium text-text break-all text-center">{file.name}</div>
          <div className="text-xs text-muted">{fmtSize(file.size)}</div>
          <button
            type="button"
            className="text-xs text-muted hover:text-danger underline"
            onClick={(e) => { e.preventDefault(); onPick(null); }}
          >
            Remove
          </button>
        </>
      ) : (
        <>
          <Upload size={24} className="text-muted" />
          <div className="text-sm text-text"><span className="text-accent font-medium">Click to choose</span> or drop a file here</div>
          <div className="text-xs text-muted">PDF, DOCX, images, etc.</div>
        </>
      )}
      <input
        type="file"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </label>
  );
}

function AddStakeholderDialog({
  submitting, onClose, onAdd,
}: {
  submitting: boolean;
  onClose: () => void;
  onAdd: (sh: { name: string; role: string; kind: "internal" | "external"; email?: string; phone?: string; notes?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [kind, setKind] = useState<"internal" | "external">("internal");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    if (!name.trim()) { setErr("Name is required."); return; }
    if (!role.trim()) { setErr("Role / title is required."); return; }
    onAdd({
      name: name.trim(), role: role.trim(), kind,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-lg font-semibold text-text">Add stakeholder</h2>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <div className="label">Type</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setKind("internal")}
                className={`p-3 rounded-md border text-sm transition-colors ${
                  kind === "internal" ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-bg"
                }`}
              >
                <div className="font-medium">Internal</div>
                <div className="text-xs text-muted mt-0.5">Owner, sponsor, exec</div>
              </button>
              <button
                type="button"
                onClick={() => setKind("external")}
                className={`p-3 rounded-md border text-sm transition-colors ${
                  kind === "external" ? "border-warn bg-warn/10 text-warn" : "border-border hover:bg-bg"
                }`}
              >
                <div className="font-medium">External</div>
                <div className="text-xs text-muted mt-0.5">Client, vendor, partner</div>
              </button>
            </div>
          </div>
          <label className="block">
            <div className="label">Name</div>
            <input className="input" autoFocus value={name} placeholder="e.g. Adaeze Okonkwo" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <div className="label">Role / title</div>
            <input className="input" value={role} placeholder={kind === "internal" ? "Project sponsor" : "Director of operations"} onChange={(e) => setRole(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Email</div>
              <input className="input" type="email" value={email} placeholder="optional" onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Phone</div>
              <input className="input" value={phone} placeholder="optional" onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <div className="label">Notes</div>
            <textarea className="input min-h-[60px]" value={notes} placeholder="optional — interests, sign-off authority, etc." onChange={(e) => setNotes(e.target.value)} />
          </label>
          {err && <div className="text-danger text-sm">{err}</div>}
        </div>
        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <SmartButton
            variant="primary"
            loading={submitting}
            loadingLabel="Adding…"
            successLabel="Added"
            onClick={() => submit()}
          >
            Add stakeholder
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}
