import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
export function LoginPage() {
    const [email, setEmail] = useState("admin@pgdp.local");
    const [password, setPassword] = useState("Admin@12345");
    const [err, setErr] = useState(null);
    const [loading, setLoading] = useState(false);
    const { setTokens } = useAuth();
    const nav = useNavigate();
    async function submit(e) {
        e.preventDefault();
        setErr(null);
        setLoading(true);
        try {
            const res = await api("/api/v1/auth/login", {
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
        }
        catch (e) {
            setErr(e.message ?? "Login failed");
        }
        finally {
            setLoading(false);
        }
    }
    return (_jsx("div", { className: "min-h-full grid place-items-center bg-bg p-6", children: _jsxs("form", { onSubmit: submit, className: "card p-8 w-full max-w-sm space-y-4", children: [_jsxs("div", { children: [_jsx("h1", { className: "h1", children: "Sign in" }), _jsx("p", { className: "text-sm text-muted", children: "PGDP \u2014 enterprise governance & delivery." })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Email" }), _jsx("input", { className: "input", value: email, onChange: (e) => setEmail(e.target.value), type: "email", required: true })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Password" }), _jsx("input", { className: "input", value: password, onChange: (e) => setPassword(e.target.value), type: "password", required: true })] }), err && _jsx("div", { className: "text-danger text-sm", children: err }), _jsx("button", { className: "btn-primary w-full justify-center", disabled: loading, children: loading ? "Signing in…" : "Sign in" })] }) }));
}
