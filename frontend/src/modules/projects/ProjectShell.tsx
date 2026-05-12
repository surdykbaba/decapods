import { useEffect, useState } from "react";
import { NavLink, Outlet, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Activity, List as ListIcon, LayoutGrid, Calendar as CalendarIcon,
  Folder, Share2, Sparkles, Pencil, Check, X, Archive, AlertTriangle, Clock,
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
  // Optional dates — present on the list endpoint; the detail GET also
  // includes them. We use end_date as the canonical target delivery so the
  // header can render a "Target delivery" badge / overdue alert.
  start_date?: string | null;
  end_date?: string | null;
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
  const [autoOpen, setAutoOpen] = useState(false);
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
            onClick={() => setAutoOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-border bg-surface text-sm font-semibold text-text hover:border-accent hover:text-accent transition-colors"
          >
            <Sparkles size={14} /> Automation
          </button>
        </div>
      </header>

      {/* Closed-project banner — makes the "edits still work" fact explicit
          so users don't assume read-only and avoid the page. Also a reminder
          that task creation is blocked, paired with a quick re-open hint. */}
      {project?.status === "closed" && (
        <div className="bg-bg/40 border border-border rounded-2xl px-4 py-3 flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg grid place-items-center bg-success/10 text-success shrink-0">
            <Archive size={14} />
          </span>
          <div className="text-[12.5px] text-text">
            <span className="font-semibold">This project is closed.</span>{" "}
            <span className="text-muted">
              Project details, documents and tasks stay editable for corrections — but
              <span className="font-semibold text-text"> no new tasks can be created</span> until it's re-opened
              via the source Pipeline opportunity.
            </span>
          </div>
        </div>
      )}

      {/* Target delivery indicator — surfaces the end_date as a real status
          signal (on track / approaching / overdue) so the header always
          answers "are we late?" without leaving the page. Hidden when the
          project has no target or is already finished. */}
      {project && project.end_date && !["paid", "closed"].includes(project.status) && (() => {
        const tgt = new Date(project.end_date + (project.end_date.length === 10 ? "T00:00:00" : "")).getTime();
        const days = Math.ceil((tgt - Date.now()) / 86_400_000);
        const tgtFmt = new Date(tgt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
        let tone: "good" | "warn" | "bad" = "good";
        let label = `On track · ${days}d to target`;
        let icon: React.ReactNode = <Clock size={14} />;
        if (days < 0) {
          tone = "bad"; label = `${Math.abs(days)}d past target`; icon = <AlertTriangle size={14} />;
        } else if (days <= 7) {
          tone = "warn"; label = `Approaching target · ${days}d left`; icon = <AlertTriangle size={14} />;
        }
        const cls = tone === "bad"  ? "bg-danger/10 text-danger border-danger/30"
                  : tone === "warn" ? "bg-warn/10 text-warn border-warn/30"
                  : "bg-success/10 text-success border-success/30";
        return (
          <div className={`rounded-2xl border px-4 py-2.5 flex items-center gap-3 ${cls}`}>
            <span className="shrink-0">{icon}</span>
            <div className="text-[12.5px] flex-1">
              <span className="font-bold">{label}</span>
              <span className="opacity-80"> · target delivery {tgtFmt}</span>
            </div>
          </div>
        );
      })()}

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

      {autoOpen && id && (
        <AutomationDialog projectId={id} onClose={() => setAutoOpen(false)} />
      )}
    </div>
  );
}

/* ---------- Automation rules dialog ---------- */

type AutomationResp = {
  config: { auto_assign_lead: boolean; notify_lead_on_blocked: boolean };
  lead_id: string | null;
  lead_name: string;
  lead_email: string;
};

function AutomationDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<AutomationResp>({
    queryKey: ["project-automation", projectId],
    queryFn: () => api(`/api/v1/projects/${projectId}/automation`),
  });

  const [autoAssign, setAutoAssign] = useState(false);
  const [notifyBlocked, setNotifyBlocked] = useState(false);

  // Hydrate the local toggles once the GET lands. We watch the config object
  // directly so a refetch after save also re-syncs.
  useEffect(() => {
    if (data?.config) {
      setAutoAssign(data.config.auto_assign_lead);
      setNotifyBlocked(data.config.notify_lead_on_blocked);
    }
  }, [data?.config]);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${projectId}/automation`, {
        method: "PUT",
        body: JSON.stringify({
          auto_assign_lead: autoAssign,
          notify_lead_on_blocked: notifyBlocked,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-automation", projectId] });
      toast.success("Automation saved");
      onClose();
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  const leadLabel = data?.lead_name?.trim() || data?.lead_email || "Project creator";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-accent">Project automation</div>
            <h2 className="text-lg font-extrabold text-text mt-0.5 inline-flex items-center gap-2">
              <Sparkles size={18} className="text-accent" /> Rules
            </h2>
            <p className="text-xs text-muted mt-1">
              On a per-project basis. Lead is resolved to{" "}
              <span className="font-semibold text-text">{leadLabel}</span> — the team-member
              with a lead/manager role, or the project creator as a fallback.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text p-1.5 rounded hover:bg-bg" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted">Loading…</div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              <RuleRow
                title="Auto-assign new tasks to the lead"
                body="When someone creates a task without picking an assignee, route it to the project lead so nothing sits unowned."
                live
                checked={autoAssign}
                onChange={setAutoAssign}
              />
              <RuleRow
                title="Notify the lead when a task is blocked"
                body="The moment any task flips to ‘blocked', the lead gets a notification with the project + task name so they can step in."
                live
                checked={notifyBlocked}
                onChange={setNotifyBlocked}
              />

              <div className="pt-4 border-t border-border">
                <div className="text-[10.5px] uppercase tracking-wider font-bold text-muted mb-2">Planned</div>
                <div className="space-y-2 text-xs text-muted">
                  <PlannedRow title="Escalate tasks stuck in ‘blocked' >24h" />
                  <PlannedRow title="Auto-nudge assignee 1 day before due" />
                  <PlannedRow title="Auto-move to ‘review' when all subtasks done" />
                </div>
              </div>
            </div>

            <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
              <button onClick={onClose} className="text-sm text-muted hover:text-text px-3 py-2">Cancel</button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[rgb(var(--accent-hover))] disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save rules"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  title, body, live, checked, onChange,
}: {
  title: string; body: string; live?: boolean;
  checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-accent/40 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 w-4 h-4 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-text">{title}</span>
          {live && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-success/15 text-success">
              Active
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted mt-0.5 leading-relaxed">{body}</div>
      </div>
    </label>
  );
}

function PlannedRow({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-muted/50" />
      <span>{title}</span>
    </div>
  );
}
