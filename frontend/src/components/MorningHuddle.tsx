import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sun, Flame, Clock, AlertCircle, X, Send, Plane, ChevronRight, Link2, Paperclip, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { checkinPhrasing } from "@/lib/checkinLabels";

type HuddleTask = {
  id: string;
  title: string;
  project_id: string;
  project: string;
  due_on: string | null;
  status: string;
};

type HuddleAttachment = { kind: "link" | "file"; name: string; url: string };

type HuddleResp = {
  today: string;
  done_today: boolean;
  mood?: string;
  focus_note?: string;
  yesterday_note?: string;
  attachments?: HuddleAttachment[];
  standup_at: string;
  tasks_due_today: HuddleTask[];
  tasks_overdue: HuddleTask[];
  approvals_waiting: number;
  on_leave_today: boolean;
};

const MOODS = [
  { emoji: "😄", label: "Great" },
  { emoji: "🙂", label: "Good" },
  { emoji: "😐", label: "OK" },
  { emoji: "😕", label: "Low" },
  { emoji: "😩", label: "Rough" },
];

const SKIP_PREFIX = "morning-huddle-skipped:";

// localDayKey — return YYYY-MM-DD in the user's *local* timezone so the
// skip-for-today flag rolls over at local midnight, not UTC midnight.
function localDayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return "Burning the midnight oil";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function MorningHuddle() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mood, setMood] = useState("");
  const [focus, setFocus] = useState("");
  const [yesterday, setYesterday] = useState("");
  const [attachments, setAttachments] = useState<HuddleAttachment[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [share, setShare] = useState(true);

  const { data, isLoading } = useQuery<HuddleResp>({
    queryKey: ["me-huddle"],
    queryFn: () => api("/api/v1/me/huddle"),
    enabled: !!user,
    staleTime: 60_000,
  });

  // Auto-open exactly once per local day, the first time we get a response
  // that says the user hasn't checked in yet. Manual skip is sticky for the
  // rest of the day via localStorage.
  useEffect(() => {
    if (!data || data.done_today) return;
    if (data.on_leave_today) return; // they're off — don't nag
    const skip = localStorage.getItem(SKIP_PREFIX + localDayKey());
    if (skip) return;
    setOpen(true);
  }, [data]);

  // Hydrate the form if the user has already started a check-in today (e.g.
  // they reopen the sheet from the manual trigger after submitting).
  useEffect(() => {
    if (data?.mood)            setMood(data.mood);
    if (data?.focus_note)      setFocus(data.focus_note);
    if (data?.yesterday_note)  setYesterday(data.yesterday_note);
    if (data?.attachments)     setAttachments(data.attachments);
  }, [data?.mood, data?.focus_note, data?.yesterday_note, data?.attachments]);

  const save = useMutation({
    mutationFn: (body: {
      mood: string;
      focus_note: string;
      yesterday_note: string;
      attachments: HuddleAttachment[];
      post_to_campfire: boolean;
    }) =>
      api("/api/v1/me/huddle", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-huddle"] });
      qc.invalidateQueries({ queryKey: ["campfire-posts"] });
      toast.success("Have a great day", "Your check-in is in.");
      setOpen(false);
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  if (!open || isLoading || !data) return null;

  const firstName = (user?.name || user?.email || "there").split(/[ @]/)[0];
  const overdue = data.tasks_overdue ?? [];
  const dueToday = data.tasks_due_today ?? [];

  function dismissForToday() {
    localStorage.setItem(SKIP_PREFIX + localDayKey(), "1");
    setOpen(false);
  }

  function submit() {
    save.mutate({
      mood: mood,
      focus_note: focus.trim(),
      yesterday_note: yesterday.trim(),
      attachments,
      post_to_campfire: share && !!focus.trim(),
    });
  }

  function addLink() {
    const raw = linkDraft.trim();
    if (!raw) return;
    // Best-effort URL guard; if it's not parseable we still let it through
    // as a free-text reference because some people paste internal IDs.
    let name = raw;
    try { name = new URL(raw).hostname || raw; } catch { /* keep raw */ }
    setAttachments((prev) => [...prev, { kind: "link", name, url: raw }]);
    setLinkDraft("");
  }
  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={dismissForToday}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-5 border-b border-border flex items-start justify-between gap-3 bg-gradient-to-br from-warn/10 via-accent-soft/30 to-transparent">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-accent">
              Morning huddle · {data.today}
            </div>
            <h2 className="text-2xl font-extrabold text-text mt-1 flex items-center gap-2">
              <Sun size={22} className="text-warn" /> {greeting()}, {firstName}
            </h2>
            <p className="text-sm text-muted mt-1">
              30 seconds: how are you feeling, what's the one thing you're owning today? Standup is at{" "}
              <span className="font-semibold text-text">{data.standup_at}</span>.
            </p>
          </div>
          <button
            onClick={dismissForToday}
            className="text-muted hover:text-text p-1.5 rounded hover:bg-bg shrink-0"
            aria-label="Close"
            title="Skip for today"
          >
            <X size={16} />
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* LEFT — Day brief */}
          <div className="p-6 border-b md:border-b-0 md:border-r border-border space-y-4">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted">Your day</div>

            {data.on_leave_today && (
              <div className="rounded-xl bg-accent-soft text-accent text-sm px-3 py-2 inline-flex items-center gap-2">
                <Plane size={14} /> You're on approved leave today.
              </div>
            )}

            <Stat
              icon={<AlertCircle size={14} className="text-danger" />}
              label="Overdue tasks"
              value={overdue.length}
            />
            <Stat
              icon={<Clock size={14} className="text-warn" />}
              label="Due today"
              value={dueToday.length}
            />
            <Stat
              icon={<Flame size={14} className="text-accent" />}
              label="Approvals waiting"
              value={data.approvals_waiting}
            />

            <div className="pt-3 border-t border-border">
              <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">
                {overdue.length ? "Pick these up first" : dueToday.length ? "On your plate" : "Open the day"}
              </div>
              {overdue.length === 0 && dueToday.length === 0 ? (
                <div className="text-sm text-muted italic">
                  No tasks due. Nice place to be — maybe knock down a milestone?
                </div>
              ) : (
                <ul className="space-y-1.5 max-h-[200px] overflow-y-auto">
                  {[...overdue, ...dueToday].slice(0, 6).map((t) => (
                    <li key={t.id}>
                      <Link
                        to={`/projects/${t.project_id}`}
                        onClick={() => setOpen(false)}
                        className="flex items-center gap-2 text-sm text-text hover:bg-bg rounded-lg px-2 py-1.5 group"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${overdue.includes(t) ? "bg-danger" : "bg-warn"}`} />
                        <span className="truncate flex-1">{t.title}</span>
                        <span className="text-[11px] text-muted truncate max-w-[120px]">{t.project}</span>
                        <ChevronRight size={12} className="text-muted opacity-0 group-hover:opacity-100" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* RIGHT — Check-in form */}
          <div className="p-6 space-y-4">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted">Check in</div>

            <div>
              <div className="text-sm font-semibold text-text mb-2">How are you feeling?</div>
              <div className="flex items-center gap-1.5">
                {MOODS.map((m) => (
                  <button
                    key={m.emoji}
                    onClick={() => setMood(m.emoji)}
                    className={`px-2.5 py-2 rounded-lg text-lg border transition-all ${
                      mood === m.emoji
                        ? "border-accent bg-accent-soft scale-110"
                        : "border-transparent hover:border-border hover:bg-bg"
                    }`}
                    title={m.label}
                  >
                    {m.emoji}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-text mb-2">{checkinPhrasing().recapLabel}</div>
              <textarea
                value={yesterday}
                onChange={(e) => setYesterday(e.target.value)}
                rows={3}
                placeholder={checkinPhrasing().recapPlaceholder}
                className="input w-full resize-none"
              />
            </div>

            <div>
              <div className="text-sm font-semibold text-text mb-2">{checkinPhrasing().planLabel}</div>
              <textarea
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                rows={4}
                placeholder={checkinPhrasing().planPlaceholder}
                className="input w-full resize-none"
                autoFocus
              />
            </div>

            <div>
              <div className="text-sm font-semibold text-text mb-2 flex items-center gap-1.5">
                <Paperclip size={12} className="text-muted" /> Attachments
                <span className="text-[11px] text-muted font-normal">— paste a link to a doc, PR, design, ticket…</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Link2 size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    type="url"
                    value={linkDraft}
                    onChange={(e) => setLinkDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
                    placeholder="https://…"
                    className="input w-full pl-8 text-sm"
                  />
                </div>
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
                        aria-label="Remove attachment"
                      >
                        <Trash2 size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={share}
                onChange={(e) => setShare(e.target.checked)}
                className="mt-1"
              />
              <span className="text-text">
                Post this to <span className="font-semibold text-accent">Campfire</span>
                <span className="text-muted"> so the team sees what you're picking up.</span>
              </span>
            </label>

            <div className="pt-2 flex items-center justify-between gap-2">
              <button
                onClick={dismissForToday}
                className="text-sm text-muted hover:text-text px-3 py-2"
              >
                Skip for today
              </button>
              <button
                onClick={submit}
                disabled={save.isPending || (!mood && !focus.trim())}
                className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[rgb(var(--accent-hover))] disabled:opacity-50"
              >
                <Send size={13} />
                {save.isPending ? "Saving…" : "I'm in"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="inline-flex items-center gap-2 text-muted">
        {icon} {label}
      </span>
      <span className={`font-bold ${value > 0 ? "text-text" : "text-muted/60"}`}>{value}</span>
    </div>
  );
}
