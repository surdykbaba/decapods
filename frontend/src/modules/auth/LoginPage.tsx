import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
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
    setErr(null);
    if (!email.trim() || !password) {
      setErr("Enter your email and password.");
      return;
    }
    setLoading(true);
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
      setErr(e.message ?? "Wrong email or password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-2 bg-surface">
      {/* Left — form */}
      <div className="flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px]">
          <BrandMark />

          <h1 className="text-[2.25rem] font-extrabold tracking-tight mt-12 leading-tight">
            Welcome back
          </h1>
          <p className="text-sm text-muted mt-1.5">Enter your credentials to continue.</p>

          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field label="Email">
              <input
                type="email"
                required
                autoFocus
                className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-[15px] text-text placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
                placeholder="name@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                required
                className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-[15px] text-text placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
                placeholder="•••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <div className="flex justify-center">
              <Link to="/forgot-password" className="text-xs text-muted hover:text-text">Forgot your password?</Link>
            </div>

            {err && (
              <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-2">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-accent text-white font-bold tracking-wider text-[15px] py-3.5 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 transition shadow-soft"
            >
              {loading ? "SIGNING IN…" : "LOGIN"}
            </button>
          </form>

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted">OR</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-3">
            <SocialButton onClick={() => alert("Google sign-in is not configured in this preview.")}>
              <GoogleIcon /> Sign up with Google
            </SocialButton>
            <SocialButton onClick={() => alert("SSO is not configured in this preview.")}>
              <SsoIcon /> Login with SSO
            </SocialButton>
          </div>

          <div className="text-center text-sm text-muted mt-6">
            Not a member?{" "}
            <Link to="#" className="text-text font-semibold hover:text-accent">Sign up</Link>
          </div>

          <div className="text-center text-[11px] text-muted/80 mt-8 leading-relaxed">
            Logging in signifies that you have read and agree to the{" "}
            <a className="text-accent hover:underline cursor-pointer">Terms of Service</a> and our{" "}
            <a className="text-accent hover:underline cursor-pointer">Privacy Policy</a>.
          </div>
        </div>
      </div>

      {/* Right — accent panel */}
      <div className="hidden lg:flex bg-accent relative overflow-hidden">
        <div className="absolute inset-6 bg-text rounded-3xl flex flex-col justify-between p-10 text-surface">
          <div className="flex items-center gap-2">
            <img src="/brand/logo-dark.png" alt="" className="w-14 h-14 object-contain" />
          </div>

          <div>
            <div className="text-3xl font-extrabold tracking-tight leading-tight">
              Governance, delivery,<br />and finance — together.
            </div>
            <p className="text-sm text-surface/70 mt-4 max-w-md leading-relaxed">
              Capture an opportunity, route it through configurable approvals, convert into a project
              when planning kicks off, and watch every stakeholder, document and dollar in one place.
            </p>

            <ul className="mt-8 space-y-2.5 text-sm text-surface/90">
              {[
                "Configurable approval workflows with role gates",
                "Document checklists tied to lead type & value",
                "Team-rate driven budgeting with risk alerts",
                "Real-time pipeline with drag-and-drop transitions",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between text-xs text-surface/60">
            <span>Built for portfolio teams</span>
            <span>v0.1 · {import.meta.env.MODE}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[13px] font-semibold text-text mb-1.5">{label}</div>
      {children}
    </label>
  );
}

function SocialButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full inline-flex items-center justify-center gap-3 border border-border rounded-full px-4 py-3 text-sm font-semibold text-text hover:bg-bg transition-colors"
    >
      {children}
    </button>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center">
      <img src="/brand/logo-dark.png" alt="D'Accubin" className="w-14 h-14 object-contain" />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 01-11.3 8 12 12 0 01-12-12 12 12 0 0112-12c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 0024 4a20 20 0 100 40 20 20 0 0019.6-23.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0124 16c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 0024 4a20 20 0 00-17.7 10.7z"/>
      <path fill="#4CAF50" d="M24 44a20 20 0 0013.5-5.2l-6.2-5.3A12 12 0 0124 36a12 12 0 01-11.3-8l-6.5 5A20 20 0 0024 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 01-4.1 5.5l6.2 5.3c-.4.4 6.6-4.8 6.6-14.8 0-1.3-.1-2.3-.4-3.5z"/>
    </svg>
  );
}

function SsoIcon() {
  return (
    <span className="w-[18px] h-[18px] rounded-md bg-accent grid place-items-center text-white">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </span>
  );
}
