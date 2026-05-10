import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import { SmartButton } from "@/components/SmartButton";
import { Plus, Trash2, Save, RotateCcw, Check, Wallet } from "lucide-react";

type Rate = {
  id?: string;
  name: string;
  kind: "internal" | "external";
  daily_rate: number;
  currency: string;
  active?: boolean;
};

type ApiResponse = {
  rates: Rate[];
  currencies: string[];
};

const DEFAULTS: Rate[] = [
  { name: "Project manager",      kind: "internal", daily_rate: 450, currency: "USD" },
  { name: "Delivery manager",     kind: "internal", daily_rate: 500, currency: "USD" },
  { name: "Engineer",             kind: "internal", daily_rate: 400, currency: "USD" },
  { name: "Senior engineer",      kind: "internal", daily_rate: 600, currency: "USD" },
  { name: "QA",                   kind: "internal", daily_rate: 300, currency: "USD" },
  { name: "Designer",             kind: "internal", daily_rate: 400, currency: "USD" },
  { name: "Compliance officer",   kind: "internal", daily_rate: 500, currency: "USD" },
  { name: "Contract engineer",    kind: "external", daily_rate: 800, currency: "USD" },
  { name: "Subject matter expert",kind: "external", daily_rate: 1200, currency: "USD" },
];

export function TeamRatesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ApiResponse>({
    queryKey: ["team-rates"],
    queryFn: () => api(`/api/v1/settings/team-rates`),
  });

  const [draft, setDraft] = useState<Rate[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) setDraft(data.rates.map((r) => ({ ...r })));
  }, [data]);

  const save = useMutation({
    mutationFn: (rates: Rate[]) =>
      api(`/api/v1/settings/team-rates`, {
        method: "PUT",
        body: JSON.stringify({ rates }),
      }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["team-rates"] });
    },
  });

  const dirty = useMemo(() => {
    if (!data) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.rates.map((r) => ({ ...r })));
  }, [draft, data]);

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  function update(idx: number, patch: Partial<Rate>) {
    setDraft((d) => d.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }
  function add() {
    setDraft((d) => [...d, { name: "", kind: "internal", daily_rate: 0, currency: "USD" }]);
  }
  function restoreDefaults() {
    setDraft(DEFAULTS.map((r) => ({ ...r })));
  }

  const internal = draft.filter((r) => r.kind === "internal");
  const external = draft.filter((r) => r.kind === "external");

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1 leading-tight flex items-center gap-2">
            <Wallet size={22} className="text-accent" />
            Team rates
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Daily rates used to estimate delivery cost on every opportunity. Internal roles cover your
            staff, external are contractors and SMEs (typically more expensive). Rates are stored per
            tenant and applied automatically when planning team composition on a new opportunity.
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
          {save.error && <div className="text-xs text-danger">{(save.error as Error).message}</div>}
        </div>
      </header>

      <RateGroup
        title="Internal team" subtitle="Your own staff."
        rates={internal} currencies={data.currencies}
        onUpdate={(rate, patch) => {
          const idx = draft.indexOf(rate);
          if (idx >= 0) update(idx, patch);
        }}
        onRemove={(rate) => {
          const idx = draft.indexOf(rate);
          if (idx >= 0) remove(idx);
        }}
      />
      <RateGroup
        title="External workforce" subtitle="Contractors and SMEs. Their rates feed into the workforce risk alert when a project leans heavily on them."
        rates={external} currencies={data.currencies}
        onUpdate={(rate, patch) => {
          const idx = draft.indexOf(rate);
          if (idx >= 0) update(idx, patch);
        }}
        onRemove={(rate) => {
          const idx = draft.indexOf(rate);
          if (idx >= 0) remove(idx);
        }}
      />

      <div>
        <button className="btn-outline" onClick={add}>
          <Plus size={14} /> Add a role
        </button>
      </div>
    </div>
  );
}

function RateGroup({
  title, subtitle, rates, currencies, onUpdate, onRemove,
}: {
  title: string; subtitle: string;
  rates: Rate[]; currencies: string[];
  onUpdate: (r: Rate, patch: Partial<Rate>) => void;
  onRemove: (r: Rate) => void;
}) {
  return (
    <Card title={title} action={<span className="text-xs text-muted">{rates.length} role{rates.length === 1 ? "" : "s"}</span>}>
      <p className="text-sm text-muted mb-4">{subtitle}</p>
      {rates.length === 0 ? (
        <div className="text-sm text-muted italic">None defined yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-border">
              <th className="text-left font-medium px-2 py-2">Role</th>
              <th className="text-left font-medium px-2 py-2 w-32">Kind</th>
              <th className="text-right font-medium px-2 py-2 w-32">Daily rate</th>
              <th className="text-left font-medium px-2 py-2 w-24">Currency</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r, i) => (
              <tr key={r.id ?? `new-${i}-${r.name}`} className="border-b border-border last:border-0">
                <td className="px-2 py-2">
                  <input
                    className="input"
                    value={r.name}
                    placeholder="Role name"
                    onChange={(e) => onUpdate(r, { name: e.target.value })}
                  />
                </td>
                <td className="px-2 py-2">
                  <select
                    className="input"
                    value={r.kind}
                    onChange={(e) => onUpdate(r, { kind: e.target.value as "internal" | "external" })}
                  >
                    <option value="internal">Internal</option>
                    <option value="external">External</option>
                  </select>
                </td>
                <td className="px-2 py-2">
                  <input
                    type="number" min={0} step="0.01"
                    className="input text-right"
                    value={r.daily_rate}
                    onChange={(e) => onUpdate(r, { daily_rate: +e.target.value || 0 })}
                  />
                </td>
                <td className="px-2 py-2">
                  <select
                    className="input"
                    value={r.currency}
                    onChange={(e) => onUpdate(r, { currency: e.target.value })}
                  >
                    {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <button
                    className="text-muted hover:text-danger p-1"
                    onClick={() => onRemove(r)}
                    aria-label="Remove rate"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
