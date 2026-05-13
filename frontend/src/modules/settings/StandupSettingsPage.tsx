// StandupSettingsPage — admin-only tenant settings for the daily standup
// nudge card on My Work → Today.
//
// Three values live here:
//   • standup_at — HH:MM (24h). The "official" time the team meets.
//   • window_before_min — minutes BEFORE standup_at that the card
//     surfaces the nudge + late-status buttons. Default 30.
//   • window_after_min — minutes AFTER standup_at that the late-status
//     buttons remain live. Default 60.
//
// Outside the configured window the SPA still renders a quiet
// "Next standup at HH:MM" hint so the widget never disappears entirely.
//
// Mirrored by handlers/standup_settings.go on the backend.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Clock, ArrowLeftRight } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";

type StandupSettings = {
  standup_at: string;          // "HH:MM"
  window_before_min: number;   // 0..240
  window_after_min: number;    // 0..240
};

const DEFAULTS: StandupSettings = {
  standup_at: "09:30",
  window_before_min: 30,
  window_after_min: 60,
};

export function StandupSettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<StandupSettings>({
    queryKey: ["settings", "standup"],
    queryFn: () => api("/api/v1/settings/standup"),
  });
  const [form, setForm] = useState<StandupSettings>(DEFAULTS);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api<StandupSettings>("/api/v1/settings/standup", {
        method: "PUT",
        body: JSON.stringify(form),
      }),
    onSuccess: (saved) => {
      toast.success("Standup settings saved", "The card on My Work will pick this up on next refresh.");
      qc.setQueryData(["settings", "standup"], saved);
      // Bust /me/huddle so the live preview updates without a hard reload.
      qc.invalidateQueries({ queryKey: ["me-huddle"] });
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  function set<K extends keyof StandupSettings>(key: K, v: StandupSettings[K]) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  // Live preview of the window. "09:00 – 10:30" makes the time-range concrete
  // so an admin doesn't have to do the arithmetic in their head.
  const previewWindow = (() => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(form.standup_at);
    if (!m) return null;
    const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    function fmt(total: number) {
      total = ((total % 1440) + 1440) % 1440;
      const h = Math.floor(total / 60);
      const mm = total % 60;
      return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    return `${fmt(mins - form.window_before_min)} – ${fmt(mins + form.window_after_min)}`;
  })();

  if (isLoading) return <div className="text-muted">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Workspace</div>
        <h1 className="h1 mt-1 flex items-center gap-2"><Bell size={22} className="text-accent" /> Standup</h1>
        <p className="text-sm text-muted mt-1">
          The card on My Work nudges your team to check in before standup and gives them one-tap
          buttons to broadcast "on my way / late / can't make it." Tune when it's live below.
        </p>
      </header>

      {/* Standup time */}
      <section className="bg-surface border border-border rounded-2xl p-5 space-y-3">
        <h2 className="h2 flex items-center gap-2"><Clock size={16} className="text-accent" /> Standup time</h2>
        <p className="text-[12.5px] text-muted">
          The official start. Used as the anchor for "Standup in 12m" and the late-status broadcasters.
        </p>
        <input
          type="time"
          value={form.standup_at}
          onChange={(e) => set("standup_at", e.target.value)}
          className="input max-w-[140px] text-base font-bold"
        />
      </section>

      {/* Visibility window */}
      <section className="bg-surface border border-border rounded-2xl p-5 space-y-3">
        <h2 className="h2 flex items-center gap-2"><ArrowLeftRight size={16} className="text-accent" /> Visibility window</h2>
        <p className="text-[12.5px] text-muted">
          How long before / after standup the card stays in its "live" state with the late-status buttons.
          Outside this window it still shows a quiet "Next standup at HH:MM" hint — never disappears.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Minutes before</div>
            <input
              type="number" min={0} max={240} step={5}
              value={form.window_before_min}
              onChange={(e) => set("window_before_min", Math.max(0, Math.min(240, parseInt(e.target.value, 10) || 0)))}
              className="input"
            />
            <div className="text-[11px] text-muted mt-1">Default 30. Card goes live this many minutes early.</div>
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Minutes after</div>
            <input
              type="number" min={0} max={240} step={5}
              value={form.window_after_min}
              onChange={(e) => set("window_after_min", Math.max(0, Math.min(240, parseInt(e.target.value, 10) || 0)))}
              className="input"
            />
            <div className="text-[11px] text-muted mt-1">Default 60. Late-arrivers can still post a status this long after.</div>
          </label>
        </div>
        {previewWindow && (
          <div className="bg-accent-soft text-accent border border-accent/30 rounded-xl px-3 py-2 text-[12.5px] font-semibold">
            Card will be in its "live" state from <span className="font-bold">{previewWindow}</span>.
          </div>
        )}
      </section>

      <div className="flex justify-end">
        <SmartButton
          variant="primary"
          loadingLabel="Saving…"
          onClick={() => save.mutate()}
        >
          Save settings
        </SmartButton>
      </div>
    </div>
  );
}
