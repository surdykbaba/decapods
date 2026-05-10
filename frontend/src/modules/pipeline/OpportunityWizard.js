import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Pill } from "@/components/ui";
import { api } from "@/lib/api";
const STEPS = ["Client", "Scope", "Commercials", "Compliance", "Review"];
export function OpportunityWizard() {
    const [step, setStep] = useState(0);
    const [form, setForm] = useState({
        title: "", lead_type: "private", estimated_value: 0, budget: 0,
        priority: 3, risk_level: "medium", technical_scope: "", proposal_summary: "",
        expected_manpower: 0, dependencies: [], compliance_tags: [],
    });
    const [err, setErr] = useState(null);
    const nav = useNavigate();
    function set(k, v) {
        setForm((f) => ({ ...f, [k]: v }));
    }
    async function submit() {
        setErr(null);
        try {
            const res = await api("/api/v1/opportunities", {
                method: "POST", body: JSON.stringify({ ...form, client_id: "00000000-0000-0000-0000-000000000000" }),
            });
            nav(`/pipeline/${res.id}`);
        }
        catch (e) {
            setErr(e.message);
        }
    }
    return (_jsxs("div", { className: "grid grid-cols-12 gap-6", children: [_jsxs("aside", { className: "col-span-3 card p-4 h-fit sticky top-0", children: [_jsx("h2", { className: "h2 mb-4", children: "New opportunity" }), _jsx("ol", { className: "space-y-2", children: STEPS.map((s, i) => (_jsxs("li", { className: `flex items-center gap-2 text-sm ${i === step ? "text-text" : "text-muted"}`, children: [_jsx("span", { className: `w-6 h-6 rounded-full grid place-items-center text-xs border ${i === step ? "border-accent text-accent" : "border-border"}`, children: i + 1 }), s] }, s))) })] }), _jsxs("main", { className: "col-span-9 space-y-6", children: [_jsxs(Card, { title: STEPS[step], children: [step === 0 && (_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "label", children: "Project title" }), _jsx("input", { className: "input", value: form.title, onChange: (e) => set("title", e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Lead type" }), _jsxs("select", { className: "input", value: form.lead_type, onChange: (e) => set("lead_type", e.target.value), children: [_jsx("option", { value: "government", children: "Government" }), _jsx("option", { value: "private", children: "Private" }), _jsx("option", { value: "foreign", children: "Foreign" }), _jsx("option", { value: "ngo", children: "NGO" }), _jsx("option", { value: "internal", children: "Internal" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Source" }), _jsx("input", { className: "input", value: form.source ?? "", onChange: (e) => set("source", e.target.value) })] })] })), step === 1 && (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "label", children: "Technical scope" }), _jsx("textarea", { className: "input min-h-[120px]", value: form.technical_scope, onChange: (e) => set("technical_scope", e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Proposal summary" }), _jsx("textarea", { className: "input min-h-[120px]", value: form.proposal_summary, onChange: (e) => set("proposal_summary", e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Expected manpower" }), _jsx("input", { className: "input", type: "number", value: form.expected_manpower, onChange: (e) => set("expected_manpower", +e.target.value) })] })] })), step === 2 && (_jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "label", children: "Estimated value (USD)" }), _jsx("input", { className: "input", type: "number", value: form.estimated_value, onChange: (e) => set("estimated_value", +e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Budget (USD)" }), _jsx("input", { className: "input", type: "number", value: form.budget, onChange: (e) => set("budget", +e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "label", children: "Priority (1-5)" }), _jsx("input", { className: "input", type: "number", min: 1, max: 5, value: form.priority, onChange: (e) => set("priority", +e.target.value) })] })] })), step === 3 && (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "label", children: "Risk level" }), _jsxs("select", { className: "input", value: form.risk_level, onChange: (e) => set("risk_level", e.target.value), children: [_jsx("option", { value: "low", children: "Low" }), _jsx("option", { value: "medium", children: "Medium" }), _jsx("option", { value: "high", children: "High" })] })] }), _jsx("div", { className: "text-sm text-muted", children: "Documents (NDA, RFP, contracts, etc.) are uploaded after creation; the governance engine will block submission until all required documents are attached for the selected lead type." })] })), step === 4 && (_jsxs("div", { className: "space-y-3 text-sm", children: [_jsx(Pill, { tone: "info", children: "Review" }), _jsx("pre", { className: "text-xs bg-bg p-3 rounded-lg border border-border overflow-auto", children: JSON.stringify(form, null, 2) }), err && _jsx("div", { className: "text-danger", children: err })] }))] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("button", { className: "btn-ghost", onClick: () => setStep(Math.max(0, step - 1)), disabled: step === 0, children: "Back" }), step < STEPS.length - 1 ? (_jsx("button", { className: "btn-primary", onClick: () => setStep(step + 1), children: "Continue" })) : (_jsx("button", { className: "btn-primary", onClick: submit, children: "Create draft" }))] })] })] }));
}
