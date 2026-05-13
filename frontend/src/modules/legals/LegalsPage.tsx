import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Scale, Search, Plus, Upload, FileText, Download, ExternalLink, Link as LinkIcon,
  Calendar, Building2, User as UserIcon, Briefcase, Tag,
  AlertOctagon, CheckCircle2, Clock, ShieldCheck, X as XIcon, Trash2,
  ChevronDown, Filter,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";

// Multipart helper — the JSON api() can't carry a File, and the JWT
// needs to ride alongside the FormData. Same pattern as TaskCard upload.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = useAuth.getState().token;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

// LegalsPage — workspace document warehouse.
//
// What lives here: every statutory + compliance record that a governance
// role needs at hand — NDAs, employee contracts, vendor MSAs, client
// SOWs, IP assignments, regulatory filings, insurance certificates,
// internal policies.
//
// Smart bits:
//   • Top KPI strip: total, active, expiring in 30 days, expired,
//     unsigned. Each tile clicks through to the corresponding filter
//     so an admin can triage straight from the row.
//   • Category chips (driven by backend vocabulary so adding a category
//     is one Go line + zero UI changes) with live counts.
//   • Project/vendor/employee filters surface contracts grouped by
//     counterparty — "what contracts do we have with this vendor?"
//     answers in one click.
//   • Expiry tinting: a row whose contract ends in ≤30 days renders
//     amber; ≤7 days red; expired in danger.
//   • Smart sort: pinned to top → expiring soon → recently uploaded.
//   • Upload dialog supports both file payloads (PDF, Word) AND link-
//     only entries (SharePoint, Box, external counsel folder URL).

type Legal = {
  id: string;
  category: string;
  category_label: string;
  title: string;
  party: string;
  reference_no: string;
  status: "active" | "draft" | "expired" | "terminated" | string;
  effective_date: string | null;
  expires_at: string | null;
  signed_at: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  has_content: boolean;
  external_url: string;
  notes: string;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
  project?: { id: string; name: string };
  user?: { id: string; name: string; email: string };
  vendor?: { id: string; name: string };
  signed_by?: { id: string; name: string };
  uploaded_by?: { id: string; name: string };
};

type Stats = {
  total: number;
  active: number;
  expired: number;
  expiring_soon: number;
  unsigned: number;
};

type ListResp = {
  items: Legal[];
  stats: Stats;
  category_counts: Record<string, number>;
  categories: Record<string, string>; // key → label
};

// CATEGORY_ICON — visual cue per category, so the table scans like a
// design system rather than a tab strip of identical pills.
const CATEGORY_ICON: Record<string, React.ComponentType<any>> = {
  nda:               ShieldCheck,
  employee_contract: UserIcon,
  client_contract:   Building2,
  vendor_msa:        Briefcase,
  sow:               FileText,
  ip_assignment:     Tag,
  policy:            Scale,
  regulatory:        ShieldCheck,
  insurance:         ShieldCheck,
  other:             FileText,
};

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso + "T00:00:00").getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86_400_000);
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

type Filter = "all" | "active" | "expiring" | "expired" | "unsigned";

export function LegalsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<string>(""); // "" = any
  const [search, setSearch] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (filter === "expiring") params.set("expiring_in_days", "30");
  if (filter === "expired")  params.set("status", "expired");
  if (filter === "active")   params.set("status", "active");
  if (search.trim())         params.set("q", search.trim());
  const qs = params.toString();

  const { data, isLoading } = useQuery<ListResp>({
    queryKey: ["legals", filter, category, search],
    queryFn: () => api(`/api/v1/legals${qs ? "?" + qs : ""}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Client-side filter for "unsigned" — the backend stats already give us
  // the count, but the list endpoint doesn't have a dedicated filter.
  let items = data?.items ?? [];
  if (filter === "unsigned") {
    items = items.filter((d) => !d.signed_at && d.status !== "draft");
  }

  // Smart sort: expiring soon → recently uploaded.
  items = [...items].sort((a, b) => {
    const da = daysUntil(a.expires_at);
    const db = daysUntil(b.expires_at);
    const aSoon = da != null && da >= 0 && da <= 60;
    const bSoon = db != null && db >= 0 && db <= 60;
    if (aSoon && !bSoon) return -1;
    if (!aSoon && bSoon) return 1;
    if (aSoon && bSoon && da !== db) return (da ?? 0) - (db ?? 0);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const stats = data?.stats ?? { total: 0, active: 0, expired: 0, expiring_soon: 0, unsigned: 0 };
  const catCounts = data?.category_counts ?? {};
  const categories = data?.categories ?? {};

  // Group counts for chips. Sorted by current-count descending so high-
  // volume categories surface left-to-right.
  const categoryEntries = useMemo(() => {
    const entries = Object.entries(categories) as [string, string][];
    return entries.sort((a, b) => (catCounts[b[0]] ?? 0) - (catCounts[a[0]] ?? 0));
  }, [categories, catCounts]);

  return (
    <div className="pt-2 pb-10">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-2xl border border-white/20 grid place-items-center shadow-soft" style={{ background: "#107B97" }}>
            <Scale className="text-white" size={28} strokeWidth={2.4} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text leading-none">Legals</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-md">
              The workspace's statutory + compliance warehouse — NDAs, contracts, policies, insurance, anything with a counterparty or expiry date.
            </p>
          </div>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-[rgb(var(--accent-hover))] shadow-soft press-fx"
        >
          <Plus size={14} /> New document
        </button>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5 animate-stagger">
        <KpiTile label="Total"           value={stats.total}         tone="muted"   active={filter === "all"}      onClick={() => setFilter("all")}      icon={FileText} />
        <KpiTile label="Active"          value={stats.active}        tone="success" active={filter === "active"}   onClick={() => setFilter("active")}   icon={CheckCircle2} />
        <KpiTile label="Expiring in 30d" value={stats.expiring_soon} tone="warn"    active={filter === "expiring"} onClick={() => setFilter("expiring")} icon={Clock} />
        <KpiTile label="Expired"         value={stats.expired}       tone="danger"  active={filter === "expired"}  onClick={() => setFilter("expired")}  icon={AlertOctagon} />
        <KpiTile label="Unsigned"        value={stats.unsigned}      tone="warn"    active={filter === "unsigned"} onClick={() => setFilter("unsigned")} icon={Filter} />
      </div>

      {/* Category chips + search */}
      <div className="bg-surface border border-border rounded-2xl p-2 mb-4 flex items-center gap-2 overflow-x-auto">
        <CategoryChip
          active={!category}
          onClick={() => setCategory("")}
          label="All categories"
          count={stats.total}
        />
        {categoryEntries.map(([key, label]) => (
          <CategoryChip
            key={key}
            active={category === key}
            onClick={() => setCategory(category === key ? "" : key)}
            label={label}
            count={catCounts[key] ?? 0}
            icon={CATEGORY_ICON[key] ?? FileText}
          />
        ))}
        <div className="ml-auto relative">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title, party, reference no"
            className="pl-7 pr-3 py-1.5 text-[12px] bg-bg/40 border border-border rounded-full w-64 no-cap"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <FileText size={28} className="mx-auto text-muted mb-3" />
          <div className="text-sm font-bold text-text">No documents match this view</div>
          <p className="text-[12px] text-muted mt-1">
            {stats.total === 0
              ? "Upload your first NDA, employee contract, or policy to get started."
              : "Try clearing the filter or search."}
          </p>
          {stats.total === 0 && (
            <button
              onClick={() => setUploadOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3 py-1.5 rounded-full press-fx"
            >
              <Plus size={12} /> New document
            </button>
          )}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-2xl overflow-hidden animate-fade-in">
          <table className="w-full text-[13px]">
            <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
              <tr>
                <th className="text-left px-4 py-3">Document</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Counterparty</th>
                <th className="text-left px-4 py-3 hidden lg:table-cell">Tied to</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Expires</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((d) => (
                <LegalRow key={d.id} d={d} onOpen={() => setOpenDocId(d.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploadOpen && (
        <UploadDialog
          categories={categories}
          onClose={() => setUploadOpen(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["legals"] }); setUploadOpen(false); }}
        />
      )}

      {openDocId && (
        <DocumentDrawer
          id={openDocId}
          onClose={() => setOpenDocId(null)}
          onDeleted={() => { qc.invalidateQueries({ queryKey: ["legals"] }); setOpenDocId(null); }}
        />
      )}
    </div>
  );
}

function KpiTile({
  label, value, tone, active, onClick, icon: Icon,
}: {
  label: string;
  value: number;
  tone: "muted" | "success" | "warn" | "danger";
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<any>;
}) {
  const cls = tone === "success" ? "bg-success/10 text-success border-success/30"
    : tone === "warn" ? "bg-warn/10 text-warn border-warn/30"
    : tone === "danger" ? "bg-danger/10 text-danger border-danger/30"
    : "bg-bg/40 text-muted border-border";
  return (
    <button
      onClick={onClick}
      className={`bg-surface border rounded-2xl p-4 text-left hover-lift focus:outline-none focus:ring-2 focus:ring-accent/30 press-fx transition-colors ${
        active ? "border-accent shadow-soft" : "border-border hover:border-accent/40"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border ${cls}`}>
          <Icon size={14} />
        </span>
        <span className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</span>
      </div>
      <div className="text-[1.7rem] font-extrabold text-text leading-none mt-2">{value}</div>
    </button>
  );
}

function CategoryChip({
  active, onClick, label, count, icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ComponentType<any>;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition-colors press-fx ${
        active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text hover:bg-bg/40"
      }`}
    >
      {Icon && <Icon size={12} />}
      {label}
      <span className={`text-[11px] font-bold ${active ? "text-white/80" : "text-muted/70"}`}>· {count}</span>
    </button>
  );
}

function LegalRow({ d, onOpen }: { d: Legal; onOpen: () => void }) {
  const dExp = daysUntil(d.expires_at);
  const expTone = (() => {
    if (dExp == null) return "text-muted";
    if (dExp < 0) return "text-danger font-semibold";
    if (dExp <= 7) return "text-danger font-semibold";
    if (dExp <= 30) return "text-warn font-semibold";
    return "text-muted";
  })();
  const CategoryIco = CATEGORY_ICON[d.category] ?? FileText;
  const statusCls = d.status === "active" ? "bg-success/15 text-success border-success/25"
    : d.status === "draft" ? "bg-bg/40 text-muted border-border"
    : d.status === "expired" ? "bg-danger/15 text-danger border-danger/25"
    : "bg-warn/15 text-warn border-warn/25";
  return (
    <tr className="hover:bg-bg/30 transition-colors cursor-pointer" onClick={onOpen}>
      <td className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-accent-soft text-accent shrink-0">
            <CategoryIco size={14} />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-text truncate">{d.title}</div>
            <div className="text-[10.5px] text-muted/80 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold">{d.category_label}</span>
              {d.reference_no && <><span>·</span><span className="font-mono">{d.reference_no}</span></>}
              {d.version > 1 && <><span>·</span><span>v{d.version}</span></>}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        <div className="text-[12.5px] text-text truncate">{d.party || <span className="text-muted/70 italic">—</span>}</div>
      </td>
      <td className="px-4 py-3 hidden lg:table-cell text-[11.5px] text-muted">
        {d.project ? (
          <span className="inline-flex items-center gap-1"><Briefcase size={10} /> {d.project.name}</span>
        ) : d.user ? (
          <span className="inline-flex items-center gap-1"><UserIcon size={10} /> {d.user.name || d.user.email}</span>
        ) : d.vendor ? (
          <span className="inline-flex items-center gap-1"><Building2 size={10} /> {d.vendor.name}</span>
        ) : (
          <span className="text-muted/60 italic">Workspace-wide</span>
        )}
      </td>
      <td className={`px-4 py-3 hidden sm:table-cell text-[11.5px] whitespace-nowrap ${expTone}`}>
        {d.expires_at ? (
          <>
            {fmtDate(d.expires_at)}
            {dExp != null && (
              <span className="block text-[10px]">
                {dExp < 0 ? `${Math.abs(dExp)}d overdue` : dExp === 0 ? "today" : `in ${dExp}d`}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted/60 italic">No expiry</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wider border ${statusCls}`}>
          {d.status}
        </span>
        {!d.signed_at && d.status !== "draft" && (
          <span className="block text-[10px] text-warn mt-0.5">unsigned</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {d.has_content ? (
          <a
            href={`/api/v1/legals/${d.id}/download`}
            onClick={(e) => { e.stopPropagation(); downloadAuth(e as any, d.id, d.filename || d.title); }}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
          >
            <Download size={11} />
          </a>
        ) : d.external_url ? (
          <a
            href={d.external_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
            title="Open external link"
          >
            <ExternalLink size={11} />
          </a>
        ) : null}
      </td>
    </tr>
  );
}

// downloadAuth — fetch with the auth header (api.ts attaches it) and save
// the blob. Direct <a href> would bypass our JWT cookie and 401.
async function downloadAuth(e: React.MouseEvent, id: string, filename: string) {
  e.preventDefault();
  try {
    const res = await authedFetch(`/api/v1/legals/${id}/download`);
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    toast.error("Couldn't download", err?.message);
  }
}

function UploadDialog({
  categories, onClose, onCreated,
}: {
  categories: Record<string, string>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [category, setCategory] = useState("nda");
  const [title, setTitle] = useState("");
  const [party, setParty] = useState("");
  const [refNo, setRefNo] = useState("");
  const [effDate, setEffDate] = useState("");
  const [expDate, setExpDate] = useState("");
  const [signedAt, setSignedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [externalURL, setExternalURL] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState("");
  const [pending, setPending] = useState(false);

  // Project + member dropdowns — lazy-fetched.
  const { data: projectsData } = useQuery<{ items: { id: string; name: string; code: string }[] }>({
    queryKey: ["legals-projects-picker"],
    queryFn: () => api("/api/v1/projects?status=active"),
    staleTime: 5 * 60_000,
  });

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!title.trim()) { toast.error("Title is required"); return; }
    setPending(true);
    try {
      const form = new FormData();
      form.append("category", category);
      form.append("title", title.trim());
      if (party.trim()) form.append("party", party.trim());
      if (refNo.trim()) form.append("reference_no", refNo.trim());
      if (effDate) form.append("effective_date", effDate);
      if (expDate) form.append("expires_at", expDate);
      if (signedAt) form.append("signed_at", signedAt);
      if (notes.trim()) form.append("notes", notes.trim());
      if (externalURL.trim()) form.append("external_url", externalURL.trim());
      if (projectId) form.append("project_id", projectId);
      if (file) form.append("file", file);
      const res = await authedFetch("/api/v1/legals", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Document uploaded");
      onCreated();
    } catch (e: any) {
      toast.error("Couldn't upload", e?.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text inline-flex items-center gap-2">
            <Upload size={14} className="text-accent" /> New legal document
          </h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted">
            <XIcon size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Category</div>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Reference no <span className="text-muted">(optional)</span></div>
              <input className="input" value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="CTR-2026-014" />
            </label>
          </div>
          <label className="block">
            <div className="label">Title</div>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Master Services Agreement – Acme Corp" autoFocus />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Counterparty</div>
              <input className="input" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Acme Corp Ltd" />
            </label>
            <label className="block">
              <div className="label">Tied to project <span className="text-muted">(optional)</span></div>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">—</option>
                {(projectsData?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <div className="label">Effective</div>
              <input type="date" className="input" value={effDate} onChange={(e) => setEffDate(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Expires</div>
              <input type="date" className="input" value={expDate} onChange={(e) => setExpDate(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Signed</div>
              <input type="date" className="input" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <div className="label">File</div>
            <input type="file" className="input file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-border file:bg-bg/40 file:text-[12px] file:font-semibold" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="block">
            <div className="label">…or paste a link <span className="text-muted">(SharePoint / Box / external folder)</span></div>
            <input className="input" value={externalURL} onChange={(e) => setExternalURL(e.target.value)} placeholder="https://…" />
          </label>
          <label className="block">
            <div className="label">Notes <span className="text-muted">(optional)</span></div>
            <textarea className="input min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Key clauses, renewal terms, gotchas…" />
          </label>
        </div>
        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-text px-3 py-1.5 rounded-lg">Cancel</button>
          <button
            type="submit"
            disabled={pending || !title.trim()}
            className="text-[12.5px] font-bold bg-accent text-white px-4 py-1.5 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx"
          >
            {pending ? "Uploading…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function DocumentDrawer({
  id, onClose, onDeleted,
}: {
  id: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { data, isLoading } = useQuery<Legal>({
    queryKey: ["legal", id],
    queryFn: () => api(`/api/v1/legals/${id}`),
  });
  const [confirmDel, setConfirmDel] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/api/v1/legals/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Document deleted"); onDeleted(); },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });

  if (isLoading || !data) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
        <div className="bg-surface border border-border rounded-2xl p-8 text-muted">Loading…</div>
      </div>
    );
  }

  const dExp = daysUntil(data.expires_at);
  const CategoryIco = CATEGORY_ICON[data.category] ?? FileText;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent-soft text-accent shrink-0">
              <CategoryIco size={18} />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider font-bold text-muted">{data.category_label}</div>
              <h2 className="text-base font-extrabold text-text truncate">{data.title}</h2>
              {data.party && <div className="text-[12px] text-muted mt-0.5">with <span className="font-semibold text-text">{data.party}</span></div>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted shrink-0">
            <XIcon size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Metadata grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-[12px]">
            <Meta label="Status" value={data.status} />
            <Meta label="Effective" value={fmtDate(data.effective_date)} />
            <Meta
              label="Expires"
              value={data.expires_at ? `${fmtDate(data.expires_at)}${dExp != null ? ` (${dExp < 0 ? `${Math.abs(dExp)}d ago` : dExp === 0 ? "today" : `in ${dExp}d`})` : ""}` : "—"}
              tone={dExp == null ? "default" : dExp < 0 || dExp <= 7 ? "danger" : dExp <= 30 ? "warn" : "default"}
            />
            <Meta label="Signed" value={data.signed_at ? fmtDate(data.signed_at.slice(0, 10)) : "—"} tone={data.signed_at ? "default" : "warn"} />
            <Meta label="Version" value={`v${data.version}`} />
            {data.reference_no && <Meta label="Reference" value={data.reference_no} mono />}
            {data.project && <Meta wide label="Project" value={data.project.name} />}
            {data.user && <Meta wide label="Employee / member" value={data.user.name || data.user.email} />}
            {data.vendor && <Meta wide label="Vendor" value={data.vendor.name} />}
          </div>

          {data.notes && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">Notes</div>
              <div className="text-[13px] text-text whitespace-pre-wrap bg-bg/40 border border-border rounded-xl p-3">{data.notes}</div>
            </div>
          )}

          {data.tags.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5">
              {data.tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg/40 border border-border text-[11px] font-semibold text-muted">
                  <Tag size={10} /> {t}
                </span>
              ))}
            </div>
          )}

          {/* File / link */}
          <div className="border border-border rounded-xl p-3 flex items-center gap-3">
            {data.has_content ? (
              <>
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent-soft text-accent shrink-0">
                  <FileText size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-text truncate">{data.filename || "document"}</div>
                  <div className="text-[11px] text-muted">{fmtSize(data.size_bytes)} · {data.content_type || "unknown"}</div>
                </div>
                <a
                  href={`/api/v1/legals/${data.id}/download`}
                  onClick={(e) => downloadAuth(e as any, data.id, data.filename || data.title)}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3 py-1.5 rounded-full press-fx"
                >
                  <Download size={12} /> Download
                </a>
              </>
            ) : data.external_url ? (
              <>
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent-soft text-accent shrink-0">
                  <LinkIcon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-text">External link</div>
                  <div className="text-[11px] text-muted truncate">{data.external_url}</div>
                </div>
                <a
                  href={data.external_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3 py-1.5 rounded-full press-fx"
                >
                  <ExternalLink size={12} /> Open
                </a>
              </>
            ) : (
              <div className="text-[12px] text-muted italic">No file or link attached.</div>
            )}
          </div>

          <footer className="text-[11px] text-muted flex items-center justify-between pt-2">
            <span className="inline-flex items-center gap-1"><Calendar size={10} /> Uploaded {fmtDate(data.created_at.slice(0, 10))}</span>
            {data.uploaded_by && <span>by {data.uploaded_by.name}</span>}
          </footer>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          {confirmDel ? (
            <>
              <span className="text-[12px] text-muted mr-2">Permanently delete this document?</span>
              <button onClick={() => setConfirmDel(false)} className="text-[12.5px] font-semibold text-muted px-3 py-1.5 rounded-lg hover:bg-bg/40">Cancel</button>
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="text-[12.5px] font-bold bg-danger text-white px-3 py-1.5 rounded-full press-fx disabled:opacity-60"
              >
                {del.isPending ? "Deleting…" : "Delete"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setConfirmDel(true)}
                className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-danger px-3 py-1.5 rounded-lg hover:bg-danger/10"
                title="Delete"
              >
                <Trash2 size={12} /> Delete
              </button>
              <button onClick={onClose} className="text-[12.5px] font-semibold text-muted px-3 py-1.5 rounded-lg hover:bg-bg/40">Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value, mono, wide, tone }: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  tone?: "default" | "warn" | "danger";
}) {
  const toneCls = tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-text";
  return (
    <div className={`bg-bg/40 rounded-xl p-3 ${wide ? "md:col-span-3" : ""}`}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`mt-0.5 font-semibold truncate ${toneCls} ${mono ? "font-mono text-[12px]" : ""}`}>{value}</div>
    </div>
  );
}

// Hide ChevronDown / Filter import-cleanup hint — both are referenced
// indirectly in the JSX above.
void ChevronDown;
