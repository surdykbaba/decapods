// CampfireUserPage — one person's Campfire timeline. Twitter-style: avatar,
// name, job title, post count + recent posts in reverse-chronological order.
// Reached by clicking a poster's name in the main Campfire feed.
//
// Data sources reused from elsewhere:
//   • GET /api/v1/members        — for identity (name, avatar, job title)
//   • GET /api/v1/campfire/posts?author_id=:id — the timeline itself
//
// No new endpoints; the author_id filter on /campfire/posts was wired in
// the same commit as this page.
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, Pin, Calendar } from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/Avatar";

type Member = {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
  job_title?: string;
  created_at: string;
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
};

function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 7 * 86400) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

// Same per-kind catalog as CampfirePage uses, trimmed to what the timeline
// needs (label + soft tint). Keeps the user page self-contained so it
// doesn't import from CampfirePage's internals.
const KIND_META: Record<string, { label: string; tint: string }> = {
  update:       { label: "Quick update",   tint: "bg-accent-soft text-accent" },
  win:          { label: "Win",            tint: "bg-success/15 text-success" },
  help:         { label: "Help wanted",    tint: "bg-warn/15 text-warn" },
  shoutout:     { label: "Shoutout",       tint: "bg-warn/15 text-warn" },
  question:     { label: "Question",       tint: "bg-accent-soft text-accent" },
  poll:         { label: "Poll",           tint: "bg-accent-soft text-accent" },
  announcement: { label: "Announcement",   tint: "bg-danger/15 text-danger" },
};

export function CampfireUserPage() {
  const { id } = useParams<{ id: string }>();
  const { data: members } = useQuery<{ items: Member[] }>({
    queryKey: ["members"],
    queryFn: () => api("/api/v1/members"),
    staleTime: 5 * 60_000,
  });
  const me = useMemo(() => (members?.items ?? []).find((m) => m.id === id) ?? null, [members, id]);

  const { data: postsData, isLoading } = useQuery<{ items: Post[] }>({
    queryKey: ["campfire-posts", "by-author", id],
    queryFn: () => api(`/api/v1/campfire/posts?author_id=${id}&limit=100`),
    enabled: !!id,
  });
  const posts = postsData?.items ?? [];

  // Quick tallies for the profile header — total posts, breakdown by kind
  // (so the user can see e.g. "12 updates · 4 wins"). Cheap to compute on
  // the client because the list is already capped at 100.
  const stats = useMemo(() => {
    const byKind: Record<string, number> = {};
    posts.forEach((p) => { byKind[p.kind] = (byKind[p.kind] ?? 0) + 1; });
    return { total: posts.length, byKind };
  }, [posts]);

  return (
    <div className="max-w-3xl space-y-4">
      <Link to="/campfire" className="text-[12px] text-muted hover:text-text inline-flex items-center gap-1">
        <ArrowLeft size={12} /> Back to Campfire
      </Link>

      {/* Profile header */}
      <header className="bg-surface border border-border rounded-2xl p-5 flex items-start gap-4">
        <Avatar name={me?.name ?? ""} email={me?.email ?? ""} src={me?.avatar_url} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-extrabold text-text leading-tight">{me?.name || me?.email || "Loading…"}</h1>
          {me?.job_title && <div className="text-[13px] text-muted mt-0.5">{me.job_title}</div>}
          <div className="mt-2 flex items-center gap-3 flex-wrap text-[12px] text-muted">
            {me?.created_at && (
              <span className="inline-flex items-center gap-1"><Calendar size={11} /> Joined {new Date(me.created_at).toLocaleDateString([], { month: "short", year: "numeric" })}</span>
            )}
            <span className="inline-flex items-center gap-1"><MessageCircle size={11} /> {stats.total} post{stats.total === 1 ? "" : "s"}</span>
          </div>
          {Object.keys(stats.byKind).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(stats.byKind).map(([k, n]) => {
                const meta = KIND_META[k] ?? { label: k, tint: "bg-bg text-muted border border-border" };
                return (
                  <span key={k} className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${meta.tint}`}>
                    {meta.label} · {n}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </header>

      {/* Timeline */}
      <section className="space-y-3">
        {isLoading ? (
          <div className="text-sm text-muted">Loading timeline…</div>
        ) : posts.length === 0 ? (
          <div className="bg-surface border border-border rounded-2xl p-6 text-center text-sm text-muted">
            No Campfire posts yet from this teammate.
          </div>
        ) : (
          posts.map((p) => {
            const meta = KIND_META[p.kind] ?? { label: p.kind, tint: "bg-bg text-muted border border-border" };
            return (
              <article
                key={p.id}
                className={`bg-surface border rounded-2xl px-4 py-3 ${p.pinned ? "border-accent/40 bg-accent-soft/20" : "border-border"}`}
              >
                <header className="flex items-center gap-2 flex-wrap text-[12px]">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${meta.tint}`}>
                    {meta.label}
                  </span>
                  <span className="text-muted" title={new Date(p.created_at).toLocaleString()}>{relTime(p.created_at)}</span>
                  {p.edited_at && <span className="text-[10.5px] text-muted italic">(edited)</span>}
                  {p.pinned && <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-accent font-semibold"><Pin size={10} /> Pinned</span>}
                </header>
                {p.title && <h3 className="mt-1 text-[13.5px] font-bold text-text">{p.title}</h3>}
                <p className="mt-1 text-[13.5px] text-text whitespace-pre-wrap leading-snug">{p.body}</p>
                <footer className="mt-2 flex items-center gap-3 text-[11px] text-muted">
                  <Link to={`/campfire#campfire-post-${p.id}`} className="hover:text-accent hover:underline inline-flex items-center gap-1">
                    <MessageCircle size={11} /> {p.comment_count} comment{p.comment_count === 1 ? "" : "s"}
                  </Link>
                </footer>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
