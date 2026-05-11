// RelationshipsPage — the merged "Stakeholders + Vendors + PR & Agents" hub.
//
// Each of the three was its own top-level menu before — same shape (people
// outside the company we work with), three sidebar slots, three contexts to
// remember which one had what. This page collapses them into a single nav
// entry with three tabs. URL state lives in ?tab=…, so deep links from
// notifications + dashboards continue to land on the right pane.
//
// The actual data + dialogs for each pane still live in their own modules —
// we just host them inside the shared tab strip here.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { UsersRound, Handshake, Network } from "lucide-react";
import { StakeholdersPage } from "@/modules/stakeholders/StakeholdersPage";
import { VendorsPage } from "@/modules/vendors/VendorsPage";
import { AgentsPage } from "@/modules/agents/AgentsPage";

type Tab = "stakeholders" | "vendors" | "agents";

const VALID: Tab[] = ["stakeholders", "vendors", "agents"];

const TABS: { key: Tab; label: string; icon: React.ComponentType<any>; hint: string }[] = [
  { key: "stakeholders", label: "Stakeholders", icon: UsersRound, hint: "Internal + external project contacts" },
  { key: "vendors",      label: "Vendors",      icon: Handshake,  hint: "Outsourced delivery partners" },
  { key: "agents",       label: "PR & Agents",  icon: Network,    hint: "Introducers, advisors, PR firms" },
];

export function RelationshipsPage() {
  const [params, setParams] = useSearchParams();
  const initial: Tab = useMemo(() => {
    const q = params.get("tab");
    return (VALID as string[]).includes(q ?? "") ? (q as Tab) : "stakeholders";
  }, []); // intentionally read once on mount

  const [tab, setTab] = useState<Tab>(initial);

  // Sync URL → state so notifications can deep-link with ?tab=vendors. Strips
  // the param when on the default tab to keep links clean.
  useEffect(() => {
    const q = params.get("tab");
    if (q !== tab) {
      const next = new URLSearchParams(params);
      if (tab === "stakeholders") next.delete("tab");
      else next.set("tab", tab);
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm text-muted max-w-2xl">
          Everyone outside the four walls of the company you work with —
          stakeholders on projects, vendors who deliver alongside you, and
          agents who introduce work. Switch panes with the tabs below.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
            >
              <t.icon size={14} /> {t.label}
            </button>
          );
        })}
      </nav>

      {/* Each pane's existing page component renders unchanged — the inner
          API filters / row-level permissions still apply, so a user who
          can't see vendors won't see anything in that tab anyway. */}
      {tab === "stakeholders" && <StakeholdersPage />}
      {tab === "vendors"      && <VendorsPage />}
      {tab === "agents"       && <AgentsPage />}
    </div>
  );
}
