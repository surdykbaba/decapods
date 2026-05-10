import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, MessageSquare, Sparkles, HelpCircle, Trophy } from "lucide-react";
import { api } from "@/lib/api";

type Preview = {
  id: string;
  title: string;
  snippet: string;
  kind: string;
  created_at: string;
  author_name: string;
  author_email: string;
};

type UnreadResp = {
  count: number;
  post_count: number;
  comment_count: number;
  preview: Preview[];
  last_seen_at: string;
};

function relTime(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function iconFor(kind: string) {
  if (kind === "kudos")  return <Trophy size={13} />;
  if (kind === "help")   return <HelpCircle size={13} />;
  if (kind === "mood")   return <Sparkles size={13} />;
  return <MessageSquare size={13} />;
}

export function CampfireBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data } = useQuery<UnreadResp>({
    queryKey: ["campfire-unread"],
    queryFn: () => api("/api/v1/campfire/unread"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // POST mark-seen — fired when the user opens the dropdown OR navigates to
  // /campfire. Resets the badge.
  const markSeen = useMutation({
    mutationFn: () => api("/api/v1/campfire/mark-seen", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire-unread"] }),
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = data?.count ?? 0;
  const previews = data?.preview ?? [];

  function toggle() {
    setOpen((v) => {
      const next = !v;
      // Mark-seen on open so the badge resets immediately. We use isPending
      // guard rather than tracking "already-seen" to avoid double POSTs while
      // the dropdown is open.
      if (next && count > 0 && !markSeen.isPending) markSeen.mutate();
      return next;
    });
  }

  function openItem(p: Preview) {
    setOpen(false);
    nav(`/campfire#post-${p.id}`);
  }

  return (
    <div className="relative" ref={ref}>
      {/* The Campfire entry point lives in the top bar as a brand-coloured pill
          rather than a sidebar nav item. Animated flicker on the flame icon
          telegraphs that this is a "live" surface; the unread count rides on
          the right edge of the pill so it doesn't compete with the label. */}
      <button
        onClick={toggle}
        className="group relative inline-flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-full bg-gradient-to-br from-warn/15 via-accent-soft to-accent-soft hover:from-warn/20 hover:via-accent-soft hover:to-accent-soft border border-accent/30 text-text transition-all"
        aria-label={`Campfire${count ? ` (${count} unread)` : ""}`}
        title="Campfire"
      >
        <span className="relative grid place-items-center">
          <Flame size={16} className="text-warn animate-flicker" strokeWidth={2.5} />
        </span>
        <span className="text-[13px] font-bold tracking-tight text-accent">Campfire</span>
        {count > 0 && (
          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold grid place-items-center ml-0.5">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[380px] bg-surface border border-border rounded-xl shadow-card overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div>
              <div className="text-sm font-bold text-text inline-flex items-center gap-2">
                <Flame size={14} className="text-accent" /> Campfire
              </div>
              <div className="text-[11px] text-muted">
                {count === 0
                  ? "All caught up"
                  : `${count} new ${count === 1 ? "update" : "updates"} since you last looked`}
              </div>
            </div>
            <button
              onClick={() => { setOpen(false); nav("/campfire"); }}
              className="text-xs font-semibold text-accent hover:underline"
            >
              Open feed →
            </button>
          </header>

          <div className="max-h-[420px] overflow-y-auto">
            {previews.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="w-12 h-12 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
                  <Flame size={20} />
                </div>
                <div className="text-sm font-semibold text-text">Nothing new in the campfire</div>
                <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
                  Posts, kudos and asks-for-help from your workspace will show up here.
                </p>
                <button
                  onClick={() => { setOpen(false); nav("/campfire"); }}
                  className="mt-3 text-xs font-semibold text-accent hover:underline"
                >
                  Browse the campfire →
                </button>
              </div>
            ) : (
              <ul>
                {previews.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => openItem(p)}
                      className="w-full text-left px-4 py-3 flex gap-3 hover:bg-bg border-b border-border last:border-0"
                    >
                      <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0 text-xs font-bold">
                        {(p.author_name || p.author_email || "?").charAt(0).toUpperCase()}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-text truncate">
                          {p.title || p.author_name || p.author_email}
                        </div>
                        <div className="text-xs text-muted mt-0.5 line-clamp-2 break-words">
                          {p.snippet}
                        </div>
                        <div className="text-[11px] text-muted/70 mt-1 inline-flex items-center gap-1">
                          {iconFor(p.kind)} {p.author_name || p.author_email} · {relTime(p.created_at)}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <footer className="px-4 py-2.5 border-t border-border bg-bg/40 text-[11px] text-muted">
            Refreshes every 30s · paste any URL into a post and it'll be a clickable link.
          </footer>
        </div>
      )}
    </div>
  );
}
