import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import {
  Plane, Plus, CheckCircle2, X, Calendar as CalendarIcon, Briefcase, AlertTriangle,
  ListChecks, Users as UsersIcon, BarChart3, Clock,
} from "lucide-react";

/* ---------- Types ---------- */

type LeaveType = {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  default_days: number;
  requires_docs: boolean;
};

type Balance = {
  leave_type_id: string;
  code: string;
  name: string;
  paid: boolean;
  accrued_days: number;
  carryover_days: number;
  used_days: number;
  remaining_days: number;
  year: number;
};

type LeaveRequest = {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  leave_type_id: string;
  code: string;
  type_name: string;
  paid: boolean;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  handover_notes: string;
  backup_user_id: string | null;
  backup_user_name: string;
  status: "draft" | "pending" | "approved" | "rejected" | "cancelled";
  decision_by: string | null;
  decision_by_name: string;
  decision_at: string | null;
  decision_comment: string;
  submitted_at: string;
};

type Dashboard = {
  on_leave_today: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string }[];
  upcoming: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string; days: number }[];
  pending_approvals: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string; days: number; reason: string; submitted_at: string }[];
  upcoming_holidays: { id: string; observed_on: string; name: string }[];
};

type Tab = "dashboard" | "my" | "team" | "balances" | "calendar";

const STATUS_PILL: Record<LeaveRequest["status"], { label: string; cls: string }> = {
  draft:     { label: "Draft",     cls: "bg-muted/15 text-muted" },
  pending:   { label: "Pending",   cls: "bg-accent-soft text-accent" },
  approved:  { label: "Approved",  cls: "bg-success/15 text-success" },
  rejected:  { label: "Rejected",  cls: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", cls: "bg-muted/15 text-muted" },
};

function fmtDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/* ---------- Main page ---------- */

export function LeavePage() {
  const { user } = useAuth();
  const canApprove = (user?.roles ?? []).some((r) => ["super_admin", "ceo", "coo", "hr"].includes(r));
  const [tab, setTab] = useState<Tab>("dashboard");
  const [requestOpen, setRequestOpen] = useState(false);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; show: boolean }[] = [
    { key: "dashboard", label: "Dashboard",    icon: BarChart3,   show: true },
    { key: "my",        label: "My requests",  icon: ListChecks,  show: true },
    { key: "team",      label: "Team requests", icon: UsersIcon,  show: canApprove },
    { key: "balances",  label: "Balances",     icon: Clock,       show: true },
    { key: "calendar",  label: "Calendar",     icon: CalendarIcon, show: true },
  ];

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Workspace</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <Plane size={26} className="text-accent" /> Leave
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Request leave, track balances and approve requests in one place. Approved leave reduces team
            availability on the workforce + project pages automatically.
          </p>
        </div>
        <SmartButton variant="primary" icon={<Plus size={14} />} onClick={() => setRequestOpen(true)}>
          Request leave
        </SmartButton>
      </header>

      <nav className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              tab === t.key ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === "dashboard" && <DashboardTab canApprove={canApprove} />}
      {tab === "my"        && <RequestList scope="mine" />}
      {tab === "team"      && canApprove && <RequestList scope="team" canApprove />}
      {tab === "balances"  && <BalancesTab />}
      {tab === "calendar"  && <CalendarTab />}

      {requestOpen && (
        <RequestLeaveDialog
          onClose={() => setRequestOpen(false)}
          onCreated={() => setRequestOpen(false)}
        />
      )}
    </div>
  );
}

/* ---------- Dashboard tab ---------- */

function DashboardTab({ canApprove }: { canApprove: boolean }) {
  const { data, isLoading } = useQuery<Dashboard>({
    queryKey: ["leave-dashboard"],
    queryFn: () => api("/api/v1/leave/dashboard"),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <div className="text-muted">Loading…</div>;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="On leave today" value={data.on_leave_today.length} tone="info" icon={<Plane size={14} />} />
        <Kpi label="Upcoming approved" value={data.upcoming.length} tone="neutral" icon={<CalendarIcon size={14} />} />
        <Kpi label="Pending approvals" value={data.pending_approvals.length} tone={data.pending_approvals.length ? "warn" : "good"} icon={<Clock size={14} />} />
        <Kpi label="Public holidays" value={data.upcoming_holidays.length} tone="neutral" icon={<CalendarIcon size={14} />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="On leave today">
          {data.on_leave_today.length === 0 ? (
            <Empty>Everybody's in today.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {data.on_leave_today.map((r) => (
                <li key={r.id} className="py-2.5 flex items-center gap-3">
                  <Avatar name={r.user_name || r.user_email} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-text truncate">{r.user_name || r.user_email}</div>
                    <div className="text-[11px] text-muted">{r.type_name} · {fmtDate(r.start_date)} → {fmtDate(r.end_date)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Upcoming">
          {data.upcoming.length === 0 ? (
            <Empty>No scheduled leave in the next few weeks.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {data.upcoming.map((r) => (
                <li key={r.id} className="py-2.5 flex items-center gap-3">
                  <Avatar name={r.user_name || r.user_email} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-text truncate">{r.user_name || r.user_email}</div>
                    <div className="text-[11px] text-muted">{r.type_name} · {fmtDate(r.start_date)} → {fmtDate(r.end_date)} ({r.days}d)</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {canApprove && (
          <Section title="Pending approvals" className="lg:col-span-2">
            {data.pending_approvals.length === 0 ? (
              <Empty>Inbox clear. No requests waiting.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {data.pending_approvals.map((r) => (
                  <PendingRow key={r.id} req={r} />
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="Upcoming public holidays" className={canApprove ? "lg:col-span-2" : ""}>
          {data.upcoming_holidays.length === 0 ? (
            <Empty>No public holidays on the calendar.</Empty>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.upcoming_holidays.map((h) => (
                <span key={h.id} className="pill bg-accent-soft text-accent">
                  {fmtDate(h.observed_on)} · {h.name}
                </span>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function PendingRow({ req }: { req: Dashboard["pending_approvals"][number] }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (body: { decision: "approved" | "rejected"; comment?: string }) =>
      api(`/api/v1/leave/requests/${req.id}/decision`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      toast.success("Decision recorded");
    },
    onError: (e: any) => toast.error("Could not save decision", e?.message),
  });

  return (
    <li className="py-3 flex items-center gap-3">
      <Avatar name={req.user_name || req.user_email} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text">{req.user_name || req.user_email}</div>
        <div className="text-[11px] text-muted">
          {req.type_name} · {fmtDate(req.start_date)} → {fmtDate(req.end_date)} ({req.days}d)
          {req.reason && ` · "${req.reason}"`}
        </div>
      </div>
      <button
        onClick={() => decide.mutate({ decision: "rejected" })}
        disabled={decide.isPending}
        className="text-xs font-semibold px-3 py-1.5 rounded-full bg-danger/10 text-danger hover:bg-danger/20"
      >
        Reject
      </button>
      <button
        onClick={() => decide.mutate({ decision: "approved" })}
        disabled={decide.isPending}
        className="text-xs font-semibold px-3 py-1.5 rounded-full bg-success/10 text-success hover:bg-success/20"
      >
        Approve
      </button>
    </li>
  );
}

/* ---------- My / Team requests tab ---------- */

function RequestList({ scope, canApprove }: { scope: "mine" | "team"; canApprove?: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: LeaveRequest[] }>({
    queryKey: ["leave-requests", scope],
    queryFn: () => api(`/api/v1/leave/requests?scope=${scope}`),
  });
  const items = data?.items ?? [];

  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/v1/leave/requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      toast.success("Request cancelled");
    },
    onError: (e: any) => toast.error("Could not cancel", e?.message),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision, comment }: { id: string; decision: "approved" | "rejected"; comment?: string }) =>
      api(`/api/v1/leave/requests/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, comment }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      toast.success("Decision recorded");
    },
    onError: (e: any) => toast.error("Could not save decision", e?.message),
  });

  if (isLoading) return <div className="text-muted">Loading…</div>;
  if (items.length === 0) return (
    <Empty>
      {scope === "mine" ? "You haven't submitted any leave requests yet." : "No team requests on file."}
    </Empty>
  );

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              {scope === "team" && <th className="text-left px-4 py-3">Member</th>}
              <th className="text-left px-4 py-3">Type</th>
              <th className="text-left px-4 py-3">Window</th>
              <th className="text-right px-4 py-3">Days</th>
              <th className="text-left px-4 py-3">Reason</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const pill = STATUS_PILL[r.status];
              return (
                <tr key={r.id} className="border-t border-border">
                  {scope === "team" && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={r.user_name || r.user_email} />
                        <div className="min-w-0">
                          <div className="font-semibold text-text truncate">{r.user_name || r.user_email}</div>
                          <div className="text-[11px] text-muted truncate">{r.user_email}</div>
                        </div>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="font-semibold text-text">{r.type_name}</div>
                    {!r.paid && <div className="text-[11px] text-muted">Unpaid</div>}
                  </td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">
                    {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-text">{r.days}</td>
                  <td className="px-4 py-3 text-muted max-w-[280px]">
                    <div className="truncate" title={r.reason}>{r.reason || "—"}</div>
                    {r.handover_notes && (
                      <div className="text-[11px] text-muted/80 italic truncate" title={r.handover_notes}>
                        Handover: {r.handover_notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`pill ${pill.cls}`}>{pill.label}</span>
                    {r.decision_by_name && (
                      <div className="text-[10.5px] text-muted mt-0.5">by {r.decision_by_name}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canApprove && r.status === "pending" && (
                      <>
                        <button
                          onClick={() => decide.mutate({ id: r.id, decision: "approved" })}
                          className="text-xs font-semibold px-2.5 py-1 rounded-full bg-success/10 text-success hover:bg-success/20 mr-1"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: r.id, decision: "rejected" })}
                          className="text-xs font-semibold px-2.5 py-1 rounded-full bg-danger/10 text-danger hover:bg-danger/20 mr-1"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {(r.status === "pending" || r.status === "approved") && (
                      <button
                        onClick={() => {
                          if (confirm("Cancel this request?")) cancel.mutate(r.id);
                        }}
                        className="text-xs text-muted hover:text-danger"
                      >
                        Cancel
                      </button>
                    )}
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

/* ---------- Balances tab ---------- */

function BalancesTab() {
  const { data, isLoading } = useQuery<{ items: Balance[]; year: number }>({
    queryKey: ["leave-balances"],
    queryFn: () => api("/api/v1/leave/balances"),
  });
  if (isLoading || !data) return <div className="text-muted">Loading…</div>;
  if (data.items.length === 0) return <Empty>No leave types configured for this workspace yet.</Empty>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {data.items.map((b) => {
        const total = b.accrued_days + b.carryover_days;
        const pct = total > 0 ? Math.min(100, Math.max(0, (b.used_days / total) * 100)) : 0;
        return (
          <div key={b.leave_type_id} className="bg-surface border border-border rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-text">{b.name}</div>
              {!b.paid && <span className="pill bg-muted/15 text-muted">Unpaid</span>}
            </div>
            <div className="mt-3 flex items-end gap-1.5">
              <div className="text-3xl font-extrabold text-accent">{b.remaining_days.toFixed(1)}</div>
              <div className="text-xs text-muted mb-1">days remaining · {data.year}</div>
            </div>
            <div className="h-1.5 bg-bg rounded-full mt-3 overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex justify-between text-[11px] text-muted mt-1.5">
              <span>Used {b.used_days}</span>
              <span>Allowance {total}</span>
            </div>
            {b.carryover_days > 0 && (
              <div className="text-[11px] text-muted mt-1">includes {b.carryover_days}d carryover</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Calendar tab ---------- */

function CalendarTab() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const from = month.toISOString().slice(0, 10);
  const toDate = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const to = toDate.toISOString().slice(0, 10);

  const { data } = useQuery<{ items: { id: string; user_name: string; user_email: string; code: string; type_name: string; start_date: string; end_date: string; status: string }[] }>({
    queryKey: ["leave-calendar", from, to],
    queryFn: () => api(`/api/v1/leave/calendar?from=${from}&to=${to}`),
  });
  const items = data?.items ?? [];

  const { data: hol } = useQuery<{ items: { id: string; observed_on: string; name: string }[] }>({
    queryKey: ["public-holidays", month.getFullYear()],
    queryFn: () => api(`/api/v1/leave/public-holidays?year=${month.getFullYear()}`),
  });
  const holidays = hol?.items ?? [];

  // Build day-cell content
  const grid = useMemo(() => {
    const first = new Date(month);
    const last  = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const cells: { date: Date; iso: string; inMonth: boolean }[] = [];
    const startOffset = first.getDay() === 0 ? 6 : first.getDay() - 1; // ISO Monday-first
    const startDate = new Date(first);
    startDate.setDate(first.getDate() - startOffset);
    const totalDays = startOffset + last.getDate();
    const totalCells = Math.ceil(totalDays / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      cells.push({ date: d, iso: d.toISOString().slice(0, 10), inMonth: d.getMonth() === month.getMonth() });
    }
    return cells;
  }, [month]);

  function shift(months: number) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + months, 1));
  }

  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => shift(-1)} className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text hover:bg-bg">← Prev</button>
        <div className="font-bold text-text">{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
        <button onClick={() => shift(1)} className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text hover:bg-bg">Next →</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => <div key={d} className="px-2">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.map((cell) => {
          const dayItems = items.filter((i) => cell.iso >= i.start_date && cell.iso <= i.end_date);
          const isHol = holidays.find((h) => h.observed_on === cell.iso);
          return (
            <div
              key={cell.iso}
              className={`min-h-[70px] rounded-lg border p-1.5 text-left text-[11px] ${
                cell.inMonth ? "border-border bg-bg/30" : "border-transparent bg-transparent text-muted/50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`font-semibold ${cell.inMonth ? "text-text" : "text-muted/60"}`}>{cell.date.getDate()}</span>
                {isHol && <span className="pill bg-warn/15 text-warn">{isHol.name.slice(0, 12)}</span>}
              </div>
              <div className="mt-1 space-y-0.5">
                {dayItems.slice(0, 3).map((i) => (
                  <div key={i.id} className={`truncate rounded px-1 py-0.5 ${
                    i.status === "approved" ? "bg-accent-soft text-accent" : "bg-bg text-muted"
                  }`} title={`${i.user_name} · ${i.type_name}`}>
                    {(i.user_name || i.user_email).split(" ")[0]}
                  </div>
                ))}
                {dayItems.length > 3 && (
                  <div className="text-[10.5px] text-muted">+{dayItems.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Request leave dialog ---------- */

function RequestLeaveDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const qc = useQueryClient();
  const { data: typesData } = useQuery<{ items: LeaveType[] }>({
    queryKey: ["leave-types"],
    queryFn: () => api("/api/v1/leave/types"),
  });
  const types = typesData?.items ?? [];
  const { data: balData } = useQuery<{ items: Balance[]; year: number }>({
    queryKey: ["leave-balances"],
    queryFn: () => api("/api/v1/leave/balances"),
  });
  const balances = balData?.items ?? [];

  const [typeID, setTypeID] = useState<string>("");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [reason, setReason] = useState("");
  const [handover, setHandover] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Default to annual once types load
  if (!typeID && types.length > 0) {
    const annual = types.find((t) => t.code === "annual") ?? types[0];
    if (annual) setTypeID(annual.id);
  }

  const pickedType = types.find((t) => t.id === typeID);
  const pickedBalance = balances.find((b) => b.leave_type_id === typeID);

  // Approx days
  const days = useMemo(() => {
    if (!start || !end) return 0;
    const s = new Date(start); const e = new Date(end);
    if (e < s) return 0;
    let count = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) count++;
    }
    return count;
  }, [start, end]);

  const overdrawn = pickedBalance && pickedBalance.paid && days > pickedBalance.remaining_days;

  const create = useMutation({
    mutationFn: (b: { leave_type_id: string; start_date: string; end_date: string; reason: string; handover_notes: string }) =>
      api("/api/v1/leave/requests", { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      toast.success("Leave request submitted", "Your manager will be notified to approve.");
      onCreated();
    },
    onError: (e: any) => setErr(e?.message ?? "Could not submit request."),
  });

  function submit() {
    setErr(null);
    if (!typeID)  { setErr("Pick a leave type."); return; }
    if (!start)   { setErr("Start date is required."); return; }
    if (!end)     { setErr("End date is required."); return; }
    if (new Date(end) < new Date(start)) { setErr("End date can't be before start date."); return; }
    create.mutate({
      leave_type_id: typeID, start_date: start, end_date: end,
      reason: reason.trim(), handover_notes: handover.trim(),
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Request leave</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4">
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Leave type</div>
            <select
              className="input"
              value={typeID}
              onChange={(e) => setTypeID(e.target.value)}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{!t.paid && " (unpaid)"}
                </option>
              ))}
            </select>
            {pickedType && pickedBalance && (
              <div className="text-[11px] text-muted mt-1">
                {pickedType.paid
                  ? <>You have <span className="font-semibold text-text">{pickedBalance.remaining_days.toFixed(1)}</span> day{pickedBalance.remaining_days === 1 ? "" : "s"} remaining.</>
                  : "Unpaid leave — no balance deduction."}
                {pickedType.requires_docs && <> · Supporting documents required.</>}
              </div>
            )}
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Start date</div>
              <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">End date</div>
              <input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>

          {days > 0 && (
            <div className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 ${
              overdrawn ? "bg-danger/10 border-danger/30 text-danger" : "bg-bg/40 border-border text-text"
            }`}>
              <CalendarIcon size={14} />
              <span className="font-semibold">{days} working day{days === 1 ? "" : "s"}</span>
              {overdrawn && (
                <span className="text-[11px] ml-auto">
                  Exceeds remaining balance ({pickedBalance!.remaining_days.toFixed(1)}d) — your manager will need to approve the overdraft.
                </span>
              )}
            </div>
          )}

          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Reason</div>
            <textarea
              className="input min-h-[60px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional — what's the trip for, or why you need the time off."
            />
          </label>

          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Handover notes</div>
            <textarea
              className="input min-h-[80px]"
              value={handover}
              onChange={(e) => setHandover(e.target.value)}
              placeholder="Pending deliverables, who's covering, open blockers, escalation owner."
            />
            <div className="text-[11px] text-muted mt-1">
              <Briefcase size={11} className="inline -mt-0.5" /> Strongly recommended on enterprise projects so the team isn't blocked while you're out.
            </div>
          </label>

          {err && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> {err}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={create.isPending}
            loadingLabel="Submitting…"
            icon={<CheckCircle2 size={14} />}
            onClick={submit}
          >
            Submit request
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ---------- Tiny presentational helpers ---------- */

function Kpi({ label, value, tone, icon }: { label: string; value: number | string; tone: "good" | "warn" | "info" | "neutral"; icon: React.ReactNode }) {
  const cls = { good: "text-success", warn: "text-warn", info: "text-accent", neutral: "text-text" }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted font-bold">
        {icon} {label}
      </div>
      <div className={`text-2xl font-extrabold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-border rounded-2xl p-5 ${className ?? ""}`}>
      <h2 className="h2 text-base mb-2">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-muted italic py-2">{children}</div>;
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center text-xs font-bold shrink-0">
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}
