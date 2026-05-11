// Campfire — the workspace social layer.
//
// Single-file module on purpose: this page is wide-but-shallow, and inlining
// the section components keeps the data plumbing visible. If any section grows
// real complexity (e.g. rooms become a full chat client with threads), it can
// migrate to its own file without touching the public surface (CampfirePage).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import { SmartBody } from "@/modules/campfire/smartBody";
import { MentionInput } from "@/modules/campfire/MentionInput";
import {
  EmojiPopover, AnimatedSticker, isStickerCode, isCelebratory, celebrateAt,
} from "@/modules/campfire/EmojiPicker";
import {
  Flame, Megaphone, Trophy, PartyPopper, UserPlus, Cake, Sparkles,
  StickyNote, Newspaper, MessageCircle, Pin, X, Send, Heart, ThumbsUp,
  Star, Smile, Frown, Meh, Zap, AlertCircle, HelpCircle, ShieldQuestion,
  Wrench, Briefcase, Hash, Activity, Plus, Loader2, CalendarDays,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────────
 * Types
 * ───────────────────────────────────────────────────────────────────────── */

type Member = { id: string; name: string; email: string };

type Reaction = { emoji: string; count: number; mine: boolean };

type Post = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  kind: string;
  title: string;
  body: string;
  meta: Record<string, any> | null;
  pinned: boolean;
  created_at: string;
  comment_count: number;
  reactions: Reaction[] | null;
};

type Comment = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  body: string;
  created_at: string;
  reactions: Reaction[] | null;
};

type Kudo = {
  id: string;
  from: { id: string; name: string; email: string };
  to:   { id: string; name: string; email: string };
  badge: string;
  message: string;
  created_at: string;
  reactions: Reaction[] | null;
};

type HelpItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: "open" | "in_progress" | "resolved";
  requester: { id: string; name: string; email: string };
  resolver: { id: string | null; name: string };
  created_at: string;
  resolved_at: string | null;
};

type Room = {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_default: boolean;
  message_count: number;
  last_message_at: string | null;
};

type Message = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  body: string;
  created_at: string;
  reactions: Reaction[] | null;
};

type PresenceBucket = { id: string; name: string; email: string; last_seen_at: string | null };
type PresenceResponse = {
  online:   PresenceBucket[];
  away:     PresenceBucket[];
  busy:     PresenceBucket[];
  on_leave: PresenceBucket[];
  focus:    PresenceBucket[];
  offline:  PresenceBucket[];
};

/* ─────────────────────────────────────────────────────────────────────────
 * Catalogues — keep the visual metadata in one place so it's easy to tweak.
 * ───────────────────────────────────────────────────────────────────────── */

const POST_KINDS: Record<string, { label: string; icon: React.ComponentType<any>; ring: string; tint: string }> = {
  announcement: { label: "Announcement",  icon: Megaphone,    ring: "ring-accent",  tint: "bg-accent-soft text-accent" },
  win:          { label: "Project win",   icon: Trophy,       ring: "ring-success", tint: "bg-success/10 text-success" },
  celebration:  { label: "Celebration",   icon: PartyPopper,  ring: "ring-warn",    tint: "bg-warn/10 text-warn" },
  joiner:       { label: "New joiner",    icon: UserPlus,     ring: "ring-accent",  tint: "bg-accent-soft text-accent" },
  birthday:     { label: "Birthday",      icon: Cake,         ring: "ring-warn",    tint: "bg-warn/10 text-warn" },
  anniversary:  { label: "Work anniversary", icon: Sparkles,  ring: "ring-success", tint: "bg-success/10 text-success" },
  note:         { label: "Leadership note", icon: StickyNote, ring: "ring-accent",  tint: "bg-accent-soft text-accent" },
  update:       { label: "Quick update",  icon: Newspaper,    ring: "ring-muted",   tint: "bg-bg text-muted" },
};

const BADGES: Record<string, { label: string; icon: React.ComponentType<any>; tint: string }> = {
  delivery_champion: { label: "Delivery Champion", icon: Trophy,    tint: "bg-warn/15 text-warn" },
  problem_solver:    { label: "Problem Solver",    icon: Zap,       tint: "bg-accent-soft text-accent" },
  team_player:       { label: "Team Player",       icon: Heart,     tint: "bg-success/15 text-success" },
  fast_responder:    { label: "Fast Responder",    icon: ThumbsUp,  tint: "bg-accent-soft text-accent" },
  client_hero:       { label: "Client Hero",       icon: Star,      tint: "bg-warn/15 text-warn" },
  custom:            { label: "Custom",            icon: Sparkles,  tint: "bg-bg text-muted" },
};

const MOODS: { value: string; label: string; icon: React.ComponentType<any>; cls: string }[] = [
  { value: "great",      label: "Great",      icon: Smile,  cls: "bg-success/15 text-success border-success/30" },
  { value: "good",       label: "Good",       icon: Smile,  cls: "bg-success/10 text-success border-success/20" },
  { value: "neutral",    label: "Neutral",    icon: Meh,    cls: "bg-bg text-muted border-border" },
  { value: "stressed",   label: "Stressed",   icon: Frown,  cls: "bg-warn/10 text-warn border-warn/30" },
  { value: "overloaded", label: "Overloaded", icon: Frown,  cls: "bg-danger/10 text-danger border-danger/30" },
];

const HELP_KINDS: Record<string, { label: string; icon: React.ComponentType<any>; tint: string }> = {
  help:       { label: "Need help",          icon: HelpCircle,     tint: "bg-accent-soft text-accent" },
  blocked:    { label: "I'm blocked",        icon: AlertCircle,    tint: "bg-danger/10 text-danger" },
  review:     { label: "Need review",        icon: ShieldQuestion, tint: "bg-warn/10 text-warn" },
  devops:     { label: "DevOps support",     icon: Wrench,         tint: "bg-bg text-muted" },
  management: { label: "Management decision", icon: Briefcase,     tint: "bg-accent-soft text-accent" },
};

// Quick-reaction emoji set is gone — the full EmojiPicker now handles every
// reaction surface. Keeping the constant as a brief reference for the curated
// "warm welcome" set if we ever want a one-click row again.
void 0;

/* ─────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────── */

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}

function initials(name: string, email: string): string {
  const s = (name || email || "?").trim();
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.charAt(0).toUpperCase();
}

function Avatar({ name, email, size = 32 }: { name: string; email: string; size?: number }) {
  return (
    <span
      className="rounded-full bg-accent-soft text-accent font-bold grid place-items-center shrink-0"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}
    >
      {initials(name, email)}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Page shell
 * ───────────────────────────────────────────────────────────────────────── */

type Tab = "feed" | "kudos" | "mood" | "help" | "rooms" | "insights";

export function CampfirePage() {
  const { user } = useAuth();
  const isAdmin = !!user?.roles?.some((r) => r === "super_admin" || r === "ceo" || r === "coo" || r === "hr");
  const [tab, setTab] = useState<Tab>("feed");
  const qc = useQueryClient();

  // Mark the feed as seen the moment the page mounts. The bell's badge resets
  // on its own next refetch (30s), but we also invalidate the query so it
  // updates within the next tick.
  useEffect(() => {
    api("/api/v1/campfire/mark-seen", { method: "POST" })
      .then(() => qc.invalidateQueries({ queryKey: ["campfire-unread"] }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; admin?: boolean }[] = [
    { key: "feed",   label: "Pulse feed",  icon: Newspaper },
    { key: "kudos",  label: "Recognition", icon: Trophy },
    { key: "mood",   label: "Mood check",  icon: Smile },
    { key: "help",   label: "Help wall",   icon: HelpCircle },
    { key: "rooms",  label: "Team rooms",  icon: Hash },
    { key: "insights", label: "Insights",  icon: Activity, admin: true },
  ];

  return (
    <div className="pt-2 pb-8">
      <div className="relative">

      <header className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="relative w-14 h-14 rounded-2xl border border-white/20 grid place-items-center shadow-soft" style={{ background: "#107B97" }}>
            <Flame className="text-white animate-flicker" size={28} strokeWidth={2.4} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text leading-none">Campfire</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-md">
              The workspace's pulse — celebrate wins, ask for help, share what's on your mind.
            </p>
          </div>
        </div>
      </header>

      {/* Two-column layout. The campfire body sits in a constrained reading
          column so long posts don't sprawl across ultrawide monitors; the
          "Most engaging this week" hero moves to a compact right rail and
          stays visible across tab switches as a workspace-pulse anchor. */}
      {/* Single column, capped at 1054px for comfortable reading on wide
          monitors. Side rail was removed — the placeholder was creating
          visual noise when the spotlight had nothing to show. */}
      <div className="mt-2 max-w-[1054px]">
        <div className="flex items-center gap-1 mb-4 p-1 bg-surface/70 backdrop-blur border border-border rounded-full overflow-x-auto w-fit shadow-soft">
          {tabs.filter((t) => !t.admin || isAdmin).map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-2 px-4 py-2 text-[13px] font-semibold whitespace-nowrap rounded-full transition-colors ${
                  active
                    ? "bg-accent text-white shadow-soft"
                    : "text-muted hover:text-text hover:bg-bg/40"
                }`}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>

        <div>
          {tab === "feed"     && <PulseFeed isAdmin={isAdmin} />}
          {tab === "kudos"    && <Kudos />}
          {tab === "mood"     && <MoodCheck isAdmin={isAdmin} />}
          {tab === "help"     && <HelpWall currentUserId={user?.id ?? ""} />}
          {tab === "rooms"    && <TeamRooms />}
          {tab === "insights" && isAdmin && <Insights />}
        </div>
      </div>
      </div>{/* close: relative z-10 content layer */}
    </div>
  );
}

/* The right-rail "Workspace Pulse" hero + "Latest activity" cards used to
 * sit here. They were good on their own but duplicated the signal the new
 * full-width "Most engaging this week" carousel already carries, so they
 * were dropped to give the feed the whole page width. If we ever want them
 * back (e.g. an admin insights dashboard) the git history has them. */

/* ─────────────────────────────────────────────────────────────────────────
 * Presence bar (legacy, kept for reference)
 * ───────────────────────────────────────────────────────────────────────── */

function PresenceBar() {
  const { data } = useQuery<PresenceResponse>({
    queryKey: ["campfire", "presence"],
    queryFn: () => api("/api/v1/campfire/presence"),
    refetchInterval: 30_000,
  });

  if (!data) return null;
  const buckets: { key: keyof PresenceResponse; label: string; dot: string; ring: string }[] = [
    { key: "online",   label: "Online",   dot: "bg-success", ring: "ring-success/30" },
    { key: "away",     label: "Away",     dot: "bg-warn",    ring: "ring-warn/30" },
    { key: "focus",    label: "Focus",    dot: "bg-danger",  ring: "ring-danger/30" },
    { key: "busy",     label: "Busy",     dot: "bg-danger",  ring: "ring-danger/30" },
    { key: "on_leave", label: "On leave", dot: "bg-accent",  ring: "ring-accent/30" },
    { key: "offline",  label: "Offline",  dot: "bg-muted",   ring: "ring-muted/30" },
  ];

  return (
    <div className="bg-surface/80 backdrop-blur border border-border/70 rounded-3xl p-5 flex items-start gap-4 flex-wrap shadow-card">
      {buckets.map(({ key, label, dot, ring }) => {
        const list = data[key] ?? [];
        return (
          <div key={key} className="flex-1 min-w-[180px]">
            <div className="flex items-center gap-2 mb-2">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              <span className="text-[12px] font-bold text-text">{label}</span>
              <span className="text-[11px] text-muted">{list.length}</span>
            </div>
            <div className="flex -space-x-1.5 flex-wrap">
              {list.slice(0, 8).map((p) => (
                <span
                  key={p.id}
                  title={p.name || p.email}
                  className={`ring-2 ${ring} ring-offset-1 ring-offset-surface rounded-full`}
                >
                  <Avatar name={p.name} email={p.email} size={28} />
                </span>
              ))}
              {list.length > 8 && (
                <span className="text-[11px] text-muted ml-3 self-end">+{list.length - 8}</span>
              )}
              {list.length === 0 && <span className="text-[11px] text-muted">—</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Pulse feed
 * ───────────────────────────────────────────────────────────────────────── */

function PulseFeed({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery<{ items: Post[] }>({
    queryKey: ["campfire", "posts"],
    queryFn: () => api("/api/v1/campfire/posts"),
    refetchInterval: 20_000,
  });
  const posts = data?.items ?? [];

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerKind, setComposerKind] = useState<string>("update");

  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api(`/api/v1/campfire/posts/${id}/pin`, { method: "POST", body: JSON.stringify({ pinned }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire", "posts"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/campfire/posts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire", "posts"] }),
  });

  // Group posts by day for the "Today / Yesterday / Mon 13 May" headers. Pinned
  // posts still float to the top in their own bucket so they always read first.
  const grouped = useMemo(() => groupByDay(posts), [posts]);

  return (
    <div className="space-y-4">
      {/* Post composer trigger — loud on purpose. The old subtle "Share
          something…" pill read like search and nobody clicked it. Now it's
          a coloured CTA card with quick-prompt chips below so the user sees
          *exactly* what they can drop in. */}
      <div className="rounded-3xl border border-white/15 p-4 shadow-soft" style={{ background: "#107B97" }}>
        <button
          onClick={() => setComposerOpen(true)}
          className="w-full bg-surface rounded-2xl px-4 py-3.5 flex items-center gap-3 hover:bg-bg/40 border border-border/60 hover:border-accent transition-all text-left"
          aria-label="Share something with the workspace"
        >
          <Avatar name={user?.name ?? ""} email={user?.email ?? ""} size={40} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-text">
              Share something with the workspace
            </div>
            <div className="text-[11.5px] text-muted">
              Announcements, wins, kudos, mood — keep the team in the loop.
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 bg-accent text-white text-[12px] font-bold px-3.5 py-2 rounded-full shadow-soft shrink-0">
            <Plus size={13} /> New post
          </span>
        </button>

        {/* Quick-kind chips — one click opens the composer with that kind
            preselected. Lowers the activation cost from "pick a label" to
            "say the thing". */}
        <div className="flex flex-wrap gap-1.5 mt-3 px-1">
          {([
            { kind: "announcement", label: "Announcement", icon: Megaphone, tint: "text-accent" },
            { kind: "win",          label: "Project win",  icon: Trophy,    tint: "text-success" },
            { kind: "celebration",  label: "Celebrate",    icon: PartyPopper, tint: "text-warn" },
            { kind: "update",       label: "Quick update", icon: Newspaper, tint: "text-muted" },
            { kind: "note",         label: "Note",         icon: StickyNote, tint: "text-accent" },
          ] as { kind: string; label: string; icon: React.ComponentType<any>; tint: string }[]).map((q) => {
            const Icon = q.icon;
            return (
              <button
                key={q.kind}
                onClick={() => { setComposerKind(q.kind); setComposerOpen(true); }}
                className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-full bg-surface/80 border border-border/60 hover:border-accent/40 hover:bg-surface transition-colors"
              >
                <Icon size={11} className={q.tint} /> {q.label}
              </button>
            );
          })}
        </div>
      </div>

      {composerOpen && (
        <PostComposer
          initialKind={composerKind}
          onClose={() => setComposerOpen(false)}
          onCreated={() => {
            setComposerOpen(false);
            qc.invalidateQueries({ queryKey: ["campfire", "posts"] });
          }}
          allowPin={isAdmin}
        />
      )}

      {isLoading && <div className="text-sm text-muted py-8 text-center">Loading feed…</div>}

      {posts.length === 0 && !isLoading && (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <Megaphone className="mx-auto text-muted mb-3" size={28} />
          <div className="text-sm font-semibold text-text">No posts yet</div>
          <div className="text-xs text-muted mt-1">Be the first to share a win, an announcement, or just say hello.</div>
        </div>
      )}

      {grouped.map(({ label, posts: chunk }) => (
        <section key={label} className="space-y-3">
          <div className="flex items-center gap-3 px-1">
            <CalendarDays size={12} className="text-muted" />
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted">{label}</span>
            <span className="flex-1 h-px bg-border" />
          </div>
          {chunk.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              currentUserId={user?.id ?? ""}
              isAdmin={isAdmin}
              onPin={(pinned) => togglePin.mutate({ id: p.id, pinned })}
              onDelete={() => remove.mutate(p.id)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

// Bucket posts into "Pinned" + day labels. Today / Yesterday / explicit dates
// for older entries. Pinned always sits at the top regardless of date so an
// announcement doesn't get buried as the week goes on.
function groupByDay(posts: Post[]): { label: string; posts: Post[] }[] {
  if (posts.length === 0) return [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const out: Record<string, Post[]> = {};
  const order: string[] = [];

  const push = (label: string, p: Post) => {
    if (!out[label]) { out[label] = []; order.push(label); }
    out[label].push(p);
  };

  for (const p of posts) {
    if (p.pinned) { push("Pinned", p); continue; }
    const d = new Date(p.created_at); d.setHours(0, 0, 0, 0);
    let label: string;
    if (d.getTime() === today.getTime()) label = "Today";
    else if (d.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    push(label, p);
  }
  return order.map((label) => ({ label, posts: out[label] }));
}

// ComposerHints — three tap-and-paste prompts under the post composer to defeat
// the blank-page problem. Each one prefills the body with a sentence-starter
// the author can edit; they don't lock you into a specific post kind.
const COMPOSER_PROMPTS: { label: string; seed: string }[] = [
  { label: "Share a win",       seed: "🎉 Just shipped: " },
  { label: "Welcome someone",   seed: "👋 Big welcome to @" },
  { label: "Say thanks",        seed: "🙌 Massive thanks to @" },
  { label: "Ask for input",     seed: "Quick poll — what do we think about " },
];

function ComposerHints({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (value.trim().length > 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {COMPOSER_PROMPTS.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onChange(p.seed)}
          className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-bg/30 hover:bg-accent-soft hover:text-accent hover:border-accent/30 text-muted transition-colors"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function PostComposer({ initialKind, onClose, onCreated, allowPin }: { initialKind?: string; onClose: () => void; onCreated: () => void; allowPin: boolean }) {
  const [kind, setKind] = useState(initialKind ?? "update");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/posts", {
        method: "POST",
        body: JSON.stringify({ kind, title: title.trim(), body: body.trim(), pinned }),
      }),
    onSuccess: () => { toast.success("Posted to Campfire"); onCreated(); },
    onError: (e: Error) => toast.error("Could not post", e.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-base font-bold">New post</h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <div className="text-[11px] font-semibold text-text mb-1.5">Kind</div>
            <div className="grid grid-cols-4 gap-1.5">
              {Object.entries(POST_KINDS).map(([k, meta]) => {
                const Icon = meta.icon;
                const active = kind === k;
                return (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-[10.5px] font-semibold ${
                      active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-bg/40"
                    }`}
                  >
                    <Icon size={15} />
                    <span className="leading-tight text-center">{meta.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <input
            className="input"
            placeholder="Headline (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <MentionInput
            className="input min-h-[120px]"
            placeholder="What's the story? Paste a link, drop an @mention…"
            value={body}
            onChange={setBody}
            minRows={5}
          />
          <ComposerHints onChange={setBody} value={body} />
          {allowPin && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <Pin size={13} className="text-muted" /> Pin to top of feed
            </label>
          )}
        </div>
        <footer className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={create.isPending || !body.trim()}
            loadingLabel="Posting…"
            icon={<Send size={14} />}
            onClick={() => create.mutate()}
          >
            Post
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function PostCard({
  post, currentUserId, isAdmin, onPin, onDelete,
}: {
  post: Post; currentUserId: string; isAdmin: boolean;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
}) {
  const meta = POST_KINDS[post.kind] ?? POST_KINDS.update;
  const Icon = meta.icon;
  const [showComments, setShowComments] = useState(false);
  const canDelete = isAdmin || post.author_id === currentUserId;

  return (
    <article className={`bg-surface border rounded-2xl overflow-hidden ${post.pinned ? "border-accent/40" : "border-border"}`}>
      {post.pinned && (
        <div className="px-5 py-1.5 bg-accent-soft/40 text-accent text-[11px] font-bold inline-flex items-center gap-1.5 border-b border-accent/20">
          <Pin size={11} /> Pinned
        </div>
      )}
      <div className="px-5 py-4">
        <header className="flex items-start gap-3">
          <Avatar name={post.author_name} email={post.author_email} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-text">{post.author_name || post.author_email || "Someone"}</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${meta.tint}`}>
                <Icon size={11} /> {meta.label}
              </span>
              <span className="text-[11px] text-muted">{relativeTime(post.created_at)}</span>
            </div>
            {post.title && <div className="text-base font-bold text-text mt-1">{post.title}</div>}
            <SmartBody className="text-sm text-text mt-1" text={post.body} />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isAdmin && (
              <button
                onClick={() => onPin(!post.pinned)}
                className={`p-1.5 rounded hover:bg-bg ${post.pinned ? "text-accent" : "text-muted"}`}
                title={post.pinned ? "Unpin" : "Pin to top"}
              >
                <Pin size={14} />
              </button>
            )}
            {canDelete && (
              <button onClick={onDelete} className="p-1.5 rounded hover:bg-bg text-muted hover:text-danger" title="Delete">
                <X size={14} />
              </button>
            )}
          </div>
        </header>

        <footer className="mt-3 flex items-center gap-2 flex-wrap">
          <ReactionStrip targetType="post" targetId={post.id} reactions={post.reactions ?? []} invalidateKey={["campfire", "posts"]} />
          <button
            onClick={() => setShowComments((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-muted hover:text-text rounded-full hover:bg-bg/40"
          >
            <MessageCircle size={12} /> {post.comment_count} comment{post.comment_count === 1 ? "" : "s"}
          </button>
        </footer>

        {showComments && <CommentsThread postId={post.id} />}
      </div>
    </article>
  );
}

function CommentsThread({ postId }: { postId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ items: Comment[] }>({
    queryKey: ["campfire", "post-comments", postId],
    queryFn: () => api(`/api/v1/campfire/posts/${postId}/comments`),
  });
  const [body, setBody] = useState("");

  const add = useMutation({
    mutationFn: () => api(`/api/v1/campfire/posts/${postId}/comments`, {
      method: "POST", body: JSON.stringify({ body: body.trim() }),
    }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["campfire", "post-comments", postId] });
      qc.invalidateQueries({ queryKey: ["campfire", "posts"] });
    },
  });

  const items = data?.items ?? [];
  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      {items.map((c) => (
        <div key={c.id} className="flex gap-2.5">
          <Avatar name={c.author_name} email={c.author_email} size={28} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-bold text-text">{c.author_name || c.author_email}</span>
              <span className="text-[10.5px] text-muted">{relativeTime(c.created_at)}</span>
            </div>
            <SmartBody className="text-[13px] text-text" text={c.body} />
            <ReactionStrip
              targetType="comment"
              targetId={c.id}
              reactions={c.reactions ?? []}
              invalidateKey={["campfire", "post-comments", postId]}
              compact
            />
          </div>
        </div>
      ))}
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <MentionInput
            className="input !py-2 text-[13px] min-h-[36px]"
            value={body}
            onChange={setBody}
            placeholder="Write a comment… (@ to mention, Enter to send)"
            minRows={1}
            onSubmit={() => body.trim() && add.mutate()}
          />
        </div>
        <button
          onClick={() => body.trim() && add.mutate()}
          disabled={!body.trim() || add.isPending}
          className="p-2 rounded-lg bg-accent text-white disabled:opacity-40 shrink-0"
          title="Send"
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
}

function ReactionStrip({
  targetType, targetId, reactions, invalidateKey, compact,
}: {
  targetType: "post" | "comment" | "message" | "kudo";
  targetId: string;
  reactions: Reaction[];
  invalidateKey: unknown[];
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const toggle = useMutation({
    mutationFn: (emoji: string) =>
      api(`/api/v1/campfire/react/${targetType}/${targetId}`, {
        method: "POST", body: JSON.stringify({ emoji }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });

  // React + maybe celebrate. The confetti burst anchors on the button so it
  // visually launches *from* the reaction the user clicked, not the page
  // origin — feels much more direct.
  function react(emoji: string, anchor?: HTMLElement | null) {
    toggle.mutate(emoji);
    if (isCelebratory(emoji)) celebrateAt(anchor ?? null);
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={(e) => react(r.emoji, e.currentTarget)}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[12px] ${
            r.mine ? "bg-accent-soft border-accent text-accent" : "bg-bg/30 border-border text-text hover:bg-bg/60"
          }`}
        >
          <span>{isStickerCode(r.emoji) ? <AnimatedSticker code={r.emoji} size={14} /> : r.emoji}</span>
          <span className="font-semibold">{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          ref={addBtnRef}
          onClick={() => setPickerOpen((v) => !v)}
          className={`px-2 py-0.5 rounded-full border border-dashed border-border text-muted hover:bg-bg/40 ${compact ? "text-[10px]" : "text-[12px]"}`}
        >
          + 😊
        </button>
        <EmojiPopover
          open={pickerOpen}
          anchorRef={addBtnRef}
          onClose={() => setPickerOpen(false)}
          onPick={(s) => react(s, addBtnRef.current)}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Kudos / recognition
 * ───────────────────────────────────────────────────────────────────────── */

function Kudos() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data } = useQuery<{ items: Kudo[] }>({
    queryKey: ["campfire", "kudos"],
    queryFn: () => api("/api/v1/campfire/kudos"),
    refetchInterval: 30_000,
  });
  const { data: membersData } = useQuery<{ items: Member[] }>({
    queryKey: ["members", "for-kudos"],
    queryFn: () => api("/api/v1/members?status=active"),
  });
  const members = (membersData?.items ?? []).filter((m) => m.id !== user?.id);

  const [open, setOpen] = useState(false);
  const items = data?.items ?? [];

  const give = useMutation({
    mutationFn: (body: { to_user_id: string; badge: string; message: string }) =>
      api("/api/v1/campfire/kudos", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "kudos"] });
      toast.success("Kudos sent!");
      setOpen(false);
    },
    onError: (e: Error) => toast.error("Could not send", e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted">Celebrate teammates who went above and beyond.</p>
        <button
          onClick={() => setOpen(true)}
          className="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90"
        >
          <Plus size={14} /> Give kudos
        </button>
      </div>

      {open && (
        <GiveKudosDialog
          members={members}
          onClose={() => setOpen(false)}
          onGive={(p) => give.mutate(p)}
          pending={give.isPending}
        />
      )}

      {items.length === 0 ? (
        <EmptyState icon={Trophy} title="No kudos yet" body="Be the first to recognise someone's great work." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((k) => <KudoCard key={k.id} kudo={k} />)}
        </div>
      )}
    </div>
  );
}

function GiveKudosDialog({
  members, onClose, onGive, pending,
}: {
  members: Member[];
  onClose: () => void;
  onGive: (p: { to_user_id: string; badge: string; message: string }) => void;
  pending: boolean;
}) {
  const [to, setTo] = useState("");
  const [badge, setBadge] = useState("team_player");
  const [message, setMessage] = useState("");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-base font-bold">Give kudos</h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          <label className="block">
            <div className="text-[11px] font-semibold text-text mb-1.5">To</div>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Pick a teammate…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
            </select>
          </label>
          <div>
            <div className="text-[11px] font-semibold text-text mb-1.5">Badge</div>
            <div className="grid grid-cols-3 gap-1.5">
              {Object.entries(BADGES).filter(([k]) => k !== "custom").map(([k, meta]) => {
                const Icon = meta.icon;
                const active = badge === k;
                return (
                  <button
                    key={k}
                    onClick={() => setBadge(k)}
                    className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg border text-[10.5px] font-semibold ${
                      active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-bg/40"
                    }`}
                  >
                    <Icon size={15} />
                    <span className="leading-tight text-center">{meta.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <textarea
            className="input min-h-[80px]"
            placeholder="Why are they getting this? (optional but recommended)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <footer className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!to || pending}
            loadingLabel="Sending…"
            icon={<Send size={14} />}
            onClick={() => onGive({ to_user_id: to, badge, message: message.trim() })}
          >
            Send kudos
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function KudoCard({ kudo }: { kudo: Kudo }) {
  const badge = BADGES[kudo.badge] ?? BADGES.custom;
  const Icon = badge.icon;
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex gap-4">
      <span className={`w-11 h-11 rounded-xl grid place-items-center shrink-0 ${badge.tint}`}>
        <Icon size={20} />
      </span>
      <div className="flex-1 min-w-0">
        <div className={`inline-block pill ${badge.tint} text-[10.5px] mb-1`}>{badge.label}</div>
        <div className="text-sm text-text">
          <span className="font-bold">{kudo.from.name || kudo.from.email}</span>
          <span className="text-muted"> sent kudos to </span>
          <span className="font-bold">{kudo.to.name || kudo.to.email}</span>
        </div>
        {kudo.message && <div className="text-[13px] text-muted mt-1 italic">"{kudo.message}"</div>}
        <div className="mt-2">
          <ReactionStrip
            targetType="kudo"
            targetId={kudo.id}
            reactions={kudo.reactions ?? []}
            invalidateKey={["campfire", "kudos"]}
            compact
          />
        </div>
        <div className="text-[10.5px] text-muted mt-1">{relativeTime(kudo.created_at)} ago</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Mood check
 * ───────────────────────────────────────────────────────────────────────── */

function MoodCheck({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: today } = useQuery<{ mood: string | null; note?: string }>({
    queryKey: ["campfire", "mood-today"],
    queryFn: () => api("/api/v1/campfire/mood/today"),
  });
  const [note, setNote] = useState("");

  useEffect(() => { if (today?.note) setNote(today.note); }, [today?.note]);

  const set = useMutation({
    mutationFn: (mood: string) =>
      api("/api/v1/campfire/mood/today", {
        method: "PUT", body: JSON.stringify({ mood, note: note.trim() }),
      }),
    onSuccess: (_d, mood) => {
      qc.invalidateQueries({ queryKey: ["campfire", "mood-today"] });
      qc.invalidateQueries({ queryKey: ["campfire", "mood-trend"] });
      toast.success(`Logged today as ${mood}`);
    },
  });

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-2xl p-6">
        <h2 className="text-base font-bold mb-1">How are you today?</h2>
        <p className="text-sm text-muted mb-4">
          A quick daily pulse. Honest answers help us spot burnout early — this is not a performance signal.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {MOODS.map((m) => {
            const Icon = m.icon;
            const active = today?.mood === m.value;
            return (
              <button
                key={m.value}
                onClick={() => set.mutate(m.value)}
                className={`flex flex-col items-center gap-1.5 px-3 py-4 rounded-xl border-2 transition-colors ${
                  active ? `${m.cls} font-bold` : "border-border text-muted hover:bg-bg/40"
                }`}
              >
                <Icon size={22} />
                <span className="text-[12px]">{m.label}</span>
              </button>
            );
          })}
        </div>
        <textarea
          className="input min-h-[60px] mt-4"
          placeholder="Optional note — only your manager / HR can see this."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (today?.mood) set.mutate(today.mood); }}
        />
      </div>

      {isAdmin && <MoodTrendCard />}
    </div>
  );
}

function MoodTrendCard() {
  const { data } = useQuery<{ items: { day: string; mood: string; count: number }[] }>({
    queryKey: ["campfire", "mood-trend"],
    queryFn: () => api("/api/v1/campfire/mood/trend?days=14"),
  });
  const items = data?.items ?? [];

  // Aggregate by day for a simple stacked summary.
  const byDay = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    items.forEach((r) => {
      const day = new Date(r.day).toISOString().slice(0, 10);
      if (!m.has(day)) m.set(day, {});
      m.get(day)![r.mood] = r.count;
    });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  return (
    <div className="bg-surface border border-border rounded-2xl p-5">
      <h3 className="text-sm font-bold mb-3">Mood trend · last 14 days</h3>
      {byDay.length === 0 ? (
        <div className="text-sm text-muted">Not enough check-ins yet.</div>
      ) : (
        <div className="flex items-end gap-1.5 h-32 overflow-x-auto">
          {byDay.map(([day, m]) => {
            const total = Object.values(m).reduce((a, b) => a + b, 0);
            return (
              <div key={day} className="flex flex-col items-center gap-1 min-w-[28px]">
                <div className="flex flex-col-reverse w-5 h-24 bg-bg rounded">
                  {MOODS.map((mo) => {
                    const v = m[mo.value] ?? 0;
                    if (v === 0) return null;
                    return (
                      <div
                        key={mo.value}
                        className={mo.cls.split(" ").find((c) => c.startsWith("bg-")) ?? "bg-accent"}
                        style={{ height: `${(v / total) * 100}%` }}
                        title={`${mo.label}: ${v}`}
                      />
                    );
                  })}
                </div>
                <span className="text-[9px] text-muted">{day.slice(5)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Help wall
 * ───────────────────────────────────────────────────────────────────────── */

function HelpWall({ currentUserId }: { currentUserId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"open" | "in_progress" | "resolved">("open");
  const [open, setOpen] = useState(false);
  const { data } = useQuery<{ items: HelpItem[] }>({
    queryKey: ["campfire", "help", tab],
    queryFn: () => api(`/api/v1/campfire/help?status=${tab}`),
    refetchInterval: 30_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: HelpItem["status"] }) =>
      api(`/api/v1/campfire/help/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire", "help"] }),
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-surface border border-border rounded-full p-1">
          {(["open", "in_progress", "resolved"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-[12px] font-semibold rounded-full ${
                tab === t ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              {t === "in_progress" ? "In progress" : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90"
        >
          <Plus size={14} /> Post a request
        </button>
      </div>

      {open && (
        <HelpComposer
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["campfire", "help"] }); }}
        />
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={HelpCircle}
          title={tab === "open" ? "Nothing open — good news!" : `No ${tab.replace("_", " ")} items`}
          body="When someone needs help, they'll post it here. Anyone can pick it up."
        />
      ) : (
        <div className="space-y-3">
          {items.map((h) => {
            const k = HELP_KINDS[h.kind] ?? HELP_KINDS.help;
            const Icon = k.icon;
            const canPick = h.status === "open";
            const canResolve = (h.status === "in_progress" && h.resolver.id === currentUserId) || h.requester.id === currentUserId;
            return (
              <div key={h.id} className="bg-surface border border-border rounded-2xl p-4 flex items-start gap-3">
                <span className={`w-10 h-10 rounded-lg grid place-items-center shrink-0 ${k.tint}`}>
                  <Icon size={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`pill ${k.tint} text-[10.5px]`}>{k.label}</span>
                    <span className="text-[11px] text-muted">{relativeTime(h.created_at)} ago · {h.requester.name || h.requester.email}</span>
                  </div>
                  <div className="text-sm font-bold text-text mt-1">{h.title}</div>
                  {h.body && <SmartBody className="text-[13px] text-muted mt-0.5" text={h.body} />}
                  {h.resolver.id && (
                    <div className="text-[11px] text-accent mt-1.5">
                      Picked up by <span className="font-semibold">{h.resolver.name}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  {canPick && (
                    <button
                      onClick={() => updateStatus.mutate({ id: h.id, status: "in_progress" })}
                      className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90"
                    >
                      I'll take it
                    </button>
                  )}
                  {canResolve && (
                    <button
                      onClick={() => updateStatus.mutate({ id: h.id, status: "resolved" })}
                      className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg bg-success text-white hover:bg-success/90"
                    >
                      Mark resolved
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HelpComposer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState("help");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/help", {
        method: "POST", body: JSON.stringify({ kind, title: title.trim(), body: body.trim() }),
      }),
    onSuccess: () => { toast.success("Help request posted"); onCreated(); },
    onError: (e: Error) => toast.error("Could not post", e.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-base font-bold">Post a request</h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5">
            {Object.entries(HELP_KINDS).map(([k, meta]) => {
              const Icon = meta.icon;
              const active = kind === k;
              return (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-[10px] font-semibold ${
                    active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-bg/40"
                  }`}
                >
                  <Icon size={14} />
                  <span className="leading-tight text-center">{meta.label}</span>
                </button>
              );
            })}
          </div>
          <input
            className="input"
            placeholder="One-line summary of what you need"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input min-h-[100px]"
            placeholder="Context, links, what you've already tried…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <footer className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!title.trim() || create.isPending}
            loadingLabel="Posting…"
            icon={<Send size={14} />}
            onClick={() => create.mutate()}
          >
            Post request
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Team rooms
 * ───────────────────────────────────────────────────────────────────────── */

function TeamRooms() {
  const { data } = useQuery<{ items: Room[] }>({
    queryKey: ["campfire", "rooms"],
    queryFn: () => api("/api/v1/campfire/rooms"),
  });
  const rooms = data?.items ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  // Default to the room flagged is_default (General) once rooms load.
  useEffect(() => {
    if (!activeId && rooms.length > 0) {
      setActiveId(rooms.find((r) => r.is_default)?.id ?? rooms[0].id);
    }
  }, [rooms, activeId]);

  const active = rooms.find((r) => r.id === activeId);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 h-[640px]">
      <aside className="bg-surface border border-border rounded-2xl p-2 overflow-y-auto">
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveId(r.id)}
            className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2 text-sm transition-colors ${
              activeId === r.id ? "bg-accent text-white" : "hover:bg-bg/40"
            }`}
          >
            <Hash size={14} className={activeId === r.id ? "text-white/80" : "text-muted"} />
            <span className="flex-1 truncate font-semibold">{r.name}</span>
            {r.message_count > 0 && (
              <span className={`text-[10px] ${activeId === r.id ? "text-white/70" : "text-muted"}`}>
                {r.message_count}
              </span>
            )}
          </button>
        ))}
      </aside>

      <div className="bg-surface border border-border rounded-2xl flex flex-col overflow-hidden">
        {active ? (
          <RoomView room={active} />
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-muted">Pick a room</div>
        )}
      </div>
    </div>
  );
}

function RoomView({ room }: { room: Room }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data } = useQuery<{ items: Message[] }>({
    queryKey: ["campfire", "messages", room.id],
    queryFn: () => api(`/api/v1/campfire/rooms/${room.id}/messages`),
    refetchInterval: 8_000,
  });
  const messages = data?.items ?? [];
  const [body, setBody] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/campfire/rooms/${room.id}/messages`, {
        method: "POST", body: JSON.stringify({ body: body.trim() }),
      }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["campfire", "messages", room.id] });
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  return (
    <>
      <header className="px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Hash size={16} className="text-muted" />
          <span className="text-sm font-bold">{room.name}</span>
        </div>
        {room.description && <div className="text-[11px] text-muted">{room.description}</div>}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-sm text-muted py-10">No messages yet — say hi 👋</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex gap-3">
            <Avatar name={m.author_name} email={m.author_email} size={32} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-text">{m.author_name || m.author_email}</span>
                <span className="text-[10.5px] text-muted">{relativeTime(m.created_at)}</span>
              </div>
              <SmartBody className="text-[13.5px] text-text" text={m.body} />
              <ReactionStrip
                targetType="message"
                targetId={m.id}
                reactions={m.reactions ?? []}
                invalidateKey={["campfire", "messages", room.id]}
                compact
              />
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t border-border p-3 flex items-end gap-2">
        <Avatar name={user?.name ?? ""} email={user?.email ?? ""} size={30} />
        <div className="flex-1 min-w-0">
          <MentionInput
            className="input min-h-[40px]"
            placeholder={`Message #${room.slug} · @ to mention, Enter to send`}
            value={body}
            onChange={setBody}
            minRows={1}
            onSubmit={() => body.trim() && send.mutate()}
          />
        </div>
        <button
          onClick={() => body.trim() && send.mutate()}
          disabled={!body.trim() || send.isPending}
          className="p-2 rounded-lg bg-accent text-white disabled:opacity-40"
        >
          {send.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </footer>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Insights (admin)
 * ───────────────────────────────────────────────────────────────────────── */

function Insights() {
  const { data } = useQuery<{
    active_today: number; total_active: number; kudos_7d: number; posts_7d: number;
    open_help: number; avg_resolution_minutes: number; mood_avg_5: number | null; engagement_score: number;
  }>({
    queryKey: ["campfire", "insights"],
    queryFn: () => api("/api/v1/campfire/insights"),
    refetchInterval: 60_000,
  });

  if (!data) return <div className="text-sm text-muted py-8 text-center">Loading insights…</div>;

  const tiles = [
    { label: "Active today",       value: `${data.active_today} / ${data.total_active}`, hint: "Heartbeat in last 24h" },
    { label: "Engagement score",   value: `${data.engagement_score}`, hint: "/100 — activity, kudos, posts" },
    { label: "Mood avg (7d)",      value: data.mood_avg_5 ? data.mood_avg_5.toFixed(1) : "—", hint: "/5 — higher is better" },
    { label: "Kudos this week",    value: `${data.kudos_7d}`, hint: "Shout-outs sent" },
    { label: "Posts this week",    value: `${data.posts_7d}`, hint: "Feed activity" },
    { label: "Open help requests", value: `${data.open_help}`, hint: "Awaiting pickup or resolution" },
    { label: "Avg resolution",     value: data.avg_resolution_minutes ? `${data.avg_resolution_minutes}m` : "—", hint: "Help-request response (30d)" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="bg-surface border border-border rounded-2xl p-4">
          <div className="text-[11px] uppercase tracking-wide font-bold text-muted">{t.label}</div>
          <div className="text-2xl font-extrabold mt-1 text-text">{t.value}</div>
          <div className="text-[11px] text-muted mt-1">{t.hint}</div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Shared bits
 * ───────────────────────────────────────────────────────────────────────── */

function EmptyState({ icon: Icon, title, body }: { icon: React.ComponentType<any>; title: string; body: string }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <Icon className="mx-auto text-muted mb-3" size={28} />
      <div className="text-sm font-semibold text-text">{title}</div>
      <div className="text-xs text-muted mt-1">{body}</div>
    </div>
  );
}

void PresenceBar;
