import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Receipt, Search, FolderKanban, ArrowLeft } from "lucide-react";

type Invoice = {
  id: string;
  number: string;
  amount: number;
  paid: number;
  outstanding: number;
  currency: string;
  status: "draft" | "issued" | "partially_paid" | "paid" | "void";
  due_on: string | null;
  issued_on: string | null;
  project_id: string | null;
  project_name: string;
  project_code: string;
};

const STATUS_META: Record<Invoice["status"], { label: string; cls: string }> = {
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
  const { data, isLoading } = useQuery<{ items: Invoice[] }>({
    queryKey: ["invoices"], queryFn: () => api("/api/v1/finance/invoices"),
  });

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Invoice["status"]>("all");

  const items = data?.items ?? [];
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
                ? "Invoices are created from a project's milestones. Once issued, they show up here."
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
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => {
                  const meta = STATUS_META[i.status];
                  const overdue = i.due_on && new Date(i.due_on) < new Date() && i.outstanding > 0;
                  return (
                    <tr key={i.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                      <td className="px-4 py-3 font-mono font-bold text-text">{i.number}</td>
                      <td className="px-3 py-3">
                        {i.project_id ? (
                          <Link to={`/projects/${i.project_id}`} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                            <FolderKanban size={12} /> {i.project_name}
                          </Link>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                        {i.project_code && <div className="text-[10.5px] text-muted">{i.project_code}</div>}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`pill ${meta.cls}`}>{meta.label}</span>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-text">{fmtMoney(i.amount, i.currency)}</td>
                      <td className="px-3 py-3 text-right text-success">{fmtMoney(i.paid, i.currency)}</td>
                      <td className={`px-3 py-3 text-right font-semibold ${i.outstanding > 0 ? "text-warn" : "text-muted"}`}>
                        {fmtMoney(i.outstanding, i.currency)}
                      </td>
                      <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{fmtDate(i.issued_on)}</td>
                      <td className={`px-3 py-3 text-[12px] whitespace-nowrap ${overdue ? "text-danger font-semibold" : "text-muted"}`}>
                        {fmtDate(i.due_on)}{overdue && <span className="ml-1">·overdue</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
