// Campfire — the workspace social layer.
//
// Single-file module on purpose: this page is wide-but-shallow, and inlining
// the section components keeps the data plumbing visible. If any section grows
// real complexity (e.g. rooms become a full chat client with threads), it can
// migrate to its own file without touching the public surface (CampfirePage).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import { Avatar } from "@/components/Avatar";
import { SmartBody, renderRich } from "@/modules/campfire/smartBody";
import { MentionInput } from "@/modules/campfire/MentionInput";
import {
  EmojiPopover, AnimatedSticker, isStickerCode, isCelebratory, celebrateAt,
} from "@/modules/campfire/EmojiPicker";
import {
  Flame, Megaphone, Trophy, PartyPopper, UserPlus, Cake, Sparkles,
  StickyNote, Newspaper, MessageCircle, Pin, X, Send, Heart, ThumbsUp,
  Star, Smile, Frown, Meh, Zap, AlertCircle, HelpCircle, ShieldQuestion,
  Wrench, Briefcase, Hash, Plus, Loader2, CalendarDays, Calendar,
  Lock, Users as UsersIcon, X as XIcon, UserPlus as UserPlusIcon, Search as SearchIcon, Check,
  ChevronLeft, ChevronDown, ChevronUp, Trash2, Link as LinkIcon, Copy, Pencil, Info, Save,
  BarChart3, CheckCircle2 as CheckCircle, Megaphone as MegaphoneIcon,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────────
 * Types
 * ───────────────────────────────────────────────────────────────────────── */

type Member = { id: string; name: string; email: string; avatar_url?: string };

type Reaction = {
  emoji: string;
  count: number;
  mine: boolean;
  // Names of the people who reacted with this emoji (oldest-first, capped
  // at 10 server-side). Drives the hover tooltip on the chip.
  users?: string[];
};

type Post = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  author_avatar_url?: string;
  kind: string;
  title: string;
  body: string;
  meta: Record<string, any> | null;
  pinned: boolean;
  created_at: string;
  edited_at?: string | null;
  comment_count: number;
  reactions: Reaction[] | null;
};

type Comment = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  author_avatar_url?: string;
  body: string;
  created_at: string;
  edited_at?: string | null;
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
  is_private?: boolean;
  is_owner?: boolean;
  member_count?: number;
  message_count: number;
  last_message_at: string | null;
};

type Message = {
  id: string;
  author_id: string | null;
  author_name: string;
  author_email: string;
  author_avatar_url?: string;
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
  poll:         { label: "Poll",           icon: BarChart3,    ring: "ring-accent",  tint: "bg-accent-soft text-accent" },
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
  const d = new Date(iso);
  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  // ≥ 1 day: include the wall-clock time so people stop wondering
  // whether a "2d" stamp was 2am or 2pm. Goes from compact "2d" → "Mon 14:23",
  // then to "14 May 14:23" once we're more than a week out.
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 7 * 86400) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

// fullDateTime — used as the `title` (hover tooltip) wherever relativeTime
// renders, so the exact instant is one hover away even on short relative
// labels like "just now" or "5m".
function fullDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function initials(name: string, email: string): string {
  const s = (name || email || "?").trim();
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.charAt(0).toUpperCase();
}

// The local Avatar component used to live here and only rendered an
// initials bubble — silently dropping any uploaded photo passed via
// `src`. It's been replaced with the shared @/components/Avatar at the
// top of the file (one import, applies to every callsite below).
void initials;

/* ─────────────────────────────────────────────────────────────────────────
 * Page shell
 * ───────────────────────────────────────────────────────────────────────── */

type Tab = "feed" | "kudos" | "mood" | "help" | "rooms";

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

  // "Insights" used to be a separate admin-only tab. Its tiles were a
  // workspace-pulse snapshot that overlapped with the Mood-check trend
  // chart — same audience (admins), adjacent signal. Merged into "Mood
  // & insights" so the tab strip stays short and admins see all the
  // pulse data in one place.
  const tabs: { key: Tab; label: string; icon: React.ComponentType<any>; admin?: boolean }[] = [
    { key: "feed",   label: "Pulse feed",        icon: Newspaper },
    { key: "kudos",  label: "Recognition",       icon: Trophy },
    { key: "mood",   label: "Mood & insights",  icon: Smile, admin: true },
    { key: "help",   label: "Help wall",         icon: HelpCircle },
    { key: "rooms",  label: "Channels",          icon: Hash },
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
          {tab === "rooms"    && <TeamRooms isAdmin={isAdmin} />}
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

  // Smart-term dictionary for the post body. We fetch the tenant's
  // projects so any mention of a project name or code in a post body
  // gets highlighted as a recognisable chip. The dictionary is augmented
  // with a curated lexicon of workspace-class acronyms (FCTIRS, PAYE,
  // KYC, etc.) so even posts about external systems read as scannable.
  // Computed once per render and passed down into TimelinePostCard.
  const { data: projectsData } = useQuery<{ items: { id: string; code: string; name: string }[] }>({
    queryKey: ["campfire-pulse-projects"],
    queryFn: () => api("/api/v1/projects?status=active"),
    staleTime: 10 * 60_000,
  });
  const smartTerms = useMemo<SmartTerm[]>(() => buildSmartTerms(projectsData?.items ?? []), [projectsData?.items]);

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

  const updatePost = useMutation({
    mutationFn: ({ id, body, title }: { id: string; body: string; title?: string }) =>
      api(`/api/v1/campfire/posts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(title !== undefined ? { body, title } : { body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "posts"] });
      toast.success("Post updated");
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  // Group posts by day for the "Today / Yesterday / Mon 13 May" headers. Pinned
  // posts still float to the top in their own bucket so they always read first.
  const grouped = useMemo(() => groupByDay(posts), [posts]);

  return (
    <div className="space-y-4">
      <UpcomingEventsBanner />

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
          <Avatar name={user?.name ?? ""} email={user?.email ?? ""} src={user?.avatar_url} size={40} />
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

      {/* Timeline render. A 2px accent rail runs down the left of every
          chunk; each post's avatar sits on the rail and the body floats
          to the right with a tiny connector line. Group labels read as
          warm chips above their cluster instead of inline strokes. */}
      {grouped.map(({ label, posts: chunk }) => (
        <section key={label} className="relative">
          {/* Day chip — pinned segment gets the accent fill, otherwise a
              soft surface chip so the eye groups by date first. */}
          <div className="mb-2 px-1">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] uppercase tracking-wider font-bold ${
              label === "Pinned"
                ? "bg-accent text-white shadow-soft"
                : "bg-surface border border-border text-muted"
            }`}>
              {label === "Pinned" ? <Pin size={10} /> : <CalendarDays size={10} />} {label}
              <span className="font-bold opacity-80">· {chunk.length}</span>
            </span>
          </div>
          {/* The rail. Stops 12px before the last post so it doesn't
              extend past the final avatar. */}
          <div aria-hidden className="absolute left-[18px] top-9 bottom-3 w-px bg-gradient-to-b from-accent/40 via-border to-transparent" />
          <div className="space-y-2">
            {chunk.map((p) => (
              <TimelinePostCard
                key={p.id}
                post={p}
                currentUserId={user?.id ?? ""}
                isAdmin={isAdmin}
                onPin={(pinned) => togglePin.mutate({ id: p.id, pinned })}
                onDelete={() => remove.mutate(p.id)}
                onEdit={(body, title) => updatePost.mutate({ id: p.id, body, title })}
                terms={smartTerms}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// SmartTerm — a workspace lexicon entry. The `tone` controls the chip
// styling; "project" entries also carry an href so the highlighted chip
// becomes a clickable shortcut to the project page.
type SmartTerm = {
  pattern: RegExp;
  label: string;
  tone: "project" | "system" | "tax" | "doc";
  href?: string;
};

// buildSmartTerms — assemble the auto-highlight dictionary.
//
//  • Tenant projects: every active project contributes both its code
//    (PRJ-0012) and a token-friendly version of its name. Short
//    one-word names get matched whole; multi-word names contribute
//    individual capitalised tokens (so "NIN-TIN Integration" matches
//    NIN-TIN, NIN, and TIN).
//  • Curated lexicon: acronyms a workspace member often types in a
//    post — FCTIRS, TaxPorta, PAYE, NIN, KYC, MSA, NDA, SOW. Pure
//    convenience; the user can ignore the chip if they don't care.
//  • Patterns are case-insensitive ASCII-word-bounded so we don't
//    light up substrings inside other words ("tincture" wouldn't
//    flash on TIN).
function buildSmartTerms(projects: { id: string; code: string; name: string }[]): SmartTerm[] {
  const out: SmartTerm[] = [];
  const seen = new Set<string>();
  const add = (raw: string, tone: SmartTerm["tone"], href?: string) => {
    const cleaned = raw.trim();
    if (!cleaned || cleaned.length < 3) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // Escape regex specials, then wrap with \b for word boundaries.
    const esc = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push({
      pattern: new RegExp(`\\b${esc}\\b`, "i"),
      label: cleaned,
      tone,
      href,
    });
  };

  // Project signals first so they dominate the highlight set.
  for (const p of projects) {
    add(p.code, "project", `/projects/${p.id}`);
    // Multi-word name: extract distinctive tokens. Skip generic stop
    // words ("the", "and", "of") so we don't light those up.
    const stop = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "any", "all"]);
    for (const tok of p.name.split(/[\s/()&,–—-]+/)) {
      if (!tok) continue;
      if (stop.has(tok.toLowerCase())) continue;
      if (tok.length < 3) continue;
      // Heuristic: prefer tokens that are mostly-uppercase or capitalised.
      // Skips lowercase-only words like "integration" which would chip
      // half the page.
      const upperRatio = tok.replace(/[^A-Z]/g, "").length / tok.length;
      if (upperRatio < 0.4) continue;
      add(tok, "project", `/projects/${p.id}`);
    }
  }

  // Curated workspace lexicon. Order matters — first match wins for a
  // given substring, so put the more specific terms before generic.
  const lexicon: { term: string; tone: SmartTerm["tone"] }[] = [
    { term: "FCTIRS",   tone: "tax" },
    { term: "TaxPorta", tone: "tax" },
    { term: "Taxporta", tone: "tax" },
    { term: "TaxPro",   tone: "tax" },
    { term: "FIRS",     tone: "tax" },
    { term: "PAYE",     tone: "tax" },
    { term: "VAT",      tone: "tax" },
    { term: "NIN",      tone: "system" },
    { term: "TIN",      tone: "system" },
    { term: "BVN",      tone: "system" },
    { term: "KYC",      tone: "system" },
    { term: "ERP",      tone: "system" },
    { term: "API",      tone: "system" },
    { term: "MSA",      tone: "doc" },
    { term: "NDA",      tone: "doc" },
    { term: "SOW",      tone: "doc" },
    { term: "SLA",      tone: "doc" },
    { term: "IP",       tone: "doc" },
  ];
  for (const l of lexicon) add(l.term, l.tone);
  return out;
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

/* UpcomingEventsBanner — slim, warm strip above the composer.
 *
 * Surfaces three categories of "what's coming up" that the spotlight endpoint
 * already exposes: work anniversaries in the next 14 days, teammates returning
 * from leave, and recent joiners. Each item gets an emoji, a friendly headline
 * and a relative-time hint. Hides itself entirely when there's nothing on the
 * horizon — no point shouting an empty bulletin. */
type SpotlightForEvents = {
  new_joiners?:   { id: string; name: string; email: string; joined_at: string }[];
  on_leave?:      { id: string; name: string; email: string; back_on: string }[];
  anniversaries?: { id: string; name: string; email: string; hire_date: string; years: number }[];
};

type UpcomingEvent = {
  key: string;
  emoji: string;
  title: React.ReactNode;
  when: string;
  avatar: { name: string; email: string };
  whenSort: number; // days from today; smaller = sooner
  // Optional click target. When set, the pill renders as a link so the
  // user can drill into the relevant section (e.g. "5 new joiners" →
  // /colleagues?filter=new).
  href?: string;
};

function fmtWhenDays(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7)   return `in ${days} days`;
  if (days < 14)  return `in ${Math.round(days / 7)} week`;
  return `in ${Math.round(days / 7)} weeks`;
}

function UpcomingEventsBanner() {
  const { data } = useQuery<SpotlightForEvents>({
    queryKey: ["campfire", "spotlight"],
    queryFn: () => api("/api/v1/campfire/spotlight"),
    refetchInterval: 5 * 60_000,
  });

  const events = useMemo<UpcomingEvent[]>(() => {
    if (!data) return [];
    const out: UpcomingEvent[] = [];
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    (data.anniversaries ?? []).forEach((a) => {
      // Hire date for *this* year's anniversary window.
      const hd = new Date(a.hire_date);
      const thisYear = new Date(new Date().getFullYear(), hd.getMonth(), hd.getDate());
      const days = Math.round((thisYear.getTime() - now) / day);
      out.push({
        key: "anniv-" + a.id,
        emoji: "🎂",
        title: <><span className="font-bold">{a.name || a.email}</span> · {a.years}-year anniversary</>,
        when: fmtWhenDays(days),
        avatar: { name: a.name, email: a.email },
        whenSort: Math.max(0, days),
      });
    });

    (data.on_leave ?? []).forEach((p) => {
      const back = new Date(p.back_on);
      const days = Math.round((back.getTime() - now) / day);
      out.push({
        key: "back-" + p.id,
        emoji: "✈️",
        title: <><span className="font-bold">{p.name || p.email}</span> back from leave</>,
        when: fmtWhenDays(days),
        avatar: { name: p.name, email: p.email },
        whenSort: Math.max(0, days) + 0.1,
      });
    });

    // New joiners — when there are 3+ within the spotlight window, collapse
    // them into a single "N new joiners" pill instead of stamping the banner
    // with four identical-looking welcome rows. Keeps the strip readable on
    // bigger teams without losing the signal.
    const joiners = data.new_joiners ?? [];
    if (joiners.length >= 3) {
      const first = joiners[0];
      out.push({
        key: "joiners-many",
        emoji: "👋",
        title: <><span className="font-bold">{joiners.length} new joiners</span> this week</>,
        when: "meet them on Colleagues",
        avatar: { name: first.name, email: first.email },
        whenSort: -1, // pinned to the front
        href: "/colleagues?filter=new",
      });
    } else {
      joiners.forEach((j) => {
        const joined = new Date(j.joined_at);
        const days = Math.round((now - joined.getTime()) / day);
        out.push({
          key: "join-" + j.id,
          emoji: "👋",
          title: <><span className="font-bold">{j.name || j.email}</span> just joined</>,
          when: days <= 0 ? "today" : `${days}d ago`,
          avatar: { name: j.name, email: j.email },
          whenSort: -1 + days * 0.01, // joiners pin to the front
          href: "/colleagues?filter=new",
        });
      });
    }

    return out.sort((a, b) => a.whenSort - b.whenSort).slice(0, 4);
  }, [data]);

  // Collapse state — every member can toggle. Persists across page loads
  // via localStorage but never fully hides the banner: in the closed state
  // a slim header still shows the title + event count and a chevron to
  // expand. That way the user can always bring it back without waiting on
  // a new event.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    localStorage.getItem("campfire-upcoming-collapsed") === "1",
  );
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("campfire-upcoming-collapsed", next ? "1" : "0");
      return next;
    });
  }

  if (events.length === 0) return null;

  return (
    <div className="relative overflow-hidden rounded-3xl shadow-soft text-white" style={{ background: "#107B97" }}>
      <div aria-hidden className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-white/10 pointer-events-none" />
      <div aria-hidden className="absolute -bottom-12 -left-8 w-44 h-44 rounded-full bg-white/5 pointer-events-none" />

      <div className={`relative ${collapsed ? "px-4 py-3" : "p-4 sm:p-5"}`}>
        {/* Header — title, event count, chevron toggle. The whole strip is
            the click target when collapsed so the affordance is generous. */}
        <button
          type="button"
          onClick={toggle}
          className={`flex items-center gap-2 ${collapsed ? "w-full text-left" : "mb-3"} group`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Open what's coming up" : "Hide what's coming up"}
          title={collapsed ? "Open" : "Hide"}
        >
          <Calendar size={14} className="text-white/90 shrink-0" />
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-white/85">
            What's coming up
          </span>
          {collapsed && (
            <span className="text-[11px] font-semibold text-white/70">
              · {events.length} event{events.length === 1 ? "" : "s"}
            </span>
          )}
          <span
            className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/10 group-hover:bg-white/25 text-white/85 group-hover:text-white transition-colors"
            aria-hidden
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </span>
        </button>

        {!collapsed && (
          <div className="flex flex-wrap gap-2">
            {events.map((e) => {
              const Inner = (
                <>
                  <span className="ring-2 ring-white/30 rounded-full block shrink-0">
                    <Avatar name={e.avatar.name} email={e.avatar.email} size={24} />
                  </span>
                  <span className="text-[13px] leading-tight truncate max-w-[260px]">
                    <span className="mr-1">{e.emoji}</span>
                    {e.title}
                  </span>
                  <span className="text-[11px] font-semibold text-white/80 shrink-0">· {e.when}</span>
                </>
              );
              const cls = "inline-flex items-center gap-2 bg-white/12 hover:bg-white/20 transition-colors border border-white/20 rounded-2xl pl-1.5 pr-3 py-1.5 min-w-0";
              const titleStr = `${typeof e.title === "string" ? e.title : ""} · ${e.when}`;
              return e.href ? (
                <Link key={e.key} to={e.href} className={cls + " hover:border-white/40 press-fx"} title={titleStr}>
                  {Inner}
                </Link>
              ) : (
                <div key={e.key} className={cls} title={titleStr}>
                  {Inner}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
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

function PostComposer({
  initialKind, initialBody, initialTitle, onClose, onCreated, allowPin,
}: {
  initialKind?: string;
  initialBody?: string;
  initialTitle?: string;
  onClose: () => void;
  onCreated: () => void;
  allowPin: boolean;
}) {
  const [kind, setKind] = useState(initialKind ?? "update");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [body, setBody] = useState(initialBody ?? "");
  const [pinned, setPinned] = useState(false);
  // Poll-only state. Two options is the floor (a "poll" with one choice
  // is just a button) and six is the ceiling (longer than that and the
  // card stops being skim-readable).
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollMulti, setPollMulti] = useState(false);

  const create = useMutation({
    mutationFn: () => {
      const payload: any = { kind, title: title.trim(), body: body.trim(), pinned };
      if (kind === "poll") {
        const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
        payload.meta = { options: opts, multi: pollMulti };
      }
      return api("/api/v1/campfire/posts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => { toast.success("Posted to Campfire"); onCreated(); },
    onError: (e: Error) => toast.error("Could not post", e.message),
  });

  // For polls, require ≥2 non-empty options. Reuse the body field as the
  // poll question — feels natural ("What should we eat?") and stops us
  // having to invent a new prompt field on the row.
  const pollReady = kind !== "poll" || pollOptions.map((o) => o.trim()).filter(Boolean).length >= 2;

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
            placeholder={kind === "poll" ? "Ask the workspace something. 'What should we eat for the team lunch?'" : "What's the story? Paste a link, drop an @mention…"}
            value={body}
            onChange={setBody}
            minRows={5}
          />
          {kind === "poll" && (
            <div className="rounded-xl border border-accent/30 bg-accent-soft/30 p-3 space-y-2">
              <div className="text-[10.5px] uppercase tracking-wider font-bold text-accent inline-flex items-center gap-1.5">
                <BarChart3 size={11} /> Poll options · {pollOptions.filter((o) => o.trim()).length}/6
              </div>
              {pollOptions.map((opt, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-muted w-5 text-center">{idx + 1}</span>
                  <input
                    className="input flex-1"
                    placeholder={`Option ${idx + 1}`}
                    value={opt}
                    onChange={(e) => {
                      const next = [...pollOptions];
                      next[idx] = e.target.value;
                      setPollOptions(next);
                    }}
                  />
                  {pollOptions.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== idx))}
                      className="p-1.5 text-muted hover:text-danger rounded-md"
                      title="Remove option"
                      aria-label="Remove option"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => pollOptions.length < 6 && setPollOptions([...pollOptions, ""])}
                  disabled={pollOptions.length >= 6}
                  className="text-[12px] font-semibold text-accent hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <Plus size={11} /> Add option
                </button>
                <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                  <input type="checkbox" checked={pollMulti} onChange={(e) => setPollMulti(e.target.checked)} />
                  Allow multiple choices
                </label>
              </div>
            </div>
          )}
          {kind !== "poll" && <ComposerHints onChange={setBody} value={body} />}
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
            disabled={create.isPending || !body.trim() || !pollReady}
            loadingLabel="Posting…"
            icon={<Send size={14} />}
            onClick={() => create.mutate()}
          >
            {kind === "poll" ? "Post poll" : "Post"}
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// PostCard is the legacy non-timeline renderer. Kept around in case a
// future view wants the original layout (e.g. a print/digest export);
// silenced from the unused-locals rule via the void below.
void PostCard;
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
          <Avatar name={post.author_name} email={post.author_email} src={post.author_avatar_url} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-text">{post.author_name || post.author_email || "Someone"}</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${meta.tint}`}>
                <Icon size={11} /> {meta.label}
              </span>
              <span className="text-[11px] text-muted" title={fullDateTime(post.created_at)}>{relativeTime(post.created_at)}</span>
            </div>
            {post.title && <div className="text-base font-bold text-text mt-1">{post.title}</div>}
            <SmartBody className="text-sm text-text mt-1" text={post.body} />
            {post.kind === "poll" && <PollBody post={post} />}
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

/* TimelinePostCard — the timeline-flavoured post entry. Wraps the same
 * data PostCard renders but lays it out as an indented card on a vertical
 * rail: the avatar sits on the rail, a 12px connector lines the eye to
 * the body, and the post chrome (header strip, kind icon, time) cleans
 * up. Body text picks up SmartTerm highlights via highlightBody().
 */
function TimelinePostCard({
  post, currentUserId, isAdmin, onPin, onDelete, onEdit, terms,
}: {
  post: Post; currentUserId: string; isAdmin: boolean;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  onEdit: (body: string, title?: string) => void;
  terms: SmartTerm[];
}) {
  const meta = POST_KINDS[post.kind] ?? POST_KINDS.update;
  const Icon = meta.icon;
  const [showComments, setShowComments] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(post.body);
  const [draftTitle, setDraftTitle] = useState(post.title ?? "");
  const canDelete = isAdmin || post.author_id === currentUserId;
  const canEdit   = isAdmin || post.author_id === currentUserId;
  function startEdit() {
    setDraftBody(post.body);
    setDraftTitle(post.title ?? "");
    setEditing(true);
  }
  function saveEdit() {
    const body = draftBody.trim();
    if (!body) return;
    const titleChanged = (post.title ?? "") !== draftTitle.trim();
    onEdit(body, titleChanged ? draftTitle.trim() : undefined);
    setEditing(false);
  }
  return (
    <article className="relative pl-12">
      {/* Avatar dot — sits on the rail with a ring matching the post's
          category tint so a glance scans by kind. */}
      <div className={`absolute left-0 top-1.5 w-9 h-9 rounded-full ring-2 ring-surface ${meta.ring} shadow-soft`}>
        <Avatar name={post.author_name} email={post.author_email} src={post.author_avatar_url} size={36} />
      </div>
      <div className={`rounded-2xl border ${post.pinned ? "border-accent/40 bg-accent-soft/20" : "border-border bg-surface"} px-4 py-3 hover-lift transition-colors`}>
        <header className="flex items-center gap-2 flex-wrap text-[12.5px]">
          <span className="font-bold text-text">{post.author_name || post.author_email || "Someone"}</span>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${meta.tint}`}>
            <Icon size={10} /> {meta.label}
          </span>
          <span className="text-[11px] text-muted" title={fullDateTime(post.created_at)}>{relativeTime(post.created_at)}</span>
          {post.edited_at && (
            <span className="text-[10.5px] text-muted italic" title={`Edited ${fullDateTime(post.edited_at)}`}>(edited)</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {post.pinned && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-accent">
                <Pin size={10} /> Pinned
              </span>
            )}
            {isAdmin && (
              <button
                onClick={() => onPin(!post.pinned)}
                className={`p-1 rounded hover:bg-bg ${post.pinned ? "text-accent" : "text-muted"}`}
                title={post.pinned ? "Unpin" : "Pin to top"}
              >
                <Pin size={12} />
              </button>
            )}
            {canEdit && !editing && (
              <button onClick={startEdit} className="p-1 rounded hover:bg-bg text-muted hover:text-accent" title="Edit">
                <Pencil size={12} />
              </button>
            )}
            {canDelete && (
              <button onClick={onDelete} className="p-1 rounded hover:bg-bg text-muted hover:text-danger" title="Delete">
                <X size={12} />
              </button>
            )}
          </div>
        </header>
        {editing ? (
          <div className="mt-2 space-y-2">
            {/* Title only edits for kinds that actually use one — preserving the
                original "had no title" state means saving doesn't accidentally
                stamp an empty title onto the row. */}
            {(post.title || post.kind === "announcement" || post.kind === "win") && (
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title (optional)"
                className="input w-full text-sm font-bold"
              />
            )}
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={Math.max(3, Math.min(10, draftBody.split("\n").length + 1))}
              className="input w-full text-[13.5px] resize-none"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setEditing(false)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-full text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={!draftBody.trim() || (draftBody === post.body && draftTitle === (post.title ?? ""))}
                className="inline-flex items-center gap-1 text-[12px] font-semibold px-3 py-1.5 rounded-full bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
              >
                <Save size={11} /> Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {post.title && <div className="text-sm font-bold text-text mt-1">{highlightBody(post.title, terms)}</div>}
            <div className="text-[13.5px] text-text/90 mt-1 leading-relaxed whitespace-pre-wrap break-words">
              {highlightBody(post.body, terms)}
            </div>
          </>
        )}
        {post.kind === "poll" && <PollBody post={post} />}
        <footer className="mt-2 flex items-center gap-1.5 flex-wrap">
          <ReactionStrip targetType="post" targetId={post.id} reactions={post.reactions ?? []} invalidateKey={["campfire", "posts"]} compact />
          <button
            onClick={() => setShowComments((v) => !v)}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-muted hover:text-text rounded-full hover:bg-bg/40 transition-colors"
          >
            <MessageCircle size={11} /> {post.comment_count}
          </button>
        </footer>
        {showComments && <CommentsThread postId={post.id} />}
      </div>
    </article>
  );
}

// highlightBody — split a body string into ReactNodes, wrapping every
// SmartTerm match with a chip styled by `tone`. Matches are word-bounded
// and case-insensitive (RegExp.i flag). To avoid double-wrapping when
// terms overlap (e.g. "PAYE" inside "PAYE recovery"), we always pick the
// LEFTMOST match each pass.
//
// Returned nodes also turn URLs and @mentions into the existing chips so
// the smart-terms layer doesn't strip those treatments. We delegate the
// "@mention / URL" pass to a shared regex below.
function highlightBody(text: string, terms: SmartTerm[]): React.ReactNode {
  if (!text) return null;
  const out: React.ReactNode[] = [];
  let i = 0;
  let keyN = 0;
  const push = (node: React.ReactNode) => out.push(<span key={keyN++}>{node}</span>);
  // Plain-text runs still need URL + @mention linkification — delegate
  // those slices to renderRich so we don't strip clickable URLs or
  // mention pills. SmartTerm chips win over URLs/mentions when both
  // overlap, but in practice they don't (SmartTerms are project codes,
  // tax codes, doc names — none of which match URL_RE / MENTION_RE).
  const pushPlain = (slice: string) => {
    if (!slice) return;
    out.push(<React.Fragment key={keyN++}>{renderRich(slice)}</React.Fragment>);
  };

  while (i < text.length) {
    // Find the leftmost match across all term patterns.
    let bestStart = -1;
    let bestEnd = -1;
    let bestTerm: SmartTerm | null = null;
    for (const t of terms) {
      // RegExp.exec doesn't carry state when the pattern has no /g flag,
      // so we can safely reuse it. Slice the remaining text to anchor
      // the leftmost search.
      const rest = text.slice(i);
      const m = t.pattern.exec(rest);
      if (m && m.index >= 0) {
        const absStart = i + m.index;
        if (bestStart < 0 || absStart < bestStart) {
          bestStart = absStart;
          bestEnd = absStart + m[0].length;
          bestTerm = t;
        }
      }
    }
    if (bestTerm == null) {
      pushPlain(text.slice(i));
      break;
    }
    if (bestStart > i) pushPlain(text.slice(i, bestStart));
    const raw = text.slice(bestStart, bestEnd);
    const cls = bestTerm.tone === "project" ? "bg-accent-soft text-accent border-accent/30"
      : bestTerm.tone === "tax" ? "bg-warn/15 text-warn border-warn/30"
      : bestTerm.tone === "doc" ? "bg-success/10 text-success border-success/30"
      : "bg-bg/60 text-text/90 border-border";
    const chipInner = (
      <span className={`inline-flex items-center px-1.5 py-px rounded-md border text-[12px] font-semibold ${cls}`}>
        {raw}
      </span>
    );
    if (bestTerm.href) {
      push(<Link to={bestTerm.href} className="no-underline hover:underline-offset-2 hover:underline">{chipInner}</Link>);
    } else {
      push(chipInner);
    }
    i = bestEnd;
  }
  return out;
}

/* PollBody — the vote-bar block that follows the question text on
 * kind="poll" posts. Click any row to toggle a vote; single-choice polls
 * (meta.multi=false) flip the previous vote automatically. Counts and
 * "your vote" markers come back from ListPosts hydration so the card
 * is correct on first paint.
 *
 * Branding: the bar uses the accent gradient at full opacity for the
 * winning option and a faded version for the rest, so a glance at any
 * card answers "what's winning?" without reading numbers.
 */
function PollBody({ post }: { post: Post }) {
  const qc = useQueryClient();
  const meta = (post.meta ?? {}) as Record<string, any>;
  const options: string[] = Array.isArray(meta.options) ? meta.options : [];
  const counts: number[] = Array.isArray(meta.vote_counts) ? meta.vote_counts : new Array(options.length).fill(0);
  const myVotes: number[] = Array.isArray(meta.my_votes) ? meta.my_votes : [];
  const voterCount: number = typeof meta.voter_count === "number" ? meta.voter_count : 0;
  const multi: boolean = !!meta.multi;

  const total = counts.reduce((a, b) => a + b, 0);
  const winner = total > 0 ? Math.max(...counts) : 0;

  const vote = useMutation({
    mutationFn: (idx: number) =>
      api(`/api/v1/campfire/posts/${post.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ option_idx: idx }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire-posts"] }),
    onError: (e: any) => toast.error("Vote didn't go through", e?.message),
  });

  if (options.length === 0) {
    return (
      <div className="mt-2 text-[12px] text-muted italic">Poll has no options yet.</div>
    );
  }

  return (
    <div className="mt-3 space-y-1.5">
      {options.map((opt, idx) => {
        const c = counts[idx] ?? 0;
        const pct = total === 0 ? 0 : Math.round((c / total) * 100);
        const picked = myVotes.includes(idx);
        const isWinner = total > 0 && c === winner;
        return (
          <button
            key={idx}
            onClick={() => vote.mutate(idx)}
            disabled={vote.isPending}
            className={`group relative w-full text-left border rounded-xl px-3 py-2 overflow-hidden press-fx transition-colors ${
              picked
                ? "border-accent bg-accent-soft/50"
                : "border-border hover:border-accent/40 hover:bg-bg/40"
            }`}
          >
            {/* Fill bar — sits behind the label so the percentage is
                readable on top. Width = pct, hue brightens for the
                winning option. */}
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 ${isWinner ? "bg-accent/30" : "bg-accent/12"} transition-[width] duration-300`}
              style={{ width: `${pct}%` }}
            />
            <span className="relative flex items-center justify-between gap-3 text-[13px] font-semibold">
              <span className="inline-flex items-center gap-2 min-w-0 truncate text-text">
                {picked && <CheckCircle size={12} className="text-accent shrink-0" />}
                {opt || <span className="italic text-muted">Option {idx + 1}</span>}
              </span>
              <span className="shrink-0 text-[11.5px] font-bold text-muted">
                {c} · {pct}%
              </span>
            </span>
          </button>
        );
      })}
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted/80 inline-flex items-center gap-1.5 pt-1">
        <BarChart3 size={10} />
        {voterCount} {voterCount === 1 ? "voter" : "voters"}
        {multi && <span className="ml-1 text-muted/60 font-medium normal-case">· multiple choices allowed</span>}
      </div>
    </div>
  );
}

function CommentsThread({ postId }: { postId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = !!user?.roles?.some((r) => r === "super_admin" || r === "ceo" || r === "coo" || r === "hr");
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
        <CommentRow
          key={c.id}
          c={c}
          postId={postId}
          canEdit={c.author_id === user?.id || isAdmin}
        />
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

// CommentRow — a single comment with edit + delete affordances.
//
//   • Hover reveals a tiny ⋯ action group on the right of the row when
//     the caller is the author or has governance:write. Pencil opens
//     an inline edit textarea (with Save / Cancel); trash opens a
//     confirm-step "Delete?" inline so a click is never one-and-done.
//   • Edit / delete mutations invalidate the comments query so the
//     thread snaps back to the new state.
function CommentRow({
  c, postId, canEdit,
}: {
  c: Comment;
  postId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [confirmDel, setConfirmDel] = useState(false);

  const save = useMutation({
    mutationFn: () => api(`/api/v1/campfire/posts/${postId}/comments/${c.id}`, {
      method: "PATCH", body: JSON.stringify({ body: draft.trim() }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "post-comments", postId] });
      toast.success("Comment updated");
      setEditing(false);
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });
  const del = useMutation({
    mutationFn: () => api(`/api/v1/campfire/posts/${postId}/comments/${c.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "post-comments", postId] });
      qc.invalidateQueries({ queryKey: ["campfire", "posts"] });
      toast.success("Comment deleted");
    },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });

  return (
    <div className="flex gap-2.5 group">
      <Avatar name={c.author_name} email={c.author_email} src={c.author_avatar_url} size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold text-text">{c.author_name || c.author_email}</span>
          <span className="text-[10.5px] text-muted" title={fullDateTime(c.created_at)}>{relativeTime(c.created_at)}</span>
          {canEdit && !editing && !confirmDel && (
            <span className="ml-auto inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => { setDraft(c.body); setEditing(true); }}
                className="p-1 rounded text-muted hover:text-accent hover:bg-bg/60"
                title="Edit"
                aria-label="Edit comment"
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={() => setConfirmDel(true)}
                className="p-1 rounded text-muted hover:text-danger hover:bg-danger/10"
                title="Delete"
                aria-label="Delete comment"
              >
                <Trash2 size={11} />
              </button>
            </span>
          )}
          {confirmDel && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]">
              <span className="text-danger font-semibold">Delete?</span>
              <button
                onClick={() => setConfirmDel(false)}
                className="text-muted hover:text-text px-1"
              >
                Cancel
              </button>
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="px-2 py-0.5 rounded-full bg-danger text-white font-semibold disabled:opacity-60"
              >
                {del.isPending ? "…" : "Yes"}
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              rows={2}
              className="input text-[13px] min-h-[60px]"
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              <button
                onClick={() => { setEditing(false); setDraft(c.body); }}
                className="text-[11.5px] font-semibold text-muted hover:text-text px-2 py-1 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || !draft.trim() || draft.trim() === c.body.trim()}
                className="text-[11.5px] font-bold bg-accent text-white px-2.5 py-1 rounded-full disabled:opacity-60 press-fx"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <SmartBody className="text-[13px] text-text" text={c.body} />
        )}
        <ReactionStrip
          targetType="comment"
          targetId={c.id}
          reactions={c.reactions ?? []}
          invalidateKey={["campfire", "post-comments", postId]}
          compact
        />
      </div>
    </div>
  );
}

// ReactionChip — one emoji + count pill with a hover-revealed tooltip
// listing the people who reacted. Names come from the server (up to 10);
// anything beyond renders as "+N more" so popular reactions don't blow
// the popover height.
function ReactionChip({
  reaction, onClick,
}: {
  reaction: Reaction;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hover, setHover] = useState(false);
  const users = reaction.users ?? [];
  const overflow = Math.max(0, reaction.count - users.length);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[12px] ${
          reaction.mine ? "bg-accent-soft border-accent text-accent" : "bg-bg/30 border-border text-text hover:bg-bg/60"
        }`}
      >
        <span>{isStickerCode(reaction.emoji) ? <AnimatedSticker code={reaction.emoji} size={14} /> : reaction.emoji}</span>
        <span className="font-semibold">{reaction.count}</span>
      </button>
      {hover && users.length > 0 && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 min-w-[140px] max-w-[240px] bg-surface border border-border rounded-xl shadow-card px-3 py-2 text-[12px] pointer-events-none"
        >
          <div className="inline-flex items-center gap-1.5 font-bold text-text mb-1">
            <span className="text-base leading-none">
              {isStickerCode(reaction.emoji) ? <AnimatedSticker code={reaction.emoji} size={14} /> : reaction.emoji}
            </span>
            <span className="text-muted font-medium">
              {reaction.count} {reaction.count === 1 ? "reaction" : "reactions"}
            </span>
          </div>
          <ul className="space-y-0.5">
            {users.map((name, i) => (
              <li key={i} className="text-text truncate">{name}</li>
            ))}
            {overflow > 0 && (
              <li className="text-muted italic">+ {overflow} more</li>
            )}
          </ul>
          {/* Down-arrow notch so the tooltip visibly anchors to the chip */}
          <span
            aria-hidden
            className="absolute top-full left-1/2 -translate-x-1/2 -mt-px w-2 h-2 bg-surface border-r border-b border-border rotate-45"
          />
        </div>
      )}
    </span>
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
        <ReactionChip
          key={r.emoji}
          reaction={r}
          onClick={(e) => react(r.emoji, e.currentTarget)}
        />
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
        <div className="text-[10.5px] text-muted mt-1" title={fullDateTime(kudo.created_at)}>{relativeTime(kudo.created_at)} ago</div>
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

  // The "How are you today?" input card lived here. The daily check-in
  // already collects the same signal on the Check-ins page; surfacing
  // the mood picker on Campfire too was duplicating the action. The
  // admin-side workspace pulse (Insights + 14-day trend) stays because
  // it's a read-only rollup, not a duplicate input.
  void today; void set; void note; void setNote; void MOODS;
  if (!isAdmin) return null;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-bold text-text mb-2 px-1">Workspace insights</h3>
        <Insights />
      </div>
      <MoodTrendCard />
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

type HelpTab = "open" | "in_progress" | "resolved" | "mine" | "all";

// HELP_STATUS_META — tone + label for the status pill that now appears on
// every Help wall card. Keeps the "what state is this in" answer in one
// place regardless of which tab the user is on.
const HELP_STATUS_META: Record<"open" | "in_progress" | "resolved", { label: string; cls: string }> = {
  open:        { label: "Open",        cls: "bg-accent-soft text-accent border-accent/30" },
  in_progress: { label: "In progress", cls: "bg-warn/15 text-warn border-warn/30" },
  resolved:    { label: "Resolved",    cls: "bg-success/15 text-success border-success/30" },
};

function HelpWall({ currentUserId }: { currentUserId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<HelpTab>("open");
  const [open, setOpen] = useState(false);

  // Single fetch for ALL items — backend returns everything when status is
  // omitted, ordered open-first then newest-first. We slice it client-side
  // per tab so picking something up never makes it vanish; it just moves
  // from "Open" to "In progress" (and stays under "Mine" / "All").
  const { data } = useQuery<{ items: HelpItem[] }>({
    queryKey: ["campfire", "help", "all"],
    queryFn: () => api(`/api/v1/campfire/help`),
    refetchInterval: 30_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: HelpItem["status"] }) =>
      api(`/api/v1/campfire/help/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["campfire", "help"] });
      if (vars.status === "in_progress") {
        toast.success("You took it on", "Switch to Mine or In progress to see it any time.");
      } else if (vars.status === "resolved") {
        toast.success("Marked resolved", "Great work — it'll stay in Resolved for the record.");
      }
    },
    onError: (e: Error) => toast.error("Could not update", e.message),
  });

  const all = data?.items ?? [];
  const counts = useMemo(() => ({
    open:        all.filter((h) => h.status === "open").length,
    in_progress: all.filter((h) => h.status === "in_progress").length,
    resolved:    all.filter((h) => h.status === "resolved").length,
    mine:        all.filter((h) => h.requester.id === currentUserId || h.resolver.id === currentUserId).length,
    all:         all.length,
  }), [all, currentUserId]);

  const items = useMemo(() => {
    if (tab === "all")  return all;
    if (tab === "mine") return all.filter((h) => h.requester.id === currentUserId || h.resolver.id === currentUserId);
    return all.filter((h) => h.status === tab);
  }, [all, tab, currentUserId]);

  const TABS: { key: HelpTab; label: string }[] = [
    { key: "open",        label: "Open" },
    { key: "in_progress", label: "In progress" },
    { key: "resolved",    label: "Resolved" },
    { key: "mine",        label: "Mine" },
    { key: "all",         label: "All" },
  ];

  const emptyCopy: Record<HelpTab, { title: string; body: string }> = {
    open:        { title: "Nothing open — good news!",      body: "When someone needs help, they'll post it here. Anyone can pick it up." },
    in_progress: { title: "Nothing in progress right now",  body: "Anything someone takes on lands here." },
    resolved:    { title: "No resolved items yet",          body: "Once a request gets wrapped up, it stays here as history." },
    mine:        { title: "Nothing of yours yet",           body: "Anything you post or pick up shows here so you can find it later." },
    all:         { title: "The help wall is empty",         body: "When someone needs help, they'll post it here." },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-surface border border-border rounded-full p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1 text-[12px] font-semibold rounded-full transition-colors ${
                tab === t.key ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 text-[10.5px] ${tab === t.key ? "opacity-90" : "opacity-60"}`}>
                {counts[t.key]}
              </span>
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
          title={emptyCopy[tab].title}
          body={emptyCopy[tab].body}
        />
      ) : (
        <div className="space-y-3">
          {items.map((h) => {
            const k = HELP_KINDS[h.kind] ?? HELP_KINDS.help;
            const Icon = k.icon;
            const canPick = h.status === "open";
            const canResolve = (h.status === "in_progress" && h.resolver.id === currentUserId) || h.requester.id === currentUserId;
            const isMine = h.requester.id === currentUserId || h.resolver.id === currentUserId;
            const sm = HELP_STATUS_META[h.status];
            // Subtle left rail mirrors the status pill so the visual state
            // reads at a glance even when the row title runs long.
            const railCls =
              h.status === "open" ? "bg-accent"
              : h.status === "in_progress" ? "bg-warn"
              : "bg-success";
            return (
              <div key={h.id} className="bg-surface border border-border rounded-2xl p-4 flex items-start gap-3 relative overflow-hidden">
                <span className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r ${railCls}`} aria-hidden />
                <span className={`w-10 h-10 rounded-lg grid place-items-center shrink-0 ${k.tint}`}>
                  <Icon size={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`pill ${k.tint} text-[10.5px]`}>{k.label}</span>
                    {/* Status pill — now visible on every card so users on
                        Mine / All / Resolved still know the state. */}
                    <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${sm.cls}`}>
                      {sm.label}
                    </span>
                    {isMine && (
                      <span className="pill bg-bg text-muted border border-border text-[10px] uppercase tracking-wide font-bold">
                        Mine
                      </span>
                    )}
                    <span className="text-[11px] text-muted">{relativeTime(h.created_at)} ago · {h.requester.name || h.requester.email}</span>
                  </div>
                  <div className="text-sm font-bold text-text mt-1">{h.title}</div>
                  {h.body && <SmartBody className="text-[13px] text-muted mt-0.5" text={h.body} />}
                  {h.resolver.id && (
                    <div className="text-[11px] text-accent mt-1.5">
                      Picked up by <span className="font-semibold">{h.resolver.id === currentUserId ? "you" : h.resolver.name}</span>
                      {h.status === "resolved" && h.resolved_at && (
                        <span className="text-muted"> · resolved {relativeTime(h.resolved_at)} ago</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  {canPick && (
                    <button
                      onClick={() => updateStatus.mutate({ id: h.id, status: "in_progress" })}
                      disabled={updateStatus.isPending}
                      className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
                    >
                      I'll take it
                    </button>
                  )}
                  {canResolve && (
                    <button
                      onClick={() => updateStatus.mutate({ id: h.id, status: "resolved" })}
                      disabled={updateStatus.isPending}
                      className="text-[11.5px] font-semibold px-3 py-1.5 rounded-lg bg-success text-white hover:bg-success/90 disabled:opacity-60"
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

// HELP_KIND_SMARTS — per-kind copy + template scaffold. Picking a kind
// rewires:
//   • Title placeholder so the prompt matches the request type ("I'm
//     blocked on …" vs "Please review …").
//   • Body template (Markdown-y skeleton) that primes the user to write
//     the context the responder will need. Tap "Use template" to drop
//     it into the body — never overwrites existing content.
//   • Default urgency: Need help / I'm blocked default to High, review
//     defaults to Medium, management decision starts at Medium.
const HELP_KIND_SMARTS: Record<string, {
  titleHint: string;
  template: string;
  defaultUrgency: "low" | "medium" | "high" | "blocking";
}> = {
  help: {
    titleHint: "What you need help with — keep it scannable",
    template: "**What I'm trying to do**\n…\n\n**Where I'm stuck**\n…\n\n**What I've already tried**\n…",
    defaultUrgency: "medium",
  },
  blocked: {
    titleHint: "What's blocking you — name the dependency",
    template: "**Blocker**\n…\n\n**Impact if not resolved by today**\n…\n\n**Who I think can unblock me**\n@",
    defaultUrgency: "high",
  },
  review: {
    titleHint: "What needs review (PR title, doc name)",
    template: "**Link**\n…\n\n**What changed**\n…\n\n**Reviewer focus**\n…\n\n**Needed by**\n…",
    defaultUrgency: "medium",
  },
  devops: {
    titleHint: "What needs DevOps attention",
    template: "**Environment**\n(prod / staging / local)\n\n**Symptom**\n…\n\n**When it started**\n…\n\n**Relevant logs / runbook**\n…",
    defaultUrgency: "high",
  },
  management: {
    titleHint: "What decision needs leadership",
    template: "**Decision needed**\n…\n\n**Options I see**\n1. …\n2. …\n\n**My recommendation**\n…\n\n**Why this can't wait**\n…",
    defaultUrgency: "medium",
  },
};

const URGENCY_META: Record<"low" | "medium" | "high" | "blocking", {
  label: string; cls: string; eta: string;
}> = {
  low:      { label: "Low",      cls: "bg-bg/60 text-muted border-border",         eta: "respond when you can — today is fine" },
  medium:   { label: "Medium",   cls: "bg-accent-soft text-accent border-accent/30", eta: "ideally within a few hours" },
  high:     { label: "High",     cls: "bg-warn/15 text-warn border-warn/30",       eta: "ideally within an hour" },
  blocking: { label: "Blocking", cls: "bg-danger/15 text-danger border-danger/30", eta: "I'm stopped — please respond ASAP" },
};

function HelpComposer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState("help");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [urgency, setUrgency] = useState<"low" | "medium" | "high" | "blocking">("medium");
  const [projectId, setProjectId] = useState("");

  const smart = HELP_KIND_SMARTS[kind] ?? HELP_KIND_SMARTS.help;

  // Project picker — surfaces the same active-project list other dialogs
  // use, so the request can carry the project context in the body.
  const { data: projectsData } = useQuery<{ items: { id: string; name: string; code: string }[] }>({
    queryKey: ["help-projects-picker"],
    queryFn: () => api("/api/v1/projects?status=active"),
    staleTime: 5 * 60_000,
  });

  // Active members list for the @mention suggester. Cheap; cached.
  const { data: membersData } = useQuery<{ items: Member[] }>({
    queryKey: ["help-members-picker"],
    queryFn: () => api("/api/v1/members?status=active"),
    staleTime: 5 * 60_000,
  });

  // Switching kind: bump urgency to the kind's default, ONLY if the
  // user hasn't already touched the urgency picker. We track that with
  // a separate flag so a manual change sticks across kind switches.
  const [urgencyTouched, setUrgencyTouched] = useState(false);
  useEffect(() => {
    if (!urgencyTouched) setUrgency(smart.defaultUrgency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  function applyTemplate() {
    if (body.trim().length === 0) {
      setBody(smart.template);
    } else {
      setBody((b) => b + (b.endsWith("\n") ? "" : "\n\n") + smart.template);
    }
  }

  // Compose the body that actually ships — prepend an urgency tag + an
  // optional project chip so the Help-wall card surfaces them on the
  // same row that already renders.
  function composedBody(): string {
    const parts: string[] = [];
    const urgLabel = URGENCY_META[urgency].label;
    parts.push(`**Urgency:** ${urgLabel}`);
    if (projectId) {
      const p = projectsData?.items.find((x) => x.id === projectId);
      if (p) parts.push(`**Project:** ${p.code} · ${p.name}`);
    }
    if (parts.length > 0) parts.push("");
    parts.push(body.trim());
    return parts.join("\n");
  }

  const create = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/help", {
        method: "POST",
        body: JSON.stringify({ kind, title: title.trim(), body: composedBody() }),
      }),
    onSuccess: () => { toast.success("Help request posted", URGENCY_META[urgency].eta); onCreated(); },
    onError: (e: Error) => toast.error("Could not post", e.message),
  });

  const titleTooShort = title.trim().length > 0 && title.trim().length < 6;
  const titleHint = !title.trim()
    ? null
    : titleTooShort
    ? "Add a couple more words — vague titles get fewer responses."
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Help wall</div>
            <h3 className="text-base font-bold text-text mt-0.5">Post a request</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Kind chips — same vocabulary, but the active state now
              picks up the kind's tint instead of the same accent so
              the eye scans "this is help" vs "this is a blocker". */}
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">What kind of ask is this?</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5">
              {Object.entries(HELP_KINDS).map(([k, meta]) => {
                const Icon = meta.icon;
                const active = kind === k;
                return (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    type="button"
                    className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-[10px] font-semibold transition-colors press-fx ${
                      active ? `border-accent ${meta.tint} shadow-soft` : "border-border text-muted hover:bg-bg/40"
                    }`}
                  >
                    <Icon size={14} />
                    <span className="leading-tight text-center">{meta.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title + smart inline hint */}
          <div>
            <input
              autoFocus
              className="input"
              placeholder={smart.titleHint}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            {titleHint && <div className="text-[10.5px] text-warn mt-1">{titleHint}</div>}
          </div>

          {/* Urgency picker with copy on response expectations */}
          <div>
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1.5">Urgency</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(URGENCY_META) as Array<keyof typeof URGENCY_META>).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => { setUrgency(u); setUrgencyTouched(true); }}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${
                    urgency === u ? URGENCY_META[u].cls : "bg-bg/40 text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {URGENCY_META[u].label}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-muted mt-1.5">{URGENCY_META[urgency].eta}</div>
          </div>

          {/* Project + member-mention shortcut row */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Tied to project <span className="text-muted font-normal">(optional)</span></div>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">—</option>
                {(projectsData?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="label">@mention a teammate <span className="text-muted font-normal">(optional)</span></div>
              <select
                className="input"
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  const m = membersData?.items.find((x) => x.id === id);
                  if (!m) return;
                  const handle = (m.email || "").split("@")[0];
                  setBody((b) => (b ? b + " " : "") + `@${handle}`);
                  // Reset the select to placeholder.
                  (e.target as HTMLSelectElement).value = "";
                }}
              >
                <option value="">Pick someone…</option>
                {(membersData?.items ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.email}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Body + "Use template" affordance */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="label">Details</div>
              <button
                type="button"
                onClick={applyTemplate}
                className="text-[11px] font-semibold text-accent hover:underline normal-case"
              >
                ✨ Use {smart.defaultUrgency === "blocking" ? "blocker" : kind} template →
              </button>
            </div>
            <textarea
              className="input min-h-[140px] text-[13px] font-mono"
              placeholder="Context, links, what you've already tried…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex items-center justify-between text-[10.5px] text-muted mt-1">
              <span>{body.length === 0 ? "Tip: the more context, the faster the response." : `${body.length} characters · markdown supported`}</span>
              {body.length > 0 && body.length < 60 && (
                <span className="text-warn font-semibold">Short for a help request — add a link or what you've tried.</span>
              )}
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted hidden sm:block">
            Posts to the Help wall · everyone in the workspace can see it.
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text">Cancel</button>
            <SmartButton
              variant="primary"
              disabled={!title.trim() || create.isPending}
              loadingLabel="Posting…"
              icon={<Send size={14} />}
              onClick={() => create.mutate()}
            >
              Post {URGENCY_META[urgency].label.toLowerCase()} request
            </SmartButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Team rooms
 * ───────────────────────────────────────────────────────────────────────── */

function TeamRooms({ isAdmin }: { isAdmin: boolean }) {
  // refetchOnWindowFocus + poll so a freshly-created room appears without a
  // hard refresh. The roster query elsewhere is the one that's heavy; the
  // rooms list itself is just metadata.
  const { data, isLoading, error } = useQuery<{ items: Room[] }>({
    queryKey: ["campfire", "rooms"],
    queryFn: () => api("/api/v1/campfire/rooms"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const rooms = data?.items ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Mobile uses a single-column flip between sidebar ("list") and the
  // active channel ("room"). md+ shows both side-by-side. Picking a
  // channel on mobile flips us to "room" so the message view fills the
  // viewport; the room header's back arrow flips us back.
  const [mobileView, setMobileView] = useState<"list" | "room">("list");

  useEffect(() => {
    if (!activeId && rooms.length > 0) {
      setActiveId(rooms.find((r) => r.is_default)?.id ?? rooms[0].id);
    }
  }, [rooms, activeId]);

  const active = rooms.find((r) => r.id === activeId);
  const handlePick = (id: string) => {
    setActiveId(id);
    setMobileView("room");
  };

  // Channel sort — three modes. "Smart" is the default and what the
  // sidebar shows when nothing's been picked.
  //   smart  — composite score (recency × activity × members). The
  //            most engaging channels float up regardless of which
  //            metric is strongest.
  //   recent — purely by last_message_at desc. Useful when the user
  //            wants to see what just happened, not what's busy.
  //   az     — alphabetical fallback for muscle memory.
  // The default channel always pins to the top of the Workspace group
  // regardless of mode — it's the org-wide signal so burying it would
  // hide announcements.
  type ChannelSort = "smart" | "recent" | "az";
  const [channelSort, setChannelSort] = useState<ChannelSort>(() => {
    const v = localStorage.getItem("campfire-channel-sort");
    return (v === "smart" || v === "recent" || v === "az") ? v : "smart";
  });
  function pickChannelSort(s: ChannelSort) {
    setChannelSort(s);
    localStorage.setItem("campfire-channel-sort", s);
  }

  // engagementScore — composite "how lively is this channel" rank. Bigger
  // is more engaging.
  //   • recency bucket: <1h = 100, <24h = 60, <7d = 25, <30d = 8, else 0.
  //     Strong primary signal — a channel with traffic today should beat
  //     a sleepier popular one.
  //   • lifetime message count, log-scaled so a single bursty channel
  //     doesn't dominate forever.
  //   • member count, log-scaled — bigger rooms get a small tail boost.
  function engagementScore(r: Room, now: number): number {
    const last = r.last_message_at ? new Date(r.last_message_at).getTime() : 0;
    const ageMs = last ? now - last : Infinity;
    const recency =
      ageMs < 60 * 60_000           ? 100
      : ageMs < 24 * 60 * 60_000    ? 60
      : ageMs < 7 * 24 * 60 * 60_000  ? 25
      : ageMs < 30 * 24 * 60 * 60_000 ? 8
      : 0;
    return recency
      + Math.log10(r.message_count + 1) * 8
      + Math.log10((r.member_count ?? 0) + 1) * 2;
  }

  // Group + filter: workspace-wide (public) on top, private below. Search
  // filters both. Each group is sorted by the active channelSort, with the
  // default channel pinned to the top of Workspace.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rooms.filter((r) => {
      if (!q) return true;
      return (r.name + " " + r.description).toLowerCase().includes(q);
    });
    const now = Date.now();
    const cmpRecent = (a: Room, b: Room) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name);
    };
    const cmpSmart = (a: Room, b: Room) => {
      const diff = engagementScore(b, now) - engagementScore(a, now);
      if (diff !== 0) return diff;
      return cmpRecent(a, b);
    };
    const cmpAZ = (a: Room, b: Room) => a.name.localeCompare(b.name);
    const cmp = channelSort === "recent" ? cmpRecent : channelSort === "az" ? cmpAZ : cmpSmart;
    // Pin the default channel first within Workspace.
    const workspace = filtered.filter((r) => !r.is_private).sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (b.is_default && !a.is_default) return 1;
      return cmp(a, b);
    });
    return {
      workspace,
      private:   filtered.filter((r) =>  r.is_private).sort(cmp),
    };
  }, [rooms, search, channelSort]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalShown = groups.workspace.length + groups.private.length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-3 md:gap-4 h-[calc(100dvh-220px)] min-h-[480px] md:h-[640px]">
      <aside className={`${mobileView === "room" ? "hidden md:flex" : "flex"} bg-surface border border-border rounded-2xl overflow-hidden flex-col`}>
        <button
          onClick={() => setCreateOpen(true)}
          className="m-2 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-lg bg-accent-soft text-accent hover:bg-accent hover:text-white transition-colors"
        >
          <Plus size={13} /> New channel
        </button>

        <div className="px-2 pb-2 space-y-1.5">
          <div className="relative">
            <SearchIcon size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search channels"
              className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-bg/40 border border-border rounded-lg focus:outline-none focus:border-accent/40 no-cap"
            />
          </div>
          {/* Sort picker — Smart (engagement × recency, default), Recent
              (purely last_message_at), or A-Z. Persists across visits. */}
          <div className="flex items-center justify-end gap-1 text-[10.5px] text-muted">
            <span className="opacity-70">Sort</span>
            {(["smart", "recent", "az"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickChannelSort(s)}
                className={`px-1.5 py-0.5 rounded font-semibold transition-colors ${
                  channelSort === s
                    ? "bg-accent-soft text-accent"
                    : "hover:text-text"
                }`}
                title={
                  s === "smart" ? "Most engaging first — recency × activity × members"
                  : s === "recent" ? "Most recently active first"
                  : "Alphabetical"
                }
              >
                {s === "smart" ? "Smart" : s === "recent" ? "Recent" : "A-Z"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5 pt-0 space-y-3">
          {isLoading ? (
            <div className="px-3 py-4 text-[12px] text-muted">Loading rooms…</div>
          ) : error ? (
            <div className="px-3 py-4 text-[12px] text-danger">
              Couldn't load rooms. Hard-refresh (⇧⌘R) and try again.
            </div>
          ) : rooms.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <div className="text-[12.5px] font-semibold text-text">No channels yet</div>
              <div className="text-[11px] text-muted mt-1 mb-3">
                Spin up your first private channel with a teammate.
              </div>
              <button
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
              >
                <Plus size={11} /> Create a channel
              </button>
            </div>
          ) : totalShown === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted italic">No channels match "{search}".</div>
          ) : (
            <>
              <RoomGroup
                label="Workspace"
                rooms={groups.workspace}
                activeId={activeId}
                onPick={handlePick}
              />
              <RoomGroup
                label="Private"
                privateGroup
                rooms={groups.private}
                activeId={activeId}
                onPick={handlePick}
                onCreate={() => setCreateOpen(true)}
              />
            </>
          )}
        </div>
      </aside>

      <div className={`${mobileView === "list" ? "hidden md:flex" : "flex"} bg-surface border border-border rounded-2xl flex-col overflow-hidden min-h-0`}>
        {active ? (
          <RoomView
            room={active}
            isAdmin={isAdmin}
            onBack={() => setMobileView("list")}
            onDeleted={() => { setActiveId(null); setMobileView("list"); }}
          />
        ) : (
          <RoomsEmptyState
            hasRooms={rooms.length > 0}
            onCreate={() => setCreateOpen(true)}
          />
        )}
      </div>

      {createOpen && (
        <CreateRoomDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => { setActiveId(id); setMobileView("room"); setCreateOpen(false); }}
        />
      )}
    </div>
  );
}

function RoomGroup({
  label, rooms, activeId, onPick, privateGroup, onCreate,
}: {
  label: string;
  rooms: Room[];
  activeId: string | null;
  onPick: (id: string) => void;
  privateGroup?: boolean;
  onCreate?: () => void;
}) {
  if (rooms.length === 0 && !privateGroup) return null;
  return (
    <div>
      <div className="px-2 pt-1 pb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.08em] font-bold text-muted/70">{label}</span>
        {privateGroup && onCreate && (
          <button
            onClick={onCreate}
            className="text-[10px] uppercase tracking-wider font-bold text-accent hover:underline"
            title="New private channel"
          >
            +
          </button>
        )}
      </div>
      {rooms.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-muted/70 italic">No private channels yet.</div>
      ) : (
        <ul className="space-y-0.5">
          {rooms.map((r) => (
            <RoomRow key={r.id} room={r} active={activeId === r.id} onPick={onPick} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RoomRow({ room: r, active, onPick }: { room: Room; active: boolean; onPick: (id: string) => void }) {
  const Icon = r.is_private ? Lock : Hash;
  const last = r.last_message_at ? new Date(r.last_message_at) : null;
  return (
    <li>
      <button
        onClick={() => onPick(r.id)}
        className={`w-full text-left px-2.5 py-2 rounded-lg flex items-start gap-2 text-sm transition-colors ${
          active ? "bg-accent text-white" : "hover:bg-bg/40"
        }`}
      >
        <Icon size={13} className={`mt-0.5 shrink-0 ${active ? "text-white/80" : r.is_private ? "text-warn" : "text-muted"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{r.name}</span>
            {r.is_default && (
              <span className={`text-[9px] uppercase tracking-wider font-bold ${active ? "text-white/60" : "text-muted/60"}`}>
                default
              </span>
            )}
          </div>
          <div className={`text-[10.5px] truncate ${active ? "text-white/70" : "text-muted"}`}>
            {r.is_private && typeof r.member_count === "number" && (
              <span className="mr-1.5">{r.member_count} member{r.member_count === 1 ? "" : "s"}</span>
            )}
            {last
              ? `· active ${relativeTime(r.last_message_at)} ago`
              : r.is_private ? "" : "· quiet for now"}
          </div>
        </div>
      </button>
    </li>
  );
}

function RoomsEmptyState({ hasRooms, onCreate }: { hasRooms: boolean; onCreate: () => void }) {
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
          <Hash size={18} />
        </div>
        <div className="text-base font-bold text-text">
          {hasRooms ? "Pick a channel to start chatting" : "Your team channels live here"}
        </div>
        <p className="text-sm text-muted leading-relaxed mt-1.5">
          {hasRooms
            ? "Channels are persistent threads — anything you post stays for the whole team to scroll through."
            : "Create a private channel and invite the teammates you want in it. Workspace-wide channels (Engineering, Delivery…) show up here automatically."}
        </p>
        <button
          onClick={onCreate}
          className="mt-4 inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-4 py-2 rounded-full hover:bg-[rgb(var(--accent-hover))]"
        >
          <Plus size={13} /> {hasRooms ? "Create a private channel" : "Create your first channel"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Create channel dialog ---------- */

function CreateRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const { data: membersResp } = useQuery<{ items: Member[] }>({
    queryKey: ["members-pick"],
    queryFn: () => api("/api/v1/members"),
    staleTime: 5 * 60_000,
  });
  const members = membersResp?.items ?? [];

  // Derive a URL-friendly slug from the name so the user doesn't have to
  // think about it. They can still pick something custom by typing into
  // the optional slug input below.
  // Slug is auto-derived from the name; we keep an override slot for future
  // wiring but the UI currently doesn't expose a custom-slug input.
  const [slugOverride] = useState("");
  const autoSlug = useMemo(
    () => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40),
    [name],
  );
  const slug = slugOverride.trim() || autoSlug;

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; healed?: boolean; message?: string }>("/api/v1/campfire/rooms", {
        method: "POST",
        body: JSON.stringify({
          slug,
          name: name.trim(),
          description: description.trim(),
          is_private: isPrivate,
          member_ids: isPrivate ? memberIds : [],
        }),
      }),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
      if (resp.healed) {
        toast.success("Channel already existed", resp.message ?? "Opening it for you.");
      } else {
        toast.success("Channel created");
      }
      onCreated(resp.id);
    },
    onError: (e: any) => toast.error("Could not create channel", e?.message),
  });

  const canSubmit = name.trim().length >= 2 && slug.length >= 2 && !create.isPending;
  const filtered = members.filter((m) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (m.name + " " + m.email).toLowerCase().includes(q);
  });
  function toggleMember(id: string) {
    setMemberIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text flex items-center gap-2">
            {isPrivate ? <Lock size={14} className="text-warn" /> : <Hash size={14} className="text-muted" />}
            New channel
          </h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted">
            <XIcon size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <div className="label">Name</div>
            <input
              autoFocus
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project Alpha · Launch crew · Leadership"
            />
            {autoSlug && (
              <div className="text-[11px] text-muted mt-1">URL slug: <span className="font-mono text-text">{slug}</span></div>
            )}
          </label>

          <label className="block">
            <div className="label">Description <span className="text-muted font-normal">(optional)</span></div>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this room is for"
            />
          </label>

          <div className="rounded-xl border border-border p-3 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="mt-1 w-4 h-4 accent-accent no-cap"
              />
              <span className="min-w-0">
                <span className="text-sm font-bold text-text inline-flex items-center gap-1.5">
                  <Lock size={12} className="text-warn" /> Private — invited members only
                </span>
                <span className="block text-[11.5px] text-muted leading-snug mt-0.5">
                  Only the people you add below will see messages and be able to post.
                  Uncheck to make a workspace-wide channel (admins only).
                </span>
              </span>
            </label>
            <label
              className={`block transition-opacity ${isPrivate ? "opacity-100" : "opacity-50 pointer-events-none"}`}
            >
              <div className="label flex items-center justify-between">
                <span>Invite teammates</span>
                <span className="text-[11px] text-muted font-normal">{memberIds.length} selected</span>
              </div>
              <div className="relative">
                <SearchIcon size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  className="input pl-8 no-cap"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or email"
                />
              </div>
              <ul className="mt-2 max-h-[200px] overflow-y-auto divide-y divide-border border border-border rounded-lg">
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-muted italic">No matches.</li>
                ) : (
                  filtered.map((m) => {
                    const on = memberIds.includes(m.id);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => toggleMember(m.id)}
                          className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg/40"
                        >
                          <span
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                              on ? "bg-accent border-accent text-white" : "border-border bg-surface"
                            }`}
                          >
                            {on && <Check size={11} />}
                          </span>
                          <Avatar name={m.name} email={m.email} src={m.avatar_url} size={22} />
                          <span className="text-[13px] text-text truncate flex-1">{m.name || m.email}</span>
                          <span className="text-[11px] text-muted truncate">{m.email}</span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </label>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm text-muted hover:text-text px-3 py-2">Cancel</button>
          <SmartButton
            variant="primary"
            disabled={!canSubmit}
            onClick={() => create.mutateAsync()}
            loadingLabel="Creating…"
            successLabel="Created"
            icon={<Plus size={13} />}
          >
            Create channel
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

function RoomView({
  room, isAdmin, onBack, onDeleted,
}: {
  room: Room;
  isAdmin: boolean;
  onBack: () => void;
  onDeleted: () => void;
}) {
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

  // Delete-channel mutation. Backend gates by ownership / governance:write
  // so the UI doesn't need to over-restrict — but we still hide the menu
  // entry for users with no chance of success, to avoid an obvious 403.
  const canDelete = !room.is_default && (room.is_owner || isAdmin);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () =>
      api(`/api/v1/campfire/rooms/${room.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Channel deleted");
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
      onDeleted();
    },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const [membersOpen, setMembersOpen] = useState(false);
  // Channel-details drawer: overview / edit / members / invite link.
  // Opened by clicking the header title or the user-count button. Pre-
  // selects a tab so the user lands on the section they clicked toward.
  const [detailsOpen, setDetailsOpen] = useState<null | "overview" | "members" | "invite">(null);

  return (
    <>
      <header className="px-3 sm:px-5 py-3 border-b border-border flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex items-center gap-2 flex-1">
          <button
            onClick={onBack}
            className="md:hidden -ml-1 p-1.5 rounded-lg text-muted hover:bg-bg/40"
            title="Back to channels"
            aria-label="Back to channels"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => setDetailsOpen("overview")}
            className="min-w-0 text-left rounded-lg hover:bg-bg/40 px-1.5 py-1 -ml-1.5"
            title="Channel details"
          >
            <div className="flex items-center gap-2">
              {room.is_private ? <Lock size={14} className="text-warn shrink-0" /> : <Hash size={16} className="text-muted shrink-0" />}
              <span className="text-sm font-bold truncate">{room.name}</span>
              {room.is_private && (
                <span className="pill bg-warn/15 text-warn text-[10px] hidden sm:inline">Private</span>
              )}
            </div>
            {room.description && <div className="text-[11px] text-muted truncate hidden sm:block">{room.description}</div>}
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {room.is_private && (
            <button
              onClick={() => setDetailsOpen("members")}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-muted hover:text-accent px-2 py-1 rounded-lg hover:bg-bg/40"
              title="View members"
            >
              <UsersIcon size={12} /> {room.member_count ?? "—"}
            </button>
          )}
          {room.is_private && (
            <button
              onClick={() => setDetailsOpen("invite")}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-muted hover:text-accent px-2 py-1 rounded-lg hover:bg-bg/40"
              title="Invite link"
            >
              <LinkIcon size={13} />
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-muted hover:text-danger px-2 py-1 rounded-lg hover:bg-danger/10"
              title="Delete channel"
              aria-label="Delete channel"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </header>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={() => setConfirmDelete(false)}>
          <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold flex items-center gap-2"><Trash2 size={14} className="text-danger" /> Delete #{room.name}?</h3>
            <p className="text-[13px] text-muted mt-2">
              Every message, reaction and member row in this channel will be removed. This can't be undone.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:bg-bg/40">
                Cancel
              </button>
              <button
                disabled={del.isPending}
                onClick={() => del.mutate()}
                className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-danger text-white hover:bg-danger/90 disabled:opacity-60"
              >
                {del.isPending ? "Deleting…" : "Delete channel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {membersOpen && (
        <RoomMembersDialog
          room={room}
          onClose={() => setMembersOpen(false)}
        />
      )}

      {detailsOpen && (
        <ChannelDetailsDialog
          room={room}
          isAdmin={isAdmin}
          initialTab={detailsOpen}
          onClose={() => setDetailsOpen(null)}
        />
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-sm text-muted py-10">No messages yet — say hi 👋</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex gap-3">
            <Avatar name={m.author_name} email={m.author_email} src={m.author_avatar_url} size={32} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-text">{m.author_name || m.author_email}</span>
                <span className="text-[10.5px] text-muted" title={fullDateTime(m.created_at)}>{relativeTime(m.created_at)}</span>
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
        <Avatar name={user?.name ?? ""} email={user?.email ?? ""} src={user?.avatar_url} size={30} />
        <div className="flex-1 min-w-0">
          <MentionInput
            className="input min-h-[40px]"
            placeholder={`Message #${room.slug} · @ to mention · Enter to send`}
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

/* ---------- Private-room member management ---------- */

type RoomMember = {
  user_id: string;
  name: string;
  email: string;
  avatar_url: string;
  added_at: string;
  is_owner: boolean;
};

function RoomMembersDialog({ room, onClose, embedded }: { room: Room; onClose: () => void; embedded?: boolean }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);

  const { data: rosterData } = useQuery<{ items: RoomMember[] }>({
    queryKey: ["campfire", "room-members", room.id],
    queryFn: () => api(`/api/v1/campfire/rooms/${room.id}/members`),
  });
  const { data: allMembersData } = useQuery<{ items: Member[] }>({
    queryKey: ["members-pick"],
    queryFn: () => api("/api/v1/members"),
    staleTime: 5 * 60_000,
  });
  const roster = rosterData?.items ?? [];
  const allMembers = allMembersData?.items ?? [];
  const rosterIds = new Set(roster.map((m) => m.user_id));
  const candidates = allMembers.filter((m) => !rosterIds.has(m.id));

  const [search, setSearch] = useState("");
  const filtered = candidates.filter((m) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (m.name + " " + m.email).toLowerCase().includes(q);
  });

  const add = useMutation({
    mutationFn: (userID: string) =>
      api(`/api/v1/campfire/rooms/${room.id}/members`, {
        method: "POST",
        body: JSON.stringify({ user_id: userID }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "room-members", room.id] });
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
    },
    onError: (e: any) => toast.error("Could not add", e?.message),
  });
  const remove = useMutation({
    mutationFn: (userID: string) =>
      api(`/api/v1/campfire/rooms/${room.id}/members/${userID}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "room-members", room.id] });
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
    },
    onError: (e: any) => toast.error("Could not remove", e?.message),
  });

  const canManage = !!room.is_owner;

  // Embedded mode: render just the body so the new ChannelDetailsDialog
  // can host the roster inside its own tabbed shell. Standalone mode
  // keeps the modal chrome for callers that still open this directly.
  const body = (
    <>
      {!embedded && (
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text inline-flex items-center gap-2">
            <Lock size={14} className="text-warn" /> Members · {roster.length}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted">
            <XIcon size={14} />
          </button>
        </header>
      )}
      <div className={embedded ? "space-y-4" : "flex-1 overflow-y-auto p-4 space-y-4"}>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">On the team</div>
            <ul className="divide-y divide-border border border-border rounded-lg">
              {roster.map((m) => (
                <li key={m.user_id} className="px-3 py-2 flex items-center gap-2">
                  <Avatar name={m.name} email={m.email} src={m.avatar_url} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-text truncate">{m.name || m.email}</div>
                    <div className="text-[11px] text-muted truncate">{m.email}</div>
                  </div>
                  {m.is_owner ? (
                    <span className="pill bg-accent-soft text-accent text-[10px]">Owner</span>
                  ) : (canManage || m.user_id === me?.id) && (
                    <button
                      onClick={() => remove.mutate(m.user_id)}
                      disabled={remove.isPending}
                      className="text-[11px] text-muted hover:text-danger disabled:opacity-50"
                      title={m.user_id === me?.id ? "Leave room" : "Remove member"}
                    >
                      {m.user_id === me?.id ? "Leave" : "Remove"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {canManage && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2 flex items-center justify-between">
                <span>Add a teammate</span>
                <span className="text-[10.5px] font-normal text-muted/70">Owner only</span>
              </div>
              <div className="relative">
                <SearchIcon size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search workspace…"
                  className="input pl-8 no-cap"
                />
              </div>
              <ul className="mt-2 max-h-[220px] overflow-y-auto divide-y divide-border border border-border rounded-lg">
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-muted italic">
                    {candidates.length === 0 ? "Everyone is already in." : "No matches."}
                  </li>
                ) : (
                  filtered.map((m) => (
                    <li key={m.id} className="px-3 py-2 flex items-center gap-2">
                      <Avatar name={m.name} email={m.email} src={m.avatar_url} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-text truncate">{m.name || m.email}</div>
                        <div className="text-[11px] text-muted truncate">{m.email}</div>
                      </div>
                      <button
                        onClick={() => add.mutate(m.id)}
                        disabled={add.isPending}
                        className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:bg-accent-soft px-2 py-1 rounded-lg disabled:opacity-50"
                      >
                        <UserPlusIcon size={11} /> Add
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[88vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Channel-details dialog — overview + edit + members + invite link in one
 * place. The right-rail "more about this channel" surface that's been
 * missing.
 *
 *  - Overview tab: metadata (creator, age, member count, visibility) + an
 *    inline rename / re-describe form when the caller can edit.
 *  - Members tab: a thin wrapper over the existing RoomMembersDialog body
 *    so we don't fork the roster UI.
 *  - Invite tab: list active links + a one-click "Generate invite link"
 *    button. Copy-to-clipboard with toast confirmation; revoke beside
 *    each row.
 *
 * Permissions:
 *   - Edit: owner OR governance:write
 *   - Generate / revoke invite: any member (matches Slack's "anyone in
 *     the channel can pull a friend in" social model)
 *   - View: any member
 * ───────────────────────────────────────────────────────────────────────── */

type ChannelDetails = {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_default: boolean;
  is_private: boolean;
  is_owner: boolean;
  member_count: number;
  message_count: number;
  created_at: string;
  created_by?: { id: string; name: string; email: string };
};

type ChannelInvite = {
  id: string;
  token: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
};

function ChannelDetailsDialog({
  room, isAdmin, initialTab, onClose,
}: {
  room: Room;
  isAdmin: boolean;
  initialTab: "overview" | "members" | "invite";
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "members" | "invite">(initialTab);

  const { data: details } = useQuery<ChannelDetails>({
    queryKey: ["campfire", "room-detail", room.id],
    queryFn: () => api(`/api/v1/campfire/rooms/${room.id}`),
  });

  const canEdit = (details?.is_owner ?? room.is_owner ?? false) || isAdmin;
  const tabs: { key: typeof tab; label: string; icon: any; show: boolean }[] = [
    { key: "overview", label: "Overview",  icon: Info,      show: true },
    { key: "members",  label: "Members",   icon: UsersIcon, show: !!room.is_private },
    { key: "invite",   label: "Invite link", icon: LinkIcon, show: !!room.is_private },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-text flex items-center gap-2 min-w-0">
            {room.is_private ? <Lock size={14} className="text-warn shrink-0" /> : <Hash size={16} className="text-muted shrink-0" />}
            <span className="truncate">{details?.name ?? room.name}</span>
          </h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted shrink-0">
            <XIcon size={14} />
          </button>
        </header>

        {/* Tab strip */}
        <div className="px-3 pt-3 flex items-center gap-1 border-b border-border">
          {tabs.filter((t) => t.show).map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold rounded-t-lg border-b-2 transition-colors ${
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:text-text"
                }`}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "overview" && (
            <ChannelOverview
              room={room}
              details={details ?? null}
              canEdit={canEdit}
              onSaved={() => {
                qc.invalidateQueries({ queryKey: ["campfire", "room-detail", room.id] });
                qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
              }}
            />
          )}
          {tab === "members" && (
            <InlineMemberRoster room={room} />
          )}
          {tab === "invite" && (
            <InviteLinkPanel room={room} />
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelOverview({
  room, details, canEdit, onSaved,
}: {
  room: Room;
  details: ChannelDetails | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(details?.name ?? room.name);
  const [desc, setDesc] = useState(details?.description ?? room.description ?? "");

  useEffect(() => {
    if (details) {
      setName(details.name);
      setDesc(details.description);
    }
  }, [details?.id, details?.name, details?.description]);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/campfire/rooms/${room.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), description: desc.trim() }),
      }),
    onSuccess: () => {
      toast.success("Channel updated");
      setEditing(false);
      onSaved();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  const createdLabel = details?.created_at ? new Date(details.created_at).toLocaleString() : "—";

  return (
    <div className="space-y-5">
      {/* Editable block */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted">Channel</div>
          {canEdit && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
            >
              <Pencil size={11} /> Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-3">
            <label className="block">
              <div className="label">Name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <div className="label">Description</div>
              <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What this channel is for" />
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => { setEditing(false); setName(details?.name ?? room.name); setDesc(details?.description ?? ""); }}
                className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:bg-bg/40"
              >
                Cancel
              </button>
              <button
                disabled={save.isPending || name.trim().length < 2}
                onClick={() => save.mutate()}
                className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm font-bold text-text">{name}</div>
            <div className="text-[13px] text-muted mt-1">{desc || <span className="italic">No description yet.</span>}</div>
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 text-[12.5px]">
        <Meta label="Visibility" value={room.is_private ? "Private" : "Workspace-wide"} />
        <Meta label="Members" value={String(details?.member_count ?? room.member_count ?? "—")} />
        <Meta label="Messages" value={String(details?.message_count ?? room.message_count ?? 0)} />
        <Meta label="Created" value={createdLabel} />
        {details?.created_by && (
          <Meta label="Created by" value={details.created_by.name || details.created_by.email} wide />
        )}
        <Meta label="Slug" value={details?.slug ?? room.slug} mono wide />
      </div>

      {/* Share to the pulse feed — prefills an announcement post so the
          author lands on a "tell the workspace" surface instead of having
          to context-switch to Campfire and remember what to say. */}
      <ShareToCampfire
        title={`#${name} is open`}
        body={
          desc
            ? `🚀 Just spun up the **#${name}** channel — ${desc}\n\nDrop in to follow along.`
            : `🚀 Just spun up the **#${name}** channel. Drop in to follow along.`
        }
        label="Announce this channel in Campfire"
      />
    </div>
  );
}

// ShareToCampfire — a generic "shout this from the pulse feed" button
// used from the Channel details, Colleagues drawer, and anywhere else
// we want to invite a one-click broadcast. Clicking opens the global
// PostComposer with kind=announcement and pre-filled title + body so
// the author lands on a ready-to-post draft instead of a blank canvas.
function ShareToCampfire({ title, body, label }: { title: string; body: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl border border-accent/30 bg-accent-soft/40 text-accent hover:bg-accent-soft press-fx"
      >
        <MegaphoneIcon size={13} /> {label}
      </button>
      {open && (
        <PostComposer
          initialKind="announcement"
          initialTitle={title}
          initialBody={body}
          onClose={() => setOpen(false)}
          onCreated={() => setOpen(false)}
          allowPin={false}
        />
      )}
    </>
  );
}

function Meta({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`bg-bg/40 rounded-xl p-3 ${wide ? "col-span-2" : ""}`}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`mt-0.5 text-text font-semibold truncate ${mono ? "font-mono text-[12px]" : ""}`}>{value}</div>
    </div>
  );
}

function InlineMemberRoster({ room }: { room: Room }) {
  // Pulls the existing roster UI without forking it. RoomMembersDialog
  // renders its own modal chrome, but the body is just a list — we
  // mount it as a pass-through and rely on its onClose being a no-op
  // (we provide one, but never trigger it from inside).
  return <RoomMembersDialog room={room} onClose={() => {}} embedded />;
}

function InviteLinkPanel({ room }: { room: Room }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: ChannelInvite[] }>({
    queryKey: ["campfire", "room-invites", room.id],
    queryFn: () => api(`/api/v1/campfire/rooms/${room.id}/invites`),
  });
  const invites = data?.items ?? [];

  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`/api/v1/campfire/rooms/${room.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ expires_in_hours: 24 * 7 }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "room-invites", room.id] });
      toast.success("Invite link ready");
    },
    onError: (e: any) => toast.error("Couldn't generate link", e?.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/campfire/rooms/${room.id}/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "room-invites", room.id] });
      toast.success("Link revoked");
    },
  });

  function inviteUrl(token: string) {
    return `${window.location.origin}/campfire/join/${token}`;
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy", "Long-press the link to copy manually.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-accent-soft/40 border border-accent/20 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <LinkIcon size={16} className="text-accent shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-text">Shareable invite link</div>
            <div className="text-[12px] text-muted mt-0.5">
              Anyone in this workspace can open the link to join #{room.name}. Links last 7 days by default and can be revoked any time.
            </div>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60"
            >
              <Plus size={12} /> {create.isPending ? "Generating…" : "Generate invite link"}
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2">
          Active links {invites.length > 0 && <span className="text-muted/70 font-normal">· {invites.length}</span>}
        </div>
        {isLoading ? (
          <div className="text-[12px] text-muted">Loading…</div>
        ) : invites.length === 0 ? (
          <div className="text-[12px] text-muted italic">No active links yet. Generate one above to share with a teammate.</div>
        ) : (
          <ul className="space-y-2">
            {invites.map((iv) => {
              const url = inviteUrl(iv.token);
              const exp = iv.expires_at ? new Date(iv.expires_at).toLocaleDateString() : "never";
              return (
                <li key={iv.id} className="bg-bg/40 border border-border rounded-xl p-3 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11.5px] text-text truncate">{url}</div>
                    <div className="text-[10.5px] text-muted mt-0.5">
                      Expires {exp} · Used {iv.uses}{iv.max_uses != null ? ` / ${iv.max_uses}` : ""} times
                    </div>
                  </div>
                  <button
                    onClick={() => copy(iv.token)}
                    title="Copy link"
                    className="p-1.5 rounded-lg text-muted hover:bg-bg hover:text-accent"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={() => revoke.mutate(iv.id)}
                    title="Revoke link"
                    className="p-1.5 rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
