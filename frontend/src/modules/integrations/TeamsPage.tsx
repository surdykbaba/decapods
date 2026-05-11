// TeamsPage — Settings → Integrations → Microsoft Teams.
//
// Manages outgoing webhook subscriptions per Teams channel. The "Test" button
// fires a probe Adaptive Card to confirm the URL is wired before relying on
// it for real events.
//
// To get a webhook URL: in Teams, open the target channel → Connectors →
// Incoming Webhook → Configure → name + icon → Create → copy URL.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import {
  MessageSquare, Plus, Trash2, Send, Power, ExternalLink, CheckCircle2, AlertTriangle,
} from "lucide-react";

type Webhook = {
  id: string;
  name: string;
  url: string;
  categories: string[];
  min_severity: "info" | "warn" | "critical";
  active: boolean;
  created_at?: string;
};

type CategoryOption = { value: string; label: string };

type Resp = { webhooks: Webhook[]; categories: CategoryOption[] };

const SEVERITY_OPTIONS: { value: Webhook["min_severity"]; label: string; hint: string }[] = [
  { value: "info",     label: "All events",        hint: "Info, warn and critical alerts" },
  { value: "warn",     label: "Warn & critical",   hint: "Skip routine info pings" },
  { value: "critical", label: "Critical only",     hint: "Just the can't-ignore ones" },
];

const blankWebhook = (): Webhook => ({
  id: "",
  name: "",
  url: "",
  categories: [],
  min_severity: "info",
  active: true,
});

export function TeamsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<Resp>({
    queryKey: ["settings", "teams"],
    queryFn: () => api("/api/v1/settings/teams"),
  });

  // Local working copy so the admin can stage multiple edits and Save once.
  const [hooks, setHooks] = useState<Webhook[]>([]);
  useEffect(() => { if (data) setHooks(data.webhooks ?? []); }, [data]);

  const categories: CategoryOption[] = data?.categories ?? [];

  const save = useMutation({
    mutationFn: (next: Webhook[]) =>
      api<{ webhooks: Webhook[] }>("/api/v1/settings/teams", {
        method: "PUT",
        body: JSON.stringify({ webhooks: next }),
      }),
    onSuccess: (resp) => {
      qc.setQueryData<Resp>(["settings", "teams"], (prev) => ({
        webhooks: resp.webhooks,
        categories: prev?.categories ?? [],
      }));
      setHooks(resp.webhooks);
      toast.success("Saved", "Teams subscriptions updated.");
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/settings/teams/test/${id}`, { method: "POST" }),
    onSuccess: () => toast.success("Test sent", "Check the channel — a probe card should land there."),
    onError: (e: any) => toast.error("Test failed", e?.message ?? "Webhook returned an error."),
  });

  function update(idx: number, patch: Partial<Webhook>) {
    setHooks((cur) => cur.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  }
  function add() {
    setHooks((cur) => [...cur, blankWebhook()]);
  }
  function remove(idx: number) {
    setHooks((cur) => cur.filter((_, i) => i !== idx));
  }
  function toggleCategory(idx: number, cat: string) {
    setHooks((cur) => cur.map((w, i) => {
      if (i !== idx) return w;
      const has = w.categories.includes(cat);
      return { ...w, categories: has ? w.categories.filter((c) => c !== cat) : [...w.categories, cat] };
    }));
  }

  // Dirty when local diverges from server. Cheap deep compare on a small list.
  const dirty = JSON.stringify(hooks) !== JSON.stringify(data?.webhooks ?? []);

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <MessageSquare size={18} className="text-accent" />
          <h2 className="h2">Microsoft Teams</h2>
        </div>
        <p className="text-sm text-muted">
          Send D'Accubin events into Teams channels. Each subscription is a single
          channel's Incoming Webhook URL plus filters for which event categories
          and severities should land there.
        </p>
      </div>

      {/* How-to */}
      <details className="bg-surface border border-border rounded-2xl">
        <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-text inline-flex items-center gap-2">
          <ExternalLink size={13} className="text-accent" /> How to get a webhook URL
        </summary>
        <ol className="px-5 pb-4 text-[13px] text-muted space-y-1.5 list-decimal pl-9">
          <li>In Teams, open the channel you want events posted to.</li>
          <li>Click the <strong>…</strong> menu next to the channel name → <strong>Connectors</strong>.</li>
          <li>Search for <strong>Incoming Webhook</strong> → <strong>Configure</strong>.</li>
          <li>Give it a name (e.g. <em>D'Accubin</em>) and optionally upload the brand logo.</li>
          <li>Click <strong>Create</strong> → copy the URL it shows.</li>
          <li>Paste the URL into a webhook row below and hit Save.</li>
        </ol>
      </details>

      {/* Webhook rows */}
      <div className="space-y-3">
        {hooks.length === 0 && (
          <div className="bg-surface border border-border rounded-2xl p-8 text-center text-sm text-muted">
            No subscriptions yet. Add one to start posting events into a Teams channel.
          </div>
        )}
        {hooks.map((w, i) => (
          <div key={w.id || i} className="bg-surface border border-border rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update(i, { active: !w.active })}
                  className={`p-1.5 rounded-lg transition-colors ${
                    w.active ? "bg-success/10 text-success" : "bg-bg text-muted hover:text-text"
                  }`}
                  title={w.active ? "Subscription is active" : "Subscription is paused"}
                >
                  <Power size={14} />
                </button>
                <input
                  className="input !py-1.5 text-[13px] font-semibold"
                  value={w.name}
                  placeholder="Channel label (e.g. Delivery announcements)"
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </div>
              <div className="flex items-center gap-1.5">
                {w.id && (
                  <SmartButton
                    variant="primary"
                    icon={<Send size={13} />}
                    onClick={() => test.mutateAsync(w.id)}
                    disabled={test.isPending || !w.url}
                    loadingLabel="Sending…"
                    successLabel="Sent"
                  >
                    Test
                  </SmartButton>
                )}
                <button
                  onClick={() => remove(i)}
                  className="p-2 rounded-lg text-muted hover:text-danger hover:bg-bg"
                  title="Remove subscription"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <label className="block">
              <div className="text-[11px] text-muted font-medium mb-1">Incoming Webhook URL</div>
              <input
                className="input font-mono text-[12px]"
                value={w.url}
                placeholder="https://*.webhook.office.com/webhookb2/…"
                onChange={(e) => update(i, { url: e.target.value })}
              />
              {w.url && !isLikelyTeamsURL(w.url) && (
                <div className="mt-1.5 text-[11.5px] text-warn inline-flex items-center gap-1.5">
                  <AlertTriangle size={11} />
                  That doesn't look like a Microsoft host. Double-check it's an Incoming Webhook URL.
                </div>
              )}
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <div className="text-[11px] text-muted font-medium mb-1">Minimum severity</div>
                <select
                  className="input"
                  value={w.min_severity}
                  onChange={(e) => update(i, { min_severity: e.target.value as Webhook["min_severity"] })}
                >
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>
                  ))}
                </select>
              </label>

              <div>
                <div className="text-[11px] text-muted font-medium mb-1">
                  Categories {w.categories.length === 0 && <span className="text-accent">· all</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((c) => {
                    const on = w.categories.includes(c.value);
                    return (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => toggleCategory(i, c.value)}
                        className={`px-2.5 py-1 rounded-full text-[11.5px] font-semibold border transition-colors ${
                          on
                            ? "bg-accent text-white border-accent"
                            : "bg-bg text-muted border-border hover:border-accent/40 hover:text-text"
                        }`}
                      >
                        {on && <CheckCircle2 size={10} className="inline mr-1 -mt-0.5" />}
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                <div className="text-[11px] text-muted mt-1.5">
                  No selection = post every category. Pick specific ones to keep a channel focused.
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          onClick={add}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
        >
          <Plus size={14} /> Add another channel
        </button>
        <div className="flex items-center gap-3">
          {!dirty && <span className="text-xs text-muted">No changes</span>}
          <SmartButton
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutateAsync(hooks)}
            loadingLabel="Saving…"
            successLabel="Saved"
          >
            Save subscriptions
          </SmartButton>
        </div>
      </div>
    </div>
  );
}

// Quick client-side heuristic mirrors the server's validator — the server is
// still the source of truth, but flagging this early saves a round trip.
function isLikelyTeamsURL(url: string): boolean {
  const low = url.toLowerCase();
  if (!low.startsWith("https://")) return false;
  return (
    low.includes("webhook.office.com") ||
    low.includes("outlook.office.com") ||
    low.includes("outlook.office365.com") ||
    low.includes("logic.azure.com")
  );
}
