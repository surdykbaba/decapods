import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function LoginPage() {
  const [email, setEmail] = useState("admin@pgdp.local");
  const [password, setPassword] = useState("Admin@12345");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { setTokens } = useAuth();
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      const res = await api<any>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (res.mfa_challenge) {
        sessionStorage.setItem("mfa_challenge", res.mfa_challenge);
        nav("/mfa");
        return;
      }
      setTokens(res.access_token, res.refresh_token);
      nav("/dashboard");
    } catch (e: any) {
      setErr(e.message ?? "Login failed");
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-full grid place-items-center bg-bg p-6">
      <form onSubmit={submit} className="card p-8 w-full max-w-sm space-y-4">
        <div>
          <h1 className="h1">Sign in</h1>
          <p className="text-sm text-muted">PGDP — enterprise governance & delivery.</p>
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
