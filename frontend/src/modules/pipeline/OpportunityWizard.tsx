import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { Check, Building2, FileText, Wallet, ShieldAlert, Eye, ArrowLeft, ArrowRight, Sparkles, AlertTriangle, X, Plus, Trash2, Users as UsersIcon, ExternalLink, Search, Wand2 } from "lucide-react";

type LeadType = "government" | "private" | "foreign" | "ngo" | "internal";
type Risk = "low" | "medium" | "high";

type DurationUnit = "days" | "months" | "years";
type TeamLine = {
  name: string;
  kind: "internal" | "external";
  daily_rate: number;
  count: number;
  days: number;            // canonical billable days (value × unit multiplier)
  duration_value?: number; // raw value the user typed
  duration_unit?: DurationUnit;
};

const UNIT_DAYS: Record<DurationUnit, number> = { days: 1, months: 30, years: 365 };

function toDays(value: number, unit: DurationUnit): number {
  return Math.max(0, Math.round(value * UNIT_DAYS[unit]));
}

/* ----------- Intelligent team-composition suggestions -----------
 * Given the lead type, scope text, manpower target and known rates, derive a
 * starter team. Pure function — no React, no network. Used by the wizard and
 * any other surface that needs a "what would a typical team look like?" call.
 *
 * Returns roles ordered by importance, each with a recommended head count and
 * the human-readable reasons that triggered the role (so the UI can explain
 * itself when surfacing the picks).
 */
type SuggestedRole = {
  rate: TeamRate;
  suggestedCount: number;
  reasons: string[];
};

const ROLE_KEYWORD_HINTS: { match: RegExp; roleHints: string[]; reason: string }[] = [
  { match: /\b(engineer|developer|coding|build|implement|backend|frontend|api|integration|system|software|platform|microservice|service)\b/i,
    roleHints: ["engineer", "senior engineer"], reason: "scope mentions engineering work" },
  { match: /\b(design|ui|ux|wireframe|mock(up)?|figma|brand|visual|prototype)\b/i,
    roleHints: ["designer"], reason: "scope mentions design / UX" },
  { match: /\b(qa|test(ing)?|quality|uat|regression)\b/i,
    roleHints: ["qa"], reason: "scope mentions testing / QA" },
  { match: /\b(compliance|regulator|regulation|audit|policy|kyc|aml|gdpr|ndpr|bpp)\b/i,
    roleHints: ["compliance officer"], reason: "scope touches compliance / regulation" },
  { match: /\b(security|secure|vulnerab|pen[\s-]?test|penetration|threat|encrypt)\b/i,
    roleHints: ["senior engineer", "subject matter expert"], reason: "security-sensitive scope" },
  { match: /\b(devops|infrastructure|cloud|aws|azure|kubernetes|deploy|sre|cicd)\b/i,
    roleHints: ["senior engineer"], reason: "infrastructure / DevOps work" },
  { match: /\b(research|feasibility|assessment|study|advisory|consult)\b/i,
    roleHints: ["subject matter expert"], reason: "advisory / research scope" },
  { match: /\b(deliver|launch|rollout|go[\s-]?live|programme|program manage)\b/i,
    roleHints: ["delivery manager"], reason: "delivery-heavy programme" },
];

function findRate(rates: TeamRate[], hint: string): TeamRate | undefined {
  const h = hint.toLowerCase();
  // Exact-ish match first, then loose contains
  return rates.find((r) => r.name.toLowerCase() === h)
      ?? rates.find((r) => r.name.toLowerCase().includes(h))
      ?? rates.find((r) => h.includes(r.name.toLowerCase()));
}

function suggestTeam(
  rates: TeamRate[],
  ctx: {
    lead_type: LeadType;
    title: string;
    technical_scope: string;
    proposal_summary: string;
    expected_manpower: number;
  },
): SuggestedRole[] {
  if (rates.length === 0) return [];
  const text = `${ctx.title} ${ctx.technical_scope} ${ctx.proposal_summary}`;
  const picked = new Map<string, SuggestedRole>(); // key = rate.name lowercased

  const add = (rate: TeamRate, reason: string, count = 1) => {
    const key = rate.name.toLowerCase();
    const existing = picked.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.suggestedCount = Math.max(existing.suggestedCount, count);
    } else {
      picked.set(key, { rate, suggestedCount: count, reasons: [reason] });
    }
  };

  // 1. Baseline roles every project needs.
  const pm = findRate(rates, "project manager");
  if (pm) add(pm, "Every project needs a single accountable PM", 1);

  // 2. Lead-type driven additions.
  if (ctx.lead_type === "government") {
    const co = findRate(rates, "compliance officer");
    if (co) add(co, "Government lead — BPP / regulatory oversight required", 1);
  }
  if (ctx.lead_type === "foreign") {
    const sme = findRate(rates, "subject matter expert");
    if (sme) add(sme, "Foreign engagement — cross-border / domain SME advised", 1);
  }
  if (ctx.lead_type === "internal") {
    // internal jobs typically don't need external SMEs, skip them
  }

  // 3. Keyword-driven additions from the scope text.
  ROLE_KEYWORD_HINTS.forEach(({ match, roleHints, reason }) => {
    if (!match.test(text)) return;
    for (const hint of roleHints) {
      const r = findRate(rates, hint);
      if (r) { add(r, reason, 1); break; } // first matching hint wins
    }
  });

  // 4. Sensible default of an engineer + QA if nothing technical matched yet.
  if (picked.size <= 1) {
    const eng = findRate(rates, "engineer");
    if (eng) add(eng, "Default delivery role", Math.max(1, Math.floor(ctx.expected_manpower / 2)));
    const qa = findRate(rates, "qa");
    if (qa) add(qa, "Independent QA on every delivery", 1);
  }

  // 5. Scale engineer count by expected manpower (cap to avoid runaway suggestions).
  const eng = picked.get("engineer");
  if (eng && ctx.expected_manpower > 2) {
    eng.suggestedCount = Math.min(8, Math.max(eng.suggestedCount, ctx.expected_manpower - 2));
  }

  // 6. Prefer internal roles first, then external — easier to staff.
  return Array.from(picked.values()).sort((a, b) => {
    if (a.rate.kind !== b.rate.kind) return a.rate.kind === "internal" ? -1 : 1;
    return a.rate.name.localeCompare(b.rate.name);
  });
}

type Form = {
  client_name: string;
  lead_type: LeadType;
  source: string;
  title: string;
  technical_scope: string;
  proposal_summary: string;
  expected_manpower: number;
  estimated_value: number;
  budget: number;
  budget_touched: boolean;
  priority: number;
  delivery_deadline: string;
  risk_level: Risk;
  risk_auto: boolean;
  compliance_tags: string[];
  dependencies: string[];
  currency: string;
  team_composition: TeamLine[];
};

type TeamRate = { id: string; name: string; kind: "internal" | "external"; daily_rate: number; currency: string };

/**
 * Title-case a client name while preserving acronyms (NDLEA, CBN, FIRS).
 * - First and last word always capitalised.
 * - Tokens already in ALL CAPS and longer than one char stay as-is.
 * - Common short connectors (of, and, the, for, in, at, by, on, to, with)
 *   stay lower-case in the middle of the name.
 */
const TITLE_CASE_LOWER = new Set([
  "of", "and", "the", "for", "in", "at", "on", "to", "by", "with", "a", "an", "or",
]);
function toTitleCase(input: string): string {
  if (!input) return input;
  // Preserve trailing space the user just typed so the next word can start fresh.
  const tokens = input.split(/(\s+)/);
  let wordIndex = 0;
  const wordCount = tokens.filter((t) => t.trim().length > 0).length;
  return tokens
    .map((tok) => {
      if (!tok.trim()) return tok;
      const i = wordIndex++;
      // Acronym pass-through: 2+ chars, already uppercase letters/digits.
      if (tok.length >= 2 && /^[A-Z0-9.&-]+$/.test(tok)) return tok;
      const lower = tok.toLowerCase();
      const isMiddleWord = i > 0 && i < wordCount - 1;
      if (isMiddleWord && TITLE_CASE_LOWER.has(lower)) return lower;
      // Capitalise first letter; keep the rest as the user typed it (handles
      // mixed-case names like "McDonald" or "iCONIC" gracefully if they
      // explicitly typed it that way).
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function fmtCurrencyIn(n: number, ccy: string): string {
  if (!n && n !== 0) return "—";
  try {
    return n.toLocaleString("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 });
  } catch {
    return `${ccy} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
}

type StepKey = "client" | "scope" | "commercials" | "risk" | "review";

type FieldError = { field: string; label: string; message: string; step: StepKey };

const FIELD_META: Record<string, { label: string; step: StepKey }> = {
  client_id: { label: "Client", step: "client" },
  client_name: { label: "Client name", step: "client" },
  lead_type: { label: "Client type", step: "client" },
  source: { label: "Source", step: "client" },
  title: { label: "Project title", step: "scope" },
  technical_scope: { label: "Technical scope", step: "scope" },
  proposal_summary: { label: "Summary", step: "scope" },
  expected_manpower: { label: "Team size", step: "scope" },
  estimated_value: { label: "Estimated value", step: "commercials" },
  budget: { label: "Internal budget", step: "commercials" },
  priority: { label: "Priority", step: "commercials" },
  delivery_deadline: { label: "Target delivery", step: "commercials" },
  risk_level: { label: "Risk level", step: "risk" },
  compliance_tags: { label: "Compliance tags", step: "risk" },
  dependencies: { label: "Dependencies", step: "risk" },
};

function humanizeRule(field: string, rule: string, label: string): string {
  switch (rule) {
    case "required": return `${label} is required.`;
    case "email": return `${label} must be a valid email.`;
    case "uuid": return `${label} must be a valid identifier.`;
    case "min": return `${label} is too short or too small.`;
    case "max": return `${label} is too long or too large.`;
    case "gt": case "gte": return `${label} must be greater than the minimum.`;
    case "lt": case "lte": return `${label} must be less than the maximum.`;
    default:
      if (rule.startsWith("oneof=")) {
        const opts = rule.slice("oneof=".length).split(/\s+/).join(", ");
        return `${label} must be one of: ${opts}.`;
      }
      return `${label} failed validation (${rule}).`;
  }
}

function parseApiError(e: unknown): FieldError[] {
  if (!(e instanceof ApiError)) {
    return [{ field: "_", label: "Error", message: (e as Error)?.message ?? "Something went wrong.", step: "review" }];
  }
  const raw = (e.body as any)?.error ?? e.message ?? "Unknown error";
  const out: FieldError[] = [];

  // Go validator errors look like:
  // Key: 'createOppReq.ClientID' Error:Field validation for 'ClientID' failed on the 'required' tag
  const pattern = /Key:\s*'[^']*\.([^']+)'\s+Error:Field validation for\s+'[^']+'\s+failed on the\s+'([^']+)'\s+tag/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    const goField = m[1];
    const rule = m[2];
    const snake = goField.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const meta = FIELD_META[snake] ?? { label: goField, step: "review" as StepKey };
    out.push({
      field: snake,
      label: meta.label,
      message: humanizeRule(snake, rule, meta.label),
      step: meta.step,
    });
  }

  if (out.length === 0) {
    // Try to detect Postgres / DB-style errors and tidy them up.
    const cleaned = String(raw)
      .replace(/^ERROR:\s*/i, "")
      .replace(/\s*\(SQLSTATE [^)]+\)/i, "");
    out.push({ field: "_", label: "Server error", message: cleaned, step: "review" });
  }
  return out;
}

const STEPS: { key: StepKey; label: string; hint: string; icon: any }[] = [
  { key: "client",      label: "Client",     hint: "Who's this for?",     icon: Building2 },
  { key: "scope",       label: "Scope",      hint: "What you'll deliver", icon: FileText },
  { key: "commercials", label: "Commercials", hint: "Value & timeline",   icon: Wallet },
  { key: "risk",        label: "Risk",       hint: "Compliance & risk",   icon: ShieldAlert },
  { key: "review",      label: "Review",     hint: "Confirm & create",    icon: Eye },
];

const LEAD_TYPES: { v: LeadType; label: string; desc: string }[] = [
  { v: "government", label: "Government", desc: "Federal, state, or LGA agency" },
  { v: "private",    label: "Private",    desc: "Commercial corporate client" },
  { v: "foreign",    label: "Foreign",    desc: "International or multilateral" },
  { v: "ngo",        label: "NGO",        desc: "Non-profit or development partner" },
  { v: "internal",   label: "Internal",   desc: "Internal initiative or R&D" },
];

const COMPLIANCE_GROUPS: { label: string; dot: string; tags: string[] }[] = [
  { label: "Privacy & data",  dot: "#3b82f6", tags: ["NDA required", "GDPR", "NDPR (Nigeria)", "POPIA (South Africa)", "HIPAA", "Data residency", "DPIA required", "Subprocessor disclosure"] },
  { label: "Security",        dot: "#a855f7", tags: ["ISO 27001", "SOC 2", "PCI-DSS", "Penetration testing", "Cybersecurity audit", "Source code escrow"] },
  { label: "Financial / KYC", dot: "#10b981", tags: ["AML / KYC", "Sanctions screening", "FATCA", "Tax clearance", "CBN guidelines"] },
  { label: "Ethics & ESG",    dot: "#f59e0b", tags: ["Anti-bribery", "ESG", "Local content", "Modern slavery", "Conflict of interest", "Whistleblower policy"] },
  { label: "Legal",           dot: "#6b7280", tags: ["IP assignment", "SLA penalties", "Right to audit", "Force majeure", "Insurance certificate"] },
  // Nigerian Public Procurement Act (BPP) — auto-selected for government leads.
  // Reflects the standard documents BPP/NOCOPO requires from bidders on federal contracts.
  { label: "Nigerian Public Procurement (BPP)", dot: "#16a34a", tags: [
    "Tax Clearance Certificate (3 yrs)",
    "VAT registration / TIN",
    "Pension Compliance (PenCom)",
    "ITF Compliance Certificate",
    "NSITF Compliance Certificate",
    "BPP IRR / NOCOPO registration",
    "CAC certificate of incorporation",
    "Audited Financial Statements (3 yrs)",
    "Sworn affidavit (BPP form)",
    "Nigerian Content Plan",
    "Bid security / bid bond",
    "Performance bond",
    "Code of Conduct (CCB)",
  ] },
];

// Compliance tags that are auto-selected for Nigerian government engagements
// (Section 16 of the Public Procurement Act 2007 + BPP standard requirements).
const BPP_AUTO_TAGS = [
  "Tax Clearance Certificate (3 yrs)",
  "VAT registration / TIN",
  "Pension Compliance (PenCom)",
  "ITF Compliance Certificate",
  "NSITF Compliance Certificate",
  "BPP IRR / NOCOPO registration",
  "CAC certificate of incorporation",
  "Audited Financial Statements (3 yrs)",
  "Sworn affidavit (BPP form)",
  "Nigerian Content Plan",
  "Code of Conduct (CCB)",
  "Anti-bribery",
];
const COMPLIANCE_PRESETS = COMPLIANCE_GROUPS.flatMap((g) => g.tags);

function suggestRisk(value: number, lead: LeadType): Risk {
  if (value >= 1_000_000) return "high";
  if (lead === "government" || lead === "foreign") return value >= 250_000 ? "high" : "medium";
  if (value >= 100_000) return "medium";
  return "low";
}

function fmtCurrency(n: number): string {
  if (!n) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function OpportunityWizard() {
  const [stepIdx, setStepIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const nav = useNavigate();

  function jumpToStep(key: StepKey) {
    const idx = STEPS.findIndex((s) => s.key === key);
    if (idx >= 0) setStepIdx(idx);
  }

  const [form, setForm] = useState<Form>({
    client_name: "",
    lead_type: "private",
    source: "",
    title: "",
    technical_scope: "",
    proposal_summary: "",
    expected_manpower: 1,
    estimated_value: 0,
    budget: 0,
    budget_touched: false,
    priority: 3,
    delivery_deadline: "",
    risk_level: "low",
    risk_auto: true,
    compliance_tags: [],
    dependencies: [],
    currency: "NGN",
    team_composition: [],
  });

  const { data: ratesData } = useQuery<{ rates: TeamRate[]; currencies: string[] }>({
    queryKey: ["team-rates"],
    queryFn: () => api(`/api/v1/settings/team-rates`),
  });
  const rates = ratesData?.rates ?? [];
  const currencies = ratesData?.currencies ?? ["USD"];

  const [ratesEditorOpen, setRatesEditorOpen] = useState(false);

  // Total team-implied cost: sum of count × days × daily_rate
  const teamCost = useMemo(() => form.team_composition.reduce(
    (s, l) => s + (l.count || 0) * (l.days || 0) * (l.daily_rate || 0), 0
  ), [form.team_composition]);
  const externalCost = useMemo(() => form.team_composition
    .filter((l) => l.kind === "external")
    .reduce((s, l) => s + (l.count || 0) * (l.days || 0) * (l.daily_rate || 0), 0),
  [form.team_composition]);
  const totalHeadcount = form.team_composition.reduce((s, l) => s + (l.count || 0), 0);

  // Smart team suggestions — recompute as the user fills lead type / scope / manpower.
  // Filter out roles already on the team; surface only what's still missing.
  const suggestions = useMemo<SuggestedRole[]>(() => {
    const all = suggestTeam(rates, {
      lead_type: form.lead_type,
      title: form.title,
      technical_scope: form.technical_scope,
      proposal_summary: form.proposal_summary,
      expected_manpower: form.expected_manpower,
    });
    const picked = new Set(form.team_composition.map((l) => l.name));
    return all.filter((s) => !picked.has(s.rate.name));
  }, [rates, form.lead_type, form.title, form.technical_scope, form.proposal_summary, form.expected_manpower, form.team_composition]);

  function applySuggestion(s: SuggestedRole) {
    set("team_composition", [...form.team_composition, {
      name: s.rate.name, kind: s.rate.kind, daily_rate: s.rate.daily_rate,
      count: s.suggestedCount,
      duration_value: 1, duration_unit: "months", days: 30,
    }]);
  }
  function applyAllSuggestions() {
    if (suggestions.length === 0) return;
    set("team_composition", [
      ...form.team_composition,
      ...suggestions.map((s) => ({
        name: s.rate.name, kind: s.rate.kind, daily_rate: s.rate.daily_rate,
        count: s.suggestedCount,
        duration_value: 1, duration_unit: "months" as DurationUnit, days: 30,
      })),
    ]);
  }

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // When team cost changes and the user hasn't manually overridden the budget,
  // keep budget in sync with the team-implied cost.
  if (teamCost > 0 && !form.budget_touched && Math.abs(form.budget - teamCost) > 0.01) {
    // schedule via microtask-equivalent to avoid setState-in-render warning
    queueMicrotask(() => setForm((f) => f.budget_touched ? f : { ...f, budget: teamCost }));
  }

  const isInternal = form.lead_type === "internal";

  // Auto-suggest risk whenever the user lets it run.
  const autoRisk = useMemo(() => suggestRisk(form.estimated_value, form.lead_type), [form.estimated_value, form.lead_type]);
  const effectiveRisk = form.risk_auto ? autoRisk : form.risk_level;

  const stepKey = STEPS[stepIdx].key;

  const stepErrors: Record<StepKey, string | null> = {
    client: !form.client_name.trim() ? "Client name is required." : null,
    scope: !form.title.trim() ? "Project title is required." : null,
    commercials: form.estimated_value <= 0 ? (isInternal ? "Allocated internal revenue must be greater than 0." : "Estimated value must be greater than 0.") :
                 form.budget < 0 ? "Budget can't be negative." :
                 (!isInternal && form.budget > form.estimated_value) ? "Budget exceeds estimated value." : null,
    risk: null,
    review: null,
  };
  const blockingError = stepErrors[stepKey];

  function next() {
    setErr(null);
    if (blockingError) { setErr(blockingError); return; }
    setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
  }
  function back() {
    setErr(null);
    setStepIdx((i) => Math.max(0, i - 1));
  }

  async function submit() {
    if (submitting) return;
    setErr(null); setSubmitting(true);
    try {
      const payload = {
        title: form.title.trim(),
        lead_type: form.lead_type,
        source: form.source.trim(),
        client_name: form.client_name.trim(),
        currency: form.currency,
        estimated_value: form.estimated_value,
        budget: form.budget,
        priority: form.priority,
        risk_level: effectiveRisk,
        delivery_deadline: form.delivery_deadline || "",
        technical_scope: form.technical_scope.trim(),
        proposal_summary: form.proposal_summary.trim(),
        expected_manpower: form.expected_manpower || totalHeadcount,
        dependencies: form.dependencies,
        compliance_tags: form.compliance_tags,
        team_composition: form.team_composition,
      };
      const res = await api<{ id: string }>("/api/v1/opportunities", {
        method: "POST", body: JSON.stringify(payload),
      });
      nav(`/pipeline/${res.id}`);
    } catch (e: any) {
      setErrors(parseApiError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const margin = form.estimated_value - form.budget;
  const marginPct = form.estimated_value > 0 ? Math.round((margin / form.estimated_value) * 100) : 0;

  return (
    <div className="max-w-4xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-text">New opportunity</h1>
        <p className="text-sm text-muted mt-1">
          Capture a lead, scope, commercials, and risk so we can route it through governance.
        </p>
      </header>

      <Stepper current={stepIdx} onJump={(i) => i < stepIdx && setStepIdx(i)} />

      <section className="card p-6 mt-6">
        {stepKey === "client" && (
          <div className="space-y-5">
            <Field label="Client name" hint="The organization receiving the work. We'll create the client record automatically.">
              <input
                className="input"
                value={form.client_name}
                placeholder="e.g. Federal Ministry of Finance"
                autoFocus
                autoCapitalize="words"
                onChange={(e) => set("client_name", toTitleCase(e.target.value))}
                onBlur={(e) => set("client_name", toTitleCase(e.target.value.trim()))}
              />
            </Field>

            <div>
              <div className="label">Client type</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {LEAD_TYPES.map((lt) => (
                  <button
                    key={lt.v}
                    type="button"
                    onClick={() => {
                      set("lead_type", lt.v);
                      // Nigerian Public Procurement Act / BPP — auto-add the standard
                      // bidder compliance tags when this becomes a government engagement.
                      if (lt.v === "government") {
                        const merged = Array.from(new Set([...form.compliance_tags, ...BPP_AUTO_TAGS]));
                        set("compliance_tags", merged);
                      }
                    }}
                    className={`text-left p-3 rounded-md border transition-colors ${
                      form.lead_type === lt.v
                        ? "border-accent bg-accent-soft"
                        : "border-border hover:bg-bg"
                    }`}
                  >
                    <div className="text-sm font-medium text-text">{lt.label}</div>
                    <div className="text-xs text-muted mt-0.5">{lt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <Field label="Source (optional)" hint="Where the lead came from — referral, RFP portal, event, etc.">
              <input
                className="input"
                value={form.source}
                placeholder="e.g. NIPP RFP portal"
                onChange={(e) => set("source", e.target.value)}
              />
            </Field>
          </div>
        )}

        {stepKey === "scope" && (
          <div className="space-y-5">
            <Field
              label="Project title"
              hint={`Short, plain-language name. Stakeholders will see this in dashboards. ${form.title.length}/225`}
            >
              <input
                className="input"
                value={form.title}
                maxLength={225}
                placeholder="e.g. National Tax Reporting Platform"
                autoFocus
                onChange={(e) => set("title", e.target.value.slice(0, 225))}
              />
            </Field>
            <Field label="One-line summary" hint="What's being delivered, in a sentence.">
              <input
                className="input"
                value={form.proposal_summary}
                placeholder="e.g. Build a unified reporting and reconciliation portal for federal taxes."
                onChange={(e) => set("proposal_summary", e.target.value)}
              />
            </Field>
            <Field label="Technical scope" hint="Bullet the major workstreams. This shapes the eventual project plan.">
              <textarea
                className="input min-h-[140px]"
                value={form.technical_scope}
                placeholder={"- Discovery & requirements\n- API & data integrations\n- Web portal\n- Training & rollout"}
                onChange={(e) => set("technical_scope", e.target.value)}
              />
            </Field>
            <Field label="Expected team size">
              <div className="flex items-center gap-3">
                <input
                  className="input w-24"
                  type="number" min={1} max={200}
                  value={form.expected_manpower}
                  onChange={(e) => set("expected_manpower", Math.max(0, +e.target.value))}
                />
                <span className="text-sm text-muted">people across the engagement</span>
              </div>
            </Field>
          </div>
        )}

        {stepKey === "commercials" && (
          <div className="space-y-5">
            <Field label="Currency">
              <select
                className="input md:w-48"
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
              >
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label={isInternal ? "Allocated internal revenue" : "Estimated contract value"}
                hint={isInternal
                  ? "Internal projects don't generate external revenue — this is the budget allocated by the business."
                  : "What the client will pay."}
              >
                <CurrencyInput
                  value={form.estimated_value}
                  ccy={form.currency}
                  onChange={(v) => set("estimated_value", v)}
                  autoFocus
                />
              </Field>
              <Field
                label={isInternal ? "Delivery cost (auto from team)" : "Internal budget (auto from team)"}
                hint={form.budget_touched
                  ? "Manually overridden — restore to recompute from the team."
                  : "Sum of headcount × days × daily rate. Edit to override."}
              >
                <div className="flex gap-2">
                  <CurrencyInput
                    value={form.budget}
                    ccy={form.currency}
                    onChange={(v) => { set("budget", v); set("budget_touched", true); }}
                  />
                  {form.budget_touched && teamCost > 0 && (
                    <button
                      type="button"
                      onClick={() => { set("budget_touched", false); set("budget", teamCost); }}
                      className="btn-outline shrink-0"
                      title="Restore budget from team composition"
                    >
                      Restore
                    </button>
                  )}
                </div>
              </Field>
            </div>

            {/* Team composition table */}
            <div className="rounded-md border border-border">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg">
                <div className="flex items-center gap-2">
                  <UsersIcon size={16} className="text-muted" />
                  <div>
                    <div className="text-sm font-medium text-text">Team composition</div>
                    <div className="text-xs text-muted">
                      {totalHeadcount} {totalHeadcount === 1 ? "person" : "people"} · {fmtCurrencyIn(teamCost, form.currency)} total
                      {externalCost > 0 && <> · <span className="text-warn">external {fmtCurrencyIn(externalCost, form.currency)}</span></>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {suggestions.length > 0 && form.team_composition.length > 0 && (
                    <button
                      type="button"
                      onClick={applyAllSuggestions}
                      className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                      title={`Add ${suggestions.length} suggested role${suggestions.length === 1 ? "" : "s"} based on the scope`}
                    >
                      <Wand2 size={12} /> Suggest {suggestions.length} more
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRatesEditorOpen(true)}
                    className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                    title="Manage team rates without leaving the wizard"
                  >
                    Edit rates <ExternalLink size={11} />
                  </button>
                </div>
              </div>
              {form.team_composition.length === 0 ? (
                <SmartTeamEmptyState
                  suggestions={suggestions}
                  currency={form.currency}
                  onAdd={applySuggestion}
                  onAddAll={applyAllSuggestions}
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-border">
                      <th className="text-left font-medium px-4 py-2">Role</th>
                      <th className="text-right font-medium px-2 py-2 w-20">People</th>
                      <th className="text-right font-medium px-2 py-2 w-32">Duration</th>
                      <th className="text-right font-medium px-2 py-2 w-32">Rate / day</th>
                      <th className="text-right font-medium px-4 py-2 w-32">Subtotal</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.team_composition.map((line, idx) => {
                      const sub = (line.count || 0) * (line.days || 0) * (line.daily_rate || 0);
                      return (
                        <tr key={idx} className="border-b border-border last:border-0">
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-text">{line.name}</span>
                              {line.kind === "external" && (
                                <span className="pill bg-warn/15 text-warn">external</span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number" min={0}
                              className="input text-right"
                              value={line.count}
                              onChange={(e) => {
                                const v = +e.target.value || 0;
                                set("team_composition", form.team_composition.map((l, i) => i === idx ? { ...l, count: v } : l));
                              }}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <DurationField
                              value={line.duration_value ?? line.days}
                              unit={line.duration_unit ?? "days"}
                              onChange={(value, unit) => {
                                set("team_composition", form.team_composition.map((l, i) => i === idx
                                  ? { ...l, duration_value: value, duration_unit: unit, days: toDays(value, unit) }
                                  : l));
                              }}
                            />
                            {(line.duration_unit && line.duration_unit !== "days") && (
                              <div className="text-[10px] text-muted text-right mt-0.5">≈ {line.days} d</div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-muted">{fmtCurrencyIn(line.daily_rate, form.currency)}</td>
                          <td className="px-4 py-2 text-right font-medium">{fmtCurrencyIn(sub, form.currency)}</td>
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              className="text-muted hover:text-danger p-1"
                              onClick={() => set("team_composition", form.team_composition.filter((_, i) => i !== idx))}
                              aria-label="Remove role"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="px-4 py-3 border-t border-border bg-bg">
                <RoleAdder
                  rates={rates}
                  alreadyPicked={new Set(form.team_composition.map((l) => l.name))}
                  onAdd={(r) => set("team_composition", [...form.team_composition, {
                    name: r.name, kind: r.kind, daily_rate: r.daily_rate, count: 1,
                    duration_value: 1, duration_unit: "months", days: 30,
                  }])}
                />
              </div>
            </div>

            {/* Margin preview / risk alerts */}
            {form.estimated_value > 0 && !isInternal && (
              <div className={`rounded-md p-4 border ${
                marginPct >= 30 ? "border-success/40 bg-success/10"
                : marginPct >= 10 ? "border-warn/40 bg-warn/10"
                : "border-danger/40 bg-danger/10"
              }`}>
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles size={14} />
                  <strong>Margin preview:</strong>
                  <span>{fmtCurrencyIn(margin, form.currency)} ({marginPct}%)</span>
                </div>
                <div className="text-xs text-muted mt-1">
                  {marginPct >= 30 && "Healthy margin."}
                  {marginPct < 30 && marginPct >= 10 && "Margin is tight — confirm assumptions before submitting."}
                  {marginPct < 10 && "Margin is too thin or negative. Revisit the budget or value before continuing."}
                </div>
              </div>
            )}

            {teamCost > form.budget * 1.05 && form.budget > 0 && (
              <div className="rounded-md p-4 border border-danger/40 bg-danger/10 text-sm">
                <div className="flex items-center gap-2 text-danger font-medium">
                  <AlertTriangle size={14} /> Workforce risk
                </div>
                <div className="text-xs text-text mt-1">
                  The team you've planned costs <strong>{fmtCurrencyIn(teamCost, form.currency)}</strong>, which is{" "}
                  {Math.round(((teamCost - form.budget) / form.budget) * 100)}% over the current budget of{" "}
                  <strong>{fmtCurrencyIn(form.budget, form.currency)}</strong>. Either trim the team, raise the budget, or accept the loss.
                </div>
              </div>
            )}
            {externalCost > 0 && externalCost > teamCost * 0.4 && (
              <div className="rounded-md p-3 border border-warn/40 bg-warn/10 text-xs text-text">
                <strong>Heavy external dependency:</strong> {Math.round((externalCost / teamCost) * 100)}% of delivery cost
                is external workforce. Confirm contracts and SLAs are in place — internal staffing is preferred.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label={`Priority — ${["", "Lowest", "Low", "Medium", "High", "Highest"][form.priority]}`}>
                <input
                  type="range" min={1} max={5} value={form.priority}
                  onChange={(e) => set("priority", +e.target.value)}
                  className="w-full accent-accent"
                />
                <div className="flex justify-between text-[10px] text-muted mt-1">
                  <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
                </div>
              </Field>
              <Field label="Target delivery date (optional)">
                <input
                  type="date" className="input"
                  value={form.delivery_deadline}
                  onChange={(e) => set("delivery_deadline", e.target.value)}
                />
              </Field>
            </div>
          </div>
        )}

        {stepKey === "risk" && (
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="label !mb-0">Risk level</div>
                <label className="text-xs text-muted flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox" checked={form.risk_auto}
                    onChange={(e) => {
                      set("risk_auto", e.target.checked);
                      if (e.target.checked) set("risk_level", autoRisk);
                    }}
                  />
                  Auto-classify based on value & client type
                </label>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["low", "medium", "high"] as Risk[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { set("risk_auto", false); set("risk_level", r); }}
                    className={`p-3 rounded-md border text-sm font-medium capitalize transition-colors ${
                      effectiveRisk === r
                        ? r === "high" ? "border-danger bg-danger/10 text-danger"
                          : r === "medium" ? "border-warn bg-warn/10 text-warn"
                          : "border-success bg-success/10 text-success"
                        : "border-border hover:bg-bg text-text"
                    }`}
                  >
                    {r}
                    {form.risk_auto && r === autoRisk && (
                      <div className="text-[10px] font-normal text-muted mt-0.5">suggested</div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <ComplianceTagPicker
              selected={form.compliance_tags}
              onChange={(v) => set("compliance_tags", v)}
            />

            <Field label="Dependencies (optional)" hint="Press Enter to add. These are upstream blockers — sign-offs, integrations, partners.">
              <ChipInput value={form.dependencies} onChange={(v) => set("dependencies", v)} />
            </Field>

            <div className="rounded-md border border-border bg-bg p-4 text-sm text-muted">
              <strong className="text-text">Heads up:</strong> documents (NDA, RFP, contract, etc.)
              are uploaded after the draft is created. The governance engine will block submission
              until every document required for a <em>{form.lead_type}</em> client is attached.
            </div>
          </div>
        )}

        {stepKey === "review" && (
          <div className="space-y-5">
            <header>
              <div className="text-[11px] uppercase tracking-wider font-bold text-accent">Review & confirm</div>
              <p className="text-sm text-muted mt-1">
                Quick scan of everything you've captured. Jump back to any step on the stepper above to edit.
              </p>
            </header>
            <Summary form={form} risk={effectiveRisk} />
            {err && (
              <div className="text-danger text-sm bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{err}</div>
            )}
          </div>
        )}

        {blockingError && stepKey !== "review" && (
          <div className="mt-4 text-danger text-sm">{blockingError}</div>
        )}
      </section>

      {errors.length > 0 && (
        <ErrorDialog
          errors={errors}
          onClose={() => setErrors([])}
          onFix={(step) => { setErrors([]); jumpToStep(step); }}
        />
      )}

      {ratesEditorOpen && (
        <TeamRatesEditorDialog
          rates={rates}
          currencies={currencies}
          onClose={() => setRatesEditorOpen(false)}
        />
      )}

      <div className="flex items-center justify-between mt-6">
        <button className="btn-outline" onClick={back} disabled={stepIdx === 0}>
          <ArrowLeft size={14} /> Back
        </button>
        {stepKey !== "review" ? (
          <button className="btn-primary" onClick={next} disabled={!!blockingError}>
            Continue <ArrowRight size={14} />
          </button>
        ) : (
          <button className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create draft"}
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorDialog({
  errors, onClose, onFix,
}: {
  errors: FieldError[];
  onClose: () => void;
  onFix: (step: StepKey) => void;
}) {
  const grouped: Record<StepKey, FieldError[]> = { client: [], scope: [], commercials: [], risk: [], review: [] };
  for (const e of errors) grouped[e.step].push(e);
  const stepLabels: Record<StepKey, string> = {
    client: "Client", scope: "Scope", commercials: "Commercials", risk: "Risk", review: "Other",
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-6"
      role="dialog" aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <div className="w-10 h-10 rounded-full bg-danger/10 text-danger grid place-items-center shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-text">We couldn't create this draft</h2>
            <p className="text-sm text-muted mt-0.5">
              {errors.length} {errors.length === 1 ? "issue" : "issues"} need your attention before we can save it.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1 rounded">
            <X size={18} />
          </button>
        </header>

        <div className="overflow-auto flex-1 p-5 space-y-4">
          {(Object.keys(grouped) as StepKey[]).map((s) =>
            grouped[s].length === 0 ? null : (
              <div key={s}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted">{stepLabels[s]}</div>
                  {s !== "review" && (
                    <button
                      onClick={() => onFix(s)}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      Fix in {stepLabels[s]} →
                    </button>
                  )}
                </div>
                <ul className="space-y-2">
                  {grouped[s].map((e, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                      <span className="text-text">{e.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </div>

        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Dismiss</button>
          {(() => {
            const first = errors.find((e) => e.step !== "review");
            return first ? (
              <button onClick={() => onFix(first.step)} className="btn-primary">
                Fix first issue
              </button>
            ) : null;
          })()}
        </footer>
      </div>
    </div>
  );
}

function Stepper({ current, onJump }: { current: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.key} className="flex-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={i > current}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md transition-colors w-full text-left ${
                active ? "bg-accent-soft text-accent"
                : done ? "text-text hover:bg-bg cursor-pointer"
                : "text-muted"
              }`}
            >
              <span className={`w-7 h-7 grid place-items-center rounded-full text-xs font-semibold border ${
                done ? "bg-accent border-accent text-white"
                : active ? "border-accent text-accent"
                : "border-border text-muted"
              }`}>
                {done ? <Check size={14} /> : <Icon size={14} />}
              </span>
              <div className="leading-tight hidden md:block">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-[11px] text-muted">{s.hint}</div>
              </div>
            </button>
            {i < STEPS.length - 1 && (
              <span className={`hidden md:block h-px flex-1 ${done ? "bg-accent" : "bg-border"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="label">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </label>
  );
}

function DurationField({
  value, unit, onChange,
}: {
  value: number;
  unit: DurationUnit;
  onChange: (value: number, unit: DurationUnit) => void;
}) {
  return (
    <div className="flex gap-1">
      <input
        type="number" min={0} step="any"
        className="input text-right !pr-2 w-16"
        value={value === 0 ? "" : value}
        placeholder="0"
        onChange={(e) => onChange(+e.target.value || 0, unit)}
      />
      <select
        className="input !px-2 w-20 text-[12px]"
        value={unit}
        onChange={(e) => onChange(value, e.target.value as DurationUnit)}
        aria-label="Duration unit"
      >
        <option value="days">days</option>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>
    </div>
  );
}

function CurrencyInput({ value, onChange, autoFocus, ccy = "USD" }: { value: number; onChange: (n: number) => void; autoFocus?: boolean; ccy?: string }) {
  const symbol = ({ USD: "$", EUR: "€", GBP: "£", NGN: "₦", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA" } as Record<string,string>)[ccy] ?? ccy;
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs font-medium">{symbol}</span>
      <input
        type="number" min={0} step="0.01"
        autoFocus={autoFocus}
        className="input pl-10"
        value={value === 0 ? "" : value}
        placeholder="0.00"
        onChange={(e) => {
          const v = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(isFinite(v) ? Math.round(v * 100) / 100 : 0);
        }}
      />
    </div>
  );
}

/* Empty-state for the team table — pitches the intelligent suggestions instead
 * of an empty void. If we have no suggestions yet (rates not loaded, scope is
 * still blank), falls back to a gentle prompt. */
function SmartTeamEmptyState({
  suggestions, currency, onAdd, onAddAll,
}: {
  suggestions: SuggestedRole[];
  currency: string;
  onAdd: (s: SuggestedRole) => void;
  onAddAll: () => void;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        Fill in the lead type and technical scope above and we'll suggest a starter team for you.
        You can also add roles manually below.
      </div>
    );
  }
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2">
          <div className="w-8 h-8 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0 mt-0.5">
            <Wand2 size={15} />
          </div>
          <div>
            <div className="text-sm font-bold text-text">Suggested team for this scope</div>
            <p className="text-xs text-muted mt-0.5 max-w-md">
              Auto-derived from the lead type, scope keywords, and your team rates.
              Click any role to add it, or add all at once.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAddAll}
          className="btn-primary shrink-0"
          style={{ padding: "0.4rem 0.9rem", fontSize: "12.5px" }}
        >
          <Plus size={13} /> Add all {suggestions.length}
        </button>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {suggestions.map((s) => (
          <li key={s.rate.name}>
            <button
              type="button"
              onClick={() => onAdd(s)}
              className="w-full text-left bg-surface border border-border rounded-lg p-3 hover:border-accent hover:bg-bg/40 transition-colors group"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-text truncate">{s.rate.name}</span>
                  {s.rate.kind === "external" && (
                    <span className="pill bg-warn/15 text-warn shrink-0">external</span>
                  )}
                </div>
                <span className="text-[11px] text-muted whitespace-nowrap">
                  ×{s.suggestedCount} · {fmtCurrencyIn(s.rate.daily_rate, currency)}/day
                </span>
              </div>
              <div className="text-[11px] text-muted leading-snug">
                {s.reasons.slice(0, 2).join(" · ")}
              </div>
              <div className="text-[11px] font-semibold text-accent mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1">
                <Plus size={10} /> Add to team
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleAdder({ rates, alreadyPicked, onAdd }: {
  rates: TeamRate[];
  alreadyPicked: Set<string>;
  onAdd: (r: TeamRate) => void;
}) {
  const [pick, setPick] = useState("");
  const available = rates.filter((r) => !alreadyPicked.has(r.name));
  if (available.length === 0) {
    return <div className="text-xs text-muted">All defined roles added. Edit rates in Settings to add more.</div>;
  }
  return (
    <div className="flex items-center gap-2">
      <select
        className="input flex-1"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
      >
        <option value="">Add a role…</option>
        <optgroup label="Internal">
          {available.filter((r) => r.kind === "internal").map((r) => (
            <option key={r.id} value={r.id}>{r.name} — {r.currency} {r.daily_rate.toLocaleString()} / day</option>
          ))}
        </optgroup>
        <optgroup label="External">
          {available.filter((r) => r.kind === "external").map((r) => (
            <option key={r.id} value={r.id}>{r.name} — {r.currency} {r.daily_rate.toLocaleString()} / day</option>
          ))}
        </optgroup>
      </select>
      <button
        type="button"
        disabled={!pick}
        onClick={() => {
          const r = rates.find((x) => x.id === pick);
          if (r) { onAdd(r); setPick(""); }
        }}
        className="btn-primary"
      >
        <Plus size={14} /> Add role
      </button>
    </div>
  );
}

function ComplianceTagPicker({
  selected, onChange,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const customs = selected.filter((t) => !COMPLIANCE_PRESETS.includes(t));

  function toggle(tag: string) {
    onChange(selected.includes(tag)
      ? selected.filter((t) => t !== tag)
      : [...selected, tag]);
  }

  function addCustom() {
    const t = draft.trim();
    if (t && !selected.includes(t)) onChange([...selected, t]);
    setDraft("");
  }

  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-bg">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert size={15} className="text-muted shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Compliance tags</div>
            <div className="text-xs text-muted truncate">
              {selected.length === 0
                ? "What procurement or legal will flag — pick all that apply."
                : `${selected.length} selected`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative hidden md:block">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className="input !py-1.5 pl-7 text-sm w-48"
              placeholder="Search tags…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs text-muted hover:text-danger"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Selected summary */}
      {selected.length > 0 && (
        <div className="px-4 py-3 border-b border-border bg-accent-soft/30">
          <div className="flex flex-wrap gap-1.5">
            {selected.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggle(t)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent text-white text-[12px] font-medium hover:opacity-90"
                title="Click to remove"
              >
                {t}
                <X size={11} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Groups */}
      <div className="divide-y divide-border">
        {COMPLIANCE_GROUPS.map((g) => {
          const visible = query
            ? g.tags.filter((t) => t.toLowerCase().includes(query.toLowerCase()))
            : g.tags;
          if (visible.length === 0) return null;
          const groupSelected = visible.filter((t) => selected.includes(t)).length;
          return (
            <div key={g.label} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: g.dot }} />
                <span className="text-[11px] uppercase tracking-wider font-semibold text-text">{g.label}</span>
                {groupSelected > 0 && (
                  <span className="text-[10px] text-accent font-semibold">{groupSelected}/{visible.length}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {visible.map((tag) => {
                  const on = selected.includes(tag);
                  return (
                    <button
                      key={tag} type="button"
                      onClick={() => toggle(tag)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-md border transition-all ${
                        on
                          ? "bg-accent text-white border-accent shadow-sm"
                          : "bg-surface text-text border-border hover:border-accent/50 hover:bg-accent-soft/40"
                      }`}
                    >
                      {on && <Check size={12} />}
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {customs.length > 0 && (
          <div className="px-4 py-3 bg-bg/40">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              <span className="text-[11px] uppercase tracking-wider font-semibold text-text">Custom</span>
              <span className="text-[10px] text-accent font-semibold">{customs.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {customs.map((tag) => (
                <button
                  key={tag} type="button"
                  onClick={() => toggle(tag)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-md bg-accent text-white border border-accent shadow-sm"
                >
                  <Check size={12} />
                  {tag}
                  <X size={11} className="opacity-80" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add custom */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-bg">
        <Plus size={14} className="text-muted shrink-0" />
        <input
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted"
          placeholder="Add a custom tag (e.g. NITDA registration, NDPC audit)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!draft.trim()}
          className="text-sm font-medium text-accent hover:underline disabled:text-muted disabled:no-underline"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function CustomTagInput({ onAdd }: { onAdd: (t: string) => void }) {
  const [draft, setDraft] = useState("");
  function commit() {
    if (draft.trim()) {
      onAdd(draft);
      setDraft("");
    }
  }
  return (
    <div className="flex items-center gap-2 pt-1 border-t border-border">
      <input
        className="input flex-1"
        value={draft}
        placeholder="Add a custom tag (e.g. NITDA registration)…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
        }}
      />
      <button type="button" className="btn-outline" onClick={commit} disabled={!draft.trim()}>
        <Plus size={14} /> Add tag
      </button>
    </div>
  );
}

function ChipInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 border border-border rounded-md px-2 py-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
      {value.map((d) => (
        <span key={d} className="pill bg-bg border border-border text-text">
          {d}
          <button
            type="button" className="ml-1 text-muted hover:text-danger"
            onClick={() => onChange(value.filter((x) => x !== d))}
          >×</button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[160px] bg-transparent outline-none text-sm py-1 px-1 placeholder:text-muted"
        placeholder={value.length ? "Add another…" : "Type and press Enter"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            if (!value.includes(draft.trim())) onChange([...value, draft.trim()]);
            setDraft("");
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function Summary({ form, risk }: { form: Form; risk: Risk }) {
  const isInternal = form.lead_type === "internal";
  const margin = form.estimated_value - form.budget;
  const marginPct = form.estimated_value > 0 ? Math.round((margin / form.estimated_value) * 100) : 0;
  const teamCost = form.team_composition.reduce((s, l) => s + l.count * l.days * l.daily_rate, 0);
  const headcount = form.team_composition.reduce((s, l) => s + l.count, 0);
  const priorityLabel = ["", "Lowest", "Low", "Medium", "High", "Highest"][form.priority] ?? "—";

  return (
    <div className="space-y-5">
      <SummarySection title="Client">
        <KV label="Client name" value={form.client_name || "—"} />
        <KV label="Type" value={<span className="capitalize">{form.lead_type}</span>} />
        <KV label="Source" value={form.source || <Muted>None</Muted>} />
      </SummarySection>

      <SummarySection title="Engagement">
        <KV label="Title" value={form.title || "—"} />
        <BlockField label="Summary" value={form.proposal_summary} />
        <BlockField label="Technical scope" value={form.technical_scope} />
      </SummarySection>

      <SummarySection title="Commercials">
        <KV label="Currency" value={form.currency} />
        <KV
          label={isInternal ? "Allocated revenue" : "Estimated value"}
          value={<strong className="text-text">{fmtCurrencyIn(form.estimated_value, form.currency)}</strong>}
        />
        <KV
          label={isInternal ? "Delivery cost" : "Internal budget"}
          value={fmtCurrencyIn(form.budget, form.currency)}
        />
        {!isInternal && form.estimated_value > 0 && (
          <KV
            label="Margin"
            value={
              <span className={marginPct >= 30 ? "text-success" : marginPct >= 10 ? "text-warn" : "text-danger"}>
                {fmtCurrencyIn(margin, form.currency)} <span className="text-muted/80">({marginPct}%)</span>
              </span>
            }
          />
        )}
        <KV label="Priority" value={`${priorityLabel} (P${form.priority})`} />
        <KV label="Target delivery" value={form.delivery_deadline || <Muted>Not set</Muted>} />
      </SummarySection>

      <SummarySection title="Team">
        <KV label="Headcount" value={headcount === 0 ? <Muted>None planned</Muted> : `${headcount} people`} />
        <KV label="Computed cost" value={teamCost > 0 ? fmtCurrencyIn(teamCost, form.currency) : <Muted>—</Muted>} />
        {form.team_composition.length === 0 ? (
          <BlockField label="Composition" value="" emptyText="No roles added — budget is fully manual." />
        ) : (
          <div>
            <div className="label">Composition</div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {form.team_composition.map((l, i) => (
                <li key={i} className="flex items-center gap-2 text-sm bg-bg border border-border rounded-lg px-2.5 py-1.5">
                  <span className="text-text font-semibold w-7 text-right">{l.count}×</span>
                  <span className="text-text truncate flex-1">{l.name}</span>
                  {l.kind === "external" && (
                    <span className="pill bg-warn/15 text-warn">ext</span>
                  )}
                  <span className="text-xs text-muted whitespace-nowrap">{l.days}d</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SummarySection>

      <SummarySection title="Risk & compliance">
        <KV
          label="Risk level"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${
                risk === "high" ? "bg-danger" : risk === "medium" ? "bg-warn" : "bg-success"
              }`} />
              <span className="capitalize">{risk}</span>
              {form.risk_auto && <span className="text-[11px] text-muted">(auto)</span>}
            </span>
          }
        />
        <div>
          <div className="label">Compliance tags</div>
          {form.compliance_tags.length === 0 ? (
            <Muted>None</Muted>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {form.compliance_tags.map((t) => (
                <span key={t} className="pill bg-accent-soft text-accent border border-accent/20">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="label">Dependencies</div>
          {form.dependencies.length === 0 ? (
            <Muted>None</Muted>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {form.dependencies.map((t) => (
                <span key={t} className="pill bg-bg border border-border text-text">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </SummarySection>
    </div>
  );
}

function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg/40 px-5 py-4">
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-3">{title}</div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm py-1">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-text text-right min-w-0 flex-1 truncate">{value}</dd>
    </div>
  );
}

function BlockField({ label, value, emptyText = "Not provided." }: { label: string; value: string; emptyText?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      {!value || !value.trim() ? (
        <Muted>{emptyText}</Muted>
      ) : (
        <div className="text-sm text-text leading-relaxed whitespace-pre-wrap break-words bg-surface border border-border rounded-lg px-3 py-2.5 max-h-48 overflow-auto">
          {value}
        </div>
      )}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted italic">{children}</span>;
}

/* ---------- Inline Team Rates editor ---------- */

function TeamRatesEditorDialog({
  rates, currencies, onClose,
}: {
  rates: TeamRate[];
  currencies: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<TeamRate[]>(() =>
    rates.map((r) => ({ ...r }))
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: (next: TeamRate[]) =>
      api(`/api/v1/settings/team-rates`, {
        method: "PUT",
        body: JSON.stringify({ rates: next }),
      }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["team-rates"] });
    },
  });

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rates), [draft, rates]);

  function update(idx: number, patch: Partial<TeamRate>) {
    setDraft((d) => d.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }
  function add() {
    setDraft((d) => [...d, { id: `new-${Date.now()}`, name: "", kind: "internal", daily_rate: 0, currency: "NGN" }]);
  }

  const internal = draft.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "internal");
  const external = draft.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "external");

  return (
    <div className="fixed inset-0 bg-black/50 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="bg-surface rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <span className="w-10 h-10 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0">
            <UsersIcon size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-text">Team rates</h2>
            <p className="text-sm text-muted mt-0.5">
              Edit daily rates for internal staff and external workforce. Changes apply to the
              role picker as soon as you save — without leaving this opportunity.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <RateGroup
            title="Internal team"
            entries={internal}
            currencies={currencies}
            onUpdate={update}
            onRemove={remove}
            emptyMsg="No internal roles defined."
          />
          <RateGroup
            title="External workforce"
            entries={external}
            currencies={currencies}
            onUpdate={update}
            onRemove={remove}
            emptyMsg="No external roles defined."
          />
          <button onClick={add} className="btn-outline w-full">
            <Plus size={14} /> Add a role
          </button>
        </div>

        <footer className="flex items-center justify-end gap-3 p-4 border-t border-border bg-bg">
          {savedAt && !dirty && (
            <span className="text-xs text-success inline-flex items-center gap-1">
              <Check size={12} /> Saved
            </span>
          )}
          {save.error && (
            <span className="text-xs text-danger">{(save.error as Error).message}</span>
          )}
          <button onClick={onClose} className="btn-outline">Done</button>
          <button
            onClick={() => save.mutate(draft)}
            disabled={!dirty || save.isPending}
            className="btn-primary"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RateGroup({
  title, entries, currencies, onUpdate, onRemove, emptyMsg,
}: {
  title: string;
  entries: { r: TeamRate; i: number }[];
  currencies: string[];
  onUpdate: (idx: number, patch: Partial<TeamRate>) => void;
  onRemove: (idx: number) => void;
  emptyMsg: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <span className="text-xs text-muted">{entries.length} role{entries.length === 1 ? "" : "s"}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted italic">{emptyMsg}</p>
      ) : (
        <div className="border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg text-xs text-muted">
              <tr>
                <th className="text-left font-medium px-2 py-1.5">Role</th>
                <th className="text-left font-medium px-2 py-1.5 w-28">Kind</th>
                <th className="text-right font-medium px-2 py-1.5 w-32">Daily rate</th>
                <th className="text-left font-medium px-2 py-1.5 w-24">Currency</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(({ r, i }) => (
                <tr key={r.id ?? `new-${i}`} className="border-t border-border">
                  <td className="px-2 py-1.5">
                    <input
                      className="input"
                      value={r.name}
                      placeholder="Role name"
                      onChange={(e) => onUpdate(i, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      className="input"
                      value={r.kind}
                      onChange={(e) => onUpdate(i, { kind: e.target.value as "internal" | "external" })}
                    >
                      <option value="internal">Internal</option>
                      <option value="external">External</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" min={0} step="0.01"
                      className="input text-right"
                      value={r.daily_rate}
                      onChange={(e) => onUpdate(i, { daily_rate: +e.target.value || 0 })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      className="input"
                      value={r.currency}
                      onChange={(e) => onUpdate(i, { currency: e.target.value })}
                    >
                      {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => onRemove(i)}
                      className="text-muted hover:text-danger p-1"
                      aria-label="Remove rate"
                    >
                      <Trash2 size={14} />
                    </button>
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
