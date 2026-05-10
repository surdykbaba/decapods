import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Pill } from "@/components/ui";
import { api } from "@/lib/api";

const STEPS = ["Client", "Scope", "Commercials", "Compliance", "Review"];

export function OpportunityWizard() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<any>({
    title: "", lead_type: "private", estimated_value: 0, budget: 0,
    priority: 3, risk_level: "medium", technical_scope: "", proposal_summary: "",
    expected_manpower: 0, dependencies: [], compliance_tags: [],
  });
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  function set<K extends string>(k: K, v: any) {
    setForm((f: any) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setErr(null);
    try {
      const res = await api<{ id: string }>("/api/v1/opportunities", {
        method: "POST", body: JSON.stringify({ ...form, client_id: "00000000-0000-0000-0000-000000000000" }),
      });
      nav(`/pipeline/${res.id}`);
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="grid grid-cols-12 gap-6">
      <aside className="col-span-3 card p-4 h-fit sticky top-0">
        <h2 className="h2 mb-4">New opportunity</h2>
        <ol className="space-y-2">
          {STEPS.map((s, i) => (
            <li key={s}
                className={`flex items-center gap-2 text-sm ${i === step ? "text-text" : "text-muted"}`}>
              <span className={`w-6 h-6 rounded-full grid place-items-center text-xs border ${
                i === step ? "border-accent text-accent" : "border-border"
              }`}>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </aside>

      <main className="col-span-9 space-y-6">
        <Card title={STEPS[step]}>
          {step === 0 && (
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="label">Project title</label>
                <input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} />
              </div>
              <div>
                <label className="label">Lead type</label>
                <select className="input" value={form.lead_type} onChange={(e) => set("lead_type", e.target.value)}>
                  <option value="government">Government</option>
                  <option value="private">Private</option>
                  <option value="foreign">Foreign</option>
                  <option value="ngo">NGO</option>
                  <option value="internal">Internal</option>
                </select>
              </div>
              <div>
                <label className="label">Source</label>
                <input className="input" value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} />
              </div>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="label">Technical scope</label>
                <textarea className="input min-h-[120px]" value={form.technical_scope}
                          onChange={(e) => set("technical_scope", e.target.value)} />
              </div>
              <div>
                <label className="label">Proposal summary</label>
                <textarea className="input min-h-[120px]" value={form.proposal_summary}
                          onChange={(e) => set("proposal_summary", e.target.value)} />
              </div>
              <div>
                <label className="label">Expected manpower</label>
                <input className="input" type="number" value={form.expected_manpower}
                       onChange={(e) => set("expected_manpower", +e.target.value)} />
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label">Estimated value (USD)</label>
                <input className="input" type="number" value={form.estimated_value}
                       onChange={(e) => set("estimated_value", +e.target.value)} />
              </div>
              <div>
                <label className="label">Budget (USD)</label>
                <input className="input" type="number" value={form.budget}
                       onChange={(e) => set("budget", +e.target.value)} />
              </div>
              <div>
                <label className="label">Priority (1-5)</label>
                <input className="input" type="number" min={1} max={5} value={form.priority}
                       onChange={(e) => set("priority", +e.target.value)} />
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-3">
              <div>
                <label className="label">Risk level</label>
                <select className="input" value={form.risk_level} onChange={(e) => set("risk_level", e.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div className="text-sm text-muted">
                Documents (NDA, RFP, contracts, etc.) are uploaded after creation; the
                governance engine will block submission until all required documents are
                attached for the selected lead type.
              </div>
            </div>
          )}
          {step === 4 && (
            <div className="space-y-3 text-sm">
              <Pill tone="info">Review</Pill>
              <pre className="text-xs bg-bg p-3 rounded-lg border border-border overflow-auto">
                {JSON.stringify(form, null, 2)}
              </pre>
              {err && <div className="text-danger">{err}</div>}
            </div>
          )}
        </Card>

        <div className="flex justify-between">
          <button className="btn-ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn-primary" onClick={() => setStep(step + 1)}>Continue</button>
          ) : (
            <button className="btn-primary" onClick={submit}>Create draft</button>
          )}
        </div>
      </main>
    </div>
  );
}
