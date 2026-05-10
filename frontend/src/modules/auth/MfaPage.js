import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
export function MfaPage() {
    const [code, setCode] = useState("");
    const [err, setErr] = useState(null);
    const { setTokens } = useAuth();
    const nav = useNavigate();
    async function submit(e) {
        e.preventDefault();
        setErr(null);
        try {
            const ch = sessionStorage.getItem("mfa_challenge");
            const res = await api("/api/v1/auth/mfa/verify", {
                method: "POST",
                body: JSON.stringify({ mfa_challenge: ch, code }),
            });
            setTokens(res.access_token, res.refresh_token);
            sessionStorage.removeItem("mfa_challenge");
            nav("/dashboard");
        }
        catch (e) {
            setErr(e.message ?? "Verification failed");
        }
    }
    return (_jsx("div", { className: "min-h-full grid place-items-center p-6", children: _jsxs("form", { onSubmit: submit, className: "card p-8 w-full max-w-sm space-y-4", children: [_jsx("h1", { className: "h1", children: "Two-factor" }), _jsx("p", { className: "text-sm text-muted", children: "Enter the 6-digit code from your authenticator app." }), _jsx("input", { className: "input tracking-[0.5em] text-center text-lg", value: code, onChange: (e) => setCode(e.target.value), inputMode: "numeric", maxLength: 6 }), err && _jsx("div", { className: "text-danger text-sm", children: err }), _jsx("button", { className: "btn-primary w-full justify-center", children: "Verify" })] }) }));
}
