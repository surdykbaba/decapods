import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function MfaPage() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { setTokens } = useAuth();
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const ch = sessionStorage.getItem("mfa_challenge");
      const res = await api<any>("/api/v1/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ mfa_challenge: ch, code }),
      });
      setTokens(res.access_token, res.refresh_token);
      sessionStorage.removeItem("mfa_challenge");
      nav("/dashboard");
    } catch (e: any) {
      setErr(e.message ?? "Verification failed");
    }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <form onSubmit={submit} className="card p-8 w-full max-w-sm space-y-4">
        <h1 className="h1">Two-factor</h1>
        <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
        <input
          className="input tracking-[0.5em] text-center text-lg"
          value={code} onChange={(e) => setCode(e.target.value)}
          inputMode="numeric" maxLength={6}
        />
        {err && <div className="text-danger text-sm">{err}</div>}
        <button className="btn-primary w-full justify-center">Verify</button>
      </form>
    </div>
  );
}
