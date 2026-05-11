import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { Avatar } from "@/components/Avatar";
import { toast } from "@/lib/toast";
import {
  Users, Plus, Search, ShieldCheck, ShieldAlert, Mail, X, Pencil, Trash2,
  Copy, KeyRound, CheckCircle2, Clock, Send, Link as LinkIcon, Circle, RotateCcw,
} from "lucide-react";
import { type Presence, presenceLabel, PRESENCE_COLORS } from "@/lib/presence";
import { confirmAction } from "@/lib/confirm";
import { ExternalEmailBadge } from "@/components/ExternalEmailBadge";

type MemberStatus = "active" | "invited" | "disabled";

type Member = {
  id: string;
  email: string;
  name: string;
  status: MemberStatus;
  mfa_enabled: boolean;
  mfa_required?: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
  last_seen_at: string | null;
  presence: Presence;
  seconds_since: number;
  avatar_url?: string;
};

type Role = {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
};

const STATUS_META: Record<MemberStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  active:   { label: "Active",     cls: "bg-success/15 text-success", icon: <CheckCircle2 size={11} /> },
  invited:  { label: "Invited",    cls: "bg-accent-soft text-accent", icon: <Clock size={11} /> },
  disabled: { label: "Disabled",   cls: "bg-warn/15 text-warn",       icon: <ShieldAlert size={11} /> },
};

function fmtRel(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function MembersPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: Member[] }>({
    queryKey: ["members"], queryFn: () => api("/api/v1/members"),
  });
  const { data: rolesData } = useQuery<{ items: Role[] }>({
    queryKey: ["roles"], queryFn: () => api("/api/v1/members/roles"),
  });
  // Light presence poll every 30s so the dot updates without churning the
  // full members list (which would yank scroll position and re-render rows).
  const { data: presenceData } = useQuery<{ items: { user_id: string; presence: Presence; last_seen_at: string | null; seconds_since: number }[] }>({
    queryKey: ["presence"],
    queryFn: () => api("/api/v1/presence"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const presenceMap = useMemo(() => {
    const m = new Map<string, { presence: Presence; last_seen_at: string | null; seconds_since: number }>();
    presenceData?.items.forEach((p) => m.set(p.user_id, p));
    return m;
  }, [presenceData]);

  // Merge live presence onto the directory rows so filters and sorts see fresh values.
  const items = useMemo(() => (data?.items ?? []).map((m) => {
    const live = presenceMap.get(m.id);
    return live ? { ...m, ...live } : m;
  }), [data, presenceMap]);
  const roles = rolesData?.items ?? [];

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | MemberStatus>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [presenceFilter] = useState<"all" | Presence>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);

  const filtered = useMemo(() => {
    let list = items;
    if (statusFilter !== "all")   list = list.filter((m) => m.status === statusFilter);
    if (roleFilter !== "all")     list = list.filter((m) => m.roles.includes(roleFilter));
    if (presenceFilter !== "all") list = list.filter((m) => m.presence === presenceFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((m) =>
        m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, statusFilter, roleFilter, presenceFilter, query]);

  const counts = useMemo(() => {
    const c = { all: items.length, active: 0, invited: 0, disabled: 0 };
    items.forEach((m) => { c[m.status]++; });
    return c;
  }, [items]);

  const create = useMutation({
    mutationFn: (body: { email: string; name: string; roles: string[] }) =>
      api<{ id: string; email: string; temp_password: string }>(
        "/api/v1/members", { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["members"] }); },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not add member", msg);
    },
  });

  const invite = useMutation({
    mutationFn: (body: { email: string; name: string; roles: string[]; message?: string }) =>
      api<{ token: string; email: string; name: string; expires_at: string }>(
        "/api/v1/members/invite", { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["members", "invitations"] }); },
    onError: (e: unknown) => {
      const body = (e instanceof ApiError ? (e.body as any) : null) ?? {};
      const msg = body.error ?? (e as Error)?.message;
      if (body.code === "invite_exists") {
        toast.error(
          "Invitation already pending",
          "Use the Resend button on the existing invitation below — minting a second link would split the inbox in two.",
        );
        // Make sure the panel is fresh so they can see / act on the existing row.
        qc.invalidateQueries({ queryKey: ["members", "invitations"] });
        return;
      }
      if (body.code === "email_taken") {
        toast.error("Email already in use", "That address already belongs to a member in this workspace.");
        return;
      }
      toast.error("Could not create invite", msg);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Member> }) =>
      api(`/api/v1/members/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Member updated");
      qc.invalidateQueries({ queryKey: ["members"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error("Update failed", e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Member removed");
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not remove", msg);
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) =>
      api<{ temp_password: string }>(`/api/v1/members/${id}/reset-password`, { method: "POST" }),
    onError: (e: Error) => toast.error("Could not reset", e.message),
  });

  return (
    <div className="space-y-5 max-w-7xl">
      {/* Compact header — the page identity is already covered by the sidebar
          nav highlight; no need for a giant "Members" billboard up here. */}
      <header className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted max-w-2xl">
          Everyone with an account in this workspace. Roles control what each member can read and write —
          assign carefully, especially <code className="text-accent">super_admin</code> and{" "}
          <code className="text-accent">finance</code>.
        </p>
        <SmartButton variant="primary" onClick={() => setCreateOpen(true)} icon={<Plus size={14} />}>
          Add member
        </SmartButton>
      </header>

      {/* Status pills */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
          {(["all", "active", "invited", "disabled"] as const).map((k) => (
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
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="bg-surface border border-border rounded-full text-[12.5px] px-3 py-1.5 focus:outline-none focus:border-accent"
          >
            <option value="all">All roles</option>
            {roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-full w-[260px] focus:outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>

      <InvitationsPanel />

      {/* Body */}
      {isLoading ? (
        <div className="text-muted">Loading members…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
            <Users size={22} />
          </div>
          <div className="text-base font-bold text-text">
            {items.length === 0 ? "No members yet" : "Nothing matches"}
          </div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            {items.length === 0
              ? "Add the first member of your workspace. They'll receive a one-time password to sign in with."
              : "Try clearing the filters or search."}
          </p>
        </div>
      ) : (
        <MemberTable
          rows={filtered}
          onEdit={setEditing}
          onRemove={async (id, name) => {
            // Pull the full member row so the confirm dialog can warn about
            // the member's role + status + MFA state. This is local data —
            // no extra round trip.
            const m = items.find((x) => x.id === id);
            const isAdminClass = !!m?.roles?.some((r) =>
              ["super_admin", "ceo", "coo", "hr", "hr_manager", "finance"].includes(r),
            );
            const ok = await confirmAction({
              title: `Remove ${name}?`,
              body: "Removing a member is a destructive action. Please read the impact below carefully before continuing.",
              confirmLabel: "Remove member permanently",
              danger: true,
              warning: isAdminClass
                ? `${name} holds an admin-class role (${(m?.roles || []).join(", ")}). Removing them may leave parts of the workspace without an owner — make sure someone else has the same access first.`
                : undefined,
              bullets: [
                "Their session ends immediately — they're signed out everywhere.",
                "They can no longer log in until you re-invite them.",
                "Tasks, projects, and audit trails they touched are preserved (their name still appears as the actor).",
                "Open task assignments stay on the project — reassign them before removal if you want them picked up.",
                "Their leave balance and approval history stay intact in case they return.",
                "This is a soft delete — a super-admin can restore the account from the database. It is NOT a hard delete.",
              ],
              requireText: name,
            });
            if (ok) remove.mutate(id);
          }}
          onReset={async (m) => {
            const ok = await confirmAction({
              title: "Issue a new temporary password?",
              body: `This invalidates ${m.email}'s current credentials and replaces them with a fresh one-time password. Make sure you can deliver it to them securely.`,
              confirmLabel: "Reset password",
            });
            if (!ok) return;
            const r = await reset.mutateAsync(m.id);
            qc.invalidateQueries({ queryKey: ["members"] });
            // Show one-time password modal-style via toast — for a real reset we'd open a richer dialog.
            await navigator.clipboard.writeText(r.temp_password).catch(() => {});
            toast.success("Password reset", `New temp password copied to clipboard. Share securely with ${m.email}.`);
          }}
        />
      )}

      {createOpen && (
        <AddMemberDialog
          roles={roles}
          createPending={create.isPending}
          createResult={create.data ?? null}
          invitePending={invite.isPending}
          inviteResult={invite.data ?? null}
          onClose={() => { setCreateOpen(false); create.reset(); invite.reset(); }}
          onCreate={(b) => create.mutate(b)}
          onInvite={(b) => invite.mutate(b)}
        />
      )}
      {editing && (
        <EditMemberDialog
          member={editing}
          roles={roles}
          submitting={update.isPending}
          onClose={() => setEditing(null)}
          onSave={(patch) => update.mutate({ id: editing.id, patch })}
        />
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function MemberTable({
  rows, onEdit, onRemove, onReset,
}: {
  rows: Member[];
  onEdit: (m: Member) => void;
  onRemove: (id: string, name: string) => void;
  onReset: (m: Member) => Promise<void> | void;
}) {
  const qc = useQueryClient();
  // Toggle the admin-side "MFA required" flag. Optimistic-merge keeps the
  // pill in sync before the server roundtrips.
  const toggleRequired = useMutation({
    mutationFn: ({ id, required }: { id: string; required: boolean }) =>
      api(`/api/v1/members/${id}/mfa-required`, {
        method: "PATCH",
        body: JSON.stringify({ required }),
      }),
    onMutate: async ({ id, required }) => {
      await qc.cancelQueries({ queryKey: ["members"] });
      const prev = qc.getQueryData<{ items: Member[] }>(["members"]);
      if (prev) {
        qc.setQueryData<{ items: Member[] }>(["members"], {
          ...prev,
          items: prev.items.map((m) => (m.id === id ? { ...m, mfa_required: required } : m)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["members"], ctx.prev); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["members"] }); },
  });

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              <th className="text-left px-4 py-3">Member</th>
              <th className="text-left px-3 py-3">Presence</th>
              <th className="text-left px-3 py-3">Roles</th>
              <th className="text-left px-3 py-3">Status</th>
              <th className="text-left px-3 py-3">MFA</th>
              <th className="text-left px-3 py-3">Last login</th>
              <th className="text-left px-3 py-3">Joined</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const sm = STATUS_META[m.status];
              return (
                <tr key={m.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                  <td className="px-4 py-3 min-w-[260px]">
                    <div className="flex items-center gap-3">
                      <span className="relative shrink-0">
                        <Avatar name={m.name} email={m.email} src={m.avatar_url} size={32} />
                        {/* Presence dot — green/yellow/grey ring matches the directory pill */}
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface ${PRESENCE_COLORS[m.presence].dot}`}
                          title={presenceLabel(m.presence, m.last_seen_at)}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Link
                            to={`/members/${m.id}`}
                            className="font-bold text-text truncate hover:text-accent transition-colors"
                          >
                            {m.name || "—"}
                          </Link>
                          <ExternalEmailBadge email={m.email} size="xs" />
                        </div>
                        <a href={`mailto:${m.email}`} className="text-[11.5px] text-muted hover:text-accent truncate inline-flex items-center gap-1">
                          <Mail size={10} /> {m.email}
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`pill ${PRESENCE_COLORS[m.presence].pill} whitespace-nowrap`}>
                      <Circle size={8} className={`fill-current ${m.presence === "online" ? "animate-pulse" : ""}`} />
                      {presenceLabel(m.presence, m.last_seen_at)}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {m.roles.length === 0 ? <span className="text-muted text-xs">—</span> : (
                      <div className="flex flex-wrap gap-1 max-w-[260px]">
                        {m.roles.map((r) => (
                          <span key={r} className="text-[10.5px] uppercase tracking-wide font-bold px-1.5 py-px rounded bg-accent-soft text-accent">{r}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3"><span className={`pill ${sm.cls}`}>{sm.icon}{sm.label}</span></td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {m.mfa_enabled
                        ? <span className="pill bg-success/15 text-success"><ShieldCheck size={11} /> On</span>
                        : <span className="pill bg-bg text-muted border border-border">Off</span>}
                      <button
                        onClick={() => toggleRequired.mutate({ id: m.id, required: !m.mfa_required })}
                        disabled={toggleRequired.isPending}
                        title={m.mfa_required
                          ? "Click to drop the requirement — the member can disable MFA again."
                          : "Click to require MFA — they'll be nudged on every visit until they enrol."}
                        className={`pill cursor-pointer transition-colors ${
                          m.mfa_required
                            ? "bg-warn/15 text-warn border border-warn/30 hover:bg-warn/25"
                            : "bg-bg text-muted border border-border hover:border-accent/40 hover:text-accent"
                        }`}
                      >
                        {m.mfa_required ? "Required" : "Optional"}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{fmtRel(m.last_login_at)}</td>
                  <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{fmtRel(m.created_at)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <button onClick={() => onReset(m)} className="text-muted hover:text-accent p-1" title="Issue new temporary password">
                      <KeyRound size={13} />
                    </button>
                    <button onClick={() => onEdit(m)} className="text-muted hover:text-accent p-1" title="Edit">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => onRemove(m.id, m.name || m.email)} className="text-muted hover:text-danger p-1" title="Remove">
                      <Trash2 size={13} />
                    </button>
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

/* ---------- Dialogs ---------- */

type Mode = "manual" | "invite";

function AddMemberDialog({
  roles, createPending, createResult, invitePending, inviteResult,
  onClose, onCreate, onInvite,
}: {
  roles: Role[];
  createPending: boolean;
  createResult: { id: string; email: string; temp_password: string } | null;
  invitePending: boolean;
  inviteResult: { token: string; email: string; name: string; expires_at: string } | null;
  onClose: () => void;
  onCreate: (b: { email: string; name: string; roles: string[] }) => void;
  onInvite: (b: { email: string; name: string; roles: string[]; message?: string }) => void;
}) {
  // Two-tab dialog: "Send invite link" (default — recommended) and "Create
  // manually" (fallback when the admin would rather hand-deliver a temp
  // password). Both share the same name/email/roles state so flipping tabs
  // doesn't lose what you've typed.
  const [mode, setMode] = useState<Mode>("invite");
  const [email, setEmail]   = useState("");
  const [name, setName]     = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState(
    "Hi — welcome to the workspace! Click the link below to set up your password and sign in. " +
    "It expires in 5 days.",
  );
  const valid = /\S+@\S+\.\S+/.test(email) && name.trim().length > 1;
  const toggle = (r: string) =>
    setPicked((p) => p.includes(r) ? p.filter((x) => x !== r) : [...p, r]);

  const result = mode === "manual" ? createResult : inviteResult;
  const submitting = mode === "manual" ? createPending : invitePending;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-start justify-between p-5 border-b border-border gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0"><Users size={16} /></div>
            <div>
              <h2 className="text-base font-bold text-text">
                {result
                  ? (mode === "invite" ? "Invitation ready" : "Member added")
                  : "Add a member"}
              </h2>
              <p className="text-xs text-muted mt-0.5">
                {result
                  ? (mode === "invite"
                      ? "Copy the link or open your mail client. They'll set their own password on the public page."
                      : "Their temporary password is shown ONCE — copy it now or open the mail client.")
                  : "Pick how you want them to receive their access."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text shrink-0"><X size={18} /></button>
        </header>

        {/* Mode tabs — hidden once we have a result so the user focuses on the next action */}
        {!result && (
          <div className="px-5 pt-4">
            <div className="flex gap-1 p-1 bg-bg border border-border rounded-full w-fit">
              <button
                onClick={() => setMode("invite")}
                className={`text-[12.5px] font-semibold px-3.5 py-1.5 rounded-full transition-colors inline-flex items-center gap-1.5 ${
                  mode === "invite" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
                }`}
              >
                <Send size={12} /> Invite by link
              </button>
              <button
                onClick={() => setMode("manual")}
                className={`text-[12.5px] font-semibold px-3.5 py-1.5 rounded-full transition-colors inline-flex items-center gap-1.5 ${
                  mode === "manual" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
                }`}
              >
                <KeyRound size={12} /> Create manually
              </button>
            </div>
            <p className="text-[11px] text-muted mt-2">
              {mode === "invite"
                ? "Recommended. They click a link, set their own password, and sign in. Account isn't created until they accept."
                : "Issues a one-time temporary password you hand over. Useful when the user can't access email."}
            </p>
          </div>
        )}

        {result ? (
          mode === "invite" && inviteResult ? (
            <InviteResult result={inviteResult} message={message} onClose={onClose} />
          ) : mode === "manual" && createResult ? (
            <ManualResult result={createResult} onClose={onClose} />
          ) : null
        ) : (
          <div className="p-5 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <div className="label">Full name *</div>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" />
              </label>
              <label className="block">
                <div className="label">Email *</div>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
              </label>
            </div>
            <div>
              <div className="label">Roles</div>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => {
                  const active = picked.includes(r.name);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggle(r.name)}
                      className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                        active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                      }`}
                      title={r.description}
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
              {picked.length === 0 && (
                <p className="text-[11px] text-warn mt-1.5">⚠ No roles selected — they'll be able to sign in but won't see anything until you grant a role.</p>
              )}
            </div>
            {mode === "invite" && (
              <label className="block">
                <div className="label">Message (optional)</div>
                <textarea
                  className="input"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="text-[11px] text-muted mt-1">Pre-filled friendly default. Edit it however you like.</div>
              </label>
            )}
          </div>
        )}

        {!result && (
          <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <SmartButton
              variant="primary"
              disabled={!valid || submitting}
              loading={submitting}
              onClick={() => mode === "invite"
                ? onInvite({ email: email.trim(), name: name.trim(), roles: picked, message: message.trim() || undefined })
                : onCreate({ email: email.trim(), name: name.trim(), roles: picked })}
              icon={mode === "invite" ? <Send size={13} /> : <Plus size={13} />}
            >
              {mode === "invite" ? "Generate invite link" : "Create with temp password"}
            </SmartButton>
          </footer>
        )}
      </div>
    </div>
  );
}

function InviteResult({
  result, message, onClose,
}: {
  result: { token: string; email: string; name: string; expires_at: string };
  message: string;
  onClose: () => void;
}) {
  const url = `${window.location.origin}/member-invite/${result.token}`;
  const expires = new Date(result.expires_at);
  const daysLeft = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86_400_000));
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(url); toast.success("Link copied"); }
    catch { toast.error("Copy failed", "Select and copy manually."); }
  };
  const mailto = `mailto:${encodeURIComponent(result.email)}?subject=${encodeURIComponent("Set up your D'Accubin account")}&body=${encodeURIComponent(`${message}\n\n${url}\n\nLink expires on ${expires.toLocaleDateString()}.`)}`;

  return (
    <>
      <div className="p-5 space-y-4">
        <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12.5px]">
          <div className="text-muted">Invite ready for</div>
          <div className="text-text font-semibold">{result.name} · {result.email}</div>
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
            Expires in {daysLeft} day{daysLeft === 1 ? "" : "s"} · single-use · revocable from the directory.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12px] text-muted">
          <span className="font-semibold text-text">Heads up:</span> email isn't auto-sent yet. Use the mail-client button below or paste the link wherever you want.
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
        <button onClick={onClose} className="btn-ghost">Done</button>
        <a href={mailto} className="btn-primary inline-flex items-center" style={{ textDecoration: "none" }}>
          <Mail size={13} /> Open in mail client
        </a>
      </footer>
    </>
  );
}

function ManualResult({
  result, onClose,
}: {
  result: { id: string; email: string; temp_password: string };
  onClose: () => void;
}) {
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(result.temp_password); toast.success("Password copied", "Send via a secure channel."); }
    catch { toast.error("Copy failed", "Select and copy manually."); }
  };
  const mailto = `mailto:${encodeURIComponent(result.email)}?subject=${encodeURIComponent("Your D'Accubin login")}&body=${encodeURIComponent(`Hi,\n\nYour workspace account is ready.\n\nEmail: ${result.email}\nTemporary password: ${result.temp_password}\n\nPlease sign in and change your password immediately.`)}`;

  return (
    <>
      <div className="p-5 space-y-4">
        <div className="rounded-lg border border-border bg-bg/30 p-3 text-[12.5px]">
          <div className="text-muted">Account created</div>
          <div className="text-text font-semibold">{result.email}</div>
        </div>
        <div>
          <div className="label">One-time password</div>
          <div className="flex items-center gap-2 bg-bg/50 border border-border rounded-lg px-3 py-2">
            <KeyRound size={13} className="text-muted shrink-0" />
            <input readOnly value={result.temp_password} className="flex-1 bg-transparent text-[13px] text-text font-mono truncate focus:outline-none" />
            <button onClick={handleCopy} className="text-xs font-semibold text-accent hover:underline whitespace-nowrap inline-flex items-center gap-1">
              <Copy size={12} /> Copy
            </button>
          </div>
          <p className="text-[11px] text-muted mt-1">
            We don't store the plain text — once you close this dialog you'll need to issue a fresh password if it's lost.
          </p>
        </div>
        <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-[12px] text-text">
          <span className="font-semibold">Heads up:</span> email isn't auto-sent yet. Use the mail-client button below or paste into your channel of choice.
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
        <button onClick={onClose} className="btn-ghost">Done</button>
        <a href={mailto} className="btn-primary inline-flex items-center" style={{ textDecoration: "none" }}>
          <Mail size={13} /> Open in mail client
        </a>
      </footer>
    </>
  );
}

function EditMemberDialog({
  member, roles, submitting, onClose, onSave,
}: {
  member: Member;
  roles: Role[];
  submitting: boolean;
  onClose: () => void;
  onSave: (patch: { name?: string; status?: MemberStatus; roles?: string[] }) => void;
}) {
  const [name, setName]   = useState(member.name);
  const [status, setStatus] = useState<MemberStatus>(member.status);
  const [picked, setPicked] = useState<string[]>([...member.roles]);
  const toggle = (r: string) =>
    setPicked((p) => p.includes(r) ? p.filter((x) => x !== r) : [...p, r]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-base font-bold text-text">Edit member</h2>
            <p className="text-[11px] text-muted">{member.email}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="label">Full name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <div className="label">Status</div>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as MemberStatus)}>
              <option value="active">Active</option>
              <option value="invited">Invited (awaiting first login)</option>
              <option value="disabled">Disabled (cannot sign in)</option>
            </select>
          </label>
          <div>
            <div className="label">Roles</div>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => {
                const active = picked.includes(r.name);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggle(r.name)}
                    className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                      active ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:text-text hover:border-accent"
                    }`}
                    title={r.description}
                  >
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton variant="primary" loading={submitting}
            onClick={() => onSave({ name: name.trim(), status, roles: picked })}>
            Save changes
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ------------------ Invitations panel ------------------ */

type Invitation = {
  id: string;
  token: string;
  email: string;
  name: string;
  roles: string[] | null;
  message: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at:  string | null;
  status: "pending" | "accepted" | "expired" | "revoked";
};

function InvitationsPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: Invitation[] }>({
    queryKey: ["members", "invitations"],
    queryFn: () => api("/api/v1/members/invitations"),
    refetchInterval: 60_000,
  });
  // Accepted invitations have served their purpose — the invitee is now in the
  // members table below, so showing them here twice is just clutter.
  const items = (data?.items ?? []).filter((i) => i.status !== "accepted");

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/member-invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", "invitations"] });
      toast.success("Invitation revoked");
    },
  });

  // Hard delete — only works once the invitation is no longer live (revoked,
  // accepted, or expired). The backend refuses with 409 otherwise so a stray
  // call can't leak active access. UI confirms with a warning dialog because
  // this destroys the row outright; there's no undo.
  const hardDelete = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/member-invitations/${id}/hard`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", "invitations"] });
      toast.success("Invitation deleted");
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not delete", msg);
    },
  });

  async function askThenRevoke(inv: Invitation) {
    const ok = await confirmAction({
      title: "Revoke this invitation?",
      body: `The link sent to ${inv.email} will stop working immediately. You can issue a fresh invite later.`,
      confirmLabel: "Revoke invite",
      danger: true,
    });
    if (ok) revoke.mutate(inv.id);
  }

  async function askThenDelete(inv: Invitation) {
    const ok = await confirmAction({
      title: "Delete this invitation?",
      body: `This permanently removes the invitation record for ${inv.email}. It can't be undone — but you can always invite them again.`,
      confirmLabel: "Delete invitation",
      danger: true,
    });
    if (ok) hardDelete.mutate(inv.id);
  }

  // Resend the same token with a fresh expiry. Server returns sent:true if SMTP
  // is wired and the email actually went out, false if it just refreshed the link.
  const resend = useMutation({
    mutationFn: (id: string) =>
      api<{ sent: boolean; email: string }>(`/api/v1/member-invitations/${id}/resend`, { method: "POST" }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["members", "invitations"] });
      if (res.sent) {
        toast.success("Invite resent", `Email re-sent to ${res.email}.`);
      } else {
        toast.success("Invite refreshed", "Link extended for 14 days. Email isn't wired — copy the link to share.");
      }
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? ((e.body as any)?.error ?? e.message) : (e as Error)?.message;
      toast.error("Could not resend", msg);
    },
  });

  if (isLoading && items.length === 0) return null;
  if (items.length === 0) return null;

  // Sort: pending first, then accepted, then expired/revoked. Newest within each.
  const order: Record<Invitation["status"], number> = { pending: 0, accepted: 1, expired: 2, revoked: 3 };
  const sorted = [...items].sort((a, b) => {
    const d = order[a.status] - order[b.status];
    return d !== 0 ? d : (b.created_at.localeCompare(a.created_at));
  });

  const pending = items.filter((i) => i.status === "pending").length;
  const accepted = items.filter((i) => i.status === "accepted").length;
  const expired = items.filter((i) => i.status === "expired").length;

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Send size={14} className="text-accent" />
          <div className="font-semibold text-text">Invitations</div>
          <div className="text-xs text-muted">
            {pending} pending · {accepted} accepted{expired > 0 ? ` · ${expired} expired` : ""}
          </div>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {sorted.map((inv) => (
          <InvitationRow
            key={inv.id}
            inv={inv}
            onRevoke={() => askThenRevoke(inv)}
            onResend={() => resend.mutate(inv.id)}
            onDelete={() => askThenDelete(inv)}
            resending={resend.isPending && resend.variables === inv.id}
            deleting={hardDelete.isPending && hardDelete.variables === inv.id}
          />
        ))}
      </ul>
    </div>
  );
}

function InvitationRow({
  inv, onRevoke, onResend, onDelete, resending, deleting,
}: {
  inv: Invitation;
  onRevoke: () => void;
  onResend: () => void;
  onDelete: () => void;
  resending: boolean;
  deleting: boolean;
}) {
  const inviteUrl = `${window.location.origin}/member-invite/${inv.token}`;
  const fmt = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const pill = STATUS_PILL[inv.status];

  return (
    <li className="px-5 py-3 flex items-center gap-4">
      <div className="w-9 h-9 rounded-full bg-accent-soft text-accent grid place-items-center font-bold text-sm shrink-0">
        {(inv.name || inv.email).charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-text truncate">{inv.name || inv.email}</span>
          <ExternalEmailBadge email={inv.email} size="xs" />
        </div>
        <div className="text-xs text-muted truncate">{inv.email}</div>
      </div>
      <div className="hidden md:flex flex-col items-end text-[11px] text-muted leading-tight">
        <span>sent {fmt(inv.created_at)}</span>
        {inv.status === "accepted"
          ? <span className="text-success">accepted {fmt(inv.accepted_at)}</span>
          : inv.status === "pending"
            ? <span>expires {fmt(inv.expires_at)}</span>
            : null}
      </div>
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${pill.cls}`}>
        {pill.icon}{pill.label}
      </span>
      <div className="flex items-center gap-1">
        {inv.status === "pending" && (
          <>
            <button
              type="button"
              title="Copy invite link"
              className="p-1.5 rounded hover:bg-bg text-muted"
              onClick={() => {
                navigator.clipboard.writeText(inviteUrl).then(
                  () => toast.success("Invite link copied"),
                  () => toast.error("Could not copy link"),
                );
              }}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              title="Resend invite email · refreshes expiry"
              disabled={resending}
              className="p-1.5 rounded hover:bg-bg text-muted hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onResend}
            >
              <RotateCcw size={14} className={resending ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              title="Revoke invite"
              className="p-1.5 rounded hover:bg-bg text-muted hover:text-danger"
              onClick={onRevoke}
            >
              <X size={14} />
            </button>
          </>
        )}
        {inv.status === "expired" && (
          <button
            type="button"
            title="Reissue invite (extends expiry by 14 days, re-sends email)"
            disabled={resending}
            className="text-[11.5px] font-semibold text-accent hover:underline px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            onClick={onResend}
          >
            <RotateCcw size={11} className={resending ? "animate-spin" : ""} /> Reissue
          </button>
        )}
        {/* Hard-delete is only safe once the invite can no longer be accepted.
            Backend enforces the same rule; UI hides it for pending so the
            obvious next click is "Revoke" instead. */}
        {(inv.status === "revoked" || inv.status === "expired" || inv.status === "accepted") && (
          <button
            type="button"
            title="Delete this invitation record permanently"
            disabled={deleting}
            className="p-1.5 rounded hover:bg-bg text-muted hover:text-danger disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

const STATUS_PILL: Record<Invitation["status"], { label: string; cls: string; icon: React.ReactNode }> = {
  pending:  { label: "Pending",  cls: "bg-accent-soft text-accent",     icon: <Clock        size={11} /> },
  accepted: { label: "Accepted", cls: "bg-success/15 text-success",     icon: <CheckCircle2 size={11} /> },
  expired:  { label: "Expired",  cls: "bg-warn/15 text-warn",           icon: <Clock        size={11} /> },
  revoked:  { label: "Revoked",  cls: "bg-muted/15 text-muted",         icon: <X            size={11} /> },
};
