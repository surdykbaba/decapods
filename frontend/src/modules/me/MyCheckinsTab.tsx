// MyCheckinsTab — personal history of the calling user's daily check-ins.
// Lives inside My Accubin so each staff member can see their own mood
// trend, streaks, attachment archive and what they shipped, day by day.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, AlertCircle, Link2, CheckCircle2, Flame, Smile, ListChecks, Activity, Pencil, Plus, X, Trash2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

type Attachment = { kind: "link" | "file"; name: string; url: string };

type Row = {
  day: string;
  mood?: string | null;
  focus_note?: string | null;
  yesterday_note?: string | null;
  attachments?: Attachment[];
  posted_to_campfire?: boolean;
  missed: boolean;
  tasks_done: number;
};

type Resp = {
  items: Row[];
  from: string;
  days: number;
  insights: {
    done: number;
    missed: number;
    tasks_done: number;
    mood_counts: Record<string, number>;
  };
};

function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function MyCheckinsTab() {
  const [windowDays, setWindowDays] = useState(30);
  const [editingDay, setEditingDay] = useState<Row | null>(null);
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["me", "daily-checkins", windowDays],
    queryFn: () => api(`/api/v1/me/daily-checkins?days=${windowDays}`),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const items = data?.items ?? [];
  const insights = data?.insights;

  // 14 days back is the server-side window for editing. Compute on the
  // client so the Edit button is only rendered for rows we'd be allowed
  // to save (no point teasing a button that 400s).
  const isEditable = (day: string): boolean => {
    const d = new Date(day + "T00:00:00").getTime();
    const ageDays = (Date.now() - d) / 86_400_000;
    return ageDays >= 0 && ageDays <= 14;
  };

  // Current streak — consecutive days from today backwards that are NOT
  // missed. items[0] is today.
  const streak = useMemo(() => {
    let n = 0;
    for (const r of items) {
      if (r.missed) break;
      n++;
    }
    return n;
  }, [items]);

  const compliancePct = useMemo(() => {
    if (!insights) return 0;
    const t = insights.done + insights.missed;
    return t === 0 ? 0 : Math.round((insights.done / t) * 100);
  }, [insights]);

  const topMood = useMemo(() => {
    if (!insights?.mood_counts) return null;
    const entries = Object.entries(insights.mood_counts);
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b[1] - a[1])[0];
  }, [insights]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="h2 flex items-center gap-2">
            <CalendarDays size={18} className="text-accent" /> My check-ins
          </h2>
          <p className="text-sm text-muted mt-1">
            Your morning huddle history — mood, what you shipped, what's next, all in one place.
          </p>
        </div>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(parseInt(e.target.value, 10))}
          className="input max-w-[180px]"
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 6 months</option>
        </select>
      </div>

      {/* Insight strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          icon={<Flame size={14} />}
          tone={streak >= 5 ? "good" : streak > 0 ? "warn" : "bad"}
          label="Current streak"
          value={`${streak}d`}
          sub={streak >= 5 ? "Keep it going" : streak > 0 ? "Stay on it" : "Check in today"}
        />
        <Tile
          icon={<Activity size={14} />}
          tone={compliancePct >= 80 ? "good" : compliancePct >= 50 ? "warn" : "bad"}
          label="Compliance"
          value={`${compliancePct}%`}
          sub={`${insights?.done ?? 0} done · ${insights?.missed ?? 0} missed`}
        />
        <Tile
          icon={<Smile size={14} />}
          tone="info"
          label="Most logged mood"
          value={topMood ? topMood[0] : "—"}
          sub={topMood ? `${topMood[1]} day${topMood[1] === 1 ? "" : "s"}` : "No moods logged yet"}
        />
        <Tile
          icon={<ListChecks size={14} />}
          tone="good"
          label="Tasks shipped"
          value={String(insights?.tasks_done ?? 0)}
          sub="In this window"
        />
      </div>

      {/* Timeline */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <CalendarDays size={14} className="text-accent" />
          <div className="text-sm font-bold text-text">Timeline</div>
          <span className="text-[11px] text-muted ml-auto">From {data?.from ?? "—"}</span>
        </header>
        {isLoading ? (
          <div className="p-10 text-center text-muted text-sm">Loading…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-muted text-sm">No history yet — your first check-in lands here tomorrow.</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((r) => (
              <li key={r.day} className={`px-5 py-3 ${r.missed ? "bg-danger/5" : ""}`}>
                <div className="flex items-start gap-4">
                  <div className="w-[120px] shrink-0">
                    <div className="text-[13px] font-bold text-text">{fmtDay(r.day)}</div>
                    <div className="text-[10.5px] text-muted/80 mt-0.5">{r.day}</div>
                    <div className="mt-2 text-[18px] leading-none">
                      {r.missed
                        ? <span className="text-[11px] text-danger font-semibold inline-flex items-center gap-1"><AlertCircle size={11} /> Missed</span>
                        : (r.mood || <span className="text-muted text-xs">No mood</span>)}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Yesterday</div>
                      <div className="text-[13px] text-text whitespace-pre-wrap leading-snug">
                        {r.yesterday_note || <span className="text-muted">—</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">Today</div>
                      <div className="text-[13px] text-text whitespace-pre-wrap leading-snug">
                        {r.focus_note || <span className="text-muted">—</span>}
                      </div>
                      {r.posted_to_campfire && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] text-accent mt-1.5">
                          <CheckCircle2 size={10} /> Shared to Campfire
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="w-[180px] shrink-0 space-y-2">
                    {r.tasks_done > 0 && (
                      <div className="inline-flex items-center gap-1 text-[12px] text-success font-semibold">
                        <ListChecks size={12} /> {r.tasks_done} shipped
                      </div>
                    )}
                    {(r.attachments?.length ?? 0) > 0 && (
                      <ul className="space-y-1">
                        {r.attachments!.map((a, i) => (
                          <li key={i}>
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline max-w-[180px] truncate"
                              title={a.url}
                            >
                              <Link2 size={10} /> {a.name}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {isEditable(r.day) && (
                      <button
                        type="button"
                        onClick={() => setEditingDay(r)}
                        className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent hover:underline"
                        title={r.missed ? "Back-fill this missed check-in" : "Add to this check-in"}
                      >
                        {r.missed ? <Plus size={11} /> : <Pencil size={11} />}
                        {r.missed ? "Back-fill" : "Add / edit"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editingDay && (
        <CheckinEditor
          row={editingDay}
          onClose={() => setEditingDay(null)}
        />
      )}
    </div>
  );
}

function CheckinEditor({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const isToday = row.day === new Date().toISOString().slice(0, 10);
  const [mood, setMood] = useState(row.mood ?? "");
  const [yesterday, setYesterday] = useState(row.yesterday_note ?? "");
  const [focus, setFocus] = useState(row.focus_note ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(row.attachments ?? []);
  const [linkDraft, setLinkDraft] = useState("");

  // Defensive: if the parent re-renders the same day, sync local state.
  useEffect(() => {
    setMood(row.mood ?? "");
    setYesterday(row.yesterday_note ?? "");
    setFocus(row.focus_note ?? "");
    setAttachments(row.attachments ?? []);
  }, [row.day]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api("/api/v1/me/huddle", {
      method: "POST",
      body: JSON.stringify({
        day: row.day,
        mood,
        focus_note: focus.trim(),
        yesterday_note: yesterday.trim(),
        attachments,
        post_to_campfire: false, // back-fills never blast Campfire
      }),
    }),
    onSuccess: () => {
      toast.success("Check-in updated", `Saved for ${row.day}.`);
      qc.invalidateQueries({ queryKey: ["me", "daily-checkins"] });
      qc.invalidateQueries({ queryKey: ["me-huddle"] });
      onClose();
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  function addLink() {
    const raw = linkDraft.trim();
    if (!raw) return;
    let name = raw;
    try { name = new URL(raw).hostname || raw; } catch { /* keep raw */ }
    setAttachments((p) => [...p, { kind: "link", name, url: raw }]);
    setLinkDraft("");
  }
  function removeAttachment(i: number) {
    setAttachments((p) => p.filter((_, idx) => idx !== i));
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-accent">
              {isToday ? "Edit today's check-in" : `Back-fill ${fmtDay(row.day)}`}
            </div>
            <h3 className="text-base font-bold text-text leading-tight">{fmtDay(row.day)}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg text-muted hover:text-text"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <div className="text-sm font-semibold text-text mb-2">Mood</div>
            <div className="flex items-center gap-1.5">
              {["😄", "🙂", "😐", "😕", "😩"].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMood(m)}
                  className={`px-2.5 py-2 rounded-lg text-lg border transition-all ${
                    mood === m
                      ? "border-accent bg-accent-soft scale-110"
                      : "border-transparent hover:border-border hover:bg-bg"
                  }`}
                >
                  {m}
                </button>
              ))}
              {mood && (
                <button
                  type="button"
                  onClick={() => setMood("")}
                  className="text-[11px] text-muted hover:text-text ml-1"
                  title="Clear mood"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold text-text mb-2">Yesterday — what shipped</div>
            <textarea
              value={yesterday}
              onChange={(e) => setYesterday(e.target.value)}
              rows={3}
              className="input w-full resize-none"
              placeholder="What did you finish, hand off, or get stuck on?"
            />
          </div>

          <div>
            <div className="text-sm font-semibold text-text mb-2">{isToday ? "Today — what's on" : "That day — what you were on"}</div>
            <textarea
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={4}
              className="input w-full resize-none"
              placeholder="One or two things you were owning."
            />
          </div>

          <div>
            <div className="text-sm font-semibold text-text mb-2 flex items-center gap-1.5">
              <Link2 size={12} className="text-muted" /> Attachments
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={linkDraft}
                onChange={(e) => setLinkDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
                placeholder="https://…"
                className="input flex-1 text-sm"
              />
              <button
                type="button"
                onClick={addLink}
                disabled={!linkDraft.trim()}
                className="text-sm font-semibold px-3 py-2 rounded-lg bg-bg border border-border hover:border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed text-text"
              >
                Add
              </button>
            </div>
            {attachments.length > 0 && (
              <ul className="mt-2 space-y-1">
                {attachments.map((a, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12.5px] bg-bg/60 border border-border rounded-lg px-2.5 py-1.5">
                    <Link2 size={11} className="text-muted shrink-0" />
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline truncate flex-1"
                      title={a.url}
                    >
                      {a.name}
                    </a>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="text-muted hover:text-danger p-1"
                      aria-label="Remove"
                    >
                      <Trash2 size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || (!mood && !focus.trim() && !yesterday.trim())}
            className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            {save.isPending ? "Saving…" : isToday ? "Save check-in" : "Save back-fill"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Tile({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "info";
}) {
  const bubble = {
    good: "bg-success/10 text-success",
    warn: "bg-warn/10 text-warn",
    bad:  "bg-danger/10 text-danger",
    info: "bg-accent-soft text-accent",
  }[tone];
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${bubble}`}>
          {icon}
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted">{label}</span>
      </div>
      <div className="text-[1.5rem] font-extrabold text-text leading-none">{value}</div>
      <div className="text-[11.5px] text-muted leading-snug">{sub}</div>
    </div>
  );
}
