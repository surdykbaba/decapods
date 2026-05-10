import { useState } from "react";
import { NavLink, Outlet, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Activity, List as ListIcon, LayoutGrid, Calendar as CalendarIcon,
  Folder, Share2, Sparkles, Pencil, Check, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import { toast } from "@/lib/toast";

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  budget?: number;
  opportunity_id?: string | null;
};

type Stakeholder = {
  id: string;
  name: string;
  role: string;
  kind: "internal" | "external";
  email?: string;
};

const TABS = [
  { to: "",           label: "Overview", icon: Activity },
  { to: "list",       label: "List",     icon: ListIcon },
  { to: "board",      label: "Board",    icon: LayoutGrid },
  { to: "calendar",   label: "Calendar", icon: CalendarIcon },
  { to: "files",      label: "Files",    icon: Folder },
];

export function ProjectShell() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: project } = useQuery<Project>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`), enabled: !!id,
  });
  const { data: stakeholdersData } = useQuery<{ items: Stakeholder[] }>({
    queryKey: ["project-stakeholders", id], queryFn: () => api(`/api/v1/projects/${id}/stakeholders`), enabled: !!id,
  });
  const stakeholders = stakeholdersData?.items ?? [];

  // "Owner" surfaced in the top bar = the stakeholder flagged as manager /
  // lead / sponsor. Falls back to the first stakeholder, then to a hint that
  // none is assigned. Used by the avatar in the header and by the Summary
  // panel on the Overview.
  const owner = stakeholders.find((s) => /manager|lead|sponsor|owner/i.test(s.role)) ?? stakeholders[0];

  // Inline rename via the pencil-icon button. PATCHes when committed and
  // reverts on Escape.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const rename = useMutation({
    mutationFn: (name: string) => api(`/api/v1/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project renamed");
      setEditing(false);
    },
    onError: (e: any) => toast.error("Rename failed", e?.message),
  });
  function startRename() {
    setDraft(project?.name ?? "");
    setEditing(true);
  }
  function commitRename() {
    const next = draft.trim();
    if (!next || next === project?.name) { setEditing(false); return; }
    rename.mutate(next);
  }

  function copyShareLink() {
    const url = `${window.location.origin}/projects/${id}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success("Share link copied", url),
      () => toast.error("Could not copy link"),
    );
  }

  return (
    <div className="space-y-5 max-w-[1400px]">
      <Link
        to="/projects"
        className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-muted hover:text-text"
      >
        <ArrowLeft size={13} /> All projects
      </Link>

      {/* Header — name (with edit), code chip, share / automation, owner avatar */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] font-mono font-bold text-muted">{project?.code ?? "—"}</span>
            {!editing ? (
              <>
                <h1 className="h1 leading-none truncate">{project?.name ?? "…"}</h1>
                <button
                  type="button"
                  onClick={startRename}
                  className="p-1.5 rounded-full text-muted hover:text-accent hover:bg-bg"
                  aria-label="Rename project"
                  title="Rename"
                >
                  <Pencil size={15} />
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 flex-1 max-w-xl">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditing(false);
                  }}
                  className="input text-2xl font-extrabold tracking-tight !py-1.5"
                  maxLength={200}
                />
                <button
                  onClick={commitRename}
                  className="p-2 rounded-full bg-accent text-white hover:bg-accent/90"
                  aria-label="Save name"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="p-2 rounded-full text-muted hover:text-text hover:bg-bg"
                  aria-label="Cancel rename"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          {project?.opportunity_id && (
            <Link
              to={`/pipeline/${project.opportunity_id}`}
              className="inline-block text-xs text-muted hover:text-accent mt-2"
            >
              ← back to source opportunity
            </Link>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[12px]" title={owner ? `${owner.name} · ${owner.role}` : "No owner assigned"}>
            <Avatar name={owner?.name} email={owner?.email} size={32} />
            <span className="text-muted hidden sm:inline">|</span>
          </div>
          <button
            type="button"
            onClick={copyShareLink}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-border bg-surface text-sm font-semibold text-text hover:border-accent hover:text-accent transition-colors"
          >
            <Share2 size={14} /> Share
          </button>
          <button
            type="button"
            onClick={() => toast.info?.("Automation rules", "Coming soon — gate stage transitions, auto-create tasks, escalate stale items.") ?? toast.success("Automation rules", "Coming soon.")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-border bg-surface text-sm font-semibold text-text hover:border-accent hover:text-accent transition-colors"
          >
            <Sparkles size={14} /> Automation
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <NavLink
            key={t.to || "overview"}
            to={t.to}
            end={t.to === ""}
            className={({ isActive }) =>
              `inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-px ${
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-text"
              }`
            }
          >
            <t.icon size={14} /> {t.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ project, stakeholders, owner }} />
    </div>
  );
}
