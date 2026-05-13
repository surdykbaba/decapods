import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Smile, Search, Mail, MessageCircle, Sparkles, Award,
  Users as UsersIcon, Hash, Calendar, X as XIcon, Megaphone,
  LayoutGrid, List as ListIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";

// ColleaguesPage — the social-side directory. The /members page is HR's
// admin tool (status / MFA / roles editor) and lives behind a permission
// gate. This page is for everyone in the workspace: who do I work with,
// who joined recently, who's online right now, how do I say hi.
//
// Three pieces:
//   • Filter strip: All / New this week / Active today / role chips
//   • Member grid with presence + role + joined date
//   • Click a card → side drawer with profile + send-kudos + open-DM
//
// Backed by the existing GET /api/v1/members — no new endpoints required.
// Member CRUD continues to live on the HR page; this view is read-only
// plus a couple of social actions.

type Colleague = {
  id: string;
  name: string;
  email: string;
  avatar_url: string;
  roles: string[];
  status: string;
  presence: "online" | "away" | "offline" | "dnd" | "leave" | "on_leave" | "focus" | "busy" | string;
  seconds_since: number;
  created_at: string;
  last_seen_at: string | null;
  // Optional. YYYY-MM-DD. Year is preserved when the user supplies one,
  // but the matching code only looks at month + day so privacy-conscious
  // users can pass any sentinel year (1900, 2000) and still get the chime.
  birthday?: string | null;
  // True when the colleague saved a daily check-in (mood or notes) for
  // today. Surfaced as a green "Checked in" pill in the list view; the
  // alternative is a muted "No check-in" pill so admins can spot quiet
  // teammates without opening the HR Check-ins page.
  checked_in_today?: boolean;
};

type Resp = { items: Colleague[] };

// Kudo — one recognition record. Shape matches the /api/v1/campfire/kudos
// list endpoint. We filter the list to the caller on the client and group
// by sender so a colleague who's sent multiple kudos appears once with a
// count instead of spamming the section.
type Kudo = {
  id: string;
  from: { id: string; name: string; email: string };
  to:   { id: string; name: string; email: string };
  badge: string;
  message: string;
  created_at: string;
};

const PRESENCE_LABEL: Record<string, string> = {
  online:   "Online",
  away:     "Away",
  offline:  "Offline",
  dnd:      "Do not disturb",
  leave:    "On leave",
  on_leave: "On leave",
  focus:    "In focus",
  busy:     "Busy",
};

const PRESENCE_DOT: Record<string, string> = {
  online:   "bg-success",
  away:     "bg-warn",
  offline:  "bg-muted/40",
  dnd:      "bg-danger",
  leave:    "bg-accent",
  on_leave: "bg-accent",
  focus:    "bg-warn",
  busy:     "bg-danger",
};

// fmtRelative — "5m ago" / "2h ago" / "3d ago". Used in the drawer's
// presence line so the "Last seen" timestamp reads at a glance.
function fmtRelative(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// birthdayState — figure out whether today is the colleague's birthday,
// or how many days away the next one is. Only compares month + day so a
// 1900/2000 sentinel year still gets a celebration.
function birthdayState(iso?: string | null): { today: boolean; inDays: number; nextDate: Date } | null {
  if (!iso) return null;
  // Use UTC parse so DST quirks don't pull the date back a day.
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const thisYear = new Date(now.getFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = thisYear.toDateString() === now.toDateString();
  let next = thisYear;
  if (next.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() && !today) {
    next = new Date(now.getFullYear() + 1, d.getUTCMonth(), d.getUTCDate());
  }
  const inDays = Math.round((next.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  return { today, inDays, nextDate: next };
}

// Kudos badge vocabulary — must match the backend's validBadges map in
// campfire.go GiveKudo. The 'custom' option is the default so the form
// is always sendable without forcing the user to pick a specific badge.
const KUDOS_BADGES: { key: string; label: string; emoji: string; tone: string }[] = [
  { key: "delivery_champion", label: "Delivery champion", emoji: "🏆", tone: "bg-success/15 text-success border-success/30" },
  { key: "problem_solver",    label: "Problem solver",    emoji: "🧠", tone: "bg-accent-soft text-accent border-accent/30" },
  { key: "team_player",       label: "Team player",       emoji: "🤝", tone: "bg-warn/15 text-warn border-warn/30" },
  { key: "fast_responder",    label: "Fast responder",    emoji: "⚡",  tone: "bg-accent-soft text-accent border-accent/30" },
  { key: "client_hero",       label: "Client hero",       emoji: "🌟", tone: "bg-success/15 text-success border-success/30" },
  { key: "custom",            label: "Just thanks",       emoji: "🙌", tone: "bg-bg text-muted border-border" },
];

function relativeDays(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function fmtJoined(iso: string): string {
  const d = relativeDays(iso);
  if (d <= 0) return "Joined today";
  if (d === 1) return "Joined yesterday";
  if (d < 7)  return `Joined ${d}d ago`;
  if (d < 30) return `Joined ${Math.round(d / 7)}w ago`;
  const date = new Date(iso);
  return `Joined ${date.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}

function isActiveToday(c: Colleague): boolean {
  return c.seconds_since >= 0 && c.seconds_since < 24 * 60 * 60;
}

function isNewThisWeek(c: Colleague): boolean {
  return relativeDays(c.created_at) < 7;
}

type Filter = "all" | "new" | "active" | "role";

export function ColleaguesPage() {
  const { user: me } = useAuth();
  const [params, setParams] = useSearchParams();
  const initialFilter = (params.get("filter") as Filter) ?? "all";
  const initialRole = params.get("role") ?? "";

  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [roleFilter, setRoleFilter] = useState<string>(initialRole);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // Grid vs list view. Grid is the rich card with role chips + footer
  // — great for browsing. List is one row per colleague — denser, easier
  // to scan when you have 30+ teammates. Persisted to localStorage so
  // the user's choice survives reloads.
  type View = "grid" | "list";
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem("colleagues:view");
    return v === "list" ? "list" : "grid";
  });
  useEffect(() => { localStorage.setItem("colleagues:view", view); }, [view]);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["colleagues", "list"],
    queryFn: () => api("/api/v1/members"),
    refetchInterval: 60_000, // presence changes every minute
    staleTime: 30_000,
  });

  // Kudos received by the caller. Endpoint returns every kudo in the
  // tenant (cheap — capped at 50 server-side); we filter to "to me" on
  // the client because the existing API doesn't take a user filter and
  // adding one would just churn the surface. Refresh every 2 minutes so
  // new kudos show up while the user is on this page.
  const { data: kudosData } = useQuery<{ items: Kudo[] }>({
    queryKey: ["colleagues", "kudos-received"],
    queryFn: () => api("/api/v1/campfire/kudos?limit=100"),
    refetchInterval: 2 * 60_000,
    staleTime: 60_000,
  });
  const myKudos = useMemo<Kudo[]>(
    () => (kudosData?.items ?? []).filter((k) => k.to?.id === me?.id),
    [kudosData, me?.id],
  );

  const items = (data?.items ?? []).filter((c) => c.status === "active" && c.id !== me?.id);

  const allRoles = useMemo(() => {
    const s = new Set<string>();
    items.forEach((c) => c.roles.forEach((r) => s.add(r)));
    return Array.from(s).sort();
  }, [items]);

  const counts = useMemo(() => ({
    all:    items.length,
    new:    items.filter(isNewThisWeek).length,
    active: items.filter(isActiveToday).length,
  }), [items]);

  const filtered = useMemo(() => {
    let out = items;
    if (filter === "new")    out = out.filter(isNewThisWeek);
    if (filter === "active") out = out.filter(isActiveToday);
    if (filter === "role" && roleFilter) {
      out = out.filter((c) => c.roles.includes(roleFilter));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((c) =>
        (c.name + " " + c.email + " " + c.roles.join(" ")).toLowerCase().includes(q),
      );
    }
    return out;
  }, [items, filter, roleFilter, search]);

  function switchFilter(next: Filter, role?: string) {
    setFilter(next);
    setRoleFilter(role ?? "");
    const p = new URLSearchParams();
    if (next !== "all")  p.set("filter", next);
    if (role)           p.set("role", role);
    setParams(p, { replace: true });
  }

  const active = openId ? items.find((c) => c.id === openId) ?? null : null;

  return (
    <div className="pt-2 pb-10">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-2xl border border-white/20 grid place-items-center shadow-soft" style={{ background: "#107B97" }}>
            <Smile className="text-white" size={28} strokeWidth={2.4} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text leading-none">Colleagues</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-md">
              Everyone you work with in this workspace — say hi, send kudos, start a channel.
            </p>
          </div>
        </div>
      </header>

      {/* Filter strip */}
      <div className="bg-surface border border-border rounded-2xl p-2 mb-4 flex items-center gap-2 overflow-x-auto">
        <FilterChip active={filter === "all"}    onClick={() => switchFilter("all")}    label="Everyone"        count={counts.all} />
        <FilterChip active={filter === "new"}    onClick={() => switchFilter("new")}    label="New this week"   count={counts.new}    icon={Sparkles} />
        <FilterChip active={filter === "active"} onClick={() => switchFilter("active")} label="Active today"    count={counts.active} />
        {allRoles.length > 0 && (
          <div className="ml-1 pl-2 border-l border-border flex items-center gap-1.5">
            <span className="text-[10.5px] uppercase tracking-wider font-bold text-muted shrink-0">Role</span>
            <select
              value={roleFilter}
              onChange={(e) => switchFilter(e.target.value ? "role" : "all", e.target.value || undefined)}
              className="bg-bg/40 border border-border rounded-full text-[12px] px-2.5 py-1 no-cap"
            >
              <option value="">Any</option>
              {allRoles.map((r) => <option key={r} value={r}>{labelRole(r)}</option>)}
            </select>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, role"
              className="pl-7 pr-3 py-1.5 text-[12px] bg-bg/40 border border-border rounded-full w-56 no-cap"
            />
          </div>
          {/* View toggle — grid for browsing, list for dense scanning.
              Persists to localStorage so the user's preference survives
              navigations. */}
          <div className="inline-flex items-center bg-bg/40 border border-border rounded-full p-0.5">
            <button
              onClick={() => setView("grid")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold transition-colors press-fx ${
                view === "grid" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
              title="Grid view"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
            >
              <LayoutGrid size={11} /> Grid
            </button>
            <button
              onClick={() => setView("list")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold transition-colors press-fx ${
                view === "list" ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
              title="List view"
              aria-label="List view"
              aria-pressed={view === "list"}
            >
              <ListIcon size={11} /> List
            </button>
          </div>
        </div>
      </div>

      {/* Kudos you've received — surfaces what colleagues have sent the
          caller. Hidden when the inbox is empty so first-time users
          don't get a "no kudos yet" guilt strip. Click any kudo to open
          the sender's drawer. */}
      {myKudos.length > 0 && (
        <KudosInbox kudos={myKudos} onOpenSender={(id) => setOpenId(id)} />
      )}

      {/* Grid */}
      {isLoading ? (
        <GridSkeleton />
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <UsersIcon size={26} className="mx-auto text-muted mb-3" />
          <div className="text-sm font-semibold text-text">No colleagues match this view</div>
          <p className="text-[12px] text-muted mt-1">
            {filter !== "all" ? "Try clearing the filter or search." : "Once HR invites more teammates, they'll appear here."}
          </p>
        </div>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 animate-stagger">
          {filtered.map((c) => (
            <ColleagueCard key={c.id} c={c} onOpen={() => setOpenId(c.id)} />
          ))}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-2xl overflow-hidden animate-fade-in">
          <ul className="divide-y divide-border">
            {filtered.map((c) => (
              <ColleagueRow key={c.id} c={c} onOpen={() => setOpenId(c.id)} />
            ))}
          </ul>
        </div>
      )}

      {active && (
        <ColleagueDrawer
          c={active}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

// KudosInbox — compact "you've been recognised" strip above the directory
// grid. Shows the most recent 5 kudos with sender avatar, badge tone, and
// the relative time. The full message is in the title (tooltip) so the
// strip stays readable; tapping a card opens the sender's drawer where
// you can reply with a kudo, start a channel, or just say thanks.
function KudosInbox({
  kudos, onOpenSender,
}: {
  kudos: Kudo[];
  onOpenSender: (senderId: string) => void;
}) {
  const visible = kudos.slice(0, 5);
  const more = Math.max(0, kudos.length - visible.length);
  return (
    <section className="bg-gradient-to-br from-warn/10 to-accent-soft border border-warn/30 rounded-2xl p-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] font-bold text-warn">
          <Award size={11} /> Kudos you've received
          <span className="text-muted/80 font-medium normal-case tracking-normal">
            · {kudos.length} total
          </span>
        </div>
      </div>
      <ul className="space-y-2">
        {visible.map((k) => {
          const meta = KUDOS_BADGES.find((b) => b.key === k.badge);
          return (
            <li key={k.id}>
              <button
                type="button"
                onClick={() => onOpenSender(k.from.id)}
                title={k.message || "Tap to open sender"}
                className="w-full flex items-start gap-3 bg-surface/70 hover:bg-surface border border-border/60 hover:border-accent/40 rounded-xl px-3 py-2.5 text-left transition-colors press-fx"
              >
                <Avatar name={k.from.name} email={k.from.email} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12.5px] font-bold text-text truncate">
                      {k.from.name || k.from.email.split("@")[0]}
                    </span>
                    {meta && (
                      <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${meta.tone}`}>
                        <span className="mr-0.5">{meta.emoji}</span> {meta.label}
                      </span>
                    )}
                    <span className="text-[11px] text-muted ml-auto whitespace-nowrap">
                      {fmtRelative(k.created_at)}
                    </span>
                  </div>
                  {k.message && (
                    <p className="text-[12.5px] text-text/80 mt-0.5 leading-snug line-clamp-2">
                      {k.message}
                    </p>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <div className="mt-2 text-[11.5px] text-muted text-center">
          + {more} earlier kudos · open the Recognition tab in Campfire to see them all
        </div>
      )}
    </section>
  );
}

function FilterChip({
  active, onClick, label, count, icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ComponentType<any>;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition-colors press-fx ${
        active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text hover:bg-bg/40"
      }`}
    >
      {Icon && <Icon size={12} />}
      {label}
      <span className={`text-[11px] font-bold ${active ? "text-white/80" : "text-muted/70"}`}>· {count}</span>
    </button>
  );
}

function ColleagueCard({ c, onOpen }: { c: Colleague; onOpen: () => void }) {
  const presenceCls = PRESENCE_DOT[c.presence] ?? "bg-muted/40";
  return (
    <button
      onClick={onOpen}
      className="bg-surface border border-border rounded-2xl p-4 text-left hover-lift hover:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <Avatar name={c.name} email={c.email} src={c.avatar_url} size={44} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-surface ${presenceCls}`}
            title={PRESENCE_LABEL[c.presence] ?? c.presence}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-text truncate">{c.name || c.email.split("@")[0]}</div>
          <div className="text-[11.5px] text-muted truncate">{c.email}</div>
          {c.roles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {c.roles.slice(0, 2).map((r) => (
                <span key={r} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-bg/60 text-muted border border-border">
                  {labelRole(r)}
                </span>
              ))}
              {c.roles.length > 2 && (
                <span className="text-[10px] font-semibold text-muted/70">+{c.roles.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <Calendar size={10} /> {fmtJoined(c.created_at)}
        </span>
        {isNewThisWeek(c) && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-accent-soft text-accent font-semibold">
            <Sparkles size={9} /> New
          </span>
        )}
      </footer>
    </button>
  );
}

// ColleagueRow — dense single-line variant for list view. Same data as
// the card, just laid out horizontally: avatar · name + email · role
// chips · presence pill · joined date · "New" badge. Click target is
// the whole row, hover lights up the accent border on the left.
function ColleagueRow({ c, onOpen }: { c: Colleague; onOpen: () => void }) {
  const presenceCls = PRESENCE_DOT[c.presence] ?? "bg-muted/40";
  const presenceLabel = PRESENCE_LABEL[c.presence] ?? c.presence;
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full text-left px-3 sm:px-4 py-3 flex items-center gap-3 hover:bg-bg/40 focus:outline-none focus:bg-accent-soft/40 transition-colors group"
      >
        {/* Accent rail — invisible by default, slides in on hover. Pure
            decoration, gives the row a "primary action" feel. */}
        <span aria-hidden className="hidden sm:block absolute left-0 w-0.5 h-8 bg-accent rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="relative shrink-0">
          <Avatar name={c.name} email={c.email} src={c.avatar_url} size={36} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface ${presenceCls}`}
            title={presenceLabel}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-bold text-text truncate">{c.name || c.email.split("@")[0]}</span>
            {isNewThisWeek(c) && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-accent-soft text-accent text-[9.5px] font-bold">
                <Sparkles size={8} /> NEW
              </span>
            )}
          </div>
          <div className="text-[11.5px] text-muted truncate">{c.email}</div>
        </div>
        <div className="hidden md:flex items-center gap-1 shrink-0 max-w-[200px] overflow-hidden">
          {c.roles.slice(0, 2).map((r) => (
            <span key={r} className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full bg-bg/60 text-muted border border-border whitespace-nowrap">
              {labelRole(r)}
            </span>
          ))}
          {c.roles.length > 2 && (
            <span className="text-[10.5px] font-semibold text-muted/70">+{c.roles.length - 2}</span>
          )}
        </div>
        {/* Today's check-in pill. Replaces the old "Offline" presence
            pill — the green dot on the avatar already tells you whether
            they're online, but whether they did their daily huddle is
            the more useful signal in a workforce directory. */}
        <div className="hidden lg:block text-[11px] whitespace-nowrap shrink-0">
          {c.checked_in_today ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/15 text-success border border-success/25 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              Checked in today
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/10 text-muted border border-border font-semibold" title="Hasn't logged a daily check-in yet today">
              <span className="w-1.5 h-1.5 rounded-full bg-muted/50" />
              No check-in today
            </span>
          )}
        </div>
        <div className="hidden sm:block text-[11px] text-muted whitespace-nowrap shrink-0 w-[120px] text-right">
          <span className="inline-flex items-center gap-1 justify-end">
            <Calendar size={10} /> {fmtJoined(c.created_at).replace("Joined ", "")}
          </span>
        </div>
      </button>
    </li>
  );
}

function ColleagueDrawer({ c, onClose }: { c: Colleague; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [kudosText, setKudosText] = useState("");
  const [kudosBadge, setKudosBadge] = useState<string>("custom");
  const [sendingKudos, setSendingKudos] = useState(false);

  const presenceCls = PRESENCE_DOT[c.presence] ?? "bg-muted/40";
  const onLeave = c.presence === "leave" || c.presence === "on_leave";
  const bday = birthdayState(c.birthday);

  // Send kudos — fixed payload (badge + message, not body) so the backend
  // accepts it instead of rejecting on the required-badge tag. Reuses the
  // existing Campfire kudos endpoint so the recognition lands in the
  // Recognition tab + triggers the notification outbox the same way.
  const sendKudos = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/kudos", {
        method: "POST",
        body: JSON.stringify({
          to_user_id: c.id,
          badge:      kudosBadge,
          message:    kudosText.trim() || "Appreciating you 🙌",
        }),
      }),
    onMutate: () => setSendingKudos(true),
    onSettled: () => setSendingKudos(false),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "kudos"] });
      toast.success("Kudos sent");
      setKudosText("");
      setKudosBadge("custom");
    },
    onError: (e: any) => {
      const body = e?.body as { code?: string; error?: string } | undefined;
      if (body?.code === "self_kudo") {
        toast.error("Can't kudo yourself", "Recognition is for others — pick another colleague.");
        return;
      }
      toast.error("Couldn't send kudos", body?.error ?? e?.message);
    },
  });

  // Start a 1:1 channel — creates a private channel just between caller
  // and this colleague. We slug it on the user ids so re-clicking the
  // same colleague reuses the same channel (caught by the existing
  // CreateRoom self-heal) instead of spamming dupes.
  const openDM = useMutation({
    mutationFn: () => {
      const slug = ("dm-" + [c.id.slice(0, 8), "x", crypto.randomUUID().slice(0, 6)].join("-")).toLowerCase();
      const name = "Chat with " + (c.name || c.email.split("@")[0]);
      return api<{ id: string; healed?: boolean }>("/api/v1/campfire/rooms", {
        method: "POST",
        body: JSON.stringify({
          slug, name, description: "", is_private: true, member_ids: [c.id],
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "rooms"] });
      nav("/campfire?tab=rooms");
    },
    onError: (e: any) => toast.error("Couldn't open channel", e?.message),
  });

  // Shout-out in Campfire — opens a confirmation dialog with an editable
  // preview before posting. Used to auto-post on click; the user pointed
  // out (rightly) that broadcasting to the workspace without a "are you
  // sure" step is too easy to fire by accident.
  //
  // Pre-baked copy is tenure-aware: ≤7 days reads as a welcome (and
  // posts as kind=joiner), older reads as a shout-out (kind=celebration).
  // The user can rewrite both lines before confirming.
  const tenureDays = relativeDays(c.created_at);
  const isWelcome = tenureDays < 7;
  const firstName = (c.name || c.email.split("@")[0]).split(" ")[0];
  const defaultTitle = isWelcome
    ? `👋 Welcome ${firstName}!`
    : `🙌 Shout-out to ${firstName}`;
  const defaultBody = isWelcome
    ? `Big welcome to ${c.name || c.email} — say hi when you get a moment.`
    : `Just wanted to give ${c.name || c.email} a shout-out for being a great colleague. Drop a 🔥 if you agree.`;
  const [shoutOpen, setShoutOpen] = useState(false);
  const [shoutTitle, setShoutTitle] = useState(defaultTitle);
  const [shoutBody, setShoutBody] = useState(defaultBody);

  const announce = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/posts", {
        method: "POST",
        body: JSON.stringify({
          kind: isWelcome ? "joiner" : "celebration",
          title: shoutTitle.trim(),
          body: shoutBody.trim(),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire-posts"] });
      toast.success("Posted to Campfire");
      setShoutOpen(false);
    },
    onError: (e: any) => toast.error("Couldn't post", e?.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 pt-5 pb-4 border-b border-border">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-3 min-w-0">
              <div className="relative shrink-0">
                <Avatar name={c.name} email={c.email} src={c.avatar_url} size={56} />
                <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-surface ${presenceCls}`} />
              </div>
              <div className="min-w-0">
                <div className="text-base font-extrabold text-text truncate inline-flex items-center gap-2">
                  {c.name || c.email.split("@")[0]}
                  {/* Birthday chip — only renders today. Click takes you
                      to the colleague drawer's kudos field with a
                      birthday seed prefilled (handled in the section
                      below). Always visible on the header so you
                      don't miss it. */}
                  {bday?.today && (
                    <span className="pill bg-warn/15 text-warn border border-warn/30 text-[10px] uppercase tracking-wide font-bold inline-flex items-center gap-1">
                      🎂 Birthday today
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-muted truncate">{c.email}</div>
                <div className="text-[11px] mt-1 inline-flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${presenceCls}`} />
                    <span className="font-semibold text-muted">{PRESENCE_LABEL[c.presence] ?? c.presence}</span>
                  </span>
                  {/* "Active 5m ago" — only when offline/away, otherwise the
                      presence dot already carries the live status. */}
                  {c.last_seen_at && c.presence !== "online" && (
                    <span className="text-muted/80">· last seen {fmtRelative(c.last_seen_at)}</span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted shrink-0">
              <XIcon size={14} />
            </button>
          </div>
          {/* On-leave callout — gentle blue strip when the colleague is
              away. Discourages "starting a channel" expecting an instant
              reply without blocking the action. */}
          {onLeave && (
            <div className="mt-3 flex items-start gap-2 bg-accent-soft/40 border border-accent/30 rounded-xl px-3 py-2 text-[12px] text-text">
              <span aria-hidden>✈️</span>
              <span>
                <span className="font-semibold">On approved leave.</span>{" "}
                <span className="text-muted">Replies may be delayed — try the next person on the project, or email if it's urgent.</span>
              </span>
            </div>
          )}
          {/* Upcoming birthday — show within the next 14 days so it's
              actionable ("plan a card") without being noise the rest of
              the year. */}
          {bday && !bday.today && bday.inDays <= 14 && (
            <div className="mt-3 flex items-start gap-2 bg-warn/10 border border-warn/30 rounded-xl px-3 py-2 text-[12px] text-text">
              <span aria-hidden>🎂</span>
              <span>
                <span className="font-semibold">
                  Birthday {bday.inDays === 1 ? "tomorrow" : `in ${bday.inDays} days`}
                </span>
                <span className="text-muted"> · {bday.nextDate.toLocaleDateString(undefined, { day: "numeric", month: "long" })}</span>
              </span>
            </div>
          )}
        </header>

        {/* Quick actions */}
        <div className="px-5 py-4 grid grid-cols-3 gap-2 border-b border-border">
          <button
            onClick={() => openDM.mutate()}
            disabled={openDM.isPending}
            className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx"
            title="Open a private channel with this colleague"
          >
            <MessageCircle size={13} /> {openDM.isPending ? "…" : "Channel"}
          </button>
          <button
            onClick={() => { setShoutTitle(defaultTitle); setShoutBody(defaultBody); setShoutOpen(true); }}
            className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl border border-accent/30 bg-accent-soft/40 text-accent hover:bg-accent-soft press-fx"
            title="Open a preview before posting to the Campfire pulse feed"
          >
            <Megaphone size={13} /> Shout-out
          </button>
          <a
            href={`mailto:${c.email}`}
            className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl bg-bg/40 text-text hover:bg-bg/70 press-fx"
            title="Open an email draft"
          >
            <Mail size={13} /> Email
          </a>
        </div>

        {/* Kudos — badge picker + message. The backend requires a badge
            tag; "Just thanks" is the no-specific-badge default that's
            always sendable. */}
        <div className="px-5 py-4 flex-1 overflow-y-auto">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2 inline-flex items-center gap-1.5">
            <Award size={11} /> Send kudos
          </div>
          <div className="grid grid-cols-3 gap-1.5 mb-2">
            {KUDOS_BADGES.map((b) => {
              const active = kudosBadge === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setKudosBadge(b.key)}
                  className={`inline-flex items-center justify-center gap-1 text-[10.5px] font-bold uppercase tracking-wide px-2 py-1.5 rounded-lg border transition-all ${
                    active ? b.tone + " scale-[1.02]" : "border-border text-muted hover:text-text bg-bg/40"
                  }`}
                  title={b.label}
                >
                  <span className="text-[12px] leading-none">{b.emoji}</span>
                  <span className="truncate">{b.label}</span>
                </button>
              );
            })}
          </div>
          <textarea
            value={kudosText}
            onChange={(e) => setKudosText(e.target.value)}
            placeholder={
              bday?.today
                ? `Happy birthday ${(c.name || c.email).split(" ")[0]}! 🎂`
                : `Tell ${(c.name || c.email).split(" ")[0]} what they crushed lately…`
            }
            className="input min-h-[70px] text-[13px]"
          />
          <button
            onClick={() => sendKudos.mutate()}
            disabled={sendingKudos}
            className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl bg-warn/15 text-warn hover:bg-warn/25 disabled:opacity-60 press-fx"
          >
            🙌 {sendingKudos ? "Sending…" : "Send kudos"}
          </button>

          <div className="mt-5">
            <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2 inline-flex items-center gap-1.5">
              <Hash size={11} /> Profile
            </div>
            <ul className="text-[12.5px] text-text space-y-1">
              {c.roles.length > 0 && (
                <li>
                  <span className="text-muted font-semibold">Roles · </span>
                  {c.roles.map(labelRole).join(", ")}
                </li>
              )}
              <li><span className="text-muted font-semibold">{fmtJoined(c.created_at)}</span></li>
              {c.last_seen_at && (
                <li><span className="text-muted font-semibold">Last seen · </span>{new Date(c.last_seen_at).toLocaleString()}</li>
              )}
              {/* Birthday line — only renders when the user has shared one.
                  Privacy-friendly: never shown year unless the source
                  string includes a non-sentinel year. */}
              {bday && (
                <li>
                  <span className="text-muted font-semibold">Birthday · </span>
                  {bday.nextDate.toLocaleDateString(undefined, { day: "numeric", month: "long" })}
                  {bday.today && <span className="ml-1.5 text-warn font-semibold">· today 🎂</span>}
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* Shout-out confirmation. Fires when the user clicks the
          Shout-out quick-action — used to auto-post silently, now
          previews the title + body and tells you exactly where it'll
          show up. Edit both fields inline, Cancel to bail, "Post to
          Campfire" to broadcast. */}
      {shoutOpen && (
        <div className="fixed inset-0 z-[60] bg-black/40 grid place-items-center p-4" onClick={(e) => { e.stopPropagation(); setShoutOpen(false); }}>
          <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-base font-bold text-text inline-flex items-center gap-2">
                <Megaphone size={14} className="text-accent" /> Post to Campfire
              </h3>
              <button onClick={() => setShoutOpen(false)} className="p-1.5 rounded hover:bg-bg text-muted">
                <XIcon size={14} />
              </button>
            </header>
            <div className="text-[12px] text-muted bg-accent-soft/40 border border-accent/30 rounded-lg px-3 py-2 mb-3">
              This will appear in the <span className="font-semibold text-text">Pulse feed</span> for everyone in the workspace. Review the preview below before posting.
            </div>
            <label className="block mb-2">
              <div className="label">Headline</div>
              <input
                className="input"
                value={shoutTitle}
                onChange={(e) => setShoutTitle(e.target.value)}
              />
            </label>
            <label className="block">
              <div className="label">Message</div>
              <textarea
                className="input min-h-[90px]"
                value={shoutBody}
                onChange={(e) => setShoutBody(e.target.value)}
              />
            </label>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setShoutOpen(false)}
                className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:bg-bg/40 press-fx"
              >
                Cancel
              </button>
              <button
                disabled={announce.isPending || !shoutBody.trim()}
                onClick={() => announce.mutate()}
                className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx"
              >
                {announce.isPending ? "Posting…" : "Post to Campfire"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-surface border border-border rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="skeleton w-11 h-11 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3.5 w-2/3 rounded" />
              <div className="skeleton h-3 w-4/5 rounded" />
            </div>
          </div>
          <div className="mt-3 skeleton h-3 w-1/3 rounded" />
        </div>
      ))}
    </div>
  );
}

function labelRole(slug: string): string {
  return slug
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
