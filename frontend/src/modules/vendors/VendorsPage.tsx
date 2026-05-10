import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import {
  Handshake, Plus, Search, ShieldCheck, ShieldAlert, Clock, CheckCircle2,
  Globe, Mail, Phone, X, LayoutGrid, Rows3, AlertTriangle, Send, Copy, Link as LinkIcon,
} from "lucide-react";

type VendorStatus = "draft" | "onboarded" | "sla_signed" | "suspended";
type RiskLevel = "low" | "medium" | "high" | "critical";

type VendorRow = {
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
  created_at: string;
  document_count: number;
  service_category: string;
  risk_level: RiskLevel;
  last_activity_at: string | null;
  mandatory_missing: string[];
  can_be_assigned: boolean;
  assigned_projects_count: number;
  open_deliverables_count: number;
  performance_score: number | null;
  outstanding_balance: number;
};

const STATUS_META: Record<VendorStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  draft:      { label: "Onboarding",   cls: "bg-warn/15 text-warn",       icon: <Clock size={11} /> },
  onboarded:  { label: "Onboarded",    cls: "bg-accent-soft text-accent", icon: <CheckCircle2 size={11} /> },
  sla_signed: { label: "SLA signed",   cls: "bg-success/15 text-success", icon: <ShieldCheck size={11} /> },
  suspended:  { label: "Suspended",    cls: "bg-danger/15 text-danger",   icon: <ShieldAlert size={11} /> },
};

const KIND_LABEL: Record<string, string> = {
  consultant: "Consultant", agency: "Agency", freelancer: "Freelancer", supplier: "Supplier",
};

const RISK_META: Record<RiskLevel, { label: string; cls: string }> = {
  low:      { label: "Low",      cls: "bg-success/15 text-success" },
  medium:   { label: "Medium",   cls: "bg-warn/15 text-warn" },
  high:     { label: "High",     cls: "bg-danger/15 text-danger" },
  critical: { label: "Critical", cls: "bg-danger text-white" },
};

function FilterSelect({
  label, value, onChange, options, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">{label}</div>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface border border-border rounded-full text-[12.5px] px-3 py-1.5 focus:outline-none focus:border-accent disabled:opacity-50"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function fmtRel(iso: string | null): string {
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

function VendorTable({ rows }: { rows: VendorRow[] }) {
  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              <th className="text-left px-4 py-3">Vendor</th>
              <th className="text-left px-3 py-3">Type</th>
              <th className="text-left px-3 py-3">Contact</th>
              <th className="text-left px-3 py-3">Category</th>
              <th className="text-left px-3 py-3">Status</th>
              <th className="text-left px-3 py-3">Risk</th>
              <th className="text-right px-3 py-3">Projects</th>
              <th className="text-right px-3 py-3">Outstanding</th>
              <th className="text-left px-3 py-3">Last activity</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const sm = STATUS_META[v.status];
              const rm = RISK_META[v.risk_level];
              return (
                <tr key={v.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                  <td className="px-4 py-3 min-w-[220px]">
                    <Link to={`/vendors/${v.id}`} className="block">
                      <div className="font-bold text-text truncate">{v.name}</div>
                      {v.legal_name && <div className="text-[11px] text-muted truncate">{v.legal_name}</div>}
                      {!v.can_be_assigned && (
                        <div className="text-[10.5px] text-warn font-semibold inline-flex items-center gap-1 mt-0.5">
                          <AlertTriangle size={10} /> Missing {v.mandatory_missing.length} required doc{v.mandatory_missing.length === 1 ? "" : "s"}
                        </div>
                      )}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted">{KIND_LABEL[v.kind] ?? v.kind}</td>
                  <td className="px-3 py-3 min-w-[180px]">
                    <div className="text-text truncate">{v.contact_name || "—"}</div>
                    <div className="text-[11px] text-muted truncate">{v.contact_email || ""}</div>
                  </td>
                  <td className="px-3 py-3 text-muted">{v.service_category ? v.service_category.replace(/_/g, " ") : "—"}</td>
                  <td className="px-3 py-3"><span className={`pill ${sm.cls}`}>{sm.icon}{sm.label}</span></td>
                  <td className="px-3 py-3"><span className={`pill ${rm.cls}`}>{rm.label}</span></td>
                  <td className="px-3 py-3 text-right text-muted">{v.assigned_projects_count}</td>
                  <td className="px-3 py-3 text-right text-muted">{v.outstanding_balance > 0 ? v.outstanding_balance.toLocaleString() : "—"}</td>
                  <td className="px-3 py-3 text-[11px] text-muted whitespace-nowrap">{fmtRel(v.last_activity_at ?? v.created_at)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <Link to={`/vendors/${v.id}`} className="text-xs font-semibold text-accent hover:underline">Open →</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VendorsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: VendorRow[] }>({
    queryKey: ["vendors"], queryFn: () => api("/api/v1/vendors"),
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | VendorStatus>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | RiskLevel>("all");
  const [view, setView] = useState<"table" | "cards">("table");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteByLinkOpen, setInviteByLinkOpen] = useState(false);

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    let list = items;
    if (statusFilter !== "all")   list = list.filter((v) => v.status === statusFilter);
    if (kindFilter !== "all")     list = list.filter((v) => v.kind === kindFilter);
    if (categoryFilter !== "all") list = list.filter((v) => v.service_category === categoryFilter);
    if (riskFilter !== "all")     list = list.filter((v) => v.risk_level === riskFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((v) =>
        v.name.toLowerCase().includes(q) ||
        v.legal_name.toLowerCase().includes(q) ||
        v.contact_name.toLowerCase().includes(q) ||
        v.contact_email.toLowerCase().includes(q) ||
        v.competencies.some((c) => c.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [items, query, statusFilter, kindFilter, categoryFilter, riskFilter]);

  // Distinct categories present so the filter dropdown is honest about what exists.
  const categories = useMemo(() =>
    Array.from(new Set(items.map((v) => v.service_category).filter(Boolean))).sort(),
  [items]);

  const counts = useMemo(() => {
    const c: Record<VendorStatus | "all", number> = {
      all: items.length, draft: 0, onboarded: 0, sla_signed: 0, suspended: 0,
    };
    items.forEach((v) => { c[v.status]++; });
    return c;
  }, [items]);

  const create = useMutation({
    mutationFn: (body: Partial<VendorRow>) =>
      api<{ id: string }>("/api/v1/vendors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success("Vendor added", "They'll appear with status Onboarding until profile docs land.");
      qc.invalidateQueries({ queryKey: ["vendors"] });
      setCreateOpen(false);
    },
    onError: (e: Error) => toast.error("Could not add vendor", e.message),
  });

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Partners</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <Handshake size={26} className="text-accent" /> Vendors
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Sub-contractors, consultants and suppliers you outsource delivery to. Onboard each one with
            profile, competencies, and a signed SLA before they can be staffed onto a project.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SmartButton variant="outline" onClick={() => setInviteByLinkOpen(true)} icon={<Send size={14} />}>
            Invite by link
          </SmartButton>
          <SmartButton variant="primary" onClick={() => setCreateOpen(true)} icon={<Plus size={14} />}>
            Add vendor
          </SmartButton>
        </div>
      </header>

      {/* Status pills */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["all","sla_signed","onboarded","draft","suspended"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setStatusFilter(k)}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-full transition-colors ${
              statusFilter === k ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {k === "all" ? "All" : STATUS_META[k].label}
            <span className="ml-1.5 opacity-70">{k === "all" ? counts.all : counts[k]}</span>
          </button>
        ))}
      </div>

      {/* Filter toolbar */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex flex-wrap gap-2 items-end">
          <FilterSelect label="Vendor type" value={kindFilter} onChange={setKindFilter}
            options={[{ value: "all", label: "All types" }, ...Object.entries(KIND_LABEL).map(([v, l]) => ({ value: v, label: l }))]}
          />
          <FilterSelect label="Service category" value={categoryFilter} onChange={setCategoryFilter}
            options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))]}
            disabled={categories.length === 0}
          />
          <FilterSelect label="Risk level" value={riskFilter} onChange={(v) => setRiskFilter(v as "all" | RiskLevel)}
            options={[
              { value: "all", label: "Any risk" },
              { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
              { value: "high", label: "High" }, { value: "critical", label: "Critical" },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search vendors…"
              className="pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-full w-[240px] focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex gap-1 p-1 bg-surface border border-border rounded-full" title="Toggle layout">
            <button onClick={() => setView("table")}
              className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "table" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
              aria-label="Table view"><Rows3 size={13} /></button>
            <button onClick={() => setView("cards")}
              className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "cards" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
              aria-label="Card view"><LayoutGrid size={13} /></button>
          </div>
        </div>
      </div>

      {/* Result body */}
      {isLoading ? (
        <div className="text-muted">Loading vendors…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
            <Handshake size={22} />
          </div>
          <div className="text-base font-bold text-text">
            {items.length === 0 ? "No vendors yet" : "Nothing matches those filters"}
          </div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            {items.length === 0
              ? "Add your sub-contractors and consultants here. They become staffable on projects once they're onboarded."
              : "Try clearing the filters or the search term."}
          </p>
        </div>
      ) : view === "cards" ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {filtered.map((v) => <VendorCard key={v.id} v={v} />)}
        </div>
      ) : (
        <VendorTable rows={filtered} />
      )}

      {createOpen && (
        <CreateVendorDialog
          submitting={create.isPending}
          onClose={() => setCreateOpen(false)}
          onCreate={(body) => create.mutate(body)}
        />
      )}
      {inviteByLinkOpen && (
        <InviteByLinkDialog
          onClose={() => setInviteByLinkOpen(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ["vendors"] })}
        />
      )}
    </div>
  );
}

function VendorCard({ v }: { v: VendorRow }) {
  const meta = STATUS_META[v.status];
  return (
    <Link
      to={`/vendors/${v.id}`}
      className="bg-surface border border-border rounded-2xl p-4 hover:border-accent transition-colors block"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text truncate" title={v.name}>{v.name}</div>
          <div className="text-[11px] text-muted">
            {KIND_LABEL[v.kind] ?? v.kind}
            {v.country && <> · {v.country}</>}
          </div>
        </div>
        <span className={`pill ${meta.cls} shrink-0`}>{meta.icon}{meta.label}</span>
      </div>
      {v.competencies.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {v.competencies.slice(0, 4).map((c) => (
            <span key={c} className="text-[10.5px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-bg border border-border text-muted">
              {c}
            </span>
          ))}
          {v.competencies.length > 4 && (
            <span className="text-[10.5px] text-muted">+{v.competencies.length - 4}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted mt-3 pt-3 border-t border-border">
        <span className="truncate">{v.contact_email || "no contact"}</span>
        <span className="shrink-0">{v.document_count} doc{v.document_count === 1 ? "" : "s"}</span>
      </div>
    </Link>
  );
}

/* ---------------- Create vendor dialog ---------------- */

const COMPETENCY_OPTIONS = [
  "engineering", "design", "compliance", "security", "data", "infrastructure",
  "legal", "finance", "training", "research", "translation", "logistics",
];

function CreateVendorDialog({
  submitting, onClose, onCreate,
}: {
  submitting: boolean;
  onClose: () => void;
  onCreate: (body: Partial<VendorRow>) => void;
}) {
  const [form, setForm] = useState({
    name: "", legal_name: "", kind: "consultant", contact_name: "",
    contact_email: "", contact_phone: "", website: "", country: "Nigeria",
    notes: "",
    competencies: [] as string[],
    service_category: "",
    risk_level: "low" as RiskLevel,
  });
  const CATS = ["engineering", "design", "compliance_advisory", "training", "research", "logistics", "infrastructure", "legal", "finance", "translation"];
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const toggleComp = (c: string) =>
    setForm((f) => ({
      ...f,
      competencies: f.competencies.includes(c)
        ? f.competencies.filter((x) => x !== c)
        : [...f.competencies, c],
    }));
  const valid = form.name.trim().length > 1;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between gap-3 p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center">
              <Handshake size={16} />
            </div>
            <div>
              <h2 className="text-base font-bold text-text">Add a vendor</h2>
              <p className="text-xs text-muted mt-0.5">
                Just the basics now — you'll attach docs and sign the SLA on the vendor page.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Vendor name *</div>
              <input className="input" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Lagos Compliance Partners" />
            </label>
            <label className="block">
              <div className="label">Legal entity</div>
              <input className="input" value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder="Lagos Compliance Partners Ltd" />
            </label>
            <label className="block">
              <div className="label">Kind</div>
              <select className="input" value={form.kind} onChange={(e) => set("kind", e.target.value)}>
                {Object.entries(KIND_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Service category</div>
              <select className="input" value={form.service_category} onChange={(e) => set("service_category", e.target.value)}>
                <option value="">— pick later —</option>
                {CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Country</div>
              <input className="input" value={form.country} onChange={(e) => set("country", e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Initial risk level</div>
              <select className="input" value={form.risk_level} onChange={(e) => set("risk_level", e.target.value as RiskLevel)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block md:col-span-2">
              <div className="label">Website</div>
              <input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
            </label>
            <label className="block">
              <div className="label">Contact name</div>
              <input className="input" value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Contact email</div>
              <input className="input" type="email" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <div className="label">Contact phone</div>
              <input className="input" value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
            </label>
          </div>
          <div>
            <div className="label">Competencies</div>
            <div className="flex flex-wrap gap-1.5">
              {COMPETENCY_OPTIONS.map((c) => {
                const active = form.competencies.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleComp(c)}
                    className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                      active
                        ? "bg-accent text-white border-accent"
                        : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted mt-1.5">
              Tag what they can deliver — used by the wizard to match vendors to suggested team roles.
            </p>
          </div>
          <label className="block">
            <div className="label">Notes</div>
            <textarea className="input" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Where you found them, past work, anything worth remembering." />
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!valid || submitting}
            loading={submitting}
            onClick={() => onCreate(form)}
            icon={<Plus size={13} />}
          >
            Add vendor
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ---------------- Invite-by-link ---------------- *
 *
 * One-step flow: skip the "fill in everything yourself" form and just send a
 * link to the vendor with a stub record (name + kind only). The vendor fills
 * the rest via the public /vendor-invite/:token page.
 *
 * Two API calls behind the scenes — POST /vendors then POST /vendors/:id/invite —
 * but the UX is a single dialog with two states (form, then result with link).
 */
function InviteByLinkDialog({
  onClose, onSuccess,
}: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName]   = useState("");
  const [kind, setKind]   = useState("consultant");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(
    "Hi — please complete your vendor onboarding via this secure link. " +
    "It takes a few minutes: contact info, competencies, and the standard documents " +
    "(company profile, tax cert, MSA, SLA)."
  );
  const [busy, setBusy]       = useState(false);
  const [result, setResult]   = useState<{ vendorId: string; vendorName: string; token: string; expires_at: string } | null>(null);
  const [err, setErr]         = useState<string | null>(null);
  const valid = name.trim().length > 1 && /\S+@\S+\.\S+/.test(email);

  async function handleSend() {
    setBusy(true); setErr(null);
    try {
      // Step 1 — create the draft vendor with the bare minimum.
      const created = await api<{ id: string }>("/api/v1/vendors", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(), kind,
          contact_email: email.trim(),
          competencies: [],
        }),
      });
      // Step 2 — mint the invite token immediately.
      const invite = await api<{ token: string; expires_at: string }>(
        `/api/v1/vendors/${created.id}/invite`,
        { method: "POST", body: JSON.stringify({ email: email.trim(), message: message.trim() || undefined }) },
      );
      setResult({ vendorId: created.id, vendorName: name.trim(), token: invite.token, expires_at: invite.expires_at });
      onSuccess();
      toast.success("Invite ready", "Copy the link or open your email client to send it.");
    } catch (e) {
      const msg = (e as Error)?.message ?? "Something went wrong.";
      setErr(msg);
      toast.error("Could not create invite", msg);
    } finally {
      setBusy(false);
    }
  }

  const url = result ? `${window.location.origin}/vendor-invite/${result.token}` : "";
  const handleCopy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast.success("Link copied"); }
    catch { toast.error("Copy failed", "Select the link manually."); }
  };
  const mailto = result
    ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Complete your vendor onboarding for ${result.vendorName}`)}&body=${encodeURIComponent(`${message}\n\n${url}\n\nThis link expires on ${new Date(result.expires_at).toLocaleDateString()}.`)}`
    : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center"><Send size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">{result ? "Invite ready to send" : "Invite a vendor by link"}</h2>
              <p className="text-xs text-muted mt-0.5">
                {result
                  ? "Copy the link or open your mail client. The vendor doesn't need an account."
                  : "We'll create a draft vendor record and mint a secure link they can use to complete onboarding."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>

        {result ? (
          <div className="p-5 space-y-4">
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12.5px]">
              <div className="text-muted">Draft vendor created</div>
              <div className="text-text font-semibold">{result.vendorName}</div>
              <Link to={`/vendors/${result.vendorId}`} className="text-[11.5px] text-accent hover:underline">
                Open vendor page →
              </Link>
            </div>
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
                Expires {new Date(result.expires_at).toLocaleDateString()} · single-use · revocable any time from the vendor page.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              <span className="font-semibold text-text">Heads up:</span> email isn't auto-sent yet — copy the link or use the mail-client button to dispatch it.
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <div className="label">Vendor name *</div>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lagos Compliance Partners" />
              </label>
              <label className="block">
                <div className="label">Kind</div>
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {Object.entries(KIND_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                </select>
              </label>
            </div>
            <label className="block">
              <div className="label">Vendor email *</div>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello@vendor.com" />
              <div className="text-[11px] text-muted mt-1">The link will go to this address.</div>
            </label>
            <label className="block">
              <div className="label">Message (optional)</div>
              <textarea className="input" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
              The link is good for 14 days, single-use. The vendor's full profile is filled in by them — you'll see it land here once they submit.
            </div>
            {err && <div className="text-xs text-danger">{err}</div>}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          {result ? (
            <>
              <button onClick={onClose} className="btn-ghost">Done</button>
              <a href={mailto} className="btn-primary inline-flex items-center" style={{ textDecoration: "none" }}>
                <Mail size={13} /> Open in mail client
              </a>
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn-ghost">Cancel</button>
              <SmartButton
                variant="primary"
                disabled={!valid || busy}
                loading={busy}
                onClick={handleSend}
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

/* placeholder so unused-warning settles */
export const _vendorIcons = { Globe, Mail, Phone };
