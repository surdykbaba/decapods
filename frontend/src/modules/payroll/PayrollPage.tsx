// PayrollPage — HR/Finance salary structure + monthly pay runs.
//
// Two tabs:
//   • Runs         — open a period, generate payslips (Nigerian PAYE +
//                     pension + NHF, pro-rated for unpaid leave),
//                     approve, mark paid, export the bank CSV.
//   • Compensation — per-employee salary structure (basic + allowances
//                     + statutory toggles), the input the run reads.
//
// All gated server-side by payroll:read / payroll:write and nav-gated to
// the "payroll" visibility section (HR + Finance + super_admin).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Wallet, Plus, RefreshCw, CheckCircle2, BadgeCheck, Download, AlertTriangle, X, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";

type RunRow = {
  id: string; period: string; status: "draft" | "approved" | "paid";
  currency: string; gross_total: number; deduction_total: number;
  net_total: number; headcount: number; created_at: string;
  approved_at?: string | null; paid_at?: string | null;
};
type Payslip = {
  id: string; user_id: string; employee_name: string; currency: string;
  basic: number; allowances: Record<string, number>; gross: number;
  paye: number; pension: number; nhf: number; other_deductions: number;
  deductions_total: number; net: number; working_days: number;
  unpaid_leave_days: number; bank_name: string; bank_account_number: string;
  bank_account_name: string; flags: string[];
};
type RunDetail = RunRow & { notes: string; payslips: Payslip[] };
type Comp = {
  user_id: string; name: string; email: string; job_title: string;
  currency: string; basic_monthly: number; allowances: Record<string, number>;
  pension_opt_in: boolean; nhf_opt_in: boolean; is_set: boolean;
  effective_from?: string;
};

const STATUS_META: Record<RunRow["status"], { label: string; cls: string }> = {
  draft:    { label: "Draft",    cls: "bg-bg text-muted border-border" },
  approved: { label: "Approved", cls: "bg-accent-soft text-accent border-accent/30" },
  paid:     { label: "Paid",     cls: "bg-success/15 text-success border-success/30" },
};

const FLAG_META: Record<string, { label: string; tone: string }> = {
  no_salary:             { label: "No salary on file", tone: "text-danger" },
  missing_bank:          { label: "No bank details",   tone: "text-warn" },
  non_positive_net:      { label: "Net ≤ 0",           tone: "text-danger" },
  prorated_unpaid_leave: { label: "Pro-rated (unpaid leave)", tone: "text-muted" },
};

function money(n: number, ccy = "NGN"): string {
  const sym = ({ NGN: "₦", USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[ccy] ?? ccy + " ";
  return `${sym}${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function PayrollPage() {
  const [tab, setTab] = useState<"runs" | "comp" | "settings">("runs");
  return (
    <div className="space-y-5 max-w-6xl">
      <header>
        <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Finance · HR</div>
        <h1 className="h1 mt-1 flex items-center gap-2"><Wallet size={22} className="text-accent" /> Payroll</h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Monthly pay runs with Nigerian PAYE, 8% pension and optional 2.5% NHF —
          auto-computed, pro-rated for unpaid leave, exportable as a bank schedule.
        </p>
      </header>

      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["runs", "comp", "settings"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-[12.5px] font-semibold rounded-full transition-colors ${
              tab === t ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {t === "runs" ? "Pay runs" : t === "comp" ? "Compensation" : "Tax settings"}
          </button>
        ))}
      </div>

      {tab === "runs" ? <RunsTab /> : tab === "comp" ? <CompensationTab /> : <SettingsTab />}
    </div>
  );
}

/* ---------------- Runs ---------------- */

function RunsTab() {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const { data, isLoading } = useQuery<{ items: RunRow[] }>({
    queryKey: ["payroll", "runs"],
    queryFn: () => api("/api/v1/payroll/runs"),
  });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));

  const create = useMutation({
    mutationFn: () => api("/api/v1/payroll/runs", { method: "POST", body: JSON.stringify({ period }) }),
    onSuccess: () => {
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["payroll", "runs"] });
      toast.success("Run opened", `Draft created for ${period}.`);
    },
    onError: (e: any) => toast.error("Couldn't open run", e?.message),
  });

  async function exportCsv(id: string, p: string) {
    try {
      const res = await fetch(`/api/v1/payroll/runs/${id}/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `payroll-${p}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error("Export failed", e?.message);
    }
  }

  const runs = data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
        >
          <Plus size={14} /> New pay run
        </button>
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={() => setCreating(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-text">Open a pay run</h2>
              <button onClick={() => setCreating(false)} className="text-muted hover:text-text"><X size={16} /></button>
            </div>
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Period</div>
              <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="input w-full" />
            </label>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="mt-4 w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-60"
            >
              <Plus size={14} /> Open draft
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center text-sm text-muted">
          No pay runs yet. Open one for the current month to get started.
        </div>
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="bg-surface border border-border rounded-2xl">
              <button
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left"
              >
                <span className="text-[14px] font-bold text-text w-24">{r.period}</span>
                <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${STATUS_META[r.status].cls}`}>
                  {STATUS_META[r.status].label}
                </span>
                <span className="text-[12px] text-muted">{r.headcount} {r.headcount === 1 ? "person" : "people"}</span>
                <span className="ml-auto text-[13px] text-text">
                  Net <span className="font-bold">{money(r.net_total, r.currency)}</span>
                </span>
              </button>
              {openRun === r.id && <RunDetailPanel id={r.id} onExport={() => exportCsv(r.id, r.period)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunDetailPanel({ id, onExport }: { id: string; onExport: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<RunDetail>({
    queryKey: ["payroll", "run", id],
    queryFn: () => api(`/api/v1/payroll/runs/${id}`),
  });
  const act = useMutation({
    mutationFn: (action: "generate" | "approve" | "pay") =>
      api(`/api/v1/payroll/runs/${id}/${action}`, { method: "POST" }),
    onSuccess: (_d, action) => {
      qc.invalidateQueries({ queryKey: ["payroll", "run", id] });
      qc.invalidateQueries({ queryKey: ["payroll", "runs"] });
      toast.success(action === "generate" ? "Payslips generated"
        : action === "approve" ? "Run approved" : "Run marked paid");
    },
    onError: (e: any) => toast.error("Action failed", e?.message),
  });

  if (isLoading || !data) return <div className="px-4 pb-4 text-sm text-muted">Loading run…</div>;
  const ccy = data.currency;
  return (
    <div className="border-t border-border px-4 py-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.status === "draft" && (
          <button onClick={() => act.mutate("generate")} disabled={act.isPending}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold bg-bg border border-border rounded-full px-3 py-1.5 hover:border-accent/40">
            <RefreshCw size={12} /> {data.headcount > 0 ? "Regenerate" : "Generate"} payslips
          </button>
        )}
        {data.status === "draft" && data.headcount > 0 && (
          <button onClick={() => act.mutate("approve")} disabled={act.isPending}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold bg-accent text-white rounded-full px-3 py-1.5 hover:bg-accent/90">
            <CheckCircle2 size={12} /> Approve
          </button>
        )}
        {data.status === "approved" && (
          <button onClick={() => act.mutate("pay")} disabled={act.isPending}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold bg-success text-white rounded-full px-3 py-1.5 hover:bg-success/90">
            <BadgeCheck size={12} /> Mark paid
          </button>
        )}
        {data.headcount > 0 && (
          <button onClick={onExport}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold bg-bg border border-border rounded-full px-3 py-1.5 hover:border-accent/40">
            <Download size={12} /> Bank CSV
          </button>
        )}
        <div className="ml-auto text-[12px] text-muted">
          Gross {money(data.gross_total, ccy)} · Deductions {money(data.deduction_total, ccy)} ·
          <span className="font-bold text-text"> Net {money(data.net_total, ccy)}</span>
        </div>
      </div>

      {data.payslips.length === 0 ? (
        <div className="text-[12.5px] text-muted italic">
          No payslips yet — generate to snapshot every employee with a salary on file.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-muted border-b border-border">
                <th className="py-2 pr-3 font-semibold">Employee</th>
                <th className="py-2 px-3 font-semibold text-right">Gross</th>
                <th className="py-2 px-3 font-semibold text-right">PAYE</th>
                <th className="py-2 px-3 font-semibold text-right">Pension</th>
                <th className="py-2 px-3 font-semibold text-right">NHF</th>
                <th className="py-2 px-3 font-semibold text-right">Net</th>
                <th className="py-2 pl-3 font-semibold">Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.payslips.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="py-2 pr-3">
                    <div className="font-semibold text-text">{p.employee_name}</div>
                    {p.unpaid_leave_days > 0 && (
                      <div className="text-[10.5px] text-muted">{p.unpaid_leave_days}d unpaid · {p.working_days}d month</div>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right">{money(p.gross, ccy)}</td>
                  <td className="py-2 px-3 text-right text-muted">{money(p.paye, ccy)}</td>
                  <td className="py-2 px-3 text-right text-muted">{money(p.pension, ccy)}</td>
                  <td className="py-2 px-3 text-right text-muted">{money(p.nhf, ccy)}</td>
                  <td className="py-2 px-3 text-right font-bold text-text">{money(p.net, ccy)}</td>
                  <td className="py-2 pl-3">
                    {p.flags.length === 0 ? <span className="text-success/70">—</span> : (
                      <div className="flex flex-wrap gap-1">
                        {p.flags.map((f) => (
                          <span key={f} className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${FLAG_META[f]?.tone ?? "text-muted"}`}>
                            <AlertTriangle size={9} /> {FLAG_META[f]?.label ?? f}
                          </span>
                        ))}
                      </div>
                    )}
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

/* ---------------- Compensation ---------------- */

function CompensationTab() {
  const { data, isLoading } = useQuery<{ items: Comp[] }>({
    queryKey: ["payroll", "compensation"],
    queryFn: () => api("/api/v1/payroll/compensation"),
  });
  const [editing, setEditing] = useState<Comp | null>(null);
  const rows = data?.items ?? [];
  const setCount = useMemo(() => rows.filter((r) => r.is_set).length, [rows]);

  if (isLoading) return <div className="text-sm text-muted">Loading…</div>;
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-muted">
        {setCount} of {rows.length} active members have a salary on file. Members without one are skipped by pay runs.
      </div>
      <ul className="bg-surface border border-border rounded-2xl divide-y divide-border">
        {rows.map((r) => {
          const allowTotal = Object.values(r.allowances || {}).reduce((s, v) => s + v, 0);
          const gross = r.basic_monthly + allowTotal;
          return (
            <li key={r.user_id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-text truncate">{r.name || r.email}</div>
                <div className="text-[11px] text-muted truncate">{r.job_title || r.email}</div>
              </div>
              {r.is_set ? (
                <div className="text-right">
                  <div className="text-[13px] font-bold text-text">{money(gross, r.currency)}/mo</div>
                  <div className="text-[10.5px] text-muted">
                    basic {money(r.basic_monthly, r.currency)}
                    {r.pension_opt_in && " · pension"}{r.nhf_opt_in && " · NHF"}
                  </div>
                </div>
              ) : (
                <span className="text-[11px] italic text-muted/70">Not set</span>
              )}
              <button
                onClick={() => setEditing(r)}
                className="text-[12px] font-semibold text-accent hover:underline shrink-0"
              >
                {r.is_set ? "Edit" : "Set salary"}
              </button>
            </li>
          );
        })}
      </ul>
      {editing && <CompDialog comp={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/* ---------------- Tax settings ---------------- */

type PayBand = { size: number; rate: number };
type PayrollConfig = {
  cra_floor: number; cra_min_pct_of_gross: number; cra_gross_pct: number;
  pension_rate: number; nhf_rate: number; bands: PayBand[];
};

function SettingsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<PayrollConfig>({
    queryKey: ["payroll", "settings"],
    queryFn: () => api("/api/v1/payroll/settings"),
  });
  const [cfg, setCfg] = useState<PayrollConfig | null>(null);
  const c = cfg ?? data ?? null;

  const save = useMutation({
    mutationFn: () => api("/api/v1/payroll/settings", { method: "PUT", body: JSON.stringify(c) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "settings"] });
      toast.success("Saved", "New runs will use these rates. Existing runs are unaffected.");
      setCfg(null);
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  if (isLoading || !c) return <div className="text-sm text-muted">Loading…</div>;
  const patch = (p: Partial<PayrollConfig>) => setCfg({ ...c, ...p });
  const setBand = (i: number, b: Partial<PayBand>) => {
    const bands = c.bands.map((x, j) => (j === i ? { ...x, ...b } : x));
    patch({ bands });
  };
  const pct = (v: number) => (v * 100).toString();

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="bg-warn/5 border border-warn/30 rounded-xl px-4 py-2.5 text-[12.5px] text-text flex items-start gap-2">
        <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
        Defaults are the standard Nigerian PITA / Finance-Act figures. Only change these
        if your tax tables differ — they apply to <strong>new</strong> pay runs only;
        already-generated payslips keep their frozen numbers.
      </div>

      <section className="bg-surface border border-border rounded-2xl p-5 space-y-3">
        <h3 className="text-[11px] uppercase tracking-wider font-bold text-muted">Reliefs &amp; statutory rates</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[12px] font-semibold text-text mb-1">CRA floor (₦/yr)</div>
            <input type="number" className="input w-full" value={c.cra_floor}
              onChange={(e) => patch({ cra_floor: parseFloat(e.target.value) || 0 })} />
          </label>
          <label className="block">
            <div className="text-[12px] font-semibold text-text mb-1">CRA min % of gross</div>
            <input type="number" className="input w-full" value={pct(c.cra_min_pct_of_gross)}
              onChange={(e) => patch({ cra_min_pct_of_gross: (parseFloat(e.target.value) || 0) / 100 })} />
          </label>
          <label className="block">
            <div className="text-[12px] font-semibold text-text mb-1">CRA % of gross</div>
            <input type="number" className="input w-full" value={pct(c.cra_gross_pct)}
              onChange={(e) => patch({ cra_gross_pct: (parseFloat(e.target.value) || 0) / 100 })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Pension %</div>
              <input type="number" className="input w-full" value={pct(c.pension_rate)}
                onChange={(e) => patch({ pension_rate: (parseFloat(e.target.value) || 0) / 100 })} />
            </label>
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">NHF %</div>
              <input type="number" className="input w-full" value={pct(c.nhf_rate)}
                onChange={(e) => patch({ nhf_rate: (parseFloat(e.target.value) || 0) / 100 })} />
            </label>
          </div>
        </div>
      </section>

      <section className="bg-surface border border-border rounded-2xl p-5 space-y-3">
        <h3 className="text-[11px] uppercase tracking-wider font-bold text-muted">PAYE bands (annual, progressive)</h3>
        <p className="text-[11px] text-muted">A band size of <strong>0</strong> is the unbounded top band — everything above.</p>
        <div className="space-y-2">
          {c.bands.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-muted w-12">#{i + 1}</span>
              <label className="flex-1">
                <div className="text-[10.5px] text-muted mb-0.5">Band size (₦/yr, 0 = top)</div>
                <input type="number" className="input w-full" value={b.size}
                  onChange={(e) => setBand(i, { size: parseFloat(e.target.value) || 0 })} />
              </label>
              <label className="w-28">
                <div className="text-[10.5px] text-muted mb-0.5">Rate %</div>
                <input type="number" className="input w-full" value={(b.rate * 100).toString()}
                  onChange={(e) => setBand(i, { rate: (parseFloat(e.target.value) || 0) / 100 })} />
              </label>
              <button
                onClick={() => patch({ bands: c.bands.filter((_, j) => j !== i) })}
                className="text-muted hover:text-danger p-1.5 mt-4" title="Remove band"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            onClick={() => patch({ bands: [...c.bands, { size: 0, rate: 0.24 }] })}
            className="text-[12px] font-semibold text-accent hover:underline inline-flex items-center gap-1"
          >
            <Plus size={12} /> Add band
          </button>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !cfg}
          className="inline-flex items-center gap-1.5 text-[13px] font-bold bg-accent text-white px-5 py-2.5 rounded-full hover:bg-accent/90 disabled:opacity-50"
        >
          <Save size={14} /> {cfg ? "Save tax settings" : "Saved"}
        </button>
      </div>
    </div>
  );
}

function CompDialog({ comp, onClose }: { comp: Comp; onClose: () => void }) {
  const qc = useQueryClient();
  const [basic, setBasic] = useState(String(comp.basic_monthly || ""));
  const [housing, setHousing] = useState(String(comp.allowances?.housing ?? ""));
  const [transport, setTransport] = useState(String(comp.allowances?.transport ?? ""));
  const [other, setOther] = useState(String(comp.allowances?.other ?? ""));
  const [currency, setCurrency] = useState(comp.currency || "NGN");
  const [pension, setPension] = useState(comp.pension_opt_in);
  const [nhf, setNhf] = useState(comp.nhf_opt_in);

  const save = useMutation({
    mutationFn: () => {
      const allowances: Record<string, number> = {};
      if (parseFloat(housing) > 0) allowances.housing = parseFloat(housing);
      if (parseFloat(transport) > 0) allowances.transport = parseFloat(transport);
      if (parseFloat(other) > 0) allowances.other = parseFloat(other);
      return api(`/api/v1/payroll/compensation/${comp.user_id}`, {
        method: "PUT",
        body: JSON.stringify({
          currency,
          basic_monthly: parseFloat(basic) || 0,
          allowances,
          pension_opt_in: pension,
          nhf_opt_in: nhf,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "compensation"] });
      toast.success("Saved", `${comp.name || comp.email}'s salary updated.`);
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  const allowTotal = (parseFloat(housing) || 0) + (parseFloat(transport) || 0) + (parseFloat(other) || 0);
  const gross = (parseFloat(basic) || 0) + allowTotal;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] overflow-y-auto">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-text">Salary structure</h2>
            <p className="text-[11px] text-muted">{comp.name || comp.email}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Currency</div>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="input w-full">
                {["NGN", "USD", "EUR", "GBP"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Basic / month</div>
              <input type="number" value={basic} onChange={(e) => setBasic(e.target.value)} className="input w-full" />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Housing</div>
              <input type="number" value={housing} onChange={(e) => setHousing(e.target.value)} className="input w-full" />
            </label>
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Transport</div>
              <input type="number" value={transport} onChange={(e) => setTransport(e.target.value)} className="input w-full" />
            </label>
            <label className="block">
              <div className="text-[12px] font-semibold text-text mb-1">Other</div>
              <input type="number" value={other} onChange={(e) => setOther(e.target.value)} className="input w-full" />
            </label>
          </div>
          <div className="flex items-center gap-4 text-[12.5px]">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={pension} onChange={(e) => setPension(e.target.checked)} />
              <span className="text-text">Pension (8%)</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={nhf} onChange={(e) => setNhf(e.target.checked)} />
              <span className="text-text">NHF (2.5%)</span>
            </label>
          </div>
          <div className="bg-bg/40 border border-border rounded-xl px-3 py-2 text-[12.5px] text-muted">
            Gross monthly: <span className="font-bold text-text">{money(gross, currency)}</span>
            <div className="text-[11px] mt-0.5">PAYE, pension &amp; NHF are computed automatically on each pay run.</div>
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-border bg-bg/30 flex justify-end gap-2">
          <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-full text-muted hover:text-text">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-4 py-1.5 rounded-full hover:bg-accent/90 disabled:opacity-60"
          >
            <Save size={13} /> Save
          </button>
        </footer>
      </div>
    </div>
  );
}
