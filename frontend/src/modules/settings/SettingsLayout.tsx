import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch, Wallet, ShieldCheck, Github, Users, FileSearch, SlidersHorizontal,
  Building2, Bell, Archive, Check,
} from "lucide-react";
import { api } from "@/lib/api";
import { SUPPORTED_CURRENCIES, FALLBACK_CURRENCY } from "@/lib/currency";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";

type Section = {
  group: string;
  items: { to: string; label: string; icon: React.ComponentType<any>; description?: string }[];
};

const SECTIONS: Section[] = [
  {
    group: "Workspace",
    items: [
      { to: "/settings",            label: "General",      icon: SlidersHorizontal, description: "Tenant, branding, and basics" },
      { to: "/settings/members",    label: "Members & roles", icon: Users,          description: "Who can do what" },
      { to: "/settings/notifications", label: "Notifications", icon: Bell,         description: "Channels and rules" },
    ],
  },
  {
    group: "Delivery & finance",
    items: [
      { to: "/settings/workflow",   label: "Approval workflow", icon: GitBranch,    description: "Stages and role gates" },
      { to: "/settings/team-rates", label: "Team rates",        icon: Wallet,       description: "Internal & external daily rates" },
    ],
  },
  {
    group: "Governance",
    items: [
      { to: "/settings/governance", label: "Policies",     icon: ShieldCheck, description: "Custom governance rules" },
      { to: "/settings/audit",      label: "Audit log",    icon: FileSearch,  description: "Recent system activity" },
      { to: "/settings/archived-projects", label: "Archived projects", icon: Archive, description: "Restore soft-deleted projects (super-admin only)" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { to: "/settings/integrations/github", label: "GitHub",       icon: Github,    description: "Link repos and webhooks" },
    ],
  },
];

export function SettingsLayout() {
  return (
    <div className="space-y-6">
      <header>
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-muted font-semibold mb-2">
          <Building2 size={13} /> Settings
        </div>
        <h1 className="h1">Workspace settings</h1>
        <p className="text-sm text-muted mt-1">Configure governance, approvals, integrations and people.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        <aside className="space-y-5">
          {SECTIONS.map((s) => (
            <div key={s.group}>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2 px-1">
                {s.group}
              </div>
              <nav className="space-y-1">
                {s.items.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === "/settings"}
                    className={({ isActive }) =>
                      `flex items-start gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                        isActive
                          ? "bg-accent-soft text-accent"
                          : "text-text hover:bg-surface"
                      }`
                    }
                  >
                    <it.icon size={16} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold leading-tight">{it.label}</div>
                      {it.description && (
                        <div className="text-[11px] text-muted leading-tight mt-0.5">{it.description}</div>
                      )}
                    </div>
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}
        </aside>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function SettingsGeneralPage() {
  return (
    <div className="space-y-4">
      <CurrencyCard />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ShortcutCard label="Approval workflow" body="Define stages and which roles can approve / reject." to="/settings/workflow" />
        <ShortcutCard label="Team rates" body="Internal and external daily rates used for budgeting." to="/settings/team-rates" />
        <ShortcutCard label="Governance policies" body="Custom rules layered on top of the built-in engine." to="/settings/governance" />
        <ShortcutCard label="GitHub integration" body="Link repositories so deliverables track real code." to="/settings/integrations/github" />
      </div>
    </div>
  );
}

function CurrencyCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ default_currency: string }>({
    queryKey: ["settings-general"],
    queryFn: () => api("/api/v1/settings/general"),
  });
  const [draft, setDraft] = useState<string>(FALLBACK_CURRENCY);
  useEffect(() => {
    if (data?.default_currency) setDraft(data.default_currency);
  }, [data?.default_currency]);

  const save = useMutation({
    mutationFn: (ccy: string) =>
      api("/api/v1/settings/general", {
        method: "PUT",
        body: JSON.stringify({ default_currency: ccy }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-general"] });
      toast.success("Default currency updated");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save currency"),
  });

  const dirty = draft !== (data?.default_currency ?? FALLBACK_CURRENCY);

  return (
    <div className="bg-surface border border-border rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="h2 mb-1">General</h2>
          <p className="text-sm text-muted">
            Tenant-wide preferences. Pick the default currency used for budgets, rates, invoices and KPIs.
          </p>
        </div>
        <SmartButton
          variant="primary"
          disabled={!dirty}
          loadingLabel="Saving…"
          icon={<Check size={14} />}
          onClick={() => save.mutateAsync(draft)}
        >
          Save
        </SmartButton>
      </div>

      <label className="block mt-5">
        <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1.5">
          Default currency
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {SUPPORTED_CURRENCIES.map((c) => {
            const active = draft === c.code;
            return (
              <button
                key={c.code}
                type="button"
                onClick={() => setDraft(c.code)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border hover:bg-bg text-text"
                }`}
              >
                <span className={`w-9 h-9 grid place-items-center rounded-lg font-bold text-base shrink-0 ${
                  active ? "bg-accent text-white" : "bg-bg text-text"
                }`}>{c.symbol}</span>
                <span className="min-w-0">
                  <div className="text-sm font-semibold leading-tight">{c.code}</div>
                  <div className="text-[11px] text-muted truncate">{c.label}</div>
                </span>
              </button>
            );
          })}
        </div>
        {isLoading && <div className="text-xs text-muted mt-2">Loading current setting…</div>}
      </label>
    </div>
  );
}

export function SettingsMembersStub() {
  return (
    <div className="bg-surface border border-border rounded-2xl p-8 text-center">
      <Users size={28} className="mx-auto text-muted mb-3" />
      <h2 className="text-lg font-bold text-text">Members & roles</h2>
      <p className="text-sm text-muted mt-1">
        Member management UI is coming soon. Roles are seeded per-tenant and can be assigned via the API in the meantime.
      </p>
    </div>
  );
}

export function SettingsNotificationsStub() {
  return (
    <div className="bg-surface border border-border rounded-2xl p-8 text-center">
      <Bell size={28} className="mx-auto text-muted mb-3" />
      <h2 className="text-lg font-bold text-text">Notifications</h2>
      <p className="text-sm text-muted mt-1">
        Email and in-app notification rules will configure here. Today, every governance event is fan-out via the
        WebSocket channel for active sessions.
      </p>
    </div>
  );
}

import { Link } from "react-router-dom";

function ShortcutCard({ label, body, to }: { label: string; body: string; to: string }) {
  return (
    <Link
      to={to}
      className="bg-surface border border-border rounded-2xl p-5 hover:border-accent/60 hover:shadow-card transition-all"
    >
      <div className="font-bold text-text">{label}</div>
      <div className="text-sm text-muted mt-1">{body}</div>
      <div className="text-xs text-accent mt-3 font-semibold">Open →</div>
    </Link>
  );
}
