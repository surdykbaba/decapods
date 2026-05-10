import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";

type Verify =
  | { state: "loading" }
  | { state: "valid"; email: string; expires_at: string }
  | { state: "invalid"; reason: "expired" | "used" | "invalid" }
  | { state: "error"; message: string };

export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [verify, setVerify] = useState<Verify>({ state: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ valid: boolean; email?: string; expires_at?: string; reason?: "expired" | "used" | "invalid" }>(
      `/api/v1/auth/reset-password/${token}`,
    )
      .then((r) => {
        if (!live) return;
        if (r.valid && r.email && r.expires_at) {
          setVerify({ state: "valid", email: r.email, expires_at: r.expires_at });
        } else {
          setVerify({ state: "invalid", reason: r.reason ?? "invalid" });
        }
      })
      .catch((e: any) => {
        if (!live) return;
        setVerify({ state: "error", message: e?.message ?? "Could not verify reset link." });
      });
    return () => { live = false; };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setLoading(true);
    try {
      await api("/api/v1/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
      setTimeout(() => nav("/login"), 1500);
    } catch (e: any) {
      setErr(e?.message ?? "Could not reset password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card p-8">
        <h1 className="h1 mb-1">Set a new password</h1>

        {verify.state === "loading" && (
          <p className="text-sm text-muted">Checking your link…</p>
        )}

        {verify.state === "invalid" && (
          <>
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-3 my-4">
              {verify.reason === "expired" && "This reset link has expired. Links are valid for 15 minutes."}
              {verify.reason === "used"    && "This reset link has already been used. Request a new one."}
              {verify.reason === "invalid" && "This reset link is invalid. It may have been mistyped or revoked."}
            </div>
            <Link to="/forgot-password" className="text-sm font-semibold text-accent hover:underline">
              Request a new link →
            </Link>
          </>
        )}

        {verify.state === "error" && (
          <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-3 my-4">
            {verify.message}
          </div>
        )}

        {verify.state === "valid" && !done && (
          <>
            <p className="text-sm text-muted mb-5">
              Resetting password for <span className="font-semibold text-text">{verify.email}</span>.
              This link expires {fmtExpiry(verify.expires_at)}.
            </p>
            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">New password</div>
                <input
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  minLength={8}
                />
              </label>
              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">Confirm new password</div>
                <input
                  type="password"
                  className="input"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                />
              </label>
              {err && (
                <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-2">
                  {err}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? "Saving…" : "Save new password"}
              </button>
            </form>
          </>
        )}

        {done && (
          <div className="bg-success/10 border border-success/30 text-success text-sm rounded-xl px-3 py-3 my-4">
            Password updated. Redirecting to sign in…
          </div>
        )}
      </div>
    </div>
  );
}

function fmtExpiry(iso: string): string {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "in less than a minute";
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m === 1) return "in about a minute";
  return `in about ${m} minutes`;
}
