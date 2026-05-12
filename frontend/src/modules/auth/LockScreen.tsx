// LockScreen — step away without ending the session.
//
// Hides the app behind a password prompt without dropping the JWT, so the
// user's presence keeps ticking (heartbeat poll from the auth store still
// fires) and any morning-huddle / attendance signals reflect that they're
// still on the clock. Just the UI is locked.
//
// We deliberately don't blank the heartbeat — being away from the desk for
// 5 minutes doesn't mean the workday is over.
import { useEffect, useRef, useState } from "react";
import { useNavigate, Navigate, useLocation } from "react-router-dom";
import { Lock, Eye, EyeOff, AlertCircle, Loader2, LogOut } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function LockScreen() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();
  const loc = useLocation();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the password input on mount so unlock is just type → Enter.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Boot the lock screen if there's no session at all — landing here without
  // a JWT is a bug, route them to login.
  if (!user) return <Navigate to="/login" replace />;

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setErr(null);
    setPending(true);
    try {
      await api("/api/v1/auth/verify-password", {
        method: "POST",
        body: JSON.stringify({ password: pw }),
      });
      // Where to go after unlock — honour ?next= if set, else dashboard.
      const params = new URLSearchParams(loc.search);
      const next = params.get("next") || "/my-work";
      nav(next, { replace: true });
    } catch (e) {
      const msg = e instanceof ApiError
        ? ((e.body as any)?.error ?? e.message)
        : (e as Error).message;
      setErr(msg || "Wrong password.");
    } finally {
      setPending(false);
    }
  }

  function signOut() {
    logout();
    nav("/login", { replace: true });
  }

  const firstName = (user.name || user.email || "there").split(/[ @]/)[0];

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="bg-surface border border-border rounded-2xl shadow-card p-6 sm:p-8 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-accent-soft text-accent grid place-items-center mb-4">
            <Lock size={22} />
          </div>
          <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-muted">
            Screen locked · session active
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-text mt-2">
            Welcome back, {firstName}
          </h1>
          <p className="text-sm text-muted mt-1.5">
            Your D'Accubin session is still live — type your password to pick up where you left off.
          </p>

          <form onSubmit={unlock} className="mt-6 space-y-3 text-left">
            <div className="text-[12px] text-muted">{user.email}</div>
            <div className="relative">
              <input
                ref={inputRef}
                type={show ? "text" : "password"}
                value={pw}
                onChange={(e) => { setPw(e.target.value); setErr(null); }}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full bg-bg border border-border rounded-xl pl-4 pr-11 py-3 text-[15px] text-text placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text p-1 rounded"
                aria-label={show ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {err && (
              <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-2 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={pending || !pw}
              className="w-full inline-flex items-center justify-center gap-2 bg-accent text-white font-bold tracking-wider text-[15px] py-3 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-50 disabled:cursor-not-allowed transition shadow-soft"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Unlock
            </button>

            <button
              type="button"
              onClick={signOut}
              className="w-full inline-flex items-center justify-center gap-1.5 text-[12px] text-muted hover:text-danger pt-2"
            >
              <LogOut size={11} /> Sign out completely
            </button>
          </form>
        </div>

        <div className="text-center text-[10.5px] text-muted/70 mt-3">
          Your presence stays online while locked. End your shift via Sign out.
        </div>
      </div>
    </div>
  );
}
