import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import {
  Wallet, FileText, AlertTriangle, CheckCircle2, ArrowRight, TrendingUp,
  Receipt, ArrowDownToLine, Clock, FolderKanban, Target, CalendarClock,
} from "lucide-react";

type Summary = {
  primary_currency: string;
  by_currency: { currency: string; billed: number; collected: number; outstanding: number }[];
  status_counts: Record<string, number>;
  aging: Record<"current" | "0_30" | "31_60" | "61_90" | "90_plus", number>;
  pipeline_at_risk: number;
  top_unpaid: TopUnpaid[];
  recent_payments: RecentPayment[];
};
type TopUnpaid = {
  id: string;
  number: string;
  amount: number;
  outstanding: number;
  currency: string;
  status: string;
  issued_on: string | null;
  due_on: string | null;
  project_name: string;
  project_id: string | null;
  days_overdue: number;
};
type RecentPayment = {
  id: string;
  amount: number;
  currency: string;
  paid_on: string | null;
  method: string;
  reference: string;
  invoice_number: string;
  project_name: string;
  project_id: string | null;
};

const CCY_SYMBOL: Record<string, string> = {
  NGN: "₦", USD: "$", EUR: "€", GBP: "£", ZAR: "R", KES: "KSh", GHS: "GH₵", XAF: "FCFA",
};

function fmtMoney(amount: number, ccy: string): string {
  const sym = CCY_SYMBOL[ccy] ?? `${ccy} `;
  if (amount === 0) return `${sym}0`;
  if (Math.abs(amount) >= 1_000_000) return `${sym}${(amount / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (Math.abs(amount) >= 1_000)     return `${sym}${(amount / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sym}${Math.round(amount).toLocaleString()}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const day = Math.floor(ms / 86_400_000);
  if (day < 1) return "today";
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

type DeliveryProject = {
  id: string;
  code: string;
  name: string;
  status: string;
  end_date: string | null;
  client_name: string;
  tasks: number;
  tasks_done: number;
};

const FINISHED_STATUSES = ["invoiced", "paid", "closed"];

export function FinancePage() {
  const { data, isLoading } = useQuery<Summary>({
    queryKey: ["finance", "summary"], queryFn: () => api("/api/v1/finance/summary"),
  });
  // Delivery health pulls from the same projects list the Projects page uses.
  // We compute target-vs-actual entirely client-side so this view stays in
  // lockstep with what HR / PMs already see, with no new endpoint to feed.
  const { data: projectsData } = useQuery<{ items: DeliveryProject[] }>({
    queryKey: ["projects", "for-finance-delivery"],
    queryFn: () => api("/api/v1/projects"),
    staleTime: 60_000,
  });

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  const ccy = data.primary_currency;
  const primary = data.by_currency.find((c) => c.currency === ccy) ?? { currency: ccy, billed: 0, collected: 0, outstanding: 0 };
  const overdue = data.aging["31_60"] + data.aging["61_90"] + data.aging["90_plus"];
  const collectionRate = primary.billed > 0 ? (primary.collected / primary.billed) * 100 : 0;

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Cash position</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <Wallet size={26} className="text-accent" /> Finance
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Live view of billed vs collected, aging receivables, and the pipeline value still due to land.
            All figures in <span className="font-semibold">{ccy}</span> — secondary currencies shown below.
          </p>
        </div>
        <Link to="/finance/invoices" className="btn-outline">
          <FileText size={14} /> Invoices →
        </Link>
      </header>

      {/* KPI strip — primary-currency totals */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <Kpi label="Billed"             value={fmtMoney(primary.billed, ccy)} sub="issued + collected" />
        <Kpi label="Collected"          value={fmtMoney(primary.collected, ccy)} tone="good"
             sub={primary.billed > 0 ? `${collectionRate.toFixed(0)}% collection rate` : ""} />
        <Kpi label="Outstanding"        value={fmtMoney(primary.outstanding, ccy)}
             tone={primary.outstanding > 0 ? "warn" : "neutral"} sub={primary.outstanding > 0 ? "awaiting payment" : "all clear"} />
        <Kpi label="Overdue"            value={fmtMoney(overdue, ccy)}
             tone={overdue > 0 ? "bad" : "good"} sub={overdue > 0 ? "past due date" : "no overdue"} />
        <Kpi label="Pipeline at risk"   value={fmtMoney(data.pipeline_at_risk, ccy)}
             icon={<TrendingUp size={11} />} sub="approved leads, not yet collected" />
      </div>

      {/* Currency breakdown — only shown when there's more than one */}
      {data.by_currency.length > 1 && (
        <section className="bg-surface border border-border rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">Currency mix</h2>
            <span className="text-[11px] text-muted">{data.by_currency.length} currencies</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {data.by_currency.map((c) => (
              <div key={c.currency} className="bg-bg/40 border border-border rounded-xl p-3">
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{c.currency}</div>
                <div className="text-text font-bold">{fmtMoney(c.billed, c.currency)} billed</div>
                <div className="text-[11.5px] text-muted">
                  {fmtMoney(c.collected, c.currency)} in · {fmtMoney(c.outstanding, c.currency)} out
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Delivery health — target end-date vs today, banded into On track /
          Approaching (≤7d) / Overdue. Shows portfolio-level counts at the
          top and a focused list of the at-risk projects beneath. Hidden
          when we have nothing to show. */}
      {projectsData && (() => {
        const active = (projectsData.items ?? []).filter((p) => !FINISHED_STATUSES.includes(p.status));
        if (active.length === 0) return null;
        type Banded = DeliveryProject & { days: number | null; band: "on_track" | "approaching" | "overdue" | "no_target" };
        const banded: Banded[] = active.map((p) => {
          if (!p.end_date) return { ...p, days: null, band: "no_target" };
          const t = new Date(p.end_date + (p.end_date.length === 10 ? "T00:00:00" : "")).getTime();
          const days = Math.ceil((t - Date.now()) / 86_400_000);
          const band = days < 0 ? "overdue" : days <= 7 ? "approaching" : "on_track";
          return { ...p, days, band };
        });
        const onTrack    = banded.filter((b) => b.band === "on_track").length;
        const approaching = banded.filter((b) => b.band === "approaching");
        const overdue    = banded.filter((b) => b.band === "overdue");
        const noTarget   = banded.filter((b) => b.band === "no_target").length;
        // The headline list — overdue first (worst), then approaching by days
        // ascending so the closest-to-target sits at the top.
        const focus = [
          ...overdue.sort((a, b) => (a.days ?? 0) - (b.days ?? 0)),
          ...approaching.sort((a, b) => (a.days ?? 0) - (b.days ?? 0)),
        ].slice(0, 8);
        return (
          <section className="bg-surface border border-border rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="h2 flex items-center gap-2">
                <Target size={16} className="text-accent" /> Delivery health
              </h2>
              <Link to="/projects" className="text-xs font-semibold text-accent hover:underline inline-flex items-center gap-1">
                All projects <ArrowRight size={11} />
              </Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <DeliveryStat tone="good" label="On track"    value={onTrack}            sub="more than a week to target" />
              <DeliveryStat tone="warn" label="Approaching" value={approaching.length} sub="due within 7 days" />
              <DeliveryStat tone="bad"  label="Overdue"     value={overdue.length}     sub="past target date" />
              <DeliveryStat tone="neutral" label="No target" value={noTarget}          sub="end date not set" />
            </div>
            {focus.length === 0 ? (
              <EmptyHint
                icon={<CheckCircle2 size={20} className="text-success" />}
                title="Every active engagement is on track"
                body="Nothing is approaching or past its target delivery date."
              />
            ) : (
              <ul className="divide-y divide-border">
                {focus.map((p) => <DeliveryRow key={p.id} p={p} />)}
              </ul>
            )}
          </section>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Aging chart */}
        <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="h2 flex items-center gap-2">
              <Clock size={16} className="text-accent" /> Receivables aging
            </h2>
            <span className="text-[11px] text-muted">In {ccy}</span>
          </div>
          <AgingBars aging={data.aging} ccy={ccy} />
        </section>

        {/* Invoice status breakdown */}
        <section className="bg-surface border border-border rounded-2xl p-5">
          <h2 className="h2 mb-4 flex items-center gap-2">
            <Receipt size={16} className="text-accent" /> Invoice mix
          </h2>
          <StatusBreakdown counts={data.status_counts} />
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top unpaid */}
        <section className="bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2 flex items-center gap-2">
              <AlertTriangle size={16} className="text-accent" /> Top unpaid invoices
            </h2>
            <Link to="/finance/invoices" className="text-xs font-semibold text-accent hover:underline inline-flex items-center gap-1">
              All invoices <ArrowRight size={11} />
            </Link>
          </div>
          {data.top_unpaid.length === 0 ? (
            <EmptyHint icon={<CheckCircle2 size={20} className="text-success" />}
              title="Nothing outstanding" body="Every issued invoice has been paid in full." />
          ) : (
            <ul className="space-y-2">
              {data.top_unpaid.map((u) => <UnpaidRow key={u.id} u={u} />)}
            </ul>
          )}
        </section>

        {/* Recent payments */}
        <section className="bg-surface border border-border rounded-2xl p-5">
          <h2 className="h2 mb-3 flex items-center gap-2">
            <ArrowDownToLine size={16} className="text-success" /> Recent payments
          </h2>
          {data.recent_payments.length === 0 ? (
            <EmptyHint icon={<Receipt size={20} className="text-muted" />}
              title="No payments recorded" body="Payments appear here as soon as they're recorded against issued invoices." />
          ) : (
            <ul className="divide-y divide-border">
              {data.recent_payments.map((p) => <PaymentRow key={p.id} p={p} />)}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function Kpi({
  label, value, sub, tone, icon,
}: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" | "neutral"; icon?: React.ReactNode }) {
  const cls = { good: "text-success", warn: "text-warn", bad: "text-danger", neutral: "text-text" }[tone ?? "neutral"];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-2xl font-extrabold mt-1 ${cls}`}>{value}</div>
      {sub && (
        <div className="text-[11px] text-muted mt-0.5 inline-flex items-center gap-1">
          {icon} {sub}
        </div>
      )}
    </div>
  );
}

function AgingBars({ aging, ccy }: { aging: Summary["aging"]; ccy: string }) {
  const buckets: { key: keyof Summary["aging"]; label: string; cls: string }[] = [
    { key: "current", label: "Current",  cls: "bg-success" },
    { key: "0_30",    label: "0-30 days",  cls: "bg-accent" },
    { key: "31_60",   label: "31-60 days", cls: "bg-warn" },
    { key: "61_90",   label: "61-90 days", cls: "bg-warn/80" },
    { key: "90_plus", label: "90+ days",   cls: "bg-danger" },
  ];
  const max = Math.max(...buckets.map((b) => aging[b.key]), 1);
  const total = buckets.reduce((s, b) => s + aging[b.key], 0);

  if (total === 0) {
    return <EmptyHint icon={<CheckCircle2 size={20} className="text-success" />}
      title="No outstanding receivables" body="Issued invoices have either been collected or aren't yet due." />;
  }

  return (
    <div className="space-y-2.5">
      {buckets.map((b) => {
        const v = aging[b.key];
        const pct = (v / max) * 100;
        const sharePct = total > 0 ? (v / total) * 100 : 0;
        return (
          <div key={b.key}>
            <div className="flex items-center justify-between text-[12px] mb-1">
              <span className="text-text font-semibold">{b.label}</span>
              <span className="text-muted">
                {fmtMoney(v, ccy)} {sharePct > 0 && <span className="text-[10.5px]">({sharePct.toFixed(0)}%)</span>}
              </span>
            </div>
            <div className="h-2 bg-bg rounded-full overflow-hidden">
              <div className={`h-full ${b.cls} transition-all`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusBreakdown({ counts }: { counts: Record<string, number> }) {
  const items: { key: string; label: string; cls: string; bar: string }[] = [
    { key: "draft",          label: "Draft",        cls: "text-muted",  bar: "bg-muted/40" },
    { key: "issued",         label: "Issued",       cls: "text-accent", bar: "bg-accent" },
    { key: "partially_paid", label: "Partial",      cls: "text-warn",   bar: "bg-warn" },
    { key: "paid",           label: "Paid",         cls: "text-success",bar: "bg-success" },
    { key: "void",           label: "Void",         cls: "text-danger", bar: "bg-danger" },
  ];
  const total = items.reduce((s, i) => s + (counts[i.key] ?? 0), 0);
  if (total === 0) {
    return <EmptyHint icon={<Receipt size={20} className="text-muted" />}
      title="No invoices yet" body="Create one from a project page to start tracking cash." />;
  }
  return (
    <>
      {/* Stacked horizontal bar */}
      <div className="h-3 bg-bg rounded-full overflow-hidden flex mb-4">
        {items.map((i) => {
          const v = counts[i.key] ?? 0;
          const pct = total > 0 ? (v / total) * 100 : 0;
          if (v === 0) return null;
          return <div key={i.key} className={`${i.bar}`} style={{ width: `${pct}%` }} title={`${i.label}: ${v}`} />;
        })}
      </div>
      <ul className="space-y-1.5 text-[12.5px]">
        {items.map((i) => {
          const v = counts[i.key] ?? 0;
          if (v === 0) return null;
          return (
            <li key={i.key} className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${i.bar}`} />
                <span className={i.cls}>{i.label}</span>
              </span>
              <span className="text-text font-semibold">{v}</span>
            </li>
          );
        })}
      </ul>
      <div className="text-[11px] text-muted mt-3 pt-3 border-t border-border">{total} invoice{total === 1 ? "" : "s"} total</div>
    </>
  );
}

function UnpaidRow({ u }: { u: TopUnpaid }) {
  const overdue = u.days_overdue > 0;
  return (
    <li className="flex items-start gap-3 bg-bg/30 border border-border rounded-xl p-3">
      <div className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${
        overdue ? "bg-danger/15 text-danger" : "bg-accent-soft text-accent"
      }`}>
        <Receipt size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-text font-mono">{u.number}</span>
          {overdue ? (
            <span className="pill bg-danger/15 text-danger">{u.days_overdue}d overdue</span>
          ) : (
            <span className="pill bg-warn/15 text-warn">due {fmtDate(u.due_on)}</span>
          )}
        </div>
        {u.project_id ? (
          <Link to={`/projects/${u.project_id}`} className="text-[11.5px] text-accent hover:underline inline-flex items-center gap-1 mt-0.5">
            <FolderKanban size={11} /> {u.project_name}
          </Link>
        ) : (
          <span className="text-[11.5px] text-muted">{u.project_name || "Unlinked"}</span>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-extrabold text-text">{fmtMoney(u.outstanding, u.currency)}</div>
        {u.amount !== u.outstanding && (
          <div className="text-[10.5px] text-muted">of {fmtMoney(u.amount, u.currency)}</div>
        )}
      </div>
    </li>
  );
}

function PaymentRow({ p }: { p: RecentPayment }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="w-9 h-9 rounded-lg bg-success/15 text-success grid place-items-center shrink-0">
        <ArrowDownToLine size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-text">{fmtMoney(p.amount, p.currency)}</span>
          <span className="text-[11px] text-muted font-mono">on {p.invoice_number}</span>
        </div>
        <div className="text-[11px] text-muted truncate">
          {p.project_id ? (
            <Link to={`/projects/${p.project_id}`} className="hover:text-accent">{p.project_name || "Project"}</Link>
          ) : "—"}
          {p.method && <> · {p.method}</>}
          {p.reference && <> · ref {p.reference}</>}
        </div>
      </div>
      <span className="text-[11px] text-muted whitespace-nowrap shrink-0">{fmtRel(p.paid_on)}</span>
    </li>
  );
}

function EmptyHint({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="text-center py-6">
      <div className="w-10 h-10 mx-auto rounded-full bg-bg/50 grid place-items-center mb-2">{icon}</div>
      <div className="text-sm font-bold text-text">{title}</div>
      <p className="text-xs text-muted mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  );
}

// DeliveryStat — small tile used inside the Delivery health section. Same
// visual language as the existing Kpi tile up top, just narrower and tone-
// banded so the four bands (good / warn / bad / neutral) read instantly.
function DeliveryStat({
  label, value, sub, tone,
}: { label: string; value: number; sub: string; tone: "good" | "warn" | "bad" | "neutral" }) {
  const valueCls = { good: "text-success", warn: "text-warn", bad: "text-danger", neutral: "text-text" }[tone];
  const bubble = {
    good:    "bg-success/10 text-success",
    warn:    "bg-warn/10 text-warn",
    bad:     "bg-danger/10 text-danger",
    neutral: "bg-bg text-muted",
  }[tone];
  return (
    <div className="bg-bg/40 border border-border rounded-xl p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md ${bubble}`}>
          <Target size={11} />
        </span>
        <span className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</span>
      </div>
      <div className={`text-2xl font-extrabold leading-none ${valueCls}`}>{value}</div>
      <div className="text-[11px] text-muted leading-snug">{sub}</div>
    </div>
  );
}

// DeliveryRow — one project entry inside the focus list. Renders the
// project code/name with client, a coloured "Xd late / Xd left" pill, and
// a quick progress bar derived from the same task counts the Projects list
// shows. Clicking jumps to the project detail page.
function DeliveryRow({ p }: { p: DeliveryProject & { days: number | null; band: "on_track" | "approaching" | "overdue" | "no_target" } }) {
  const completion = p.tasks === 0 ? 0 : Math.round((p.tasks_done / p.tasks) * 100);
  const dayLabel =
    p.days === null ? "No target"
    : p.days < 0    ? `${Math.abs(p.days)}d overdue`
    : p.days === 0  ? "Due today"
    : `${p.days}d left`;
  const pillCls =
    p.band === "overdue"     ? "bg-danger/15 text-danger border-danger/30"
    : p.band === "approaching" ? "bg-warn/15 text-warn border-warn/30"
    : "bg-bg text-muted border-border";
  return (
    <li className="py-3 flex items-center gap-3">
      <span className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${
        p.band === "overdue" ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn"
      }`}>
        <CalendarClock size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-[11px] font-mono font-semibold text-muted shrink-0">{p.code}</span>
          <Link to={`/projects/${p.id}`} className="text-sm font-bold text-text hover:text-accent truncate">
            {p.name}
          </Link>
          <span className={`pill border text-[10px] uppercase tracking-wide font-bold whitespace-nowrap ${pillCls}`}>
            {dayLabel}
          </span>
        </div>
        <div className="text-[11.5px] text-muted truncate">
          {p.client_name || "Unassigned"}
          {p.end_date && <span> · target {new Date(p.end_date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
          {p.tasks > 0 && <span> · {completion}% complete</span>}
        </div>
      </div>
      {p.tasks > 0 && (
        <div className="h-1.5 w-24 bg-bg/60 rounded-full overflow-hidden shrink-0">
          <div
            className={`h-full ${completion === 100 ? "bg-success" : completion >= 50 ? "bg-accent" : "bg-warn"}`}
            style={{ width: `${completion}%` }}
          />
        </div>
      )}
    </li>
  );
}
