// MyCheckinsTab — personal history of the calling user's daily check-ins.
// Lives inside My Accubin so each staff member can see their own mood
// trend, streaks, attachment archive and what they shipped, day by day.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays, AlertCircle, Link2, CheckCircle2, Flame, Smile, ListChecks,
  Activity, Pencil, Plus, X, Trash2, Loader2, TrendingUp, TrendingDown,
  Sparkles, Filter, Search,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

// Mood semantics — used to colour the rhythm strip + derive "best day" facts.
// Anything in POSITIVE_MOODS counts toward "great day" signals; NEGATIVE_MOODS
// flag a rough day. Anything else is neutral.
const POSITIVE_MOODS = new Set(["😄", "🙂"]);
const NEGATIVE_MOODS = new Set(["😕", "😩"]);
const MOODS = ["😄", "🙂", "😐", "😕", "😩"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

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
  // Diagnostic block surfaced on the empty state so a "no history" report
  // is debuggable without DB access. items_emitted should match items.length;
  // a non-zero scan_errors means the backend dropped rows during scan.
  _meta?: {
    items_emitted: number;
    scan_errors: number;
    last_scan_err: string;
    from: string;
    days: number;
  };
};

function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function MyCheckinsTab() {
  const qc = useQueryClient();
  const [windowDays, setWindowDays] = useState(30);
  const [editingDay, setEditingDay] = useState<Row | null>(null);
  // Timeline filters — let the user slice their own history without leaving
  // the page. All client-side because the dataset is small (windowDays bound).
  const [moodFilter, setMoodFilter] = useState<"all" | string>("all");
  const [missedOnly, setMissedOnly] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  // Pagination for the timeline list — keeps long ranges navigable.
  const TIMELINE_PAGE_SIZES = [7, 14, 30, 0] as const; // 0 = All
  const [pageSize, setPageSize] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("me-checkins-page-size") ?? "14", 10);
    return Number.isFinite(v) ? v : 14;
  });
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["me", "daily-checkins", windowDays],
    queryFn: () => api(`/api/v1/me/daily-checkins?days=${windowDays}`),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const items = data?.items ?? [];

  // Today's row, if any. Drives the header CTA — first-time users get a
  // "Check in for today" primary button; if today already has content the
  // button switches to "Edit today's check-in" so they don't accidentally
  // think nothing's saved.
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayRow = useMemo<Row>(
    () => items.find((r) => r.day === todayISO) ?? {
      day: todayISO,
      mood: null,
      focus_note: null,
      yesterday_note: null,
      attachments: [],
      posted_to_campfire: false,
      missed: false,
      tasks_done: 0,
    },
    [items, todayISO],
  );
  const todayHasContent = !!(todayRow.mood || todayRow.focus_note || todayRow.yesterday_note);

  // 14 days back is the server-side window for editing. Compute on the
  // client so the Edit button is only rendered for rows we'd be allowed
  // to save (no point teasing a button that 400s).
  const isEditable = (day: string): boolean => {
    const d = new Date(day + "T00:00:00").getTime();
    const ageDays = (Date.now() - d) / 86_400_000;
    return ageDays >= 0 && ageDays <= 14;
  };

  // Rhythm — oldest → newest for the strip. We fill in any missing dates in
  // the window with synthetic "missed" rows so the user can see real gaps
  // rather than getting a confusingly-jagged strip.
  const rhythm = useMemo<Row[]>(() => {
    const byDay = new Map(items.map((r) => [r.day, r]));
    const out: Row[] = [];
    const today = new Date(todayISO + "T00:00:00").getTime();
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(today - i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      out.push(byDay.get(iso) ?? {
        day: iso, mood: null, focus_note: null, yesterday_note: null,
        attachments: [], posted_to_campfire: false, missed: true, tasks_done: 0,
      });
    }
    return out;
  }, [items, windowDays, todayISO]);

  // Smart facts — auto-derived insights only surfaced when there's enough
  // signal to back them up. Returns the chips the SmartFacts strip renders.
  const facts = useMemo(() => {
    const out: { icon: React.ReactNode; label: string; value: string; tone: "good" | "warn" | "info" }[] = [];
    if (items.length < 3) return out;

    // Longest streak in the window. Items are newest-first; flip and scan.
    let longest = 0, run = 0;
    for (const r of [...items].reverse()) {
      if (!r.missed) { run++; longest = Math.max(longest, run); } else { run = 0; }
    }
    if (longest >= 2) {
      out.push({
        icon: <Flame size={11} />,
        label: "Longest streak",
        value: `${longest}d`,
        tone: longest >= 5 ? "good" : "info",
      });
    }

    // Most-missed weekday — counts of `missed=true` grouped by getDay(). Only
    // surfaces if one weekday clearly stands out (>= 2 misses and >= 40% of
    // total misses) so we don't fingerpoint Tuesdays for one bad week.
    const missByDow: number[] = Array(7).fill(0);
    let totalMissed = 0;
    items.forEach((r) => {
      if (r.missed) {
        const dow = new Date(r.day + "T00:00:00").getDay();
        missByDow[dow]++;
        totalMissed++;
      }
    });
    if (totalMissed >= 2) {
      const maxDow = missByDow.indexOf(Math.max(...missByDow));
      if (missByDow[maxDow] >= 2 && missByDow[maxDow] / totalMissed >= 0.4) {
        out.push({
          icon: <AlertCircle size={11} />,
          label: "Most missed",
          value: WEEKDAYS[maxDow],
          tone: "warn",
        });
      }
    }

    // Best-mood weekday — most positive-mood rows by getDay(). Counterpart to
    // most-missed: a tiny positive nudge.
    const posByDow: number[] = Array(7).fill(0);
    let totalPos = 0;
    items.forEach((r) => {
      if (r.mood && POSITIVE_MOODS.has(r.mood)) {
        const dow = new Date(r.day + "T00:00:00").getDay();
        posByDow[dow]++;
        totalPos++;
      }
    });
    if (totalPos >= 3) {
      const maxDow = posByDow.indexOf(Math.max(...posByDow));
      if (posByDow[maxDow] >= 2) {
        out.push({
          icon: <Smile size={11} />,
          label: "Best mood day",
          value: WEEKDAYS[maxDow],
          tone: "good",
        });
      }
    }

    // Mood trend — compare first vs second half of the window. We score moods
    // (+1 positive, -1 negative, 0 neutral) and look at the delta in average.
    if (items.length >= 6) {
      const score = (m?: string | null) => m && POSITIVE_MOODS.has(m) ? 1 : m && NEGATIVE_MOODS.has(m) ? -1 : 0;
      const sorted = [...items].sort((a, b) => a.day.localeCompare(b.day));
      const mid = Math.floor(sorted.length / 2);
      const avg = (xs: Row[]) => xs.length ? xs.reduce((s, r) => s + score(r.mood), 0) / xs.length : 0;
      const delta = avg(sorted.slice(mid)) - avg(sorted.slice(0, mid));
      if (Math.abs(delta) >= 0.25) {
        out.push({
          icon: delta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />,
          label: "Mood trend",
          value: delta > 0 ? "Lifting" : "Dipping",
          tone: delta > 0 ? "good" : "warn",
        });
      }
    }

    return out;
  }, [items]);

  // Filtered + paged timeline. Server gives us newest-first already; we keep
  // that order so the most recent day is always row #1 on page #1.
  const filtered = useMemo(() => {
    let xs = items;
    if (missedOnly) xs = xs.filter((r) => r.missed);
    if (moodFilter !== "all") xs = xs.filter((r) => r.mood === moodFilter);
    const q = searchQ.trim().toLowerCase();
    if (q) xs = xs.filter((r) =>
      (r.focus_note ?? "").toLowerCase().includes(q)
      || (r.yesterday_note ?? "").toLowerCase().includes(q)
      || r.day.includes(q),
    );
    return xs;
  }, [items, missedOnly, moodFilter, searchQ]);
  useEffect(() => { setPage(0); }, [missedOnly, moodFilter, searchQ, pageSize, windowDays]);
  const total = filtered.length;
  const effectivePageSize = pageSize === 0 ? Math.max(1, total) : pageSize;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => (pageSize === 0 ? filtered : filtered.slice(safePage * pageSize, safePage * pageSize + pageSize)),
    [filtered, safePage, pageSize],
  );
  const firstShown = total === 0 ? 0 : (pageSize === 0 ? 1 : safePage * pageSize + 1);
  const lastShown  = pageSize === 0 ? total : Math.min(total, safePage * pageSize + pageSize);
  function pickPageSize(n: number) {
    setPageSize(n);
    localStorage.setItem("me-checkins-page-size", String(n));
  }

  // Quick-log mood from the Today hero card. Doesn't open the editor — saves
  // immediately and toasts a soft nudge to add notes later. Reuses today's
  // existing notes/attachments so this never clobbers content silently.
  const quickMood = useMutation({
    mutationFn: (mood: string) => api("/api/v1/me/huddle", {
      method: "POST",
      body: JSON.stringify({
        day: todayISO,
        mood,
        focus_note: todayRow.focus_note ?? "",
        yesterday_note: todayRow.yesterday_note ?? "",
        attachments: todayRow.attachments ?? [],
        post_to_campfire: false,
      }),
    }),
    onSuccess: (_d, mood) => {
      toast.success(`Logged ${mood}`, "Open the editor to add what you shipped + what's next.");
      qc.invalidateQueries({ queryKey: ["me", "daily-checkins"] });
      qc.invalidateQueries({ queryKey: ["me-huddle"] });
    },
    onError: (e: any) => toast.error("Could not save mood", e?.message),
  });

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

      {/* Today hero was here. Removed at the user's request — the
          empty-state quick-pick row felt redundant with the Timeline's
          "+ Check in for today" CTA below, and once today already had
          content the summary card duplicated the first timeline row.
          The mutation, types and TodayHero component itself are kept
          (referenced via void below) in case we revive a smarter
          Today affordance later. */}
      {(() => { void TodayHero; void todayHasContent; void quickMood; return null; })()}

      {/* Smart facts — auto-derived nudges. Only chips with backing signal
          appear, so the strip is empty when there isn't a story to tell. */}
      {facts.length > 0 && (
        <div className="flex items-center flex-wrap gap-2">
          <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <Sparkles size={11} /> Smart facts
          </span>
          {facts.map((f, i) => {
            const cls = f.tone === "good" ? "bg-success/10 text-success border-success/30"
              : f.tone === "warn" ? "bg-warn/10 text-warn border-warn/30"
              : "bg-accent-soft text-accent border-accent/30";
            return (
              <span key={i} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[12px] font-semibold ${cls}`}>
                {f.icon}
                <span className="text-muted/80 font-medium">{f.label}:</span>
                <span>{f.value}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Insight strip removed — the Smart facts chips above already carry
          the same signal when there's a story to tell, and the rhythm strip
          below shows the at-a-glance pattern. Four big tiles screaming "0d
          streak · 0% compliance" added noise without action. */}

      {/* Rhythm strip — one square per day in the window, oldest left → newest
          right. Colour encodes whether the day was checked in, and the click
          target opens the editor for that day (if still inside the back-fill
          window). Lets the user see their pattern without scrolling. */}
      <section className="bg-surface border border-border rounded-2xl p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-[12px] font-bold text-text inline-flex items-center gap-1.5">
            <Activity size={12} className="text-accent" /> Rhythm
            <span className="font-normal text-muted">· last {windowDays} days</span>
          </div>
          <div className="inline-flex items-center gap-3 text-[10.5px] text-muted">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-success/70" /> Checked in</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-warn/40" /> No mood</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-danger/40" /> Missed</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {rhythm.map((r) => {
            const isToday = r.day === todayISO;
            const editable = isEditable(r.day);
            const cls = r.missed
              ? "bg-danger/30 hover:bg-danger/40"
              : r.mood
                ? "bg-success/60 hover:bg-success/80"
                : "bg-warn/40 hover:bg-warn/60";
            return (
              <button
                key={r.day}
                type="button"
                disabled={!editable}
                onClick={() => setEditingDay(r)}
                title={`${fmtDay(r.day)}${r.mood ? " · " + r.mood : ""}${r.missed ? " · missed" : ""}`}
                className={`w-5 h-5 rounded-sm transition-all ${cls} ${isToday ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""} ${editable ? "cursor-pointer" : "cursor-default opacity-80"}`}
              />
            );
          })}
        </div>
      </section>

      {/* Timeline */}
      <section className="bg-surface border border-border rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
          <CalendarDays size={14} className="text-accent" />
          <div className="text-sm font-bold text-text">Timeline</div>
          <span className="text-[11px] text-muted">From {data?.from ?? "—"}</span>

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search notes…"
                className="pl-7 pr-2 py-1 text-[12px] bg-bg border border-border rounded-lg w-[160px] focus:outline-none focus:border-accent"
              />
            </div>
            <select
              value={moodFilter}
              onChange={(e) => setMoodFilter(e.target.value)}
              className="bg-bg border border-border rounded-lg px-2 py-1 text-[12px] font-semibold text-text"
              title="Filter by mood"
            >
              <option value="all">All moods</option>
              {MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5 text-[12px] text-muted select-none">
              <input
                type="checkbox"
                checked={missedOnly}
                onChange={(e) => setMissedOnly(e.target.checked)}
              />
              <Filter size={11} /> Missed only
            </label>
          </div>
        </header>
        {isLoading ? (
          <div className="p-10 text-center text-muted text-sm">Loading…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="text-sm font-semibold text-text">No check-ins found for this window</div>
            <p className="text-[12.5px] text-muted max-w-md mx-auto">
              History appears here as soon as you save a check-in — either via the Today hero card above,
              or the Morning huddle prompt on the <span className="font-semibold text-text">Today</span> tab.
              If you've checked in recently and don't see it, try refreshing.
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingDay(todayRow)}
                className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
              >
                <Plus size={13} /> Check in for today
              </button>
              <button
                type="button"
                onClick={() => qc.invalidateQueries({ queryKey: ["me", "daily-checkins"] })}
                className="inline-flex items-center gap-1.5 text-sm font-semibold bg-surface border border-border text-text px-4 py-2 rounded-full hover:border-accent/40 hover:text-accent"
                title="Re-fetch the timeline"
              >
                <Activity size={13} /> Refresh
              </button>
            </div>
            {/* Diagnostic — only renders when the server returned 0 items
                OR dropped any during scan. Lets the user (and us) tell apart
                "endpoint returned nothing" from "rows came back but a scan
                bug ate them" without DB access. */}
            {data?._meta && (data._meta.items_emitted === 0 || data._meta.scan_errors > 0) && (
              <div className="text-[10.5px] text-muted/70 mt-3 font-mono">
                debug · items: {data._meta.items_emitted} · scan_errs: {data._meta.scan_errors}
                {data._meta.scan_errors > 0 && (
                  <> · last: <span className="text-danger">{data._meta.last_scan_err}</span></>
                )}
                {" "}· from: {data._meta.from} · days: {data._meta.days}
              </div>
            )}
          </div>
        ) : pageRows.length === 0 ? (
          <div className="p-10 text-center text-muted text-sm">No days match these filters.</div>
        ) : (
          <ul className="divide-y divide-border">
            {pageRows.map((r) => (
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
        {/* Pager — only when filtered set actually exceeds one page worth. */}
        {total > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-bg/30 text-xs flex-wrap">
            <div className="text-muted inline-flex items-center gap-3 flex-wrap">
              <span>
                Showing <span className="font-semibold text-text">{firstShown}</span>–
                <span className="font-semibold text-text">{lastShown}</span> of{" "}
                <span className="font-semibold text-text">{total.toLocaleString()}</span> day{total === 1 ? "" : "s"}
              </span>
              <label className="inline-flex items-center gap-1.5">
                Rows
                <select
                  value={pageSize}
                  onChange={(e) => pickPageSize(parseInt(e.target.value, 10))}
                  className="bg-surface border border-border rounded-lg px-2 py-1 text-[12px] font-semibold text-text"
                >
                  {TIMELINE_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n === 0 ? "All" : n}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0 || pageSize === 0}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                ← Prev
              </button>
              <span className="text-muted px-1">
                Page <span className="font-semibold text-text">{pageSize === 0 ? 1 : safePage + 1}</span> of{" "}
                <span className="font-semibold text-text">{pageSize === 0 ? 1 : totalPages}</span>
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={pageSize === 0 || safePage + 1 >= totalPages}
                className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </section>

      {editingDay && (() => {
        // Smart prior-day hint — when a user starts a check-in, the most
        // common "Yesterday — what shipped" answer is literally yesterday's
        // "Today — what's on". We look that up by day and pass it through so
        // the wizard can offer a "Use yesterday's plan" one-tap prefill.
        const prevISO = (() => {
          const t = new Date(editingDay.day + "T00:00:00").getTime();
          return new Date(t - 86_400_000).toISOString().slice(0, 10);
        })();
        const prior = items.find((r) => r.day === prevISO) ?? null;
        return (
          <CheckinEditor
            row={editingDay}
            priorRow={prior}
            onClose={() => setEditingDay(null)}
          />
        );
      })()}
    </div>
  );
}

// Mood metadata — drives the labeled emoji tiles in step 1 and the tone of
// the conversational nudge that follows. Centralised so the editor and any
// future surface (settings, exports) stay aligned.
const MOOD_META: Record<string, { label: string; tone: "good" | "ok" | "rough"; line: string }> = {
  "😄": { label: "Energised",  tone: "good",  line: "Great day to ship momentum — what's the next bold move?" },
  "🙂": { label: "Good",       tone: "good",  line: "Steady wins the race. Keep the rhythm going." },
  "😐": { label: "OK",         tone: "ok",    line: "Neutral days are normal — what would tip it positive?" },
  "😕": { label: "Off",        tone: "rough", line: "Something feels off — write it out, even just a sentence." },
  "😩": { label: "Rough",      tone: "rough", line: "Tough day. Be kind to yourself — even logging it counts." },
};

type WizardStep = 0 | 1 | 2;
const STEP_TITLES = ["How are you feeling?", "What's the story?", "Anything to attach?"] as const;

function CheckinEditor({
  row, priorRow, onClose,
}: {
  row: Row;
  priorRow: Row | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isToday = row.day === new Date().toISOString().slice(0, 10);
  const [step, setStep] = useState<WizardStep>(0);
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
    setStep(0);
  }, [row.day]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smart prefill — yesterday's "Today" is, more often than not, the right
  // first draft of today's "Yesterday". We don't auto-write it (clobbering is
  // hostile) but we expose a one-tap "Use yesterday's plan" inside the wizard.
  const priorPlan = (priorRow?.focus_note ?? "").trim();
  const canUsePriorPlan = !!priorPlan && yesterday.trim() === "";

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
      toast.success("Check-in saved", `Logged for ${fmtDay(row.day)}.`);
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

  // Step gating — step 1 ("Mood") needs a selection before Next is enabled.
  // Steps 2 and 3 are always advanceable; the final Save still guards against
  // an entirely empty submission so we don't write blank rows.
  const canAdvance = step === 0 ? !!mood : true;
  const canSave = !save.isPending && (!!mood || !!focus.trim() || !!yesterday.trim());
  // Last-step actions also enable on Ctrl/Cmd + Enter so power users can move
  // through the wizard without lifting from the keyboard.
  function onKey(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (step < 2 && canAdvance) setStep((s) => (s + 1) as WizardStep);
      else if (step === 2 && canSave) save.mutate();
    }
  }

  const tone = mood ? MOOD_META[mood]?.tone : null;
  // Hero tint shifts with the chosen mood so the dialog feels like it's
  // actually listening. Stays neutral until the user picks something.
  const heroTint =
    tone === "good"  ? "from-success/10 to-success/5"
    : tone === "ok"  ? "from-accent-soft to-accent-soft/20"
    : tone === "rough" ? "from-warn/10 to-warn/5"
    : "from-accent-soft to-accent-soft/20";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={onKey}
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Branded hero header — wizard step indicator + friendly title.
            The tint reacts to mood selection so it never feels static. */}
        <header className={`relative bg-gradient-to-br ${heroTint} px-5 pt-4 pb-3 border-b border-border`}>
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-surface/70 text-muted hover:text-text"
            aria-label="Close"
          >
            <X size={16} />
          </button>
          <div className="text-[10.5px] uppercase tracking-[0.12em] font-bold text-accent inline-flex items-center gap-1.5">
            <Sparkles size={11} />
            {isToday ? "Daily check-in" : `Back-fill · ${fmtDay(row.day)}`}
            <span className="text-muted/70 font-medium">· Step {step + 1} of 3</span>
          </div>
          <h3 className="text-xl font-extrabold text-text leading-tight mt-1.5">{STEP_TITLES[step]}</h3>

          {/* Progress dots — clickable so users can jump back to revise. We
              only allow forward jumps to a step whose prerequisites are met
              (currently just step 0 → mood). */}
          <div className="mt-3 flex items-center gap-1.5">
            {[0, 1, 2].map((i) => {
              const reached = step >= i;
              const allowed = i <= step || (i === 1 && !!mood) || i === 2;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!allowed}
                  onClick={() => allowed && setStep(i as WizardStep)}
                  className={`h-1.5 rounded-full transition-all ${
                    reached ? "bg-accent" : "bg-bg"
                  } ${i === step ? "w-10" : "w-6"} ${allowed ? "cursor-pointer hover:opacity-80" : "cursor-not-allowed"}`}
                  aria-label={`Go to step ${i + 1}`}
                />
              );
            })}
          </div>
        </header>

        {/* ============ Step body ============ */}
        <div className="p-5 overflow-y-auto flex-1">
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                One tap — pick the mood that best matches your day. You can change it any time.
              </p>
              <div className="grid grid-cols-5 gap-2">
                {(Object.keys(MOOD_META) as (keyof typeof MOOD_META)[]).map((m) => {
                  const meta = MOOD_META[m];
                  const on = mood === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMood(m)}
                      className={`flex flex-col items-center gap-1 px-2 py-3 rounded-2xl border-2 transition-all ${
                        on
                          ? "border-accent bg-accent-soft scale-105 shadow-soft"
                          : "border-border bg-surface hover:border-accent/40"
                      }`}
                    >
                      <span className="text-3xl leading-none">{m}</span>
                      <span className={`text-[11px] font-bold ${on ? "text-accent" : "text-muted"}`}>{meta.label}</span>
                    </button>
                  );
                })}
              </div>
              {/* Mood-aware tone copy. Slides in to confirm we registered the
                  selection without forcing the user to read a wall of text. */}
              {mood && (
                <div className={`text-[12.5px] rounded-xl px-3.5 py-2.5 border ${
                  tone === "good"  ? "bg-success/5 text-success border-success/20"
                  : tone === "ok"    ? "bg-accent-soft/40 text-accent border-accent/20"
                  : "bg-warn/5 text-warn border-warn/20"
                }`}>
                  {MOOD_META[mood].line}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div>
                <div className="text-sm font-semibold text-text mb-1 flex items-center justify-between gap-2">
                  <span>Yesterday — what shipped</span>
                  {canUsePriorPlan && (
                    <button
                      type="button"
                      onClick={() => setYesterday(priorPlan)}
                      className="text-[11px] font-semibold text-accent hover:underline inline-flex items-center gap-1"
                      title={`Copy yesterday's plan: ${priorPlan.slice(0, 80)}${priorPlan.length > 80 ? "…" : ""}`}
                    >
                      <Sparkles size={10} /> Use yesterday's plan
                    </button>
                  )}
                </div>
                <textarea
                  value={yesterday}
                  onChange={(e) => setYesterday(e.target.value)}
                  rows={3}
                  className="input w-full resize-none"
                  placeholder="What did you finish, hand off, or get stuck on?"
                  autoFocus
                />
                <div className="text-[10.5px] text-muted/80 mt-1 text-right">{yesterday.trim().length} chars</div>
              </div>

              <div>
                <div className="text-sm font-semibold text-text mb-1">
                  {isToday ? "Today — what's on" : "That day — what you were on"}
                </div>
                <textarea
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  rows={4}
                  className="input w-full resize-none"
                  placeholder={
                    tone === "rough"
                      ? "Even one small thing counts — what's the first achievable next move?"
                      : "One or two things you're owning today."
                  }
                />
                <div className="text-[10.5px] text-muted/80 mt-1 text-right">{focus.trim().length} chars</div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <div className="text-sm font-semibold text-text mb-2 flex items-center gap-1.5">
                  <Link2 size={12} className="text-muted" /> Attachments (optional)
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={linkDraft}
                    onChange={(e) => setLinkDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
                    placeholder="https://… a doc, ticket, PR, or design"
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
                {attachments.length > 0 ? (
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
                ) : (
                  <div className="text-[11.5px] text-muted/80 mt-2">No links added — that's fine, this step is optional.</div>
                )}
              </div>

              {/* Review summary — shows everything the user is about to save
                  so the final click feels intentional. */}
              <div className="bg-bg/40 border border-border rounded-2xl p-4 space-y-2.5">
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted inline-flex items-center gap-1">
                  <CheckCircle2 size={11} className="text-accent" /> Ready to save
                </div>
                <ReviewLine label="Mood">{mood
                  ? <span><span className="text-base mr-1">{mood}</span><span className="text-muted text-[12px]">{MOOD_META[mood]?.label}</span></span>
                  : <span className="text-muted italic">none</span>}</ReviewLine>
                <ReviewLine label="Yesterday">{yesterday.trim()
                  ? <span className="line-clamp-2">{yesterday.trim()}</span>
                  : <span className="text-muted italic">empty</span>}</ReviewLine>
                <ReviewLine label="Today">{focus.trim()
                  ? <span className="line-clamp-2">{focus.trim()}</span>
                  : <span className="text-muted italic">empty</span>}</ReviewLine>
                <ReviewLine label="Attachments">{attachments.length
                  ? `${attachments.length} link${attachments.length === 1 ? "" : "s"}`
                  : <span className="text-muted italic">none</span>}</ReviewLine>
              </div>
            </div>
          )}
        </div>

        {/* ============ Footer ============ */}
        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2 bg-bg/20">
          <button
            type="button"
            onClick={step === 0 ? onClose : () => setStep((s) => (s - 1) as WizardStep)}
            className="text-sm font-semibold px-3 py-2 rounded-lg text-muted hover:text-text inline-flex items-center gap-1.5"
          >
            {step === 0 ? "Cancel" : "← Back"}
          </button>
          <div className="text-[11px] text-muted hidden md:block">
            Tip: <kbd className="px-1.5 py-0.5 bg-bg border border-border rounded text-[10px] font-mono">⌘ Enter</kbd> {step === 2 ? "to save" : "to advance"}
          </div>
          {step < 2 ? (
            <button
              type="button"
              onClick={() => canAdvance && setStep((s) => (s + 1) as WizardStep)}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!canSave}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {save.isPending ? "Saving…" : isToday ? "Save check-in" : "Save back-fill"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ReviewLine — tight key/value row for the final wizard step. Keeping it
// inline keeps the review markup readable.
function ReviewLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2 items-baseline text-[12.5px]">
      <span className="text-[10.5px] uppercase tracking-wider font-bold text-muted">{label}</span>
      <div className="text-text">{children}</div>
    </div>
  );
}

// TodayHero — the primary action surface on this tab. Renders one of three
// states:
//
//   1. Empty (today not yet logged): big quick-pick emoji row + "Add notes"
//      link that opens the full editor.
//   2. Logged today: green-tinted summary card showing mood + focus snippet
//      + an Edit button.
//   3. Missed today (only after the current day rolls past without a save):
//      we still treat this as "empty" so the user can back-fill in one tap.
function TodayHero({
  row, hasContent, onOpen, onPickMood, saving,
}: {
  row: Row;
  hasContent: boolean;
  onOpen: () => void;
  onPickMood: (m: string) => void;
  saving: boolean;
}) {
  // Friendly date header — "Tuesday, 12 May" feels more like a journal entry
  // than the ISO row keys we use everywhere else.
  const friendly = new Date(row.day + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
  });

  if (hasContent) {
    return (
      <section className="bg-success/5 border border-success/30 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-success inline-flex items-center gap-1">
              <CheckCircle2 size={11} /> Checked in today
            </div>
            <h3 className="text-lg font-extrabold text-text leading-tight mt-1">
              {row.mood ? <span className="text-xl mr-1.5">{row.mood}</span> : null}
              {friendly}
            </h3>
            {row.focus_note && (
              <p className="text-sm text-text mt-2 max-w-2xl whitespace-pre-wrap leading-snug line-clamp-3">
                {row.focus_note}
              </p>
            )}
            {(row.attachments?.length ?? 0) > 0 && (
              <div className="text-[11.5px] text-muted mt-2 inline-flex items-center gap-1">
                <Link2 size={10} /> {row.attachments!.length} attachment{row.attachments!.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 text-sm font-bold bg-surface border border-border px-4 py-2 rounded-full hover:border-accent/40 hover:text-accent"
          >
            <Pencil size={13} /> Edit today's check-in
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-accent-soft/40 border border-accent/30 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-accent inline-flex items-center gap-1">
            <Sparkles size={11} /> Today
          </div>
          <h3 className="text-lg font-extrabold text-text leading-tight mt-1">{friendly}</h3>
          <p className="text-[12.5px] text-muted mt-1">
            Tap a mood to log it now — you can add what you shipped and what's next any time today.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
        >
          <Plus size={13} /> Add notes
        </button>
      </div>
      <div className="mt-4 flex items-center gap-1.5 flex-wrap">
        {MOODS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onPickMood(m)}
            disabled={saving}
            className="px-3 py-2.5 rounded-xl text-2xl border border-transparent bg-surface hover:border-accent/40 hover:scale-110 transition-all disabled:opacity-50 disabled:cursor-wait"
            title={`Log ${m}`}
          >
            {m}
          </button>
        ))}
        {saving && <Loader2 size={14} className="animate-spin text-muted ml-1" />}
      </div>
    </section>
  );
}

