import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import {
  Plane, Plus, CheckCircle2, X, Calendar as CalendarIcon, AlertTriangle,
  ListChecks, Users as UsersIcon, BarChart3, Clock, UploadCloud, FileText,
  Trash2, Hourglass, MessageSquare, TrendingUp, Ban,
  ChevronDown, ChevronRight,
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
  approval_stage?: "manager_pending" | "hr_pending" | "completed";
  approvals?: { stage: "manager" | "hr"; decision: "approved" | "rejected"; by: string; at: string; comment?: string }[];
  duration?: "full_day" | "half_day_am" | "half_day_pm";
  decision_by: string | null;
  decision_by_name: string;
  decision_at: string | null;
  decision_comment: string;
  submitted_at: string;
};

type Dashboard = {
  on_leave_today: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string }[];
  upcoming: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string; days: number }[];
  pending_approvals: { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string; days: number; reason: string; submitted_at: string; approval_stage?: "manager_pending" | "hr_pending" }[];
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

// For pending requests, the stage is more informative than "Pending" — it
// tells you who's blocking the request right now.
function statusPill(r: LeaveRequest): { label: string; cls: string } {
  if (r.status === "pending") {
    if (r.approval_stage === "manager_pending") return { label: "Awaiting line manager", cls: "bg-accent-soft text-accent" };
    if (r.approval_stage === "hr_pending")      return { label: "Awaiting HR sign-off",    cls: "bg-warn/15 text-warn" };
  }
  return STATUS_PILL[r.status];
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/* ---------- Main page ---------- */

export function LeavePage() {
  const { user } = useAuth();
  // Anyone who can act on either stage (line manager OR HR) sees the team tab.
  const canApprove = (user?.roles ?? []).some((r) =>
    ["super_admin", "ceo", "coo", "hr", "delivery_manager", "project_manager"].includes(r)
  );
  const [tab, setTab] = useState<Tab>("dashboard");
  const [requestOpen, setRequestOpen] = useState(false);

  // Block the "Request leave" button when the caller already has a live
  // request (pending, or approved & not yet ended). Mirrors the 409 the API
  // returns so the user finds out before opening the dialog.
  const { data: mine } = useQuery<{ items: LeaveRequest[] }>({
    queryKey: ["leave-requests", "mine"],
    queryFn: () => api(`/api/v1/leave/requests?scope=mine`),
  });
  const today = new Date().toISOString().slice(0, 10);
  const activeLeave = (mine?.items ?? []).find(
    (r) => (r.status === "pending" || r.status === "approved") && r.end_date >= today,
  );

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
        <div className="flex flex-col items-end gap-1">
          <SmartButton
            variant="primary"
            icon={<Plus size={14} />}
            onClick={() => setRequestOpen(true)}
            disabled={!!activeLeave}
            title={activeLeave ? "You already have an active leave request" : undefined}
          >
            Request leave
          </SmartButton>
          {activeLeave && (
            <div className="text-[11px] text-muted text-right">
              You have a {activeLeave.status} request ({fmtDate(activeLeave.start_date)} – {fmtDate(activeLeave.end_date)}).
              Cancel it to request another.
            </div>
          )}
        </div>
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
  const { data: auth } = useQuery<{ can_approve_manager: boolean; can_approve_hr: boolean }>({
    queryKey: ["leave-authority"],
    queryFn: () => api("/api/v1/leave/decision-authority"),
    staleTime: 60_000,
  });
  const authority = auth ?? { can_approve_manager: false, can_approve_hr: false };

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
          <PendingApprovalsSection
            authority={authority}
            onLeaveToday={data.on_leave_today}
            upcoming={data.upcoming}
          />
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

type OverlapPerson = { id: string; user_name: string; user_email: string; type_name: string; start_date: string; end_date: string };

function PendingApprovalsSection({
  authority, onLeaveToday, upcoming,
}: {
  authority: { can_approve_manager: boolean; can_approve_hr: boolean };
  onLeaveToday: OverlapPerson[];
  upcoming: OverlapPerson[];
}) {
  const { data, isLoading } = useQuery<{ items: LeaveRequest[] }>({
    queryKey: ["leave-requests", "team", "pending"],
    queryFn: () => api(`/api/v1/leave/requests?scope=team&status=pending`),
    refetchInterval: 60_000,
  });
  const items = data?.items ?? [];
  // Sort: things I can act on first, then by start_date asc (closest first).
  const sorted = useMemo(() => {
    const canActOn = (r: LeaveRequest) =>
      r.approval_stage === "hr_pending" ? authority.can_approve_hr : authority.can_approve_manager;
    return [...items].sort((a, b) => {
      const ax = canActOn(a) ? 0 : 1;
      const bx = canActOn(b) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      return a.start_date.localeCompare(b.start_date);
    });
  }, [items, authority]);

  const [filter, setFilter] = useState<"actionable" | "all">("actionable");
  const actionable = sorted.filter((r) =>
    (r.approval_stage === "hr_pending" ? authority.can_approve_hr : authority.can_approve_manager),
  );
  const visible = filter === "actionable" ? actionable : sorted;

  const overlapPool: OverlapPerson[] = [...onLeaveToday, ...upcoming];

  return (
    <Section title={`Pending approvals${sorted.length ? ` · ${sorted.length}` : ""}`} className="lg:col-span-2">
      {sorted.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          <FilterChip active={filter === "actionable"} onClick={() => setFilter("actionable")}>
            Awaiting me · {actionable.length}
          </FilterChip>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All pending · {sorted.length}
          </FilterChip>
        </div>
      )}
      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : sorted.length === 0 ? (
        <Empty>Inbox clear. No requests waiting.</Empty>
      ) : visible.length === 0 ? (
        <Empty>Nothing waiting on you right now — switch to “All pending” to peek at the rest.</Empty>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => (
            <PendingRow key={r.id} req={r} authority={authority} overlapPool={overlapPool} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-semibold px-3 py-1 rounded-full transition-colors ${
        active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text border border-border"
      }`}
    >
      {children}
    </button>
  );
}

function ageString(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function PendingRow({ req, authority, overlapPool }: {
  req: LeaveRequest;
  authority: { can_approve_manager: boolean; can_approve_hr: boolean };
  overlapPool: OverlapPerson[];
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");
  const [rejectMode, setRejectMode] = useState(false);

  const decide = useMutation({
    mutationFn: (body: { decision: "approved" | "rejected"; comment?: string }) =>
      api(`/api/v1/leave/requests/${req.id}/decision`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      toast.success("Decision recorded");
      setComment("");
      setRejectMode(false);
    },
    onError: (e: any) => toast.error("Could not save decision", e?.message),
  });

  const isHRStage = req.approval_stage === "hr_pending";
  const stageLabel = isHRStage ? "HR sign-off" : "line manager";
  const stageBadgeCls = isHRStage ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent";
  const canAct = isHRStage ? authority.can_approve_hr : authority.can_approve_manager;

  const win = relWindow(req.start_date, req.end_date);
  const ageLabel = req.submitted_at ? ageString(req.submitted_at) : "";

  // Urgency: leave starting in <=3 working days = urgent; <=7 = soon.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startDt = new Date(req.start_date); startDt.setHours(0, 0, 0, 0);
  const daysToStart = Math.round((startDt.getTime() - today.getTime()) / 86_400_000);
  const urgency: { label: string; cls: string } | null =
    daysToStart < 0 ? { label: "Already started", cls: "bg-danger/15 text-danger" } :
    daysToStart <= 3 ? { label: `Starts in ${daysToStart}d`, cls: "bg-danger/15 text-danger" } :
    daysToStart <= 7 ? { label: `Starts in ${daysToStart}d`, cls: "bg-warn/15 text-warn" } :
    null;

  // Stale: pending for >48h.
  const submittedAge = req.submitted_at ? Date.now() - new Date(req.submitted_at).getTime() : 0;
  const isStale = submittedAge > 48 * 3_600_000;

  // Overlapping teammates already on/scheduled for leave in this window.
  const overlaps = overlapPool.filter((o) =>
    o.id !== req.id &&
    o.start_date <= req.end_date &&
    o.end_date   >= req.start_date,
  );

  const managerApproval = req.approvals?.find((a) => a.stage === "manager" && a.decision === "approved");

  function submitReject() {
    if (!comment.trim()) {
      toast.error("Reason required", "Tell the requester why so they can plan accordingly.");
      return;
    }
    decide.mutate({ decision: "rejected", comment: comment.trim() });
  }

  return (
    <li className={`bg-surface border rounded-2xl overflow-hidden ${canAct ? "border-border" : "border-border/60 opacity-80"}`}>
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          <Avatar name={req.user_name || req.user_email} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-text">{req.user_name || req.user_email}</span>
              <span className={`pill ${stageBadgeCls} text-[11px]`}>Awaiting {stageLabel}</span>
              {!req.paid && <span className="pill bg-muted/15 text-muted text-[10.5px]">Unpaid</span>}
              {req.duration && req.duration !== "full_day" && (
                <span className="pill bg-bg text-muted text-[10.5px] border border-border">
                  {req.duration === "half_day_am" ? "Half-day AM" : "Half-day PM"}
                </span>
              )}
              {urgency && <span className={`pill ${urgency.cls} text-[10.5px] font-semibold`}>{urgency.label}</span>}
              {isStale && (
                <span className="pill bg-danger/10 text-danger text-[10.5px] inline-flex items-center gap-1" title="Submitted more than 48h ago">
                  <AlertTriangle size={10} /> Stale
                </span>
              )}
            </div>

            <div className="text-[12px] text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-text font-semibold">{req.type_name}</span>
              <span className="inline-flex items-center gap-1">
                <CalendarIcon size={11} /> {fmtDate(req.start_date)} → {fmtDate(req.end_date)}
              </span>
              <span className="font-semibold text-text">{req.days}d</span>
              <span className={`inline-flex items-center gap-1 ${win.tone}`}>
                <Clock size={11} /> {win.label}
              </span>
              {ageLabel && (
                <span className="inline-flex items-center gap-1" title={req.submitted_at}>
                  <Hourglass size={11} /> submitted {ageLabel}
                </span>
              )}
            </div>

            {req.reason && (
              <div className="text-sm text-text mt-1.5 line-clamp-2" title={req.reason}>
                "{req.reason}"
              </div>
            )}

            {/* Conflict signal — visible without expanding so approvers don't double-book a team */}
            {overlaps.length > 0 && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-warn bg-warn/10 border border-warn/20 px-2 py-1 rounded">
                <AlertTriangle size={11} />
                <span>
                  Overlaps with {overlaps.length} other {overlaps.length === 1 ? "person" : "people"}
                  {": "}
                  {overlaps.slice(0, 2).map((o) => (o.user_name || o.user_email).split(" ")[0]).join(", ")}
                  {overlaps.length > 2 && ` +${overlaps.length - 2}`}
                </span>
              </div>
            )}

            <div className="mt-2"><StageStrip r={req} /></div>
          </div>

          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <button
              onClick={() => setExpanded((p) => !p)}
              className="text-[11px] text-muted hover:text-text inline-flex items-center gap-0.5"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? "Less" : "Details"}
            </button>
            {canAct ? (
              <div className="flex gap-1">
                <button
                  onClick={() => setRejectMode((p) => { setExpanded(true); return !p; })}
                  disabled={decide.isPending}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-danger/10 text-danger hover:bg-danger/20"
                >
                  Reject
                </button>
                <button
                  onClick={() => decide.mutate({ decision: "approved", comment: comment.trim() || undefined })}
                  disabled={decide.isPending}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-success/10 text-success hover:bg-success/20"
                >
                  Approve
                </button>
              </div>
            ) : (
              <span className="text-[11px] text-muted italic">Waiting on {isHRStage ? "HR" : "line manager"}</span>
            )}
          </div>
        </div>

        {expanded && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Reason</div>
              <div className="text-text whitespace-pre-wrap">{req.reason || <span className="italic text-muted">No reason provided.</span>}</div>

              {req.handover_notes && (
                <>
                  <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">
                    <FileText size={11} className="inline mr-1" /> Handover
                  </div>
                  <div className="text-text whitespace-pre-wrap">{req.handover_notes}</div>
                </>
              )}

              {req.backup_user_name && (
                <>
                  <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">Backup</div>
                  <div className="text-text">{req.backup_user_name}</div>
                </>
              )}

              {overlaps.length > 0 && (
                <>
                  <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">Calendar overlap</div>
                  <ul className="space-y-1">
                    {overlaps.map((o) => (
                      <li key={o.id} className="text-[12px] text-muted">
                        <span className="text-text font-semibold">{o.user_name || o.user_email}</span>
                        {" — "}{o.type_name} · {fmtDate(o.start_date)} → {fmtDate(o.end_date)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Submitted</div>
              <div className="text-text">
                {req.submitted_at
                  ? new Date(req.submitted_at).toLocaleString()
                  : "—"}
              </div>

              <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">Approvals so far</div>
              {(!req.approvals || req.approvals.length === 0) ? (
                <div className="text-muted italic text-[12px]">No decisions yet — you're first in line.</div>
              ) : (
                <ul className="space-y-1.5">
                  {req.approvals.map((a, i) => (
                    <li key={i} className="text-[12px]">
                      <span className={`pill text-[10.5px] ${a.decision === "approved" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"}`}>
                        {a.stage === "manager" ? "Manager" : "HR"} {a.decision}
                      </span>{" "}
                      <span className="text-muted">by {a.by}</span>
                      {a.comment && <div className="text-muted italic mt-0.5">"{a.comment}"</div>}
                    </li>
                  ))}
                </ul>
              )}

              {isHRStage && managerApproval && (
                <div className="mt-3 text-[11px] text-muted">
                  Line manager already approved — you're the final sign-off.
                </div>
              )}
            </div>

            {canAct && (
              <div className="md:col-span-2">
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">
                  {rejectMode ? "Reason for rejection (required)" : "Optional note"}
                </div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  placeholder={rejectMode
                    ? "e.g. Conflicts with the QBR week — please reschedule to the following week."
                    : "Add an optional note the requester will see…"}
                  className="input resize-none"
                />
                <div className="flex justify-end gap-2 mt-2">
                  {rejectMode ? (
                    <>
                      <button
                        onClick={() => { setRejectMode(false); setComment(""); }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={submitReject}
                        disabled={decide.isPending}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full bg-danger text-white hover:bg-danger/90 disabled:opacity-60"
                      >
                        Confirm reject
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => decide.mutate({ decision: "approved", comment: comment.trim() || undefined })}
                      disabled={decide.isPending}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full bg-success/15 text-success hover:bg-success/25 inline-flex items-center gap-1"
                    >
                      <CheckCircle2 size={12} /> Approve with note
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* ---------- My / Team requests tab ---------- */

type StatusFilter = "all" | "active" | "pending" | "approved" | "rejected" | "cancelled";

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / 86_400_000);
}

function relWindow(start: string, end: string): { label: string; tone: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = new Date(start);  s.setHours(0, 0, 0, 0);
  const e = new Date(end);    e.setHours(0, 0, 0, 0);
  if (today < s) {
    const d = daysBetween(today, s);
    if (d === 0) return { label: "Starts today",       tone: "text-accent" };
    if (d === 1) return { label: "Starts tomorrow",    tone: "text-accent" };
    if (d <= 7)  return { label: `Starts in ${d} days`, tone: "text-accent" };
    return { label: `Starts in ${d} days`, tone: "text-muted" };
  }
  if (today > e) {
    const d = daysBetween(e, today);
    if (d === 0) return { label: "Ended today",      tone: "text-muted" };
    if (d === 1) return { label: "Ended yesterday",   tone: "text-muted" };
    if (d <= 30) return { label: `Ended ${d}d ago`,    tone: "text-muted" };
    const months = Math.round(d / 30);
    return { label: `Ended ${months}mo ago`,           tone: "text-muted/70" };
  }
  return { label: "On leave now", tone: "text-success" };
}

function timeToDecision(submitted?: string, decided?: string | null): string | null {
  if (!submitted || !decided) return null;
  const ms = new Date(decided).getTime() - new Date(submitted).getTime();
  if (ms < 0) return null;
  const h = Math.floor(ms / 3_600_000);
  if (h < 1)  return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function RequestList({ scope }: { scope: "mine" | "team"; canApprove?: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: LeaveRequest[] }>({
    queryKey: ["leave-requests", scope],
    queryFn: () => api(`/api/v1/leave/requests?scope=${scope}`),
  });
  const items = data?.items ?? [];

  // /me/decision-authority drives which buttons show. Manager-only people see
  // Approve/Reject on manager_pending rows; HR-only people see them on
  // hr_pending rows; super_admin sees them on both.
  const { data: auth } = useQuery<{ can_approve_manager: boolean; can_approve_hr: boolean }>({
    queryKey: ["leave-authority"],
    queryFn: () => api("/api/v1/leave/decision-authority"),
    staleTime: 60_000,
  });
  const canActOn = (r: LeaveRequest): boolean => {
    if (r.status !== "pending") return false;
    if (r.approval_stage === "manager_pending") return !!auth?.can_approve_manager;
    if (r.approval_stage === "hr_pending")      return !!auth?.can_approve_hr;
    return false;
  };

  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/v1/leave/requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      toast.success("Request cancelled");
    },
    onError: (e: any) => toast.error("Could not cancel", e?.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/leave/requests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      toast.success("Request deleted");
    },
    onError: (e: any) => toast.error("Could not delete", e?.message),
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

  const [filter, setFilter]   = useState<StatusFilter>("all");
  const [search, setSearch]   = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // KPIs across the full set so the strip doesn't change when filters do.
  const stats = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const year = today.getFullYear();
    const inYear = items.filter((r) => new Date(r.start_date).getFullYear() === year);

    const approved = items.filter((r) => r.status === "approved");
    const rejected = items.filter((r) => r.status === "rejected");
    const decided  = approved.length + rejected.length;
    const approvalRate = decided > 0 ? Math.round((approved.length / decided) * 100) : null;

    const daysApprovedYTD = inYear
      .filter((r) => r.status === "approved")
      .reduce((sum, r) => sum + (r.days || 0), 0);
    const daysPending = items
      .filter((r) => r.status === "pending")
      .reduce((sum, r) => sum + (r.days || 0), 0);

    // Median time-to-decision in hours, for the dashboard's "how fast does HR move" stat.
    const ttdHours = items
      .map((r) => (r.decision_at && r.submitted_at
        ? (new Date(r.decision_at).getTime() - new Date(r.submitted_at).getTime()) / 3_600_000
        : null))
      .filter((v): v is number => v !== null && v >= 0)
      .sort((a, b) => a - b);
    const medianTTD = ttdHours.length === 0 ? null : ttdHours[Math.floor(ttdHours.length / 2)];

    // Active = pending OR approved & not yet ended. Used by the filter pill.
    const todayStr = today.toISOString().slice(0, 10);
    const active = items.filter(
      (r) => (r.status === "pending" || (r.status === "approved" && r.end_date >= todayStr)),
    );

    const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0, cancelled: 0, draft: 0 };
    items.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

    return {
      total: items.length,
      active: active.length,
      daysApprovedYTD,
      daysPending,
      approvalRate,
      medianTTD,
      byStatus,
    };
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    return items.filter((r) => {
      if (filter === "active") {
        if (!(r.status === "pending" || (r.status === "approved" && r.end_date >= today))) return false;
      } else if (filter !== "all" && r.status !== filter) {
        return false;
      }
      if (!q) return true;
      const hay = [r.type_name, r.reason, r.handover_notes, r.user_name, r.user_email]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [items, filter, search]);

  if (isLoading) return <div className="text-muted">Loading…</div>;
  if (items.length === 0) return (
    <Empty>
      {scope === "mine" ? "You haven't submitted any leave requests yet." : "No team requests on file."}
    </Empty>
  );

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatTile icon={<ListChecks size={14} />} label="Total" value={stats.total} sub={`${stats.active} active`} />
        <StatTile icon={<CheckCircle2 size={14} className="text-success" />} label={`Days approved · ${new Date().getFullYear()}`} value={stats.daysApprovedYTD} />
        <StatTile icon={<Hourglass size={14} className="text-accent" />} label="Days pending" value={stats.daysPending} />
        <StatTile
          icon={<TrendingUp size={14} className="text-accent" />}
          label="Approval rate"
          value={stats.approvalRate === null ? "—" : `${stats.approvalRate}%`}
          sub={stats.approvalRate === null ? "no decisions yet" : `${stats.byStatus.approved} approved / ${stats.byStatus.rejected} rejected`}
        />
        <StatTile
          icon={<Clock size={14} className="text-muted" />}
          label="Median time-to-decision"
          value={stats.medianTTD === null ? "—" : (stats.medianTTD < 48 ? `${Math.round(stats.medianTTD)}h` : `${Math.round(stats.medianTTD / 24)}d`)}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full">
          {([
            { k: "all",       label: `All · ${stats.total}` },
            { k: "active",    label: `Active · ${stats.active}` },
            { k: "pending",   label: `Pending · ${stats.byStatus.pending ?? 0}` },
            { k: "approved",  label: `Approved · ${stats.byStatus.approved ?? 0}` },
            { k: "rejected",  label: `Rejected · ${stats.byStatus.rejected ?? 0}` },
            { k: "cancelled", label: `Cancelled · ${stats.byStatus.cancelled ?? 0}` },
          ] as { k: StatusFilter; label: string }[]).map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                filter === f.k ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search type, reason, name…"
          className="bg-surface border border-border rounded-lg text-sm px-3 py-2 w-56"
        />
      </div>

      {filtered.length === 0 ? (
        <Empty>No requests match this filter.</Empty>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <RequestCard
              key={r.id}
              r={r}
              scope={scope}
              expanded={expanded === r.id}
              onToggle={() => setExpanded((p) => (p === r.id ? null : r.id))}
              canActOn={canActOn(r)}
              onCancel={() => {
                if (confirm("Cancel this request?")) cancel.mutate(r.id);
              }}
              onDelete={() => {
                if (confirm("Delete this request permanently? This can't be undone.")) remove.mutate(r.id);
              }}
              onApprove={() => decide.mutate({ id: r.id, decision: "approved" })}
              onReject={() => decide.mutate({ id: r.id, decision: "rejected" })}
              deleting={remove.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function StatTile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-bold text-muted">
        {icon} {label}
      </div>
      <div className="text-2xl font-extrabold text-text mt-1">{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function StageStrip({ r }: { r: LeaveRequest }) {
  if (r.status === "cancelled") {
    return <div className="text-[11px] text-muted inline-flex items-center gap-1"><Ban size={11} /> Cancelled by {r.decision_by_name || "owner"}</div>;
  }
  const managerDecision = r.approvals?.find((a) => a.stage === "manager")?.decision;
  const hrDecision      = r.approvals?.find((a) => a.stage === "hr")?.decision;

  const dot = (state: "done" | "active" | "rejected" | "idle") =>
    state === "done"     ? "bg-success" :
    state === "active"   ? "bg-accent animate-pulse" :
    state === "rejected" ? "bg-danger"  : "bg-border";

  let mgr: "done" | "active" | "rejected" | "idle" = "idle";
  let hr:  "done" | "active" | "rejected" | "idle" = "idle";
  if (managerDecision === "approved") mgr = "done";
  else if (managerDecision === "rejected") mgr = "rejected";
  else if (r.approval_stage === "manager_pending") mgr = "active";
  if (hrDecision === "approved") hr = "done";
  else if (hrDecision === "rejected") hr = "rejected";
  else if (r.approval_stage === "hr_pending") hr = "active";

  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className={`w-2 h-2 rounded-full ${dot(mgr)}`} />
      <span className={mgr === "active" ? "text-accent font-semibold" : "text-muted"}>Manager</span>
      <span className="w-4 h-px bg-border" />
      <span className={`w-2 h-2 rounded-full ${dot(hr)}`} />
      <span className={hr === "active" ? "text-accent font-semibold" : "text-muted"}>HR</span>
    </div>
  );
}

function RequestCard({
  r, scope, expanded, onToggle, canActOn,
  onCancel, onDelete, onApprove, onReject, deleting,
}: {
  r: LeaveRequest;
  scope: "mine" | "team";
  expanded: boolean;
  onToggle: () => void;
  canActOn: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
  deleting: boolean;
}) {
  const pill = statusPill(r);
  const win  = relWindow(r.start_date, r.end_date);
  const ttd  = timeToDecision(r.submitted_at, r.decision_at);
  const isTerminal = r.status === "cancelled" || r.status === "rejected";
  const isOwnerScope = scope === "mine";
  const rejection = r.approvals?.find((a) => a.decision === "rejected");

  return (
    <li className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-3">
        <button onClick={onToggle} className="text-muted hover:text-text mt-1.5" aria-label="Expand details">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="min-w-0">
          <div className="flex items-baseline flex-wrap gap-2">
            {scope === "team" && (
              <div className="inline-flex items-center gap-1.5 mr-1">
                <Avatar name={r.user_name || r.user_email} />
                <span className="text-sm font-semibold text-text">{r.user_name || r.user_email}</span>
              </div>
            )}
            <span className="text-sm font-bold text-text">{r.type_name}</span>
            {!r.paid && <span className="pill bg-muted/15 text-muted text-[10px]">Unpaid</span>}
            <span className={`pill ${pill.cls} text-[11px]`}>{pill.label}</span>
            {r.duration && r.duration !== "full_day" && (
              <span className="text-[11px] text-muted">{r.duration.replace("_", " ")}</span>
            )}
          </div>

          <div className="text-sm text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <CalendarIcon size={12} /> {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
            </span>
            <span className="font-semibold text-text">{r.days}d</span>
            <span className={`inline-flex items-center gap-1 ${win.tone}`}>
              <Clock size={11} /> {win.label}
            </span>
            {ttd && (
              <span className="inline-flex items-center gap-1 text-muted" title="Time from submission to decision">
                <TrendingUp size={11} /> decided in {ttd}
              </span>
            )}
          </div>

          {r.reason && <div className="text-sm text-text mt-1 truncate" title={r.reason}>{r.reason}</div>}

          {r.status === "rejected" && rejection?.comment && (
            <div className="mt-2 rounded-lg bg-danger/5 border border-danger/20 px-3 py-2 text-sm text-danger">
              <span className="font-semibold">Rejected:</span> {rejection.comment}
            </div>
          )}

          <div className="mt-2"><StageStrip r={r} /></div>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {canActOn && (
            <div className="flex gap-1">
              <button
                onClick={onApprove}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-success/10 text-success hover:bg-success/20"
                title={r.approval_stage === "manager_pending" ? "Approve as line manager" : "Approve as HR"}
              >
                Approve
              </button>
              <button
                onClick={onReject}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-danger/10 text-danger hover:bg-danger/20"
              >
                Reject
              </button>
            </div>
          )}
          {(r.status === "pending" || r.status === "approved") && (
            <button
              onClick={onCancel}
              className="text-[11px] text-muted hover:text-danger inline-flex items-center gap-1"
            >
              <Ban size={11} /> Cancel
            </button>
          )}
          {isOwnerScope && isTerminal && (
            <button
              onClick={onDelete}
              disabled={deleting}
              className="text-[11px] text-muted hover:text-danger inline-flex items-center gap-1 disabled:opacity-50"
              title="Delete from history"
            >
              <Trash2 size={11} /> Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-bg/30 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Submitted</div>
            <div className="text-text">{fmtDate(r.submitted_at)}{r.submitted_at && ` · ${new Date(r.submitted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</div>

            {r.backup_user_name && (
              <>
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">Backup</div>
                <div className="text-text">{r.backup_user_name}</div>
              </>
            )}

            {r.handover_notes && (
              <>
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mt-3 mb-1">
                  <FileText size={11} className="inline mr-1" /> Handover
                </div>
                <div className="text-text whitespace-pre-wrap">{r.handover_notes}</div>
              </>
            )}
          </div>

          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Approvals</div>
            {(!r.approvals || r.approvals.length === 0) ? (
              <div className="text-muted italic">Awaiting first decision.</div>
            ) : (
              <ul className="space-y-2">
                {r.approvals.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${a.decision === "approved" ? "bg-success" : "bg-danger"}`} />
                    <div className="min-w-0">
                      <div className="text-text">
                        <span className="font-semibold">{a.stage === "manager" ? "Manager" : "HR"}</span>{" "}
                        <span className={a.decision === "approved" ? "text-success" : "text-danger"}>
                          {a.decision}
                        </span>
                        {" "}<span className="text-muted">by {a.by}</span>
                      </div>
                      <div className="text-[11px] text-muted">{new Date(a.at).toLocaleString()}</div>
                      {a.comment && <div className="text-sm text-muted mt-0.5 italic">"{a.comment}"</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {r.decision_comment && !r.approvals?.some((a) => a.comment === r.decision_comment) && (
              <div className="mt-3 text-sm">
                <MessageSquare size={11} className="inline mr-1 text-muted" />
                <span className="text-muted">Final note:</span> <span className="text-text">{r.decision_comment}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
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

type Duration = "full" | "first_half" | "second_half";

type DirectoryMember = {
  id: string;
  name: string;
  email: string;
  roles?: string[];
};

export function RequestLeaveDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
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

  // Directory used for the backup-assignee picker. Filter out the requester
  // themselves — they can't be their own cover.
  const { data: membersData } = useQuery<{ items: DirectoryMember[] }>({
    queryKey: ["members", "for-leave-backup"],
    queryFn: () => api("/api/v1/members?status=active"),
  });
  const members = (membersData?.items ?? []).filter((m) => m.id !== user?.id);

  const [typeID, setTypeID] = useState<string>("");
  const [duration, setDuration] = useState<Duration>("full");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [reason, setReason] = useState("");
  const [handover, setHandover] = useState("");
  const [backupID, setBackupID] = useState<string>("");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Default to annual once types load. Has to be an effect (not a side-effect
  // during render) so React doesn't drop the update in concurrent mode.
  useEffect(() => {
    if (!typeID && types.length > 0) {
      const annual = types.find((t) => t.code === "annual") ?? types[0];
      if (annual) setTypeID(annual.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.length]);

  // Half-day implies a single date — auto-mirror end → start when the user
  // flips to half. Saves a click and matches the screenshot's mental model.
  function changeDuration(next: Duration) {
    setDuration(next);
    if (next !== "full" && start) setEnd(start);
  }
  function changeStart(v: string) {
    setStart(v);
    if (duration !== "full") setEnd(v);
  }

  const pickedType = types.find((t) => t.id === typeID);
  const pickedBalance = balances.find((b) => b.leave_type_id === typeID);
  const pickedBackup = members.find((m) => m.id === backupID);

  // Working-day count. Half-day requests collapse to 0.5 regardless of date math.
  const days = useMemo(() => {
    if (duration !== "full") return start ? 0.5 : 0;
    if (!start || !end) return 0;
    const s = new Date(start); const e = new Date(end);
    if (e < s) return 0;
    let count = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) count++;
    }
    return count;
  }, [start, end, duration]);

  const overdrawn = pickedBalance && pickedBalance.paid && days > pickedBalance.remaining_days;

  const create = useMutation({
    mutationFn: (b: {
      leave_type_id: string; duration: string; start_date: string; end_date: string;
      reason: string; handover_notes: string; backup_user_id?: string;
      supporting_docs?: { name: string; size: number; mime: string }[];
    }) => api("/api/v1/leave/requests", { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-dashboard"] });
      toast.success("Leave request submitted", "Your line manager will get the first approval. HR signs off after that.");
      onCreated();
    },
    onError: (e: any) => setErr(e?.message ?? "Could not submit request."),
  });

  // Map the frontend duration tag onto the backend's enum so the day-count
  // and half-day window are stored canonically.
  const DURATION_MAP: Record<Duration, "full_day" | "half_day_am" | "half_day_pm"> = {
    full: "full_day",
    first_half: "half_day_am",
    second_half: "half_day_pm",
  };

  function submit() {
    setErr(null);
    if (!typeID)  { setErr("Pick a leave type."); return; }
    if (!start)   { setErr("Start date is required."); return; }
    if (!end)     { setErr("End date is required."); return; }
    if (new Date(end) < new Date(start)) { setErr("End date can't be before start date."); return; }
    if (!reason.trim()) { setErr("Add a reason so your manager has context."); return; }
    if (pickedType?.requires_docs && !docFile) {
      setErr(`${pickedType.name} requires a supporting document — please attach one.`);
      return;
    }

    const docs = docFile ? [{ name: docFile.name, size: docFile.size, mime: docFile.type }] : [];
    create.mutate({
      leave_type_id: typeID,
      duration: DURATION_MAP[duration],
      start_date: start,
      end_date: end,
      reason: reason.trim(),
      handover_notes: handover.trim(),
      backup_user_id: backupID || undefined,
      supporting_docs: docs,
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-bold text-text">Apply for Leave</h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-bg text-muted" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="px-6 py-5 space-y-5">
          {/* Leave type + duration */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Leave Type" required>
              <select
                className="input"
                value={typeID}
                onChange={(e) => setTypeID(e.target.value)}
                disabled={types.length === 0}
              >
                {/* Placeholder option keeps the controlled value valid until */}
                {/* the types load and the effect picks Annual as default. */}
                <option value="" disabled>
                  {types.length === 0 ? "Loading…" : "Select a leave type"}
                </option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}{!t.paid && " (unpaid)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Duration" required>
              <select
                className="input"
                value={duration}
                onChange={(e) => changeDuration(e.target.value as Duration)}
              >
                <option value="full">Full Day</option>
                <option value="first_half">Half Day — Morning</option>
                <option value="second_half">Half Day — Afternoon</option>
              </select>
            </Field>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Start Date" required>
              <input
                type="date"
                className="input"
                value={start}
                onChange={(e) => changeStart(e.target.value)}
              />
            </Field>
            <Field label="End Date" required>
              <input
                type="date"
                className="input"
                value={end}
                min={start}
                disabled={duration !== "full"}
                onChange={(e) => setEnd(e.target.value)}
              />
              {duration !== "full" && (
                <div className="text-[11px] text-muted mt-1">Half-day requests are limited to a single date.</div>
              )}
            </Field>
          </div>

          {/* Day-count summary */}
          {days > 0 && (
            <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${
              overdrawn ? "bg-danger/10 border border-danger/30 text-danger" : "text-muted"
            }`}>
              <CalendarIcon size={13} />
              <span>
                Total: <span className="font-semibold text-text">{days} {days === 1 ? "day" : "days"}</span>
              </span>
              {pickedType?.paid && pickedBalance && !overdrawn && (
                <span className="text-[11px] ml-auto">
                  {pickedBalance.remaining_days.toFixed(1)} day{pickedBalance.remaining_days === 1 ? "" : "s"} remaining after this
                </span>
              )}
              {overdrawn && (
                <span className="text-[11px] ml-auto">
                  Exceeds balance ({pickedBalance!.remaining_days.toFixed(1)}d) — needs overdraft approval.
                </span>
              )}
            </div>
          )}

          {/* Reason */}
          <Field label="Reason" required>
            <textarea
              className="input min-h-[64px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Family vacation, medical appointment, etc."
            />
          </Field>

          {/* Handover */}
          <Field label="Handover / Notes">
            <textarea
              className="input min-h-[80px]"
              value={handover}
              onChange={(e) => setHandover(e.target.value)}
              placeholder="I will complete the ongoing task and share updates with the backup."
            />
          </Field>

          {/* Backup assignee */}
          <Field label="Backup Assignee">
            {pickedBackup ? (
              <div className="input flex items-center gap-3 !py-2">
                <span className="w-8 h-8 rounded-full bg-accent-soft text-accent font-bold text-sm grid place-items-center shrink-0">
                  {(pickedBackup.name || pickedBackup.email).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text truncate">{pickedBackup.name || pickedBackup.email}</div>
                  <div className="text-[11px] text-muted truncate">
                    {pickedBackup.roles?.[0] ?? pickedBackup.email}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setBackupID("")}
                  className="p-1 rounded hover:bg-bg text-muted"
                  aria-label="Clear backup"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <select
                className="input"
                value={backupID}
                onChange={(e) => setBackupID(e.target.value)}
              >
                <option value="">Select a teammate to cover for you…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.email}{m.roles?.length ? ` · ${m.roles[0]}` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {/* Supporting document */}
          <Field label="Supporting Document (optional)">
            <SupportingDocPicker file={docFile} onChange={setDocFile} required={pickedType?.requires_docs} />
          </Field>

          {err && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> {err}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2 sticky bottom-0 bg-surface">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-muted hover:text-text font-medium">
            Cancel
          </button>
          <SmartButton
            variant="primary"
            disabled={create.isPending}
            loadingLabel="Submitting…"
            icon={<CheckCircle2 size={14} />}
            onClick={submit}
          >
            Submit Request
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// Tiny labelled-field wrapper to match the screenshot's spacing and the small
// red asterisk on required fields. Local to this file — not worth a shared
// component until another form needs it.
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[12px] font-semibold text-text mb-1.5">
        {label}{required && <span className="text-danger ml-0.5">*</span>}
      </div>
      {children}
    </label>
  );
}

// Drag-drop / click-to-browse upload box. Doesn't actually POST anywhere yet —
// the leave backend has no document slot. The filename rides along in the
// reason field as a tag so the approver can ask for it directly, and we'll
// wire real storage once the broader files pipeline lands.
function SupportingDocPicker({
  file, onChange, required,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
  required?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const MAX_BYTES = 10 * 1024 * 1024;

  function accept(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.error("File too large", "Maximum 10MB.");
      return;
    }
    onChange(f);
  }

  if (file) {
    return (
      <div className="border border-border rounded-lg px-3 py-2.5 flex items-center gap-3 bg-bg/40">
        <span className="w-9 h-9 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
          <FileText size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text truncate">{file.name}</div>
          <div className="text-[11px] text-muted">{(file.size / 1024).toFixed(0)} KB</div>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="p-1.5 rounded hover:bg-surface text-muted hover:text-danger"
          aria-label="Remove file"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        accept(e.dataTransfer.files?.[0]);
      }}
      className={`block border-2 border-dashed rounded-xl px-4 py-5 text-center cursor-pointer transition-colors ${
        drag ? "border-accent bg-accent-soft/30" : "border-border hover:border-accent/40 hover:bg-bg/30"
      }`}
    >
      <input
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png"
        onChange={(e) => accept(e.target.files?.[0] ?? undefined)}
      />
      <div className="flex items-center justify-center gap-2 text-sm text-text">
        <UploadCloud size={16} className="text-accent" />
        Drag &amp; drop file or <span className="text-accent font-semibold underline-offset-2 hover:underline">click to upload</span>
      </div>
      <div className="text-[11px] text-muted mt-1">
        PDF, JPG, PNG up to 10MB{required && <span className="text-danger"> · required for this leave type</span>}
      </div>
    </label>
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
