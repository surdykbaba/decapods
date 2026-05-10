// Public, no-auth page where an invited member sets their password and joins
// the workspace. Token in the URL is the only credential.
import { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Users, ShieldCheck, AlertTriangle, CheckCircle2, KeyRound, Eye, EyeOff } from "lucide-react";
import { SmartButton } from "@/components/SmartButton";

type InviteContext = {
  email: string;
  name: string;
  roles: string[];
  message: string;
  workspace: string;
  expires_at: string;
};

async function fetchInvite(token: string): Promise<InviteContext> {
  const res = await fetch(`/api/v1/member-invite/${token}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body?.code;
    throw err;
  }
  return body as InviteContext;
}

async function acceptInvite(token: string, payload: { password: string; name?: string }) {
  const res = await fetch(`/api/v1/member-invite/${token}`, {
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
  | { kind: "done"; email: string };

export function MemberInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const nav = useNavigate();

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
      <div className="w-full max-w-md">
        {state.kind === "loading" && <div className="text-center text-muted py-20">Loading invitation…</div>}
        {state.kind === "error"   && <ErrorScreen message={state.message} code={state.code} />}
        {state.kind === "done"    && <DoneScreen email={state.email} onSignIn={() => nav("/login")} />}
        {state.kind === "ready"   && (
          <Form
            ctx={state.ctx}
            onSubmit={async (p) => {
              const r = await acceptInvite(token!, p);
              setState({ kind: "done", email: r.email });
            }}
          />
        )}
      </div>
    </div>
  );
}

function ErrorScreen({ message, code }: { message: string; code?: string }) {
  const reason = code === "expired"
    ? "This invitation has expired. Ask the workspace admin to send a fresh link."
    : code === "accepted"
      ? "This invitation has already been used. Try signing in instead."
      : code === "revoked"
        ? "This invitation was revoked. Ask the admin to issue a new one."
        : message;
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-warn/15 text-warn grid place-items-center mb-3">
        <AlertTriangle size={22} />
      </div>
      <h1 className="text-xl font-bold text-text">Can't open this invitation</h1>
      <p className="text-sm text-muted mt-2">{reason}</p>
    </div>
  );
}

function DoneScreen({ email, onSignIn }: { email: string; onSignIn: () => void }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-success/15 text-success grid place-items-center mb-3">
        <CheckCircle2 size={22} />
      </div>
      <h1 className="text-xl font-bold text-text">You're in 🎉</h1>
      <p className="text-sm text-muted mt-2">
        Account created for <span className="font-semibold text-text">{email}</span>. You can sign in now.
      </p>
      <button onClick={onSignIn} className="btn-primary mt-5">
        Sign in →
      </button>
    </div>
  );
}

function Form({
  ctx, onSubmit,
}: { ctx: InviteContext; onSubmit: (payload: { password: string; name?: string }) => Promise<void> }) {
  const [name, setName]               = useState(ctx.name);
  const [password, setPassword]       = useState("");
  const [confirm, setConfirm]         = useState("");
  const [showPassword, setShowPwd]    = useState(false);
  const [err, setErr]                 = useState<string | null>(null);

  const tooShort  = password.length > 0 && password.length < 10;
  const mismatch  = confirm.length > 0 && confirm !== password;
  const valid     = name.trim().length > 1 && password.length >= 10 && password === confirm;

  return (
    <div className="space-y-5">
      <header className="bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
            <Users size={20} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Workspace invite</div>
            <h1 className="text-2xl font-extrabold text-text mt-1">
              Welcome{ctx.workspace ? `, to ${ctx.workspace}` : ""}
            </h1>
            <p className="text-sm text-muted mt-1">
              Set your password to finish setting up your account. The link expires {new Date(ctx.expires_at).toLocaleDateString()}.
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
        <div className="space-y-3">
          <div>
            <div className="label">Email</div>
            <div className="bg-bg/50 border border-border rounded-xl px-3.5 py-2.5 text-text font-mono text-[13.5px]">
              {ctx.email}
            </div>
          </div>
          <label className="block">
            <div className="label">Full name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <div className="label">Choose a password</div>
            <div className="relative">
              <input
                className="input pr-10"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 10 characters"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {tooShort && <p className="text-[11.5px] text-warn mt-1">Use at least 10 characters.</p>}
          </label>
          <label className="block">
            <div className="label">Confirm password</div>
            <input
              className="input"
              type={showPassword ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch && <p className="text-[11.5px] text-warn mt-1">Passwords don't match.</p>}
          </label>
          {ctx.roles.length > 0 && (
            <div>
              <div className="label">Your roles</div>
              <div className="flex flex-wrap gap-1.5">
                {ctx.roles.map((r) => (
                  <span key={r} className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-accent-soft text-accent">{r}</span>
                ))}
              </div>
            </div>
          )}
          {err && <div className="text-xs text-danger">{err}</div>}
        </div>
        <div className="mt-5 flex justify-end">
          <SmartButton
            variant="primary"
            disabled={!valid}
            icon={<KeyRound size={14} />}
            onClick={async () => {
              setErr(null);
              try {
                await onSubmit({ password, name: name.trim() });
              } catch (e) {
                setErr((e as Error)?.message ?? "Couldn't accept the invitation.");
              }
            }}
          >
            Set password & sign me up
          </SmartButton>
        </div>
      </section>

      <p className="text-center text-[11px] text-muted">
        <ShieldCheck size={11} className="inline mr-1" />
        Your password is hashed before it leaves the server. We never store the plain text.
      </p>
    </div>
  );
}
