import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
import { SmartButton } from "@/components/SmartButton";
import { Plus, Trash2, RotateCcw, GitBranch, Save, Check, ArrowRight } from "lucide-react";

type Transition = {
  from: string;
  to: string;
  label?: string;
  roles?: string[];
};

type WorkflowResponse = {
  workflow: { transitions: Transition[] };
  default: { transitions: Transition[] };
  stages: string[];
  roles: string[];
};

function pretty(s: string) { return s.replace(/_/g, " "); }

export function WorkflowPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<WorkflowResponse>({
    queryKey: ["opp-workflow"],
    queryFn: () => api(`/api/v1/settings/opportunity-workflow`),
  });

  const [draft, setDraft] = useState<Transition[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) setDraft(data.workflow.transitions.map((t) => ({ ...t, roles: t.roles ?? [] })));
  }, [data]);

  const save = useMutation({
    mutationFn: (transitions: Transition[]) =>
      api(`/api/v1/settings/opportunity-workflow`, {
        method: "PUT",
        body: JSON.stringify({ transitions }),
      }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["opp-workflow"] });
    },
  });

  const dirty = useMemo(() => {
    if (!data) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.workflow.transitions.map((t) => ({ ...t, roles: t.roles ?? [] })));
  }, [draft, data]);

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  function update(idx: number, patch: Partial<Transition>) {
    setDraft((d) => d.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }
  function remove(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }
  function add() {
    setDraft((d) => [...d, { from: data?.stages[0] ?? "new_request", to: data?.stages[1] ?? "approved", label: "", roles: [] }]);
  }
  function restoreDefaults() {
    if (!data) return;
    setDraft(data.default.transitions.map((t) => ({ ...t, roles: t.roles ?? [] })));
  }
  function toggleRole(idx: number, role: string) {
    const t = draft[idx];
    const has = (t.roles ?? []).includes(role);
    update(idx, { roles: has ? (t.roles ?? []).filter((r) => r !== role) : [...(t.roles ?? []), role] });
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1 leading-tight flex items-center gap-2">
            <GitBranch size={22} className="text-accent" />
            Approval workflow
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Define which stages an opportunity can move between, and which roles are
            allowed to perform each move. Transitions with no roles are open to anyone
            with the <code className="text-xs bg-bg px-1 rounded">opportunity:write</code> permission.
            Submission from <em>new request</em> is always governed by the document checklist.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <SmartButton variant="outline" onClick={restoreDefaults} disabled={save.isPending} icon={<RotateCcw size={14} />}>
              Restore defaults
            </SmartButton>
            <SmartButton
              variant="primary"
              disabled={!dirty}
              loadingLabel="Saving…"
              icon={<Save size={14} />}
              onClick={() => save.mutateAsync(draft)}
            >
              Save changes
            </SmartButton>
          </div>
          {savedAt && !dirty && (
            <div className="text-xs text-success flex items-center gap-1">
              <Check size={12} /> Saved
            </div>
          )}
          {save.error && (
            <div className="text-xs text-danger">{(save.error as Error).message}</div>
          )}
        </div>
      </header>

      <Card title="Stages in use">
        <div className="flex flex-wrap gap-2">
          {data.stages.map((s) => (
            <Pill key={s} tone="neutral">{pretty(s)}</Pill>
          ))}
        </div>
        <div className="text-xs text-muted mt-3">
          Stages are inferred from the saved and default workflows. To introduce a new stage,
          add it as the <em>to</em> or <em>from</em> in any transition below.
        </div>
      </Card>

      <Card
        title="Transitions"
        action={
          <button className="btn-outline" onClick={add}>
            <Plus size={14} /> Add transition
          </button>
        }
      >
        {draft.length === 0 ? (
          <div className="text-sm text-muted">
            No transitions yet. Click <strong>Add transition</strong> or restore defaults.
          </div>
        ) : (
          <div className="space-y-3">
            {draft.map((t, idx) => (
              <div key={idx} className="border border-border rounded-md p-4 bg-surface">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
                  <FieldStack label="From" className="md:col-span-3">
                    <StageSelect
                      value={t.from}
                      stages={data.stages}
                      onChange={(v) => update(idx, { from: v })}
                    />
                  </FieldStack>
                  <div className="md:col-span-1 hidden md:flex items-center justify-center text-muted pt-7">
                    <ArrowRight size={16} />
                  </div>
                  <FieldStack label="To" className="md:col-span-3">
                    <StageSelect
                      value={t.to}
                      stages={data.stages}
                      onChange={(v) => update(idx, { to: v })}
                    />
                  </FieldStack>
                  <FieldStack label="Button label" className="md:col-span-4">
                    <input
                      className="input"
                      value={t.label ?? ""}
                      placeholder={`Move to ${pretty(t.to || "next")}`}
                      onChange={(e) => update(idx, { label: e.target.value })}
                    />
                  </FieldStack>
                  <div className="md:col-span-1 flex md:justify-end pt-7">
                    <button
                      className="text-muted hover:text-danger p-1.5 rounded hover:bg-danger/10"
                      onClick={() => remove(idx)}
                      aria-label="Remove transition"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="label !mb-0">Allowed roles</div>
                    <div className="text-xs text-muted">
                      {(t.roles ?? []).length === 0 ? "Open to anyone with opportunity:write" : `${(t.roles ?? []).length} selected`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.roles.map((r) => {
                      const on = (t.roles ?? []).includes(r);
                      return (
                        <button
                          key={r} type="button"
                          onClick={() => toggleRole(idx, r)}
                          className={`pill border transition-colors ${
                            on ? "bg-accent-soft border-accent text-accent" : "border-border text-muted hover:bg-bg"
                          }`}
                        >
                          {on && <Check size={12} />} {pretty(r)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function FieldStack({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <div className="label">{label}</div>
      {children}
    </label>
  );
}

function StageSelect({ value, stages, onChange }: { value: string; stages: string[]; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(!stages.includes(value));
  if (custom) {
    return (
      <div className="flex gap-1">
        <input
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn-outline" onClick={() => { setCustom(false); onChange(stages[0] ?? ""); }}>
          List
        </button>
      </div>
    );
  }
  return (
    <div className="flex gap-1">
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {stages.map((s) => (
          <option key={s} value={s}>{pretty(s)}</option>
        ))}
      </select>
      <button type="button" className="btn-outline" onClick={() => setCustom(true)} title="Type a new stage">+</button>
    </div>
  );
}
