import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import {
  Receipt, Search, FolderKanban, ArrowLeft, Sparkles, FileText, X, Plus,
  ArrowDownToLine, Send, Ban, ChevronRight, AlertTriangle, Briefcase,
} from "lucide-react";

type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void";

type Invoice = {
  id: string;
  number: string;
  amount: number;
  paid: number;
  outstanding: number;
  currency: string;
  status: InvoiceStatus;
  due_on: string | null;
  issued_on: string | null;
  project_id: string | null;
  project_name: string;
  project_code: string;
};

type Billable = {
  kind: "opportunity" | "milestone";
  id: string;
  title: string;
  suggested_amount: number;
  currency: string;
  project_id: string | null;
  project_name: string;
  project_code: string;
  due_on: string | null;
  reason: string;
  existing_invoices: number;
};

const STATUS_META: Record<InvoiceStatus, { label: string; cls: string }> = {
  draft:          { label: "Draft",   cls: "bg-bg text-muted border border-border" },
  issued:         { label: "Issued",  cls: "bg-accent-soft text-accent" },
  partially_paid: { label: "Partial", cls: "bg-warn/15 text-warn" },
  paid:           { label: "Paid",    cls: "bg-success/15 text-success" },
  void:           { label: "Void",    cls: "bg-danger/15 text-danger" },
};

const CCY_SYMBOL: Record<string, string> = {
  NGN: "₦", USD: "$", EUR: "€", GBP: "£", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA",
};
function fmtMoney(amount: number, ccy: string): string {
  const sym = CCY_SYMBOL[ccy] ?? `${ccy} `;
  return `${sym}${Math.round(amount).toLocaleString()}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function InvoicesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: Invoice[] }>({
    queryKey: ["invoices"], queryFn: () => api("/api/v1/finance/invoices"),
  });
  const { data: billableData } = useQuery<{ items: Billable[] }>({
    queryKey: ["finance", "billable"], queryFn: () => api("/api/v1/finance/billable"),
  });

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | InvoiceStatus>("all");
  const [createFor, setCreateFor] = useState<Billable | null>(null);
  const [recordFor, setRecordFor] = useState<Invoice | null>(null);

  const items = data?.items ?? [];
  const billable = billableData?.items ?? [];

  const filtered = useMemo(() => {
    let list = items;
    if (statusFilter !== "all") list = list.filter((i) => i.status === statusFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((i) =>
        i.number.toLowerCase().includes(q) ||
        i.project_name.toLowerCase().includes(q) ||
        i.project_code.toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, statusFilter, query]);

  const counts = useMemo(() => {
    const c = { all: items.length, draft: 0, issued: 0, partially_paid: 0, paid: 0, void: 0 };
    items.forEach((i) => { c[i.status]++; });
    return c;
  }, [items]);

  const setStatus = useMutation({
    mutationFn: ({ id, status, due_on }: { id: string; status: "draft" | "issued" | "void"; due_on?: string }) =>
      api(`/api/v1/finance/invoices/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, due_on }),
      }),
    onSuccess: () => {
      toast.success("Invoice updated");
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["finance", "summary"] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error).message;
      toast.error("Could not update invoice", msg);
    },
  });

  return (
    <div className="space-y-5 max-w-7xl">
      <Link to="/finance" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft size={14} /> Back to finance
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Cash position</div>
        <h1 className="h1 mt-1 flex items-center gap-2">
          <Receipt size={26} className="text-accent" /> Invoices
        </h1>
        <p className="text-sm text-muted mt-1">
          Every invoice issued from a project, with collection state and outstanding balance.
        </p>
      </header>

      {/* Action queue — what finance should do right now */}
      {billable.length > 0 && (
        <section className="bg-accent-soft/40 border border-accent/30 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-accent text-white grid place-items-center shrink-0">
                <Sparkles size={16} />
              </div>
              <div>
                <h2 className="h2">Ready to invoice</h2>
                <p className="text-xs text-muted mt-0.5">
                  {billable.length} item{billable.length === 1 ? "" : "s"} where work has been delivered or accepted but not yet billed.
                  Click to draft an invoice with the suggested amount.
                </p>
              </div>
            </div>
          </div>
          <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
            {billable.map((b) => (
              <li key={`${b.kind}-${b.id}`}>
                <button
                  onClick={() => setCreateFor(b)}
                  className="w-full text-left bg-surface border border-border rounded-xl p-3 hover:border-accent transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {b.kind === "opportunity"
                        ? <Briefcase size={11} className="text-accent shrink-0" />
                        : <FolderKanban size={11} className="text-accent shrink-0" />}
                      <span className="text-[10px] uppercase tracking-wider font-bold text-accent shrink-0">
                        {b.kind === "opportunity" ? "Pipeline lead" : "Project milestone"}
                      </span>
                    </div>
                    <span className="text-[13px] font-extrabold text-text whitespace-nowrap shrink-0">
                      {fmtMoney(b.suggested_amount, b.currency)}
                    </span>
                  </div>
                  <div className="text-[13.5px] font-bold text-text truncate" title={b.title}>{b.title}</div>
                  <div className="text-[11.5px] text-muted truncate">
                    {b.project_name && <>{b.project_name} · </>}{b.reason}
                  </div>
                  <div className="text-[11px] font-semibold text-accent mt-2 inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Plus size={10} /> Draft invoice <ChevronRight size={10} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 p-1 bg-surface border border-border rounded-full">
          {(["all", "issued", "partially_paid", "paid", "draft", "void"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setStatusFilter(k)}
              className={`text-[12px] font-semibold px-3 py-1.5 rounded-full transition-colors ${
                statusFilter === k ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              {k === "all" ? "All" : STATUS_META[k].label}
              <span className="ml-1.5 opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by number, project…"
            className="pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-full w-[260px] focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Invoice table */}
      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-muted">Loading invoices…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-2">
              <Receipt size={20} />
            </div>
            <div className="text-base font-bold text-text">
              {items.length === 0 ? "No invoices yet" : "Nothing matches"}
            </div>
            <p className="text-sm text-muted mt-1 max-w-md mx-auto">
              {items.length === 0
                ? billable.length > 0
                  ? "There's billable work waiting at the top of this page — draft your first invoice from the queue."
                  : "Invoices appear here when they're created from a project. The pipeline at risk on the finance page shows what's still in flight."
                : "Try clearing the filters or search."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
                <tr>
                  <th className="text-left px-4 py-3">Number</th>
                  <th className="text-left px-3 py-3">Project</th>
                  <th className="text-left px-3 py-3">Status</th>
                  <th className="text-right px-3 py-3">Amount</th>
                  <th className="text-right px-3 py-3">Paid</th>
                  <th className="text-right px-3 py-3">Outstanding</th>
                  <th className="text-left px-3 py-3">Issued</th>
                  <th className="text-left px-3 py-3">Due</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => {
                  const meta = STATUS_META[i.status];
                  const overdue = !!(i.due_on && new Date(i.due_on) < new Date() && i.outstanding > 0);
                  return (
                    <tr key={i.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                      <td className="px-4 py-3 font-mono font-bold text-text">{i.number}</td>
                      <td className="px-3 py-3">
                        {i.project_id ? (
                          <Link to={`/projects/${i.project_id}`} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                            <FolderKanban size={12} /> {i.project_name}
                          </Link>
                        ) : <span className="text-muted">—</span>}
                        {i.project_code && <div className="text-[10.5px] text-muted">{i.project_code}</div>}
                      </td>
                      <td className="px-3 py-3"><span className={`pill ${meta.cls}`}>{meta.label}</span></td>
                      <td className="px-3 py-3 text-right font-semibold text-text">{fmtMoney(i.amount, i.currency)}</td>
                      <td className="px-3 py-3 text-right text-success">{fmtMoney(i.paid, i.currency)}</td>
                      <td className={`px-3 py-3 text-right font-semibold ${i.outstanding > 0 ? "text-warn" : "text-muted"}`}>
                        {fmtMoney(i.outstanding, i.currency)}
                      </td>
                      <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{fmtDate(i.issued_on)}</td>
                      <td className={`px-3 py-3 text-[12px] whitespace-nowrap ${overdue ? "text-danger font-semibold" : "text-muted"}`}>
                        {fmtDate(i.due_on)}{overdue && <span className="ml-1">·overdue</span>}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <RowActions invoice={i} onRecord={() => setRecordFor(i)} onStatus={(s) => setStatus.mutate({ id: i.id, status: s })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createFor && (
        <CreateInvoiceDialog
          billable={createFor}
          onClose={() => setCreateFor(null)}
          onCreated={() => {
            setCreateFor(null);
            qc.invalidateQueries({ queryKey: ["invoices"] });
            qc.invalidateQueries({ queryKey: ["finance", "billable"] });
            qc.invalidateQueries({ queryKey: ["finance", "summary"] });
          }}
        />
      )}
      {recordFor && (
        <RecordPaymentDialog
          invoice={recordFor}
          onClose={() => setRecordFor(null)}
          onRecorded={() => {
            setRecordFor(null);
            qc.invalidateQueries({ queryKey: ["invoices"] });
            qc.invalidateQueries({ queryKey: ["finance", "summary"] });
          }}
        />
      )}
    </div>
  );
}

/* ---------- Row actions ---------- */

function RowActions({
  invoice, onRecord, onStatus,
}: {
  invoice: Invoice;
  onRecord: () => void;
  onStatus: (s: "draft" | "issued" | "void") => void;
}) {
  const canRecordPayment = invoice.status === "issued" || invoice.status === "partially_paid";
  return (
    <div className="inline-flex items-center gap-1">
      {invoice.status === "draft" && (
        <button onClick={() => onStatus("issued")} className="text-muted hover:text-accent p-1" title="Issue this invoice">
          <Send size={13} />
        </button>
      )}
      {canRecordPayment && (
        <button onClick={onRecord} className="text-muted hover:text-success p-1" title="Record a payment">
          <ArrowDownToLine size={13} />
        </button>
      )}
      {invoice.status !== "void" && invoice.status !== "paid" && (
        <button
          onClick={() => { if (confirm(`Void invoice ${invoice.number}? This can't be undone in the UI.`)) onStatus("void"); }}
          className="text-muted hover:text-danger p-1"
          title="Void this invoice"
        >
          <Ban size={13} />
        </button>
      )}
    </div>
  );
}

/* ---------- Create-invoice dialog (from billable queue) ---------- */

function CreateInvoiceDialog({
  billable, onClose, onCreated,
}: {
  billable: Billable;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [number, setNumber] = useState(`INV-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`);
  const [amount, setAmount] = useState<number>(Math.round(billable.suggested_amount));
  const [issued, setIssued] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [issueImmediately, setIssueImmediately] = useState(true);

  const create = useMutation({
    mutationFn: async () => {
      if (!billable.project_id) {
        throw new Error("This billable item has no project linked. Convert the opportunity to a project first.");
      }
      const inv = await api<{ id: string }>("/api/v1/finance/invoices", {
        method: "POST",
        body: JSON.stringify({
          project_id: billable.project_id,
          milestone_id: billable.kind === "milestone" ? billable.id : undefined,
          number, amount, currency: billable.currency,
          issued_on: issued, due_on: due,
        }),
      });
      // If the user wants it issued straight away, transition out of draft.
      if (issueImmediately) {
        await api(`/api/v1/finance/invoices/${inv.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "issued", due_on: due }),
        });
      }
      return inv;
    },
    onSuccess: () => {
      toast.success("Invoice created", issueImmediately ? "Issued and ready to chase." : "Saved as draft.");
      onCreated();
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not create invoice", msg);
    },
  });

  const valid = number.trim().length > 1 && amount > 0 && !!billable.project_id;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-start justify-between p-5 border-b border-border gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0"><Receipt size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">Draft an invoice</h2>
              <p className="text-xs text-muted mt-0.5">
                {billable.kind === "opportunity" ? "From opportunity" : "From milestone"}: <span className="font-semibold text-text">{billable.title}</span>
              </p>
              {billable.project_name && (
                <p className="text-[11px] text-muted mt-0.5">on {billable.project_name}</p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          {!billable.project_id && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-[12px] text-text">
              <div className="font-semibold inline-flex items-center gap-1.5 text-warn">
                <AlertTriangle size={13} /> No project linked
              </div>
              Move this opportunity to <span className="font-mono">planning</span> stage first — that converts it to a project that invoices can attach to.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Invoice number *</div>
              <input className="input font-mono" value={number} onChange={(e) => setNumber(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Amount ({billable.currency}) *</div>
              <input className="input text-right" type="number" min={0} step="0.01"
                value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} />
            </label>
            <label className="block">
              <div className="label">Issued on</div>
              <input className="input" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Due on</div>
              <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={issueImmediately} onChange={(e) => setIssueImmediately(e.target.checked)} />
            <span>Issue immediately (skip draft)</span>
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!valid}
            loadingLabel="Creating…"
            successLabel="Created"
            icon={<Plus size={13} />}
            onClick={() => create.mutateAsync()}
          >
            {issueImmediately ? "Create & issue" : "Save draft"}
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ---------- Record payment dialog ---------- */

function RecordPaymentDialog({
  invoice, onClose, onRecorded,
}: {
  invoice: Invoice;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState<number>(invoice.outstanding);
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState("");

  const record = useMutation({
    mutationFn: () => api(`/api/v1/finance/payments`, {
      method: "POST",
      body: JSON.stringify({
        invoice_id: invoice.id,
        amount, paid_on: paidOn, method, reference,
      }),
    }),
    onSuccess: () => {
      toast.success("Payment recorded");
      onRecorded();
    },
    onError: (e: Error) => toast.error("Could not record payment", e.message),
  });

  const valid = amount > 0 && amount <= invoice.outstanding && !!paidOn;
  const overpay = amount > invoice.outstanding;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-start justify-between p-5 border-b border-border gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-success/15 text-success grid place-items-center shrink-0"><ArrowDownToLine size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">Record payment</h2>
              <p className="text-xs text-muted mt-0.5">
                Against <span className="font-mono font-bold">{invoice.number}</span> · outstanding {fmtMoney(invoice.outstanding, invoice.currency)}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Amount ({invoice.currency}) *</div>
              <input className="input text-right" type="number" min={0} step="0.01"
                value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} />
              {overpay && <div className="text-[11px] text-warn mt-1">Exceeds outstanding balance — record only what was actually received.</div>}
            </label>
            <label className="block">
              <div className="label">Paid on *</div>
              <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Method</div>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="bank_transfer">Bank transfer</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Reference</div>
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. txn id" />
            </label>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!valid}
            loadingLabel="Recording…"
            successLabel="Recorded"
            icon={<ArrowDownToLine size={13} />}
            onClick={() => record.mutateAsync()}
          >
            Record payment
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// keep the FileText import alive for future rich-doc preview, suppress unused warning
void FileText;
