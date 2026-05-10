import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!email.trim()) { setErr("Enter your email address."); return; }
    setLoading(true);
    try {
      await api("/api/v1/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setSubmitted(true);
    } catch (e: any) {
      setErr(e?.message ?? "Could not send reset email.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card p-8">
        <h1 className="h1 mb-1">Reset your password</h1>
        <p className="text-sm text-muted mb-6">
          Enter the email tied to your account. If it matches, we'll send a single-use link that
          expires in 15 minutes.
        </p>

        {submitted ? (
          <>
            <div className="bg-success/10 border border-success/30 text-success text-sm rounded-xl px-3 py-3 mb-4">
              If an account exists for <span className="font-semibold">{email}</span>, a reset link is on its way.
              Check your inbox — and spam folder — within the next minute.
            </div>
            <Link to="/login" className="text-sm font-semibold text-accent hover:underline">← Back to sign in</Link>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Email</div>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourco.com"
                autoComplete="email"
                autoFocus
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
              {loading ? "Sending…" : "Send reset link"}
            </button>
            <div className="text-center">
              <Link to="/login" className="text-xs text-muted hover:text-text">Back to sign in</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
