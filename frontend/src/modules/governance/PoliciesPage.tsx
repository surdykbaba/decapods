import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/lib/confirm";
import {
  ShieldCheck, Plus, Pencil, Trash2, X, Check, AlertTriangle, BookOpen,
} from "lucide-react";

type Policy = {
  id: string;
  code: string;
  kind: string;
  active: boolean;
  definition: Record<string, any>;
  updated_at: string;
};

const KINDS = [
  { value: "opportunity_submit", label: "Opportunity submit", help: "Evaluated when an opportunity is submitted. Vars: lead_type, estimated_value." },
];

// Helpful starter templates. The engine supports a small JSON-Logic dialect:
// and, or, >, >=, <, <=, ==, !=, in, with {var: "field"} for variable access.
const TEMPLATES: { name: string; body: Record<string, any> }[] = [
  {
    name: "Government deals over ₦100M need extra review",
    body: {
      and: [
        { "==": [{ var: "lead_type" }, "government"] },
        { ">":  [{ var: "estimated_value" }, 100_000_000] },
      ],
    },
  },
  {
    name: "Foreign + private value cap at $2M",
    body: {
      or: [
        { "==": [{ var: "lead_type" }, "internal"] },
        { "<=": [{ var: "estimated_value" }, 2_000_000] },
      ],
    },
  },
  {
    name: "Allow only listed lead types",
    body: {
      in: [{ var: "lead_type" }, ["government", "private", "ngo", "foreign", "internal"]],
    },
  },
];

const BUILTIN_RULES = [
  { title: "Required documents", body: "NDA, TechnicalProposal and ScopeDocument are required for every submission. Government leads also require ComplianceAttestation and SecurityChecklist." },
  { title: "High-value escalation", body: "Opportunities above ₦50M require an additional FinanceSignOff document attached." },
  { title: "Role-gated transitions", body: "Stage moves obey the workflow configured under Settings → Approval workflow." },
];

export function GovernancePoliciesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: Policy[] }>({
    queryKey: ["policies"],
    queryFn: () => api("/api/v1/governance/policies"),
  });
  const items = data?.items ?? [];

  const upsert = useMutation({
    mutationFn: (p: { code: string; kind: string; active: boolean; definition: Record<string, any> }) =>
      api("/api/v1/governance/policies", { method: "POST", body: JSON.stringify(p) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policies"] });
      toast.success("Policy saved");
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not save policy", msg);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/governance/policies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policies"] });
      toast.success("Policy deleted");
    },
    onError: (e: Error) => toast.error("Delete failed", e.message),
  });

  const [editing, setEditing] = useState<Policy | "new" | null>(null);

  const byKind = useMemo(() => {
    const m: Record<string, Policy[]> = {};
    items.forEach((p) => { (m[p.kind] ||= []).push(p); });
    return m;
  }, [items]);

  return (
    <div className="space-y-5 max-w-5xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="h1 flex items-center gap-2">
            <ShieldCheck size={26} className="text-accent" /> Governance policies
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Layer custom rules on top of the built-in governance engine. Rules use a small
            JSON-Logic dialect and fire at the moments listed below.
          </p>
        </div>
        <SmartButton variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          Add policy
        </SmartButton>
      </header>

      {/* Built-in baseline */}
      <div className="bg-accent-soft/40 border border-accent/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 text-accent font-semibold text-sm mb-2">
          <BookOpen size={14} /> Built-in baseline
        </div>
        <p className="text-xs text-muted mb-3">
          These rules always run for every tenant. Custom policies below stack on top of them.
        </p>
        <ul className="space-y-2">
          {BUILTIN_RULES.map((r) => (
            <li key={r.title} className="text-sm">
              <span className="font-semibold text-text">{r.title}</span>
              <span className="text-muted"> — {r.body}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Custom policies grouped by kind */}
      {isLoading ? (
        <div className="text-muted">Loading policies…</div>
      ) : items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
            <ShieldCheck size={22} />
          </div>
          <div className="text-base font-bold text-text">No custom policies yet</div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            Built-in rules are still doing their job. Add a custom policy to encode tenant-specific
            checks (e.g. extra approvals for government leads above a threshold).
          </p>
          <div className="mt-4">
            <SmartButton variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
              Add your first policy
            </SmartButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {KINDS.map((k) => {
            const group = byKind[k.value] ?? [];
            if (group.length === 0) return null;
            return (
              <div key={k.value} className="bg-surface border border-border rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-border">
                  <div className="font-semibold text-text">{k.label}</div>
                  <div className="text-xs text-muted">{k.help}</div>
                </div>
                <ul className="divide-y divide-border">
                  {group.map((p) => (
                    <PolicyRow
                      key={p.id}
                      policy={p}
                      onEdit={() => setEditing(p)}
                      onToggle={(active) => upsert.mutate({ code: p.code, kind: p.kind, active, definition: p.definition })}
                      onDelete={async () => {
                        const ok = await confirmAction({
                          title: "Delete policy",
                          body: `Remove the "${p.code}" policy? This cannot be undone.`,
                          confirmLabel: "Delete",
                          danger: true,
                        });
                        if (ok) remove.mutate(p.id);
                      }}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <PolicyDialog
          policy={editing === "new" ? null : editing}
          existingCodes={new Set(items.map((p) => p.code))}
          saving={upsert.isPending}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await upsert.mutateAsync(body);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PolicyRow({
  policy, onEdit, onToggle, onDelete,
}: {
  policy: Policy;
  onEdit: () => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li className="px-5 py-3 flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-text">{policy.code}</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
            policy.active ? "bg-success/15 text-success" : "bg-muted/15 text-muted"
          }`}>
            {policy.active ? "Active" : "Disabled"}
          </span>
        </div>
        <div className="text-[11px] text-muted mt-0.5 font-mono truncate">
          {JSON.stringify(policy.definition)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onToggle(!policy.active)}
        className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
          policy.active ? "bg-muted/15 text-muted hover:bg-muted/25" : "bg-success/15 text-success hover:bg-success/25"
        }`}
      >
        {policy.active ? "Disable" : "Enable"}
      </button>
      <button onClick={onEdit} className="p-1.5 rounded hover:bg-bg text-muted" title="Edit">
        <Pencil size={14} />
      </button>
      <button onClick={onDelete} className="p-1.5 rounded hover:bg-bg text-muted hover:text-danger" title="Delete">
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function PolicyDialog({
  policy, existingCodes, saving, onClose, onSave,
}: {
  policy: Policy | null;
  existingCodes: Set<string>;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { code: string; kind: string; active: boolean; definition: Record<string, any> }) => void;
}) {
  const isEdit = !!policy;
  const [code, setCode] = useState(policy?.code ?? "");
  const [kind, setKind] = useState(policy?.kind ?? KINDS[0].value);
  const [active, setActive] = useState(policy?.active ?? true);
  const [defText, setDefText] = useState(JSON.stringify(policy?.definition ?? { ">": [{ var: "estimated_value" }, 0] }, null, 2));
  const [parseErr, setParseErr] = useState<string | null>(null);

  const codeClash = !isEdit && existingCodes.has(code.trim());

  function applyTemplate(t: typeof TEMPLATES[number]) {
    setDefText(JSON.stringify(t.body, null, 2));
    setParseErr(null);
  }

  function submit() {
    let parsed: any;
    try {
      parsed = JSON.parse(defText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Definition must be a JSON object");
      }
    } catch (e: any) {
      setParseErr(e.message ?? "Invalid JSON");
      return;
    }
    setParseErr(null);
    onSave({ code: code.trim(), kind, active, definition: parsed });
  }

  const canSave = code.trim() !== "" && !codeClash && !parseErr;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-text">{isEdit ? "Edit policy" : "New policy"}</h2>
            <p className="text-xs text-muted mt-0.5">
              Rules use a small JSON-Logic dialect: <code>and</code>, <code>or</code>, comparison ops, <code>in</code>, and{" "}
              <code>{`{"var":"field"}`}</code>.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] text-muted mb-1 font-medium">Code</div>
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s+/g, "_").toLowerCase())}
                placeholder="gov_high_value_review"
                disabled={isEdit}
              />
              {codeClash && <div className="text-[11px] text-danger mt-1">A policy with that code already exists.</div>}
            </label>
            <label className="block">
              <div className="text-[11px] text-muted mb-1 font-medium">Triggers on</div>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
              <div className="text-[11px] text-muted mt-1">{KINDS.find((k) => k.value === kind)?.help}</div>
            </label>
          </div>

          <label className="flex items-center gap-2 select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-sm">Active — enforce this policy immediately</span>
          </label>

          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] text-muted font-medium">Rule definition (JSON-Logic)</div>
              <div className="flex flex-wrap gap-1">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-accent-soft text-accent hover:bg-accent/20 font-semibold"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="input font-mono text-[12px] leading-relaxed min-h-[180px]"
              value={defText}
              onChange={(e) => { setDefText(e.target.value); setParseErr(null); }}
              spellCheck={false}
            />
            {parseErr && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-danger">
                <AlertTriangle size={12} /> {parseErr}
              </div>
            )}
            <p className="text-[11px] text-muted mt-1">
              Variables available: <code>lead_type</code> (string), <code>estimated_value</code> (number).
              The rule must return <code>true</code> for the action to be allowed; returning <code>false</code> blocks it.
            </p>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton variant="primary" icon={<Check size={14} />} disabled={!canSave || saving} loadingLabel="Saving…" onClick={submit}>
            {isEdit ? "Save changes" : "Create policy"}
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}
