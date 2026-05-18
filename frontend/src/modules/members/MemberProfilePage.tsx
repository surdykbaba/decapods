import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Mail, Shield, ShieldCheck, ShieldOff, Clock, Plane,
  AlertCircle, CheckCircle2, Briefcase, FolderKanban, ListChecks,
  Activity as ActivityIcon, Flame,
  TrendingUp, Coffee, Circle, Github, PauseCircle, AlertTriangle, Settings,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth, type Me } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { Avatar } from "@/components/Avatar";
import { SmartButton } from "@/components/SmartButton";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ExternalEmailBadge } from "@/components/ExternalEmailBadge";
import { MfaCard } from "@/modules/me/MyWorkPage";
import { PersonnelCard } from "@/components/PersonnelCard";

type Balance  = { name: string; paid: boolean; accrued: number; carryover: number; used: number; remaining: number };
type LeaveReq = { id: string; type_name: string; start_date: string; end_date: string; days: number; status: string; reason: string };
type ProjectRef = { id: string; name: string; role: string; allocation: number };
type AttDay   = { day: string; hours: number; sessions: number; first_seen: string };
type MoodDay  = { day: string; mood: string; focus: string };
type AuditEv  = { action: string; entity: string; entity_id: string; created_at: string };
type CfPost   = { id: string; kind: string; title: string; body: string; created_at: string };

type Profile = {
  id: string;
  email: string;
  name: string;
  avatar_url: string;
  status: "active" | "invited" | "disabled";
  mfa_enabled: boolean;
  mfa_required: boolean;
  created_at: string;
  last_login_at: string | null;
  last_seen_at: string | null;
  seconds_since: number;
  presence: string;
  roles: string[];
  workload: {
    projects: ProjectRef[];
    active_projects: number;
    total_allocation: number;
    open_tasks: number;
    overdue_tasks: number;
    due_soon_tasks: number;
    completed_30d: number;
    by_status: { todo: number; in_progress: number; blocked: number; review: number; done: number };
  };
  leave: {
    balances: Balance[];
    recent_requests: LeaveReq[];
    on_leave_today: boolean;
    days_off_ytd: number;
  };
  attendance_14d: AttDay[];
  mood_14d: MoodDay[];
  recent_activity: AuditEv[];
  recent_campfire: CfPost[];
};

function relTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Never";
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function dayShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
}

const PRESENCE_TONE: Record<string, string> = {
  online: "bg-success/15 text-success",
  away:   "bg-warn/15 text-warn",
  offline:"bg-muted/15 text-muted",
};

const LEAVE_STATUS_TONE: Record<string, string> = {
  pending:   "bg-accent-soft text-accent",
  approved:  "bg-success/15 text-success",
  rejected:  "bg-danger/15 text-danger",
  cancelled: "bg-muted/15 text-muted",
  draft:     "bg-muted/15 text-muted",
};

export function MemberProfilePage() {
  const { id } = useParams();
  const me = useAuth((s) => s.user);
  const { data, isLoading, error } = useQuery<Profile>({
    queryKey: ["member-profile", id],
    queryFn: () => api(`/api/v1/members/${id}/profile`),
    enabled: !!id,
  });
  // Self-view = me viewing my own profile. Switches on the account-settings
  // section (Edit details + MFA) so others looking at someone's public
  // profile never see the editable form or 2FA enrollment UI.
  const isSelf = !!me && !!data && me.id === data.id;

  if (isLoading) {
    return <div className="p-10 text-center text-muted">Loading profile…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-10 text-center">
        <div className="text-base font-bold text-text">Member not found</div>
        <Link to="/members" className="text-sm text-accent hover:underline mt-2 inline-block">← Back to members</Link>
      </div>
    );
  }

  const w = data.workload;
  const taskTotal = w.by_status.todo + w.by_status.in_progress + w.by_status.blocked + w.by_status.review + w.by_status.done;
  const completionPct = taskTotal === 0 ? 0 : Math.round((w.by_status.done / taskTotal) * 100);
  const allocationTone =
    w.total_allocation >= 100 ? "text-danger" :
    w.total_allocation >= 80  ? "text-warn"   :
    "text-success";

  // Attendance summary: total hours over the 14d window, average per active day.
  const attHours = data.attendance_14d.reduce((s, d) => s + d.hours, 0);
  const activeDays = data.attendance_14d.filter((d) => d.hours > 0.1).length;
  const avgPerActive = activeDays === 0 ? 0 : attHours / activeDays;
  const maxHours = Math.max(0.1, ...data.attendance_14d.map((d) => d.hours));

  return (
    <div className="space-y-6">
      <Link
        to="/members"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
      >
        <ArrowLeft size={14} /> All members
      </Link>

      {/* ============= HERO ============= */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-accent via-accent/50 to-transparent" />
        <div className="p-6 grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-5">
          <div className="relative shrink-0">
            <Avatar name={data.name} email={data.email} src={data.avatar_url || undefined} size={88} />
            <span
              className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full ring-2 ring-surface ${
                data.presence === "online" ? "bg-success" :
                data.presence === "away"   ? "bg-warn" : "bg-muted/50"
              }`}
              title={data.presence}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-2xl font-extrabold text-text truncate">{data.name || "—"}</h1>
              <span className={`pill ${PRESENCE_TONE[data.presence] ?? PRESENCE_TONE.offline}`}>
                <Circle size={8} className="fill-current" /> {data.presence}
              </span>
              {data.leave.on_leave_today && (
                <span className="pill bg-accent-soft text-accent">
                  <Plane size={11} /> On leave today
                </span>
              )}
              {data.status === "disabled" && (
                <span className="pill bg-danger/15 text-danger">Disabled</span>
              )}
              <ExternalEmailBadge email={data.email} showDomain />
            </div>
            <a href={`mailto:${data.email}`} className="text-sm text-muted hover:text-accent inline-flex items-center gap-1.5 mt-1">
              <Mail size={12} /> {data.email}
            </a>

            <div className="flex flex-wrap items-center gap-2 mt-3">
              {data.roles.length === 0 ? (
                <span className="text-xs text-muted italic">No roles assigned</span>
              ) : data.roles.map((r) => (
                <span key={r} className="text-[10.5px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-accent-soft text-accent">
                  {r}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted mt-3">
              <span className="inline-flex items-center gap-1"><Clock size={11} /> Joined {fmtDate(data.created_at)}</span>
              <span className="inline-flex items-center gap-1"><ActivityIcon size={11} /> Last login {relTime(data.last_login_at)}</span>
              <span className="inline-flex items-center gap-1"><Circle size={9} /> Last seen {relTime(data.last_seen_at)}</span>
            </div>
          </div>

          <div className="flex md:flex-col items-start md:items-end gap-2 shrink-0">
            <div className={`pill ${data.mfa_enabled ? "bg-success/15 text-success" : "bg-warn/15 text-warn"}`}>
              {data.mfa_enabled ? <ShieldCheck size={11} /> : <ShieldOff size={11} />}
              MFA {data.mfa_enabled ? "on" : "off"}
            </div>
            {data.mfa_required && (
              <div className="pill bg-accent-soft text-accent">
                <Shield size={11} /> Required by admin
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ============= QUICK STATS ============= */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat icon={<FolderKanban size={14} className="text-accent" />} label="Active projects" value={w.active_projects} />
        <Stat
          icon={<TrendingUp size={14} className={allocationTone} />}
          label="Total allocation"
          value={`${w.total_allocation}%`}
          sub={w.total_allocation >= 100 ? "over-allocated" : w.total_allocation >= 80 ? "near capacity" : "headroom"}
        />
        <Stat icon={<ListChecks size={14} className="text-text" />} label="Open tasks" value={w.open_tasks} sub={`${w.completed_30d} closed last 30d`} />
        <Stat icon={<AlertCircle size={14} className="text-danger" />} label="Overdue" value={w.overdue_tasks} sub={`${w.due_soon_tasks} due this week`} />
        <Stat icon={<Plane size={14} className="text-accent" />} label="Days off YTD" value={data.leave.days_off_ytd} sub={`${data.leave.recent_requests.length} recent requests`} />
      </section>

      {/* Self-only: personal scoreboard + account settings + MFA. Moved off
          the My Work profile tab so account management lives here next to
          the public-facing view of the same person. */}
      {isSelf && <SelfAccountPanel />}

      {/* Personnel file — HR view of someone else's record. The person's
          own self-edit path lives on the My Work → Profile tab, so we
          don't double it up here for self-view. Backend re-checks the
          gate; this guard avoids rendering a panel that would 403. */}
      {!!id && !isSelf && (me?.roles ?? []).some((r: string) =>
        ["super_admin", "ceo", "coo", "hr", "hr_manager"].includes(r)) && (
        <section className="bg-surface border border-border rounded-2xl p-5 mt-5">
          <h2 className="h2 mb-1">Personnel &amp; documents</h2>
          <p className="text-xs text-muted mb-4">
            NIN, blood group, emergency contact, next of kin, guarantor, payroll
            details and document uploads (CV, NIN slip, ID, certificates).
            Visible to HR and the teammate only.
          </p>
          <PersonnelCard memberId={id} />
        </section>
      )}

      {/* ============= 2-COLUMN BODY ============= */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-5">
        <div className="space-y-5">
          {/* Workload */}
          <Card title="Workload" icon={<Briefcase size={14} className="text-accent" />}>
            {/* Task status breakdown */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>Task completion · last 30 days</span>
                <span className="font-semibold text-text">{completionPct}%</span>
              </div>
              <div className="h-2 bg-bg rounded-full overflow-hidden flex">
                <Bar n={w.by_status.done}        total={taskTotal} cls="bg-success" />
                <Bar n={w.by_status.review}      total={taskTotal} cls="bg-warn" />
                <Bar n={w.by_status.in_progress} total={taskTotal} cls="bg-accent" />
                <Bar n={w.by_status.blocked}     total={taskTotal} cls="bg-danger" />
                <Bar n={w.by_status.todo}        total={taskTotal} cls="bg-muted/40" />
              </div>
              <div className="grid grid-cols-5 gap-2 text-[11px] text-muted">
                <Legend dot="bg-success" label="Done" value={w.by_status.done} />
                <Legend dot="bg-warn"    label="Review" value={w.by_status.review} />
                <Legend dot="bg-accent"  label="Active" value={w.by_status.in_progress} />
                <Legend dot="bg-danger"  label="Blocked" value={w.by_status.blocked} />
                <Legend dot="bg-muted/50" label="To do" value={w.by_status.todo} />
              </div>
            </div>

            <div className="border-t border-border my-4" />

            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Projects</div>
            {w.projects.length === 0 ? (
              <div className="text-sm text-muted italic">Not on any active projects.</div>
            ) : (
              <ul className="space-y-2">
                {w.projects.map((p) => (
                  <li key={p.id}>
                    <Link to={`/projects/${p.id}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-bg group">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate group-hover:text-accent">{p.name}</div>
                        {p.role && <div className="text-[11px] text-muted">{p.role}</div>}
                      </div>
                      <span className="text-[11px] font-semibold text-muted shrink-0">{p.allocation}%</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Attendance pulse */}
          <Card title="Attendance · last 14 days" icon={<Clock size={14} className="text-accent" />}>
            <div className="flex items-end gap-4 mb-4">
              <div>
                <div className="text-2xl font-extrabold text-text">{attHours.toFixed(1)}h</div>
                <div className="text-[11px] text-muted">total online</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold text-text">{avgPerActive.toFixed(1)}h</div>
                <div className="text-[11px] text-muted">avg per active day · {activeDays} days</div>
              </div>
            </div>
            <div className="grid grid-cols-14 gap-1" style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}>
              {data.attendance_14d.map((d) => {
                const pct = Math.max(0, Math.min(1, d.hours / maxHours));
                const h = Math.round(pct * 56) + 4;
                return (
                  <div key={d.day} className="flex flex-col items-center gap-1" title={`${d.day} · ${d.hours.toFixed(1)}h${d.first_seen ? " · started " + d.first_seen : ""}`}>
                    <div className="w-full bg-bg rounded relative h-16 flex items-end">
                      <div className={`w-full ${d.hours > 0 ? "bg-accent" : "bg-transparent"} rounded`} style={{ height: `${h}px` }} />
                    </div>
                    <span className="text-[9px] text-muted">{new Date(d.day).toLocaleDateString("en-US", { weekday: "narrow" })}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Mood trend */}
          {data.mood_14d.length > 0 && (
            <Card title="Mood & focus · last 14 days" icon={<Coffee size={14} className="text-accent" />}>
              <ul className="space-y-2">
                {data.mood_14d.slice().reverse().map((m) => (
                  <li key={m.day} className="flex items-start gap-3 text-sm">
                    <span className="text-xl shrink-0 leading-tight">{m.mood || "·"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-muted">{dayShort(m.day)}</div>
                      {m.focus ? <div className="text-text">{m.focus}</div> : <div className="text-muted italic">No note</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {/* Leave */}
          <Card title="Leave balances" icon={<Plane size={14} className="text-accent" />}>
            {data.leave.balances.length === 0 ? (
              <div className="text-sm text-muted italic">No leave types configured.</div>
            ) : (
              <ul className="space-y-3">
                {data.leave.balances.map((b) => {
                  const total = b.accrued + b.carryover;
                  const pct = total > 0 ? Math.min(100, (b.used / total) * 100) : 0;
                  return (
                    <li key={b.name}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-text">{b.name}</span>
                        <span className="text-muted">
                          <span className="font-bold text-text">{b.remaining.toFixed(1)}d</span> left
                        </span>
                      </div>
                      <div className="h-1.5 bg-bg rounded mt-1 overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-muted mt-1">
                        {b.used.toFixed(1)} of {total.toFixed(1)} used{!b.paid && " · unpaid"}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.leave.recent_requests.length > 0 && (
              <>
                <div className="border-t border-border my-4" />
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">Recent requests</div>
                <ul className="space-y-1.5">
                  {data.leave.recent_requests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <div className="text-text truncate">{r.type_name}</div>
                        <div className="text-[11px] text-muted">{fmtDate(r.start_date)} → {fmtDate(r.end_date)} · {r.days}d</div>
                      </div>
                      <span className={`pill text-[10px] ${LEAVE_STATUS_TONE[r.status] ?? "bg-muted/15 text-muted"}`}>{r.status}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {/* Recent activity */}
          <Card title="Recent activity" icon={<ActivityIcon size={14} className="text-accent" />}>
            {data.recent_activity.length === 0 ? (
              <div className="text-sm text-muted italic">No recorded activity yet.</div>
            ) : (
              <ul className="space-y-2">
                {data.recent_activity.slice(0, 12).map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 size={11} className="text-success mt-1 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-text">
                        <span className="font-semibold">{humanAction(e.action)}</span>{" "}
                        <span className="text-muted">on {e.entity}</span>
                      </div>
                      <div className="text-[11px] text-muted">{relTime(e.created_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Recent campfire */}
          {data.recent_campfire.length > 0 && (
            <Card title="Recent Campfire posts" icon={<Flame size={14} className="text-warn" />}>
              <ul className="space-y-3">
                {data.recent_campfire.map((p) => (
                  <li key={p.id} className="text-sm">
                    <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">
                      {p.kind} · {relTime(p.created_at)}
                    </div>
                    {p.title && <div className="font-semibold text-text mt-0.5">{p.title}</div>}
                    <div className="text-text mt-0.5">{p.body}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-surface border border-border rounded-2xl p-5">
      <h2 className="text-sm font-bold text-text flex items-center gap-2 mb-3">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number | string; sub?: string }) {
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

function Bar({ n, total, cls }: { n: number; total: number; cls: string }) {
  if (total === 0 || n === 0) return null;
  const w = (n / total) * 100;
  return <div className={cls} style={{ width: `${w}%` }} />;
}

function Legend({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="inline-flex items-center gap-1 min-w-0">
      <span className={`w-2 h-2 rounded-full ${dot} shrink-0`} />
      <span className="truncate">{label}</span>
      <span className="font-semibold text-text">{value}</span>
    </div>
  );
}

function humanAction(action: string): string {
  return action.replace(/[._]/g, " ");
}

/* ---------- Self-only account panel ---------- */

type SelfProfile = {
  id: string;
  email: string;
  name: string;
  avatar_url?: string | null;
  github_username?: string;
  mfa_enabled?: boolean;
  mfa_required?: boolean;
  performance: {
    tasks_done: number;
    tasks_overdue: number;
    blocked_now: number;
    hours_last_30: number;
  };
};

// Renders the personal scoreboard, edit-details form, and 2FA card. Only
// mounted when the page is being viewed by its owner — anchored to /me/profile
// so the editable fields and MFA state map to the signed-in user.
function SelfAccountPanel() {
  const qc = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  const currentUser = useAuth((s) => s.user);

  const { data, isLoading } = useQuery<SelfProfile>({
    queryKey: ["me", "profile"],
    queryFn: () => api("/api/v1/me/profile"),
  });

  const [name, setName] = useState("");
  const [github, setGithub] = useState("");

  useEffect(() => {
    if (data) {
      setName(data.name ?? "");
      setGithub(data.github_username ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.email]);

  const dirty = !!data && (
    (data.name ?? "") !== name ||
    (data.github_username ?? "") !== github
  );

  const save = useMutation({
    mutationFn: () => api<Partial<Me>>("/api/v1/me/profile", {
      method: "PUT",
      body: JSON.stringify({ name: name.trim(), github_username: github.trim() }),
    }),
    onSuccess: (resp) => {
      if (resp && currentUser) setUser({ ...currentUser, ...resp } as Me);
      toast.success("Profile updated", "Your changes have been saved.");
      qc.invalidateQueries({ queryKey: ["me", "profile"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-profile"] });
    },
    onError: (e: unknown) => {
      const msg = (e as { message?: string })?.message ?? "Could not save your profile.";
      toast.error("Save failed", msg);
    },
  });

  if (isLoading || !data) return null;
  const p = data.performance;
  const avgHoursPerWeek = p.hours_last_30 / (30 / 7);

  return (
    <div className="space-y-5">
      {/* Personal scoreboard — the four tiles that used to sit on the My
          Work profile tab. Kept self-only so others browsing the directory
          don't see another teammate's blocked / overdue counts. */}
      <div className="bg-surface border border-border rounded-2xl p-5">
        <h2 className="text-sm font-bold text-text flex items-center gap-2 mb-3">
          <ActivityIcon size={14} className="text-accent" /> Your scoreboard
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <InsightTile
            icon={<CheckCircle2 size={14} />}
            label="Tasks completed"
            value={p.tasks_done.toString()}
            sub="Lifetime — every one shipped."
            tone="good"
          />
          <InsightTile
            icon={<AlertTriangle size={14} />}
            label="Overdue right now"
            value={p.tasks_overdue.toString()}
            sub={p.tasks_overdue === 0 ? "Clear runway." : "Knock these out first."}
            tone={p.tasks_overdue === 0 ? "good" : "bad"}
          />
          <InsightTile
            icon={<PauseCircle size={14} />}
            label="Blocked"
            value={p.blocked_now.toString()}
            sub={p.blocked_now === 0 ? "Nothing waiting on others." : "Unblock or escalate."}
            tone={p.blocked_now === 0 ? "good" : "warn"}
          />
          <InsightTile
            icon={<Clock size={14} />}
            label="Avg hours / week"
            value={`${avgHoursPerWeek.toFixed(1)}h`}
            sub={`${p.hours_last_30.toFixed(1)}h logged over 30 days.`}
            tone="info"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <section className="bg-surface border border-border rounded-2xl p-5 lg:col-span-3">
          <h2 className="text-base font-bold text-text mb-1 flex items-center gap-2">
            <Settings size={14} className="text-accent" /> Edit details
          </h2>
          <p className="text-xs text-muted mb-4">
            Email is set by your workspace admin — reach out if it's wrong.
          </p>
          {/* Photo first — the hero avatar updates the moment this saves
              because AvatarUploader pushes the fresh user into the auth
              store. Invalidate the member-profile cache too so the hero
              <Avatar src={data.avatar_url} /> repaints without a reload. */}
          <div className="mb-5 pb-5 border-b border-border">
            <AvatarUploader
              name={data.name}
              email={data.email}
              src={data.avatar_url}
              onSaved={() => {
                qc.invalidateQueries({ queryKey: ["member-profile"] });
              }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <div className="label">Display name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Email</div>
              <input className="input bg-bg no-cap" value={data.email} readOnly />
            </label>
            <label className="block md:col-span-2">
              <div className="label">GitHub username</div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-bg border border-border rounded-l-xl text-sm text-muted">
                  <Github size={14} /> github.com/
                </span>
                <input
                  className="input rounded-l-none no-cap"
                  value={github}
                  onChange={(e) => setGithub(e.target.value)}
                  placeholder="your-handle"
                />
              </div>
              <div className="text-xs text-muted mt-1">
                Linking your GitHub lets the system attribute commits, PRs and reviews to you.
              </div>
            </label>
          </div>
          <div className="mt-5 flex items-center justify-end gap-3">
            {!dirty && !save.isPending && (
              <span className="text-xs text-muted">No changes yet</span>
            )}
            <SmartButton
              variant="primary"
              disabled={!dirty}
              onClick={() => save.mutateAsync()}
              loadingLabel="Saving…"
              successLabel="Saved"
            >
              Save changes
            </SmartButton>
          </div>
        </section>

        <div className="lg:col-span-2">
          <MfaCard
            enabled={!!data.mfa_enabled}
            required={!!data.mfa_required}
            onChanged={() => qc.invalidateQueries({ queryKey: ["me", "profile"] })}
          />
        </div>
      </div>
    </div>
  );
}

function InsightTile({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "info";
}) {
  const bubble = {
    good: "bg-success/10 text-success",
    warn: "bg-warn/10 text-warn",
    bad:  "bg-danger/10 text-danger",
    info: "bg-accent-soft text-accent",
  }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${bubble}`}>
          {icon}
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted">{label}</span>
      </div>
      <div className="text-[1.5rem] font-extrabold text-text leading-none">{value}</div>
      <div className="text-[11.5px] text-muted leading-snug">{sub}</div>
    </div>
  );
}
