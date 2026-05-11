import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Mail, Lock, Eye, EyeOff, AlertCircle, ArrowRight, Loader2,
  CornerRightUp, Sparkles, ShieldCheck, Cpu, BarChart3,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Stable Pexels hero — abstract circuit/macro tech image. Pexels permits
// hotlinking under their license; the URL carries auto-compress + width so the
// CDN serves a right-sized variant rather than the raw original.
const HERO_URL =
  "https://images.pexels.com/photos/2451646/pexels-photo-2451646.jpeg?auto=compress&cs=tinysrgb&w=1600&dpr=2";

const REMEMBER_KEY = "pgdp:remember-email";

const TIPS = [
  "Capture every opportunity. Route it through approvals you control.",
  "One source of truth — pipeline, projects, finance, and people.",
  "Burnout signals before they become resignations.",
  "Audit-grade trail of who did what, from where.",
];

export function LoginPage() {
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(() => !!localStorage.getItem(REMEMBER_KEY));
  const [capsLock, setCapsLock] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tipIdx, setTipIdx] = useState(0);
  const { setTokens } = useAuth();
  const nav = useNavigate();

  // Rotate the marketing tip every 5s. Pauses while the form is submitting so
  // the screen doesn't shuffle under the user.
  useEffect(() => {
    if (loading) return;
    const t = setInterval(() => setTipIdx((i) => (i + 1) % TIPS.length), 5000);
    return () => clearInterval(t);
  }, [loading]);

  function onKeyForCaps(e: React.KeyboardEvent<HTMLInputElement>) {
    if (typeof e.getModifierState === "function") {
      setCapsLock(e.getModifierState("CapsLock"));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setErr("Enter your email and password.");
      return;
    }
    if (!/\S+@\S+\.\S+/.test(trimmed)) {
      setErr("That doesn't look like a valid email.");
      return;
    }
    setLoading(true);
    try {
      const res = await api<any>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: trimmed, password }),
      });
      if (remember) localStorage.setItem(REMEMBER_KEY, trimmed);
      else localStorage.removeItem(REMEMBER_KEY);
      if (res.mfa_challenge) {
        sessionStorage.setItem("mfa_challenge", res.mfa_challenge);
        nav("/mfa");
        return;
      }
      setTokens(res.access_token, res.refresh_token);
      nav("/dashboard");
    } catch (e: any) {
      setErr(e?.message ?? "Wrong email or password.");
    } finally {
      setLoading(false);
    }
  }

  const emailValid = useMemo(() => /\S+@\S+\.\S+/.test(email.trim()), [email]);
  const canSubmit = emailValid && password.length > 0 && !loading;

  return (
    <div className="min-h-screen flex bg-bg" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {/* ============== LEFT — form ============== */}
      <div className="flex-1 flex items-center justify-center px-5 py-10 sm:px-8 lg:px-14 relative">
        {/* Subtle accent glow behind the card on small screens — replaces the
            absent hero image, gives the form a sense of place. */}
        <div className="absolute inset-0 lg:hidden pointer-events-none">
          <div className="absolute -top-32 -left-20 w-72 h-72 bg-accent/20 rounded-full blur-3xl" />
          <div className="absolute -bottom-32 -right-20 w-72 h-72 bg-warn/15 rounded-full blur-3xl" />
        </div>

        <div className="w-full max-w-[420px] relative">
          <BrandMark />

          <div className="mt-10 sm:mt-12">
            <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] font-bold text-accent">
              <Sparkles size={11} /> D'Accubin workspace
            </div>
            <h1 className="text-[2rem] sm:text-[2.25rem] font-extrabold tracking-tight mt-2 leading-tight text-text">
              Welcome back
            </h1>
            <p className="text-sm text-muted mt-1.5">
              Sign in to pick up where you left off.
            </p>
          </div>

          <form onSubmit={submit} className="mt-8 space-y-4" autoComplete="on">
            <Field label="Email">
              <div className="relative">
                <Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  autoFocus={!email}
                  className="w-full bg-surface border border-border rounded-xl pl-10 pr-3 py-3 text-[15px] text-text placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {emailValid && (
                  <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-success text-xs">✓</span>
                )}
              </div>
            </Field>

            <Field
              label="Password"
              right={<Link to="/forgot-password" className="text-[12px] font-semibold text-accent hover:underline">Forgot?</Link>}
            >
              <div className="relative">
                <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  type={showPw ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  required
                  autoFocus={!!email}
                  onKeyUp={onKeyForCaps}
                  onKeyDown={onKeyForCaps}
                  className="w-full bg-surface border border-border rounded-xl pl-10 pr-11 py-3 text-[15px] text-text placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text p-1 rounded"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {capsLock && (
                <div className="inline-flex items-center gap-1 text-[11px] text-warn mt-1.5">
                  <CornerRightUp size={11} /> Caps Lock is on
                </div>
              )}
            </Field>

            <label className="flex items-center gap-2 text-[12.5px] text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent"
              />
              <span>Remember my email on this device</span>
            </label>

            {err && (
              <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-xl px-3 py-2 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 bg-accent text-white font-bold tracking-wider text-[15px] py-3.5 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-50 disabled:cursor-not-allowed transition shadow-soft"
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  SIGNING IN…
                </>
              ) : (
                <>
                  CONTINUE
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          <div className="text-center text-[11px] text-muted/80 mt-8 leading-relaxed">
            Signing in means you've read and agree to the{" "}
            <a className="text-accent hover:underline cursor-pointer">Terms of Service</a> and the{" "}
            <a className="text-accent hover:underline cursor-pointer">Privacy Policy</a>.
          </div>

          <div className="text-center text-[10px] text-muted/60 mt-3 inline-flex items-center justify-center gap-1.5 w-full">
            <ShieldCheck size={10} /> Encrypted end-to-end · MFA-ready
          </div>
        </div>
      </div>

      {/* ============== RIGHT — hero ============== */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden">
        {/* Pexels image fills the panel; fallback is the accent gradient if
            the CDN is unreachable. onError swaps to a CSS-only background. */}
        <img
          src={HERO_URL}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = "none";
            const parent = el.parentElement;
            if (parent) parent.style.background = "linear-gradient(135deg, rgb(var(--accent)), #0a3b4b)";
          }}
        />
        {/* Brand-tinted gradient overlay so text reads cleanly regardless of
            which slice of the photo is visible at any viewport. */}
        <div className="absolute inset-0 bg-gradient-to-br from-text/95 via-text/80 to-accent/70" />
        {/* Subtle grid texture so the panel doesn't feel like a flat overlay. */}
        <div
          className="absolute inset-0 opacity-[0.07] pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)`,
            backgroundSize: "32px 32px",
          }}
        />

        <div className="relative z-10 flex flex-col justify-between p-12 xl:p-16 text-surface w-full">
          <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-bold text-accent-soft">
            <Sparkles size={11} /> Project governance &amp; delivery
          </div>

          <div>
            <h2 className="text-[2.4rem] xl:text-[2.8rem] font-extrabold tracking-tight leading-[1.05] text-white">
              Governance, delivery,<br />and finance — together.
            </h2>
            <p className="text-base text-white/75 mt-5 max-w-md leading-relaxed">
              From the first lead to the final invoice. Every approval, every dollar, every
              decision in one auditable, mobile-ready workspace.
            </p>

            <div className="mt-8 grid grid-cols-3 gap-3 max-w-md">
              <StatPill icon={<ShieldCheck size={14} />} label="Auditable" />
              <StatPill icon={<Cpu size={14} />}         label="Automated" />
              <StatPill icon={<BarChart3 size={14} />}   label="Insightful" />
            </div>

            {/* Rotating tip strip — soft motion, easy to ignore, easy to read. */}
            <div className="mt-10 h-12 flex items-start max-w-md">
              <div
                key={tipIdx}
                className="text-sm text-white/85 leading-relaxed transition-opacity duration-500 animate-[fadeIn_0.4s_ease-out]"
              >
                <span className="text-accent-soft mr-1.5">›</span>
                {TIPS[tipIdx]}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-white/55">
            <span>Built for portfolio teams</span>
            <span>v0.1 · {import.meta.env.MODE}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[13px] font-semibold text-text">{label}</div>
        {right}
      </div>
      {children}
    </label>
  );
}

function StatPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 border border-white/15 text-white text-[11.5px] font-semibold backdrop-blur-sm">
      {icon} {label}
    </div>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <img src="/brand/logo-dark.png" alt="D'Accubin" className="w-12 h-12 object-contain" />
      <div>
        <div className="text-[15px] font-extrabold text-text leading-none">D'Accubin</div>
        <div className="text-[10.5px] text-muted leading-none mt-1">Workspace</div>
      </div>
    </div>
  );
}
