import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  GraduationCap, Plus, ExternalLink, BookOpen, Clock, Tag,
  CheckCircle2, Play, ChevronRight, Sparkles, X as XIcon, Search,
  Filter, Users as UsersIcon, ListChecks, Send, Trash2, Pencil,
  Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";

// LearningPage — curated catalog + ordered paths + per-user
// assignments. Today the backend stores hand-entered links; the
// schema carries provider + external_id so a future LinkedIn
// Learning API sync drops in without a model change.
//
// Three tabs:
//   • Catalog  — browse + filter, "Add resource", "Start"
//   • My learning — what's assigned to me / I picked up
//   • Paths     — admin-curated curricula

type Tab = "catalog" | "mine" | "paths";

type Resource = {
  id: string;
  provider: string;
  external_id: string;
  external_url: string;
  title: string;
  description: string;
  topic: string;
  role_tags: string[];
  difficulty: string;
  duration_minutes: number | null;
  added_by: string | null;
  added_by_name: string;
  created_at: string;
};

type Assignment = {
  id: string;
  status: "pending" | "in_progress" | "completed" | "dropped";
  due_on: string | null;
  started_at: string | null;
  completed_at: string | null;
  hours_spent: number | null;
  notes: string;
  assigned_by: string | null;
  assigned_by_name: string;
  resource_id: string | null;
  resource_title: string;
  resource_url: string;
  provider: string;
  topic: string;
  duration_minutes: number | null;
  path_id: string | null;
  path_name: string;
};

type Path = {
  id: string;
  name: string;
  description: string;
  role: string;
  created_by: string | null;
  created_by_name: string;
  created_at: string;
  item_count: number;
};

const PROVIDERS: { value: string; label: string; color: string }[] = [
  { value: "linkedin_learning", label: "LinkedIn Learning", color: "bg-[#0a66c2]/15 text-[#0a66c2] border-[#0a66c2]/30" },
  { value: "coursera",          label: "Coursera",          color: "bg-[#0056d2]/15 text-[#0056d2] border-[#0056d2]/30" },
  { value: "pluralsight",       label: "Pluralsight",       color: "bg-[#f15b2a]/15 text-[#f15b2a] border-[#f15b2a]/30" },
  { value: "udemy",             label: "Udemy",             color: "bg-[#a435f0]/15 text-[#a435f0] border-[#a435f0]/30" },
  { value: "youtube",           label: "YouTube",           color: "bg-danger/15 text-danger border-danger/30" },
  { value: "internal",          label: "Internal",          color: "bg-accent-soft text-accent border-accent/30" },
  { value: "other",             label: "Other",             color: "bg-bg/60 text-muted border-border" },
];
function providerMeta(p: string) {
  return PROVIDERS.find((x) => x.value === p) ?? PROVIDERS[PROVIDERS.length - 1];
}

function fmtDuration(m: number | null | undefined) {
  if (m == null) return "—";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

export function LearningPage() {
  const { user } = useAuth();
  const isAdmin = !!user?.roles?.some((r) =>
    r === "super_admin" || r === "ceo" || r === "coo" || r === "hr");
  const [tab, setTab] = useState<Tab>("catalog");

  return (
    <div className="pt-2 pb-8 max-w-[1200px]">
      <header className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-accent-soft grid place-items-center border border-accent/30">
            <GraduationCap className="text-accent" size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text leading-none">Learning</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-md">
              Curated courses, internal paths, and team progress —
              read, watch, ship better.
            </p>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-1 mb-5 p-1 bg-surface/70 backdrop-blur border border-border rounded-full overflow-x-auto w-fit shadow-soft">
        {([
          { key: "catalog", label: "Catalog",    icon: BookOpen   },
          { key: "mine",    label: "My learning", icon: ListChecks },
          { key: "paths",   label: "Paths",      icon: Sparkles   },
        ] as { key: Tab; label: string; icon: any }[]).map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3.5 py-1.5 rounded-full transition-colors ${
                active ? "bg-accent text-white shadow-soft" : "text-muted hover:text-text"
              }`}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "catalog" && <CatalogTab isAdmin={isAdmin} />}
      {tab === "mine"    && <MineTab />}
      {tab === "paths"   && <PathsTab isAdmin={isAdmin} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Catalog

function CatalogTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 220);
    return () => clearTimeout(t);
  }, [search]);

  const [provider, setProvider] = useState("");
  const [topic, setTopic] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const params = new URLSearchParams();
  if (debounced) params.set("q", debounced);
  if (provider) params.set("provider", provider);
  if (topic) params.set("topic", topic);

  const { data, isLoading } = useQuery<{ items: Resource[] }>({
    queryKey: ["learning", "catalog", debounced, provider, topic],
    queryFn: () => api(`/api/v1/learning/resources?${params.toString()}`),
  });
  const items = data?.items ?? [];

  // Distinct topics surfaced as filter chips. Cheap client-side
  // aggregation — catalog is capped at 200 so it's negligible.
  const topics = useMemo(() => {
    const s = new Set<string>();
    items.forEach((r) => r.topic && s.add(r.topic));
    return Array.from(s).sort();
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or description…"
            className="w-full pl-9 pr-8 py-2 text-[13px] bg-surface border border-border rounded-full outline-none focus:border-accent transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text">
              <XIcon size={13} />
            </button>
          )}
        </div>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="text-[12.5px] bg-surface border border-border rounded-full px-3 py-1.5"
        >
          <option value="">All providers</option>
          {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        {topics.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setTopic("")}
              className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${
                topic === "" ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:border-accent/40"
              }`}
            >
              All topics
            </button>
            {topics.map((t) => (
              <button
                key={t}
                onClick={() => setTopic(t)}
                className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full border ${
                  topic === t ? "bg-accent text-white border-accent" : "bg-surface text-muted border-border hover:border-accent/40"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => setAddOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3.5 py-2 rounded-full hover:bg-[rgb(var(--accent-hover))] press-fx shadow-soft"
        >
          <Plus size={13} /> Add resource
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted py-10 text-center"><Loader2 className="inline animate-spin mr-2" size={14} /> Loading catalog…</div>
      ) : items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <BookOpen className="mx-auto text-muted mb-3" size={28} />
          <div className="text-sm font-semibold text-text">No resources yet</div>
          <div className="text-xs text-muted mt-1">
            {debounced || provider || topic
              ? "Try clearing your filters, or "
              : "Be the first to "}
            <button onClick={() => setAddOpen(true)} className="text-accent hover:underline font-semibold">add one →</button>
          </div>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((r) => (
            <CatalogCard key={r.id} resource={r} onChanged={() => qc.invalidateQueries({ queryKey: ["learning"] })} isAdmin={isAdmin} />
          ))}
        </ul>
      )}

      {addOpen && <AddResourceDialog onClose={() => setAddOpen(false)} onCreated={() => {
        setAddOpen(false);
        qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
      }} />}
    </div>
  );
}

function CatalogCard({ resource, onChanged, isAdmin }: {
  resource: Resource;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const { user } = useAuth();
  const meta = providerMeta(resource.provider);
  const canEdit = isAdmin || resource.added_by === user?.id;

  // Self-assign / mark "I'm doing this" — POST /learning/assignments
  // with user_id = me. Idempotent server-side, so a rapid click won't
  // dupe.
  const start = useMutation({
    mutationFn: () =>
      api("/api/v1/learning/assignments", {
        method: "POST",
        body: JSON.stringify({ user_id: user?.id, resource_id: resource.id }),
      }),
    onSuccess: () => {
      toast.success("Added to your learning", "Mark it in_progress and head over to the page.");
      onChanged();
    },
    onError: (e: any) => toast.error("Couldn't add", e?.message),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/v1/learning/resources/${resource.id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Removed"); onChanged(); },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });

  return (
    <li className="bg-surface border border-border rounded-2xl p-4 hover-lift transition-colors">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${meta.color}`}>
              {meta.label}
            </span>
            {resource.topic && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-muted">
                <Tag size={9} /> {resource.topic}
              </span>
            )}
            {resource.duration_minutes != null && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-muted">
                <Clock size={9} /> {fmtDuration(resource.duration_minutes)}
              </span>
            )}
            {resource.difficulty && resource.difficulty !== "all" && (
              <span className="text-[10.5px] text-muted">· {resource.difficulty}</span>
            )}
          </div>
          <a
            href={resource.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[14px] font-bold text-text hover:text-accent transition-colors"
          >
            {resource.title}
          </a>
          {resource.description && (
            <p className="text-[12px] text-muted mt-1 leading-snug line-clamp-2">{resource.description}</p>
          )}
          <div className="text-[10.5px] text-muted mt-2">
            Added by {resource.added_by_name || "someone"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/60">
        <button
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="inline-flex items-center gap-1.5 text-[12px] font-bold bg-accent-soft text-accent border border-accent/30 px-3 py-1.5 rounded-full hover:bg-accent/10 press-fx disabled:opacity-60"
        >
          <Play size={11} /> {start.isPending ? "Adding…" : "Start"}
        </button>
        <a
          href={resource.external_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted hover:text-text px-2.5 py-1.5"
        >
          Open <ExternalLink size={11} />
        </a>
        {canEdit && (
          <button
            onClick={() => { if (confirm("Remove this resource?")) del.mutate(); }}
            className="ml-auto text-muted hover:text-danger p-1.5"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </li>
  );
}

function AddResourceDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [topic, setTopic] = useState("");
  const [provider, setProvider] = useState("other");
  const [difficulty, setDifficulty] = useState("all");
  const [duration, setDuration] = useState<string>("");
  const [roleTags, setRoleTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  // Provider auto-detect: guess from the URL so the curator doesn't
  // have to think. Falls back to "other" — they can correct it.
  useEffect(() => {
    const u = url.toLowerCase();
    if (!u) return;
    if (u.includes("linkedin.com/learning"))     setProvider("linkedin_learning");
    else if (u.includes("coursera.org"))         setProvider("coursera");
    else if (u.includes("pluralsight.com"))      setProvider("pluralsight");
    else if (u.includes("udemy.com"))            setProvider("udemy");
    else if (u.includes("youtube.com") || u.includes("youtu.be")) setProvider("youtube");
  }, [url]);

  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/learning/resources", {
        method: "POST",
        body: JSON.stringify({
          external_url: url.trim(),
          title: title.trim(),
          description: description.trim(),
          topic: topic.trim(),
          provider,
          difficulty,
          duration_minutes: duration ? parseInt(duration, 10) : null,
          role_tags: roleTags,
        }),
      }),
    onSuccess: () => { toast.success("Added"); onCreated(); },
    onError: (e: any) => toast.error("Couldn't add", e?.message),
  });

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t || roleTags.includes(t)) return;
    setRoleTags([...roleTags, t]);
    setTagInput("");
  }

  const ready = url.trim() && title.trim() && !save.isPending;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">New resource</div>
            <h2 className="text-base font-bold text-text mt-0.5 inline-flex items-center gap-2"><BookOpen size={14} className="text-accent" /> Add to catalog</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><XIcon size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="label">URL</div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.linkedin.com/learning/…"
              className="input w-full text-sm"
              autoFocus
            />
            <div className="text-[10.5px] text-muted mt-1">Paste a link from LinkedIn Learning, Coursera, Pluralsight, Udemy, YouTube, or anywhere.</div>
          </label>
          <label className="block">
            <div className="label">Title</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input w-full text-sm" placeholder="What's this called?" />
          </label>
          <label className="block">
            <div className="label">Why this matters <span className="text-muted font-normal">(optional)</span></div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="input w-full text-sm" rows={3} placeholder="A sentence telling teammates when to take this." />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <div className="label">Provider</div>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="input w-full text-sm">
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="label">Difficulty</div>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="input w-full text-sm">
                <option value="all">All</option>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Duration (min)</div>
              <input value={duration} onChange={(e) => setDuration(e.target.value.replace(/[^0-9]/g, ""))} className="input w-full text-sm" placeholder="60" />
            </label>
          </div>
          <label className="block">
            <div className="label">Topic <span className="text-muted font-normal">(e.g. security, leadership)</span></div>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} className="input w-full text-sm" placeholder="security" />
          </label>
          <div>
            <div className="label">Role tags <span className="text-muted font-normal">(engineer, pm, hr…)</span></div>
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                className="input flex-1 text-sm" placeholder="engineer"
              />
              <button onClick={addTag} className="text-[12.5px] font-bold bg-bg/40 border border-border px-3 py-1.5 rounded-lg hover:bg-bg">Add</button>
            </div>
            {roleTags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-2">
                {roleTags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-soft text-accent text-[10.5px] font-semibold border border-accent/30">
                    {t}
                    <button onClick={() => setRoleTags(roleTags.filter((x) => x !== t))}><XIcon size={9} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-text px-3 py-1.5 rounded-lg">Cancel</button>
          <button disabled={!ready} onClick={() => save.mutate()} className="text-[12.5px] font-bold bg-accent text-white px-4 py-1.5 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx">
            {save.isPending ? "Adding…" : "Add to catalog"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// My learning

type MyLearningResp = {
  items: Assignment[];
  stats: { pending: number; in_progress: number; completed: number; dropped: number };
};

function MineTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<MyLearningResp>({
    queryKey: ["learning", "mine"],
    queryFn: () => api("/api/v1/me/learning"),
    refetchInterval: 60_000,
  });
  const items = data?.items ?? [];
  const stats = data?.stats ?? { pending: 0, in_progress: 0, completed: 0, dropped: 0 };

  const update = useMutation({
    mutationFn: (args: { id: string; body: any }) =>
      api(`/api/v1/learning/assignments/${args.id}`, { method: "PATCH", body: JSON.stringify(args.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learning", "mine"] }),
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  const grouped = useMemo(() => {
    const g: Record<string, Assignment[]> = { in_progress: [], pending: [], completed: [], dropped: [] };
    items.forEach((a) => { (g[a.status] ||= []).push(a); });
    return g;
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="In progress" value={stats.in_progress} tone="text-accent" />
        <Stat label="Up next" value={stats.pending} tone="text-text" />
        <Stat label="Completed" value={stats.completed} tone="text-success" />
        <Stat label="Dropped" value={stats.dropped} tone="text-muted" />
      </div>

      {isLoading ? (
        <div className="text-sm text-muted py-10 text-center"><Loader2 className="inline animate-spin mr-2" size={14} /> Loading…</div>
      ) : items.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <Sparkles className="mx-auto text-muted mb-3" size={26} />
          <div className="text-sm font-semibold text-text">Nothing in your queue yet</div>
          <div className="text-xs text-muted mt-1">Hit the <b>Catalog</b> tab and start a course.</div>
        </div>
      ) : (
        <div className="space-y-5">
          {(["in_progress", "pending", "completed", "dropped"] as const).map((s) => {
            const rows = grouped[s] ?? [];
            if (rows.length === 0) return null;
            const label = ({ in_progress: "In progress", pending: "Up next", completed: "Completed", dropped: "Dropped" } as const)[s];
            return (
              <section key={s}>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted mb-2">{label} <span className="text-text/70">· {rows.length}</span></h3>
                <ul className="space-y-2">
                  {rows.map((a) => (
                    <AssignmentRow
                      key={a.id}
                      a={a}
                      onStatus={(status) => update.mutate({ id: a.id, body: { status } })}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-4">
      <div className="text-[10.5px] uppercase tracking-wider text-muted font-bold">{label}</div>
      <div className={`text-3xl font-extrabold mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

function AssignmentRow({ a, onStatus }: {
  a: Assignment;
  onStatus: (s: Assignment["status"]) => void;
}) {
  const meta = providerMeta(a.provider);
  const isAssigned = !!a.assigned_by;
  return (
    <li className="bg-surface border border-border rounded-2xl p-3.5 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          {a.resource_title && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${meta.color}`}>{meta.label}</span>
          )}
          {a.path_name && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-accent-soft text-accent border border-accent/30">
              <Sparkles size={9} /> Path · {a.path_name}
            </span>
          )}
          {isAssigned && (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-muted" title={`Assigned by ${a.assigned_by_name}`}>
              <Send size={9} /> by {a.assigned_by_name}
            </span>
          )}
          {a.due_on && (
            <span className="text-[10.5px] text-warn font-semibold">due {new Date(a.due_on).toLocaleDateString()}</span>
          )}
          {a.duration_minutes != null && (
            <span className="text-[10.5px] text-muted">· {fmtDuration(a.duration_minutes)}</span>
          )}
        </div>
        {a.resource_url ? (
          <a href={a.resource_url} target="_blank" rel="noopener noreferrer" className="text-[13.5px] font-bold text-text hover:text-accent">
            {a.resource_title || "(untitled)"}
          </a>
        ) : (
          <span className="text-[13.5px] font-bold text-text">{a.resource_title || a.path_name || "(untitled)"}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {a.status === "pending" && (
          <button onClick={() => onStatus("in_progress")} className="text-[11.5px] font-bold bg-accent-soft text-accent border border-accent/30 px-2.5 py-1 rounded-full hover:bg-accent/10 press-fx">
            <Play size={10} className="inline mr-1" /> Start
          </button>
        )}
        {a.status === "in_progress" && (
          <button onClick={() => onStatus("completed")} className="text-[11.5px] font-bold bg-success/15 text-success border border-success/30 px-2.5 py-1 rounded-full hover:bg-success/25 press-fx">
            <CheckCircle2 size={10} className="inline mr-1" /> Mark done
          </button>
        )}
        {a.status === "completed" && (
          <span className="text-[11.5px] font-bold text-success inline-flex items-center gap-1">
            <CheckCircle2 size={11} /> Completed
            {a.completed_at && <span className="text-muted font-normal">· {new Date(a.completed_at).toLocaleDateString()}</span>}
          </span>
        )}
        {a.status !== "dropped" && a.status !== "completed" && (
          <button onClick={() => { if (confirm("Drop this from your queue?")) onStatus("dropped"); }} className="text-[11.5px] text-muted hover:text-danger px-2 py-1">
            Drop
          </button>
        )}
      </div>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Paths

function PathsTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useQuery<{ items: Path[] }>({
    queryKey: ["learning", "paths"],
    queryFn: () => api("/api/v1/learning/paths"),
  });
  const paths = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[12.5px] text-muted max-w-md">
          A <b>path</b> is an ordered set of resources for a role or level —
          "New PM onboarding", "Security foundations". Managers assign paths
          to reports; reports work through them.
        </p>
        {isAdmin && (
          <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1.5 text-[12.5px] font-bold bg-accent text-white px-3.5 py-2 rounded-full hover:bg-[rgb(var(--accent-hover))] press-fx shadow-soft">
            <Plus size={13} /> New path
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted py-10 text-center"><Loader2 className="inline animate-spin mr-2" size={14} /> Loading paths…</div>
      ) : paths.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-10 text-center">
          <Sparkles className="mx-auto text-muted mb-3" size={26} />
          <div className="text-sm font-semibold text-text">No paths yet</div>
          <div className="text-xs text-muted mt-1">
            {isAdmin
              ? <>Curate one — start with onboarding for a specific role.</>
              : <>Your admins haven't published any paths yet.</>}
          </div>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {paths.map((p) => (
            <li key={p.id} className="bg-surface border border-border rounded-2xl p-4 hover-lift">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-soft text-accent border border-accent/30 grid place-items-center shrink-0">
                  <Sparkles size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-bold text-text">{p.name}</div>
                  {p.role && <div className="text-[11px] text-muted">For {p.role}</div>}
                  {p.description && <p className="text-[12px] text-muted mt-1 leading-snug line-clamp-2">{p.description}</p>}
                  <div className="text-[10.5px] text-muted mt-2">
                    {p.item_count} item{p.item_count === 1 ? "" : "s"} · curated by {p.created_by_name || "—"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/60">
                <Link to={`/learning/paths/${p.id}`} className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline">
                  View path <ChevronRight size={12} />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {createOpen && <CreatePathDialog onClose={() => setCreateOpen(false)} onCreated={() => {
        setCreateOpen(false);
        qc.invalidateQueries({ queryKey: ["learning", "paths"] });
      }} />}
    </div>
  );
}

function CreatePathDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/learning/paths", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim(), role: role.trim() }),
      }),
    onSuccess: () => { toast.success("Path created"); onCreated(); },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });
  const ready = name.trim() && !save.isPending;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <h2 className="text-base font-bold text-text inline-flex items-center gap-2"><Sparkles size={14} className="text-accent" /> New path</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><XIcon size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="label">Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input w-full text-sm" placeholder="New PM ramp" autoFocus />
          </label>
          <label className="block">
            <div className="label">Target role <span className="text-muted font-normal">(optional)</span></div>
            <input value={role} onChange={(e) => setRole(e.target.value)} className="input w-full text-sm" placeholder="pm" />
          </label>
          <label className="block">
            <div className="label">Description</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="input w-full text-sm" rows={3} placeholder="What does someone know after finishing this?" />
          </label>
        </div>
        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-text px-3 py-1.5 rounded-lg">Cancel</button>
          <button disabled={!ready} onClick={() => save.mutate()} className="text-[12.5px] font-bold bg-accent text-white px-4 py-1.5 rounded-full hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60 press-fx">
            {save.isPending ? "Saving…" : "Create path"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Silenced parked imports — kept around for future filter / inline-edit
// affordances on the catalog cards.
void Filter; void UsersIcon; void Pencil;
