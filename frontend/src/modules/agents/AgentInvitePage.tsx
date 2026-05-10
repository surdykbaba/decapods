// Public, no-auth onboarding page for agents. Mirrors VendorInvitePage but
// targets the agent endpoints + the (heavier) compliance docset.
import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Network, ShieldCheck, AlertTriangle, CheckCircle2, FileText, Plus, X } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";

type InviteContext = {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  country: string;
  region: string;
  invited_email: string;
  message: string;
  expires_at: string;
  requested_fields: string[];
  required_documents: string[];
};

const DOC_LABEL: Record<string, string> = {
  nda: "NDA",
  engagement_agreement: "Engagement agreement",
  agent_declaration: "Agent declaration form",
  conflict_of_interest: "Conflict-of-interest declaration",
  kyc: "KYC / identity verification",
  anti_bribery: "Anti-bribery declaration",
  approval_memo: "Approval memo",
  data_protection: "Data protection agreement",
  company_registration: "Company registration",
  tax_info: "Tax information",
  bank_details: "Bank details",
  other: "Other",
};

const SECTORS = [
  "finance","energy","public_sector","telecom","health","manufacturing",
  "agriculture","logistics","education","tech","real_estate","extractives",
];

type Doc = { kind: string; name: string; object_key: string };

async function fetchInvite(token: string): Promise<InviteContext> {
  const res = await fetch(`/api/v1/agent-invite/${token}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body?.code;
    throw err;
  }
  return body as InviteContext;
}

async function submitInvite(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`/api/v1/agent-invite/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; ctx: InviteContext }
  | { kind: "error"; message: string; code?: string }
  | { kind: "done" };

export function AgentInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useMemo(() => {
    if (!token) { setState({ kind: "error", message: "Missing invite token." }); return; }
    fetchInvite(token)
      .then((ctx) => setState({ kind: "ready", ctx }))
      .catch((e: Error & { code?: string }) =>
        setState({ kind: "error", message: e.message, code: e.code }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen bg-bg flex items-start justify-center p-4 md:p-8">
      <div className="w-full max-w-3xl">
        {state.kind === "loading" && <div className="text-center text-muted py-20">Loading invitation…</div>}
        {state.kind === "error" && <ErrorScreen message={state.message} code={state.code} />}
        {state.kind === "done" && <DoneScreen />}
        {state.kind === "ready" && (
          <OnboardingForm
            ctx={state.ctx}
            onSubmit={async (p) => { await submitInvite(token!, p); setState({ kind: "done" }); }}
          />
        )}
      </div>
    </div>
  );
}

function ErrorScreen({ message, code }: { message: string; code?: string }) {
  const reason = code === "expired" ? "This invitation has expired."
    : code === "accepted" ? "This invitation has already been completed."
      : code === "revoked" ? "This invitation was revoked."
        : message;
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-warn/15 text-warn grid place-items-center mb-3">
        <AlertTriangle size={22} />
      </div>
      <h1 className="text-xl font-bold text-text">Can't open this invitation</h1>
      <p className="text-sm text-muted mt-2 max-w-md mx-auto">{reason}</p>
    </div>
  );
}

function DoneScreen() {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-success/15 text-success grid place-items-center mb-3">
        <CheckCircle2 size={22} />
      </div>
      <h1 className="text-xl font-bold text-text">Onboarding submitted ✓</h1>
      <p className="text-sm text-muted mt-2 max-w-md mx-auto">
        Thanks. Your details and documents have been sent for review. The team will follow up.
      </p>
    </div>
  );
}

function OnboardingForm({
  ctx, onSubmit,
}: { ctx: InviteContext; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [form, setForm] = useState({
    organization: "", contact_name: "", contact_email: ctx.invited_email,
    contact_phone: "", region: ctx.region, country: ctx.country,
    notes: "", sector_focus: [] as string[],
  });
  const [docs, setDocs] = useState<Doc[]>([]);
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleSector = (s: string) =>
    setForm((f) => ({
      ...f,
      sector_focus: f.sector_focus.includes(s) ? f.sector_focus.filter((x) => x !== s) : [...f.sector_focus, s],
    }));
  const have = new Set(docs.map((d) => d.kind));
  const missing = ctx.required_documents.filter((k) => !have.has(k));

  return (
    <div className="space-y-5">
      <header className="bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
            <Network size={22} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Agent onboarding</div>
            <h1 className="text-2xl font-extrabold text-text mt-1">Welcome, {ctx.agent_name}</h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">
              Please complete your contact details, sector focus and the compliance pack below. Link expires {new Date(ctx.expires_at).toLocaleDateString()}.
            </p>
            {ctx.message && (
              <blockquote className="mt-3 text-sm text-text border-l-2 border-accent/40 pl-3 whitespace-pre-wrap">
                {ctx.message}
              </blockquote>
            )}
          </div>
        </div>
      </header>

      <section className="bg-surface border border-border rounded-2xl p-6">
        <h2 className="h2 mb-4">Your details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Organization (if applicable)"><input className="input" value={form.organization} onChange={(e) => set("organization", e.target.value)} /></Field>
          <Field label="Country"><input className="input" value={form.country} onChange={(e) => set("country", e.target.value)} /></Field>
          <Field label="Region"><input className="input" value={form.region} onChange={(e) => set("region", e.target.value)} /></Field>
          <Field label="Primary contact name"><input className="input" value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} /></Field>
          <Field label="Contact email"><input className="input" type="email" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} /></Field>
          <Field label="Contact phone"><input className="input" value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} /></Field>
        </div>
        <div className="mt-4">
          <div className="label">Sector focus</div>
          <div className="flex flex-wrap gap-1.5">
            {SECTORS.map((s) => {
              const active = form.sector_focus.includes(s);
              return (
                <button key={s} type="button" onClick={() => toggleSector(s)}
                  className={`text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                    active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                  }`}>{s.replace(/_/g, " ")}</button>
              );
            })}
          </div>
        </div>
        <Field label="Anything else we should know" className="mt-4">
          <textarea className="input" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </section>

      <section className="bg-surface border border-border rounded-2xl p-6">
        <div className="mb-3">
          <h2 className="h2">Compliance pack</h2>
          <p className="text-xs text-muted mt-1">
            Paste a shareable link (Drive / Dropbox / similar) for each. The pack is mandatory before engagement.
          </p>
        </div>
        {missing.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/5 p-3 mb-3 text-[12.5px] text-text">
            <div className="font-semibold inline-flex items-center gap-1.5 text-warn">
              <AlertTriangle size={13} /> Still needed:
            </div>
            <span className="text-muted ml-2">{missing.map((k) => DOC_LABEL[k] ?? k).join(", ")}</span>
          </div>
        )}
        <DocList docs={docs} setDocs={setDocs} requiredKinds={ctx.required_documents} />
      </section>

      <div className="flex items-center justify-end">
        <SmartButton variant="primary" size="lg" onClick={async () => await onSubmit({ ...form, documents: docs })} icon={<ShieldCheck size={14} />}>
          Submit onboarding
        </SmartButton>
      </div>
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <div className="label">{label}</div>
      {children}
    </label>
  );
}

function DocList({
  docs, setDocs, requiredKinds,
}: { docs: Doc[]; setDocs: (d: Doc[]) => void; requiredKinds: string[] }) {
  const [kind, setKind] = useState(requiredKinds[0] ?? "nda");
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");
  const valid = name.trim() && url.trim();
  const allKinds = Array.from(new Set([...requiredKinds, ...Object.keys(DOC_LABEL)]));
  const add = () => {
    if (!valid) return;
    setDocs([...docs, { kind, name: name.trim(), object_key: url.trim() }]);
    setName(""); setUrl("");
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {allKinds.map((k) => <option key={k} value={k}>{DOC_LABEL[k] ?? k}{requiredKinds.includes(k) ? " *" : ""}</option>)}
        </select>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
        <button type="button" onClick={add} disabled={!valid} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
          <Plus size={13} /> Add
        </button>
      </div>
      {docs.length > 0 && (
        <ul className="space-y-1.5">
          {docs.map((d, i) => (
            <li key={i} className="flex items-center gap-2 bg-bg/50 border border-border rounded-lg p-2.5">
              <FileText size={13} className="text-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-text truncate">{d.name}</div>
                <div className="text-[11px] text-muted truncate">{DOC_LABEL[d.kind] ?? d.kind} · {d.object_key}</div>
              </div>
              <button onClick={() => setDocs(docs.filter((_, j) => j !== i))} className="text-muted hover:text-danger" aria-label="Remove">
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
