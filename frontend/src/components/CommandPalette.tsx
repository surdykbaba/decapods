import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Search, X, ArrowRight, Briefcase, FolderKanban, LayoutDashboard,
  Settings, GitBranch, Wallet, ShieldCheck, Github, Users, FileSearch, Bell,
  CornerDownLeft, CheckSquare, MessageSquare, Scale, Loader2,
} from "lucide-react";

// Server search hit — flat, typed; the palette groups + decorates it.
type SearchHit = {
  type: "person" | "project" | "opportunity" | "task" | "post" | "legal";
  id: string;
  title: string;
  subtitle: string;
  url: string;
};

type Group =
  | "Quick actions" | "People" | "Projects" | "Opportunities"
  | "Tasks" | "Campfire" | "Legals" | "Navigate";

type Result = {
  id: string;
  group: Group;
  label: string;
  hint?: string;
  icon: React.ComponentType<any>;
  to?: string;
  onRun?: () => void;
};

const HIT_META: Record<SearchHit["type"], { group: Group; icon: React.ComponentType<any> }> = {
  person:      { group: "People",        icon: Users },
  project:     { group: "Projects",      icon: FolderKanban },
  opportunity: { group: "Opportunities", icon: Briefcase },
  task:        { group: "Tasks",         icon: CheckSquare },
  post:        { group: "Campfire",      icon: MessageSquare },
  legal:       { group: "Legals",        icon: Scale },
};

const GROUP_ORDER: Group[] = [
  "Quick actions", "People", "Projects", "Opportunities",
  "Tasks", "Campfire", "Legals", "Navigate",
];

const NAV_RESULTS: Result[] = [
  { id: "nav-dashboard", group: "Navigate", label: "Dashboard",  icon: LayoutDashboard, to: "/dashboard", hint: "Executive overview" },
  { id: "nav-pipeline",  group: "Navigate", label: "Pipeline",   icon: Briefcase,       to: "/pipeline",  hint: "Opportunities board" },
  { id: "nav-projects",  group: "Navigate", label: "Projects",   icon: FolderKanban,    to: "/projects",  hint: "Active engagements" },
  { id: "nav-settings",  group: "Navigate", label: "Settings",   icon: Settings,        to: "/settings",  hint: "Workspace settings" },
  { id: "nav-workflow",  group: "Navigate", label: "Approval workflow", icon: GitBranch, to: "/settings/workflow",   hint: "Stages and role gates" },
  { id: "nav-rates",     group: "Navigate", label: "Team rates", icon: Wallet,          to: "/settings/team-rates", hint: "Daily rates per role" },
  { id: "nav-policies",  group: "Navigate", label: "Governance policies", icon: ShieldCheck, to: "/settings/governance", hint: "Custom rules" },
  { id: "nav-audit",     group: "Navigate", label: "Audit log",  icon: FileSearch,      to: "/settings/audit",      hint: "Recent activity" },
  { id: "nav-github",    group: "Navigate", label: "GitHub integration", icon: Github,  to: "/settings/integrations/github", hint: "Linked repos" },
  { id: "nav-members",   group: "Navigate", label: "Members & roles",    icon: Users,    to: "/settings/members",    hint: "Who can do what" },
  { id: "nav-notifs",    group: "Navigate", label: "Notifications",      icon: Bell,     to: "/settings/notifications", hint: "Email & in-app rules" },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce the typed query so we hit /search at most ~5x/sec while
  // the user types, not on every keystroke.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  const { data: searchData, isFetching } = useQuery<{ items: SearchHit[] }>({
    queryKey: ["global-search", debounced],
    queryFn: () => api(`/api/v1/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  });

  // Static rows (quick actions + navigate) are always available and
  // filtered locally; server hits come from /search.
  const staticResults: Result[] = useMemo(() => {
    const quick: Result[] = [
      { id: "qa-new-opp", group: "Quick actions", label: "New opportunity", hint: "Open the wizard", icon: Briefcase, to: "/pipeline/new" },
    ];
    return [...quick, ...NAV_RESULTS];
  }, []);

  const serverResults: Result[] = useMemo(
    () =>
      (searchData?.items ?? []).map((h) => {
        const meta = HIT_META[h.type];
        return {
          id: `${h.type}-${h.id}`,
          group: meta.group,
          label: h.title || "(untitled)",
          hint: h.subtitle,
          icon: meta.icon,
          to: h.url,
        };
      }),
    [searchData],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const staticFiltered = !q
      ? staticResults
      : staticResults.filter(
          (r) => r.label.toLowerCase().includes(q) || (r.hint ?? "").toLowerCase().includes(q),
        );
    return [...staticFiltered, ...serverResults];
  }, [staticResults, serverResults, query]);

  // Group for rendering in a fixed, sensible order.
  const grouped = useMemo(() => {
    const groups = {} as Record<Group, Result[]>;
    GROUP_ORDER.forEach((g) => { groups[g] = []; });
    filtered.forEach((r) => { (groups[r.group] ||= []).push(r); });
    return GROUP_ORDER
      .map((g) => [g, groups[g]] as [Group, Result[]])
      .filter(([, list]) => list.length > 0);
  }, [filtered]);

  // Reset highlight when filtered changes
  useEffect(() => { setHighlight(0); }, [query]);
  // Focus input when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function run(result: Result) {
    onClose();
    if (result.onRun) result.onRun();
    if (result.to) nav(result.to);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlight]) run(filtered[highlight]);
    }
  }

  // Scroll the highlighted row into view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  if (!open) return null;

  let runningIdx = 0;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-[60] grid place-items-start pt-[14vh] p-4"
      role="dialog" aria-modal="true" aria-label="Command palette"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          {isFetching
            ? <Loader2 size={18} className="text-accent shrink-0 animate-spin" />
            : <Search size={18} className="text-muted shrink-0" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search people, projects, tasks, posts, legals…"
            className="flex-1 bg-transparent outline-none text-[15px] text-text placeholder:text-muted"
          />
          <kbd className="text-[11px] font-mono text-muted px-1.5 py-0.5 border border-border rounded">esc</kbd>
          <button onClick={onClose} className="text-muted hover:text-text p-1 -m-1">
            <X size={16} />
          </button>
        </div>

        <div ref={listRef} className="overflow-auto max-h-[55vh]">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              {isFetching ? (
                <div className="text-sm text-muted inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Searching…
                </div>
              ) : debounced.length >= 2 ? (
                <>
                  <div className="text-sm font-semibold text-text">No matches for “{debounced}”</div>
                  <div className="text-xs text-muted mt-1">Try a name, project code, task or post text.</div>
                </>
              ) : (
                <>
                  <div className="text-sm font-semibold text-text">Type to search</div>
                  <div className="text-xs text-muted mt-1">People, projects, tasks, Campfire posts, legals — at least 2 characters.</div>
                </>
              )}
            </div>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} className="py-1">
                <div className="px-4 py-1.5 text-[10.5px] uppercase tracking-[0.08em] font-bold text-muted">
                  {group}
                </div>
                {list.map((r) => {
                  const idx = runningIdx++;
                  const active = idx === highlight;
                  const Icon = r.icon;
                  return (
                    <button
                      key={r.id}
                      data-idx={idx}
                      onClick={() => run(r)}
                      onMouseMove={() => setHighlight(idx)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                        active ? "bg-accent text-white" : "text-text hover:bg-bg"
                      }`}
                    >
                      <span className={`w-7 h-7 rounded-full grid place-items-center shrink-0 ${
                        active ? "bg-white/20" : "bg-accent-soft text-accent"
                      }`}>
                        <Icon size={14} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <div className={`text-[14px] font-semibold truncate ${active ? "text-white" : "text-text"}`}>
                          {r.label}
                        </div>
                        {r.hint && (
                          <div className={`text-[12px] truncate ${active ? "text-white/80" : "text-muted"}`}>
                            {r.hint}
                          </div>
                        )}
                      </span>
                      {active && <CornerDownLeft size={14} className="opacity-80" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border bg-bg text-[11px] text-muted">
          <span className="inline-flex items-center gap-1"><kbd className="px-1.5 py-0.5 border border-border rounded bg-surface font-mono">↑</kbd><kbd className="px-1.5 py-0.5 border border-border rounded bg-surface font-mono">↓</kbd> navigate</span>
          <span className="inline-flex items-center gap-1"><kbd className="px-1.5 py-0.5 border border-border rounded bg-surface font-mono">↵</kbd> open</span>
          <span className="inline-flex items-center gap-1"><kbd className="px-1.5 py-0.5 border border-border rounded bg-surface font-mono">esc</kbd> dismiss</span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="text-text font-semibold">{filtered.length}</span> result{filtered.length === 1 ? "" : "s"}
            <ArrowRight size={11} />
          </span>
        </div>
      </div>
    </div>
  );
}
