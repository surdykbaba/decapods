// Public, no-auth onboarding page. The vendor opens this from a link sent to
// them. We hit the server for context, then they POST their details back —
// no JWT required. Token is the only secret in the URL.
import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Handshake, ShieldCheck, AlertTriangle, CheckCircle2, FileText, Plus, X } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";

type InviteContext = {
  vendor_id: string;
  vendor_name: string;
  vendor_kind: string;
  vendor_country: string;
  service_category: string;
  status: string;
  invited_email: string;
  message: string;
  expires_at: string;
  requested_fields: string[];
  required_documents: string[];
};

const DOC_LABEL: Record<string, string> = {
  profile: "Company profile",
  tax_cert: "Tax / TIN certificate",
  service_agreement: "Master service agreement",
  sla: "Signed SLA",
  nda: "NDA",
  insurance: "Insurance certificate",
  bank_details: "Bank details",
  data_protection: "Data protection agreement",
  security_clearance: "Security clearance",
  company_registration: "Company registration",
  vendor_approval_form: "Vendor approval form",
  portfolio: "Portfolio / past work",
  reference: "Reference letter",
};

const COMPETENCIES = [
  "engineering","design","compliance","security","data","infrastructure",
  "legal","finance","training","research","translation","logistics",
];

type Doc = { kind: string; name: string; object_key: string };

// We hit the API directly here so we don't drag the JWT-aware `api()` helper
// into a public page.
async function fetchInvite(token: string): Promise<InviteContext> {
  const res = await fetch(`/api/v1/vendor-invite/${token}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body?.code;
    throw err;
  }
  return body as InviteContext;
}

async function submitInvite(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`/api/v1/vendor-invite/${token}`, {
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

export function VendorInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Eager fetch on mount.
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
            onSubmit={async (payload) => {
              await submitInvite(token!, payload);
              setState({ kind: "done" });
            }}
          />
        )}
      </div>
    </div>
  );
}

function ErrorScreen({ message, code }: { message: string; code?: string }) {
  const reason = code === "expired"
    ? "This invitation has expired. Ask the team that invited you to send a fresh link."
    : code === "accepted"
      ? "This invitation has already been completed. If you need to update your details, ask for a new link."
      : code === "revoked"
        ? "This invitation was revoked. Ask the team to issue a new one."
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
        Thanks — your details and any documents you provided have been sent. The team will review and reach out from here.
        You can close this tab.
      </p>
    </div>
  );
}

function OnboardingForm({
  ctx, onSubmit,
}: { ctx: InviteContext; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [form, setForm] = useState({
    legal_name: "",
    contact_name: "",
    contact_email: ctx.invited_email,
    contact_phone: "",
    website: "",
    country: ctx.vendor_country,
    notes: "",
    competencies: [] as string[],
  });
  const [docs, setDocs] = useState<Doc[]>([]);
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const toggleComp = (c: string) =>
    setForm((f) => ({
      ...f,
      competencies: f.competencies.includes(c)
        ? f.competencies.filter((x) => x !== c)
        : [...f.competencies, c],
    }));

  const requiredHave = new Set(docs.map((d) => d.kind));
  const stillMissing = ctx.required_documents.filter((k) => !requiredHave.has(k));

  return (
    <div className="space-y-5">
      {/* Header */}
      <header className="bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
            <Handshake size={22} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Vendor onboarding</div>
            <h1 className="text-2xl font-extrabold text-text mt-1">Welcome, {ctx.vendor_name}</h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">
              Please fill in your contact details, competencies, and attach the standard documents below.
              The link is good until {new Date(ctx.expires_at).toLocaleDateString()}.
            </p>
            {ctx.message && (
              <blockquote className="mt-3 text-sm text-text border-l-2 border-accent/40 pl-3 whitespace-pre-wrap">
                {ctx.message}
              </blockquote>
            )}
          </div>
        </div>
      </header>

      {/* Contact + competencies */}
      <section className="bg-surface border border-border rounded-2xl p-6">
        <h2 className="h2 mb-4">Your details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Legal entity name">
            <input className="input" value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder="e.g. Lagos Compliance Partners Ltd" />
          </Field>
          <Field label="Country">
            <input className="input" value={form.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="Primary contact name">
            <input className="input" value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} />
          </Field>
          <Field label="Contact email">
            <input className="input" type="email" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <input className="input" value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
          </Field>
          <Field label="Website">
            <input className="input" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
          </Field>
        </div>

        <div className="mt-4">
          <div className="label">Competencies</div>
          <p className="text-[11.5px] text-muted mb-2">Tag what your team can deliver — used to match you to project roles.</p>
          <div className="flex flex-wrap gap-1.5">
            {COMPETENCIES.map((c) => {
              const active = form.competencies.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleComp(c)}
                  className={`text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                    active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>

        <Field label="Anything else we should know" className="mt-4">
          <textarea className="input" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional notes — past work, team size, capacity, certifications, etc." />
        </Field>
      </section>

      {/* Documents */}
      <section className="bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <h2 className="h2">Required documents</h2>
            <p className="text-xs text-muted mt-1">
              Paste a shareable link (Drive / Dropbox / similar) for each. We'll review and follow up if anything's missing.
            </p>
          </div>
        </div>

        {stillMissing.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/5 p-3 mb-3 text-[12.5px] text-text">
            <div className="font-semibold inline-flex items-center gap-1.5 text-warn">
              <AlertTriangle size={13} /> Still needed:
            </div>
            <span className="text-muted ml-2">
              {stillMissing.map((k) => DOC_LABEL[k] ?? k).join(", ")}
            </span>
          </div>
        )}

        <DocumentList docs={docs} setDocs={setDocs} requiredKinds={ctx.required_documents} />
      </section>

      {/* Submit */}
      <div className="flex items-center justify-end gap-2">
        <SmartButton
          variant="primary"
          size="lg"
          onClick={async () => {
            await onSubmit({ ...form, documents: docs });
          }}
          icon={<ShieldCheck size={14} />}
        >
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

function DocumentList({
  docs, setDocs, requiredKinds,
}: { docs: Doc[]; setDocs: (d: Doc[]) => void; requiredKinds: string[] }) {
  const [kind, setKind] = useState(requiredKinds[0] ?? "profile");
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");
  const valid = name.trim() && url.trim();

  const add = () => {
    if (!valid) return;
    setDocs([...docs, { kind, name: name.trim(), object_key: url.trim() }]);
    setName(""); setUrl("");
  };
  const remove = (idx: number) => setDocs(docs.filter((_, i) => i !== idx));

  const allKinds = Array.from(new Set([...requiredKinds, ...Object.keys(DOC_LABEL)]));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {allKinds.map((k) =>
            <option key={k} value={k}>
              {DOC_LABEL[k] ?? k}{requiredKinds.includes(k) ? " *" : ""}
            </option>
          )}
        </select>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (e.g. CAC certificate)" />
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://link-to-document" />
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
              <button onClick={() => remove(i)} className="text-muted hover:text-danger" aria-label="Remove">
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
