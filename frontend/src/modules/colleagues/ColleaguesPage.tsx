import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Smile, Search, Mail, MessageCircle, Sparkles, Award,
  Users as UsersIcon, Hash, Calendar, X as XIcon,
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
  presence: "online" | "away" | "offline" | "dnd" | "leave" | string;
  seconds_since: number;
  created_at: string;
  last_seen_at: string | null;
};

type Resp = { items: Colleague[] };

const PRESENCE_LABEL: Record<string, string> = {
  online:  "Online",
  away:    "Away",
  offline: "Offline",
  dnd:     "Do not disturb",
  leave:   "On leave",
};

const PRESENCE_DOT: Record<string, string> = {
  online:  "bg-success",
  away:    "bg-warn",
  offline: "bg-muted/40",
  dnd:     "bg-danger",
  leave:   "bg-accent",
};

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

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["colleagues", "list"],
    queryFn: () => api("/api/v1/members"),
    refetchInterval: 60_000, // presence changes every minute
    staleTime: 30_000,
  });

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
        <div className="ml-auto relative">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, role"
            className="pl-7 pr-3 py-1.5 text-[12px] bg-bg/40 border border-border rounded-full w-56 no-cap"
          />
        </div>
      </div>

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
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 animate-stagger">
          {filtered.map((c) => (
            <ColleagueCard key={c.id} c={c} onOpen={() => setOpenId(c.id)} />
          ))}
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
          <Avatar name={c.name} email={c.email} size={44} />
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

function ColleagueDrawer({ c, onClose }: { c: Colleague; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [kudosText, setKudosText] = useState("");
  const [sendingKudos, setSendingKudos] = useState(false);

  const presenceCls = PRESENCE_DOT[c.presence] ?? "bg-muted/40";

  // Send kudos — reuses the existing Campfire kudos endpoint so the
  // recognition lands in the Recognition tab + triggers the notification
  // outbox the same way as in-Campfire kudos.
  const sendKudos = useMutation({
    mutationFn: () =>
      api("/api/v1/campfire/kudos", {
        method: "POST",
        body: JSON.stringify({ to_user_id: c.id, body: kudosText.trim() || "Appreciating you 🙌" }),
      }),
    onMutate: () => setSendingKudos(true),
    onSettled: () => setSendingKudos(false),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campfire", "kudos"] });
      toast.success("Kudos sent");
      setKudosText("");
    },
    onError: (e: any) => toast.error("Couldn't send kudos", e?.message),
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
                <Avatar name={c.name} email={c.email} size={56} />
                <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-surface ${presenceCls}`} />
              </div>
              <div className="min-w-0">
                <div className="text-base font-extrabold text-text truncate">{c.name || c.email.split("@")[0]}</div>
                <div className="text-[12px] text-muted truncate">{c.email}</div>
                <div className="text-[11px] mt-1 inline-flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${presenceCls}`} />
                  <span className="font-semibold text-muted">{PRESENCE_LABEL[c.presence] ?? c.presence}</span>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-bg text-muted shrink-0">
              <XIcon size={14} />
            </button>
          </div>
        </header>

        {/* Quick actions */}
        <div className="px-5 py-4 grid grid-cols-2 gap-2 border-b border-border">
          <button
            onClick={() => openDM.mutate()}
            disabled={openDM.isPending}
            className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx"
          >
            <MessageCircle size={13} /> {openDM.isPending ? "Opening…" : "Start a channel"}
          </button>
          <a
            href={`mailto:${c.email}`}
            className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl bg-bg/40 text-text hover:bg-bg/70 press-fx"
          >
            <Mail size={13} /> Email
          </a>
        </div>

        {/* Kudos */}
        <div className="px-5 py-4 flex-1 overflow-y-auto">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2 inline-flex items-center gap-1.5">
            <Award size={11} /> Send kudos
          </div>
          <textarea
            value={kudosText}
            onChange={(e) => setKudosText(e.target.value)}
            placeholder={`Tell ${(c.name || c.email).split(" ")[0]} what they crushed lately…`}
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
            </ul>
          </div>
        </div>
      </div>
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
