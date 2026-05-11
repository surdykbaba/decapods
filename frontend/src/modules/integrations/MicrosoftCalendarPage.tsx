// MicrosoftCalendarPage — Settings → Integrations → Microsoft Calendar.
//
// Admin-only. Stores Azure AD app credentials (client_id, client_secret,
// tenant hint) so every user in the workspace can sign their personal MS
// account into D'Accubin via OAuth.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import {
  CalendarClock, ShieldCheck, Copy, ExternalLink, AlertTriangle, CheckCircle2,
} from "lucide-react";

type Resp = {
  client_id: string;
  tenant_hint: string;
  secret_stored: boolean;
  redirect_uri: string;
  configured: boolean;
};

export function MicrosoftCalendarPage() {
  const qc = useQueryClient();
  const { data } = useQuery<Resp>({
    queryKey: ["settings", "microsoft"],
    queryFn: () => api("/api/v1/settings/microsoft"),
  });

  const [clientID, setClientID] = useState("");
  const [tenantHint, setTenantHint] = useState("common");
  const [secret, setSecret] = useState(""); // blank = keep stored

  useEffect(() => {
    if (!data) return;
    setClientID(data.client_id ?? "");
    setTenantHint(data.tenant_hint || "common");
    setSecret(""); // never echo back
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api<Resp>("/api/v1/settings/microsoft", {
        method: "PUT",
        body: JSON.stringify({
          client_id: clientID.trim(),
          client_secret: secret.trim(),
          tenant_hint: tenantHint.trim(),
        }),
      }),
    onSuccess: (resp) => {
      qc.setQueryData(["settings", "microsoft"], resp);
      setSecret("");
      toast.success("Saved", resp.configured ? "Members can now connect their Microsoft account." : "Add the client ID and secret to enable connect.");
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  const dirty =
    !!data &&
    (clientID.trim() !== data.client_id ||
      tenantHint.trim() !== (data.tenant_hint || "common") ||
      secret.trim().length > 0);

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Copy failed"),
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <CalendarClock size={18} className="text-accent" />
          <h2 className="h2">Microsoft Calendar</h2>
        </div>
        <p className="text-sm text-muted">
          Connect Azure AD so every member can pull their Microsoft/Outlook
          calendar into D'Accubin. Each user signs in individually — they
          only ever see their own events. Admins paste the app credentials
          once here.
        </p>
      </div>

      {/* Status pill */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${
        data?.configured
          ? "bg-success/10 border-success/30 text-success"
          : "bg-warn/10 border-warn/30 text-warn"
      }`}>
        {data?.configured ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        <span className="text-[13px] font-semibold">
          {data?.configured ? "Configured — members can connect their Microsoft account." : "Not configured yet — credentials below are required."}
        </span>
      </div>

      {/* Setup guide */}
      <details className="bg-surface border border-border rounded-2xl" open={!data?.configured}>
        <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-text inline-flex items-center gap-2">
          <ExternalLink size={13} className="text-accent" /> One-time Azure AD app setup
        </summary>
        <ol className="px-5 pb-4 text-[13px] text-muted space-y-2 list-decimal pl-9">
          <li>
            Go to{" "}
            <a className="text-accent underline" href="https://entra.microsoft.com/" target="_blank" rel="noopener noreferrer">
              entra.microsoft.com
            </a>{" "}
            → <strong>Applications</strong> → <strong>App registrations</strong> → <strong>+ New registration</strong>.
          </li>
          <li>Name it <em>D'Accubin Calendar</em>. Supported account types: <strong>Accounts in any organizational directory (Multitenant)</strong> usually fits.</li>
          <li>
            Set the redirect URI (Web platform) to:
            <div className="mt-1 inline-flex items-center gap-2 bg-bg border border-border rounded px-2 py-1 font-mono text-[11.5px]">
              {data?.redirect_uri ?? "https://your-host/api/v1/auth/microsoft/callback"}
              {data?.redirect_uri && (
                <button onClick={() => copy(data.redirect_uri)} className="text-muted hover:text-accent" title="Copy">
                  <Copy size={11} />
                </button>
              )}
            </div>
          </li>
          <li>After registration, copy the <strong>Application (client) ID</strong> into the field below.</li>
          <li>Under <strong>Certificates & secrets</strong> → <strong>New client secret</strong>, copy the <strong>Value</strong> (not the secret ID) into the field below.</li>
          <li>Under <strong>API permissions</strong> add <strong>Microsoft Graph → Delegated permissions</strong>: <code>Calendars.Read</code>, <code>User.Read</code>, <code>offline_access</code>. Click <strong>Grant admin consent</strong>.</li>
        </ol>
      </details>

      {/* Form */}
      <section className="bg-surface border border-border rounded-2xl p-5 space-y-4">
        <label className="block">
          <div className="text-[11px] text-muted font-medium mb-1">Application (client) ID</div>
          <input
            className="input font-mono text-[12.5px]"
            value={clientID}
            onChange={(e) => setClientID(e.target.value)}
            placeholder="e.g. 12345678-1234-1234-1234-123456789abc"
          />
        </label>

        <label className="block">
          <div className="text-[11px] text-muted font-medium mb-1">
            Client secret value
            {data?.secret_stored && !secret && (
              <span className="text-success ml-1">· stored</span>
            )}
          </div>
          <input
            className="input font-mono text-[12.5px]"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={data?.secret_stored ? "Leave blank to keep the stored secret" : "Paste the secret value here"}
            autoComplete="off"
          />
          <div className="text-[11px] text-muted mt-1">
            Paste the <strong>Value</strong> shown right after you create the secret — it's only revealed once.
          </div>
        </label>

        <label className="block">
          <div className="text-[11px] text-muted font-medium mb-1">Tenant hint</div>
          {/* Always-visible text field — preset chips above just stamp common
              values into it. Previously the input was conditional on a select,
              which hid it whenever the value matched a preset, leaving admins
              with no way to paste a custom tenant ID without first clearing
              the select. */}
          <input
            className="input font-mono text-[12px]"
            value={tenantHint}
            onChange={(e) => setTenantHint(e.target.value)}
            placeholder="Tenant ID GUID, contoso.onmicrosoft.com, or common"
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {[
              { v: "common",        label: "common" },
              { v: "organizations", label: "organizations" },
              { v: "consumers",     label: "consumers" },
            ].map((p) => (
              <button
                key={p.v}
                type="button"
                onClick={() => setTenantHint(p.v)}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition ${
                  tenantHint === p.v
                    ? "bg-accent-soft text-accent border-accent/40"
                    : "bg-bg text-muted border-border hover:border-accent/30 hover:text-text"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-2 leading-snug">
            Paste your <strong>Directory (tenant) ID</strong> (Azure → App registration → Overview) for a single-tenant app.
            Use <code>common</code> only if your app is registered as multi-tenant.
          </div>
        </label>

        <div className="flex items-center justify-end gap-3 pt-1">
          {!dirty && <span className="text-xs text-muted">No changes</span>}
          <SmartButton
            variant="primary"
            disabled={!dirty || save.isPending || !clientID.trim()}
            onClick={() => save.mutateAsync()}
            loadingLabel="Saving…"
            successLabel="Saved"
          >
            Save credentials
          </SmartButton>
        </div>
      </section>

      <div className="text-[11.5px] text-muted inline-flex items-center gap-1.5">
        <ShieldCheck size={11} className="text-success" />
        Credentials are stored encrypted at rest. Each user authorises their own account; D'Accubin never sees passwords.
      </div>
    </div>
  );
}
