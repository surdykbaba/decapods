// ProjectFilesTab — two stacked sections:
//   • Project files: first-class uploads with metadata + visibility. The
//     project manager uploads change requests, architecture diagrams, scope
//     addenda etc. via the Upload dialog on the Overview tab.
//   • Statutory / opportunity documents: the compliance pack from the source
//     opportunity (NDA, MSA etc.). Kept read-only here so users see one
//     unified list without having to jump back to the pipeline.
import { useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Download, UploadCloud, Search, Trash2, Globe, Users as TeamIcon,
  Crown, Lock, Filter,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar } from "@/components/Avatar";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/lib/confirm";

type ProjectMeta = { opportunity_id?: string | null };
type OppDoc = {
  id: string;
  kind: string;
  name: string;
  object_key: string;
  uploaded_at: string;
};
type ProjectFile = {
  id: string;
  name: string;
  description: string;
  kind: string;
  visibility: "workspace" | "team" | "leads" | "private";
  tags: string[];
  mime: string;
  size_bytes: number;
  version: number;
  uploaded_by: string;
  uploaded_by_name: string;
  uploaded_by_email: string;
  created_at: string;
  download_url: string;
};

const KIND_LABEL: Record<string, string> = {
  architecture: "Architecture",
  change_request: "Change request",
  scope: "Scope",
  design: "Design",
  contract: "Contract",
  spec: "Spec",
  meeting_notes: "Meeting notes",
  reference: "Reference",
  other: "Other",
};

const VIS_META: Record<ProjectFile["visibility"], { label: string; icon: React.ComponentType<any>; cls: string }> = {
  workspace: { label: "Workspace",    icon: Globe,   cls: "bg-accent-soft text-accent" },
  team:      { label: "Project team", icon: TeamIcon, cls: "bg-success/10 text-success" },
  leads:     { label: "Leads only",   icon: Crown,   cls: "bg-warn/15 text-warn" },
  private:   { label: "Private",      icon: Lock,    cls: "bg-bg text-muted border border-border" },
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectFilesTab() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { token } = useAuth();
  const { project } = useOutletContext<{ project: ProjectMeta | undefined }>();

  // Live project files (visibility-filtered at the API).
  const { data: filesData, isLoading } = useQuery<{ items: ProjectFile[] }>({
    queryKey: ["project-files", id],
    queryFn: () => api(`/api/v1/projects/${id}/files`),
    enabled: !!id,
  });
  const files = filesData?.items ?? [];

  // Source opportunity documents (legacy / statutory).
  const { data: opp } = useQuery<{ documents?: OppDoc[] }>({
    queryKey: ["opp", project?.opportunity_id],
    queryFn: () => api(`/api/v1/opportunities/${project?.opportunity_id}`),
    enabled: !!project?.opportunity_id,
  });
  const oppDocs = opp?.documents ?? [];

  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/v1/projects/${id}/files/${fileId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-files", id] });
      toast.success("File deleted");
    },
    onError: (e: any) => toast.error("Could not delete", e?.message),
  });

  // Filters
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return files.filter((f) => {
      if (kind && f.kind !== kind) return false;
      if (!needle) return true;
      return [
        f.name, f.description, f.uploaded_by_name, f.uploaded_by_email, ...f.tags,
      ].some((s) => s && s.toLowerCase().includes(needle));
    });
  }, [files, q, kind]);

  // Streaming download — we attach Authorization on the fetch, then save the
  // blob. This avoids a public download URL on a private project file.
  async function download(f: ProjectFile) {
    try {
      const res = await fetch(f.download_url, {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Could not download", (e as Error).message);
    }
  }

  async function askDelete(f: ProjectFile) {
    const ok = await confirmAction({
      title: `Delete ${f.name}?`,
      body: "This removes the file from the project. It can't be undone from the UI.",
      confirmLabel: "Delete file",
      danger: true,
    });
    if (ok) remove.mutate(f.id);
  }

  return (
    <div className="space-y-4">
      {/* Header + filters */}
      <div className="bg-surface border border-border rounded-2xl px-5 py-4 flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-text">Project files</h2>
          <p className="text-[11px] text-muted">
            Working artefacts uploaded by the team. Use <strong>Upload a File</strong>
            {" "}on the Overview tab to add more.
          </p>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, tag, uploader…"
            className="pl-8 pr-3 py-2 bg-bg border border-border rounded-lg text-sm w-56"
          />
        </div>
        <div className="relative">
          <Filter size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="pl-8 pr-3 py-2 bg-bg border border-border rounded-lg text-sm"
          >
            <option value="">All types</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* Project file list */}
      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <UploadCloud size={28} className="text-muted mx-auto mb-2" />
            <div className="text-sm font-semibold text-text">
              {files.length === 0 ? "No project files yet" : "Nothing matches"}
            </div>
            <div className="text-xs text-muted mt-1 max-w-md mx-auto">
              {files.length === 0
                ? "Click Upload a File on the Overview tab to attach architecture diagrams, change requests, scope notes, etc."
                : "Try clearing the search or type filter."}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((f) => {
              const v = VIS_META[f.visibility];
              const VIcon = v.icon;
              return (
                <li key={f.id} className="px-5 py-3 flex items-start gap-3">
                  <span className="w-10 h-10 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
                    <FileText size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-text truncate">{f.name}</span>
                      <span className="pill bg-bg text-muted border border-border text-[10.5px]">
                        {KIND_LABEL[f.kind] ?? f.kind}
                      </span>
                      <span className={`pill text-[10.5px] inline-flex items-center gap-1 ${v.cls}`}>
                        <VIcon size={10} /> {v.label}
                      </span>
                      {f.version > 1 && (
                        <span className="pill bg-warn/10 text-warn text-[10.5px]">v{f.version}</span>
                      )}
                    </div>
                    {f.description && (
                      <div className="text-[12.5px] text-muted mt-0.5 line-clamp-2">{f.description}</div>
                    )}
                    <div className="text-[11px] text-muted mt-1 flex items-center gap-2 flex-wrap">
                      <Avatar name={f.uploaded_by_name} email={f.uploaded_by_email} size={16} />
                      <span>{f.uploaded_by_name || f.uploaded_by_email}</span>
                      <span>·</span>
                      <span>{new Date(f.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                      <span>·</span>
                      <span>{fmtSize(f.size_bytes)}</span>
                      {f.tags.length > 0 && (
                        <>
                          <span>·</span>
                          {f.tags.map((t) => (
                            <span key={t} className="pill bg-bg text-muted text-[10px] border border-border">
                              #{t}
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => download(f)}
                      className="p-1.5 rounded hover:bg-bg text-muted hover:text-accent"
                      title="Download"
                    >
                      <Download size={14} />
                    </button>
                    <button
                      onClick={() => askDelete(f)}
                      className="p-1.5 rounded hover:bg-bg text-muted hover:text-danger"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Opportunity documents — read-only, kept here for one-stop visibility. */}
      {oppDocs.length > 0 && (
        <div className="bg-surface border border-border rounded-2xl overflow-hidden">
          <header className="px-5 py-4 border-b border-border">
            <h2 className="text-base font-bold text-text">From the source opportunity</h2>
            <p className="text-[11px] text-muted mt-0.5">
              Statutory / compliance pack. Read-only here — manage them on the opportunity.
            </p>
          </header>
          <ul className="divide-y divide-border">
            {oppDocs.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                <span className="w-9 h-9 rounded-lg bg-bg text-muted grid place-items-center shrink-0 border border-border">
                  <FileText size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text truncate">{d.name || d.kind}</div>
                  <div className="text-[11px] text-muted">
                    {d.kind} · uploaded {new Date(d.uploaded_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                  </div>
                </div>
                {d.object_key && (
                  <a
                    href={d.object_key}
                    target="_blank" rel="noopener noreferrer"
                    className="text-muted hover:text-accent p-1.5 rounded hover:bg-bg"
                    title="Open"
                  >
                    <Download size={14} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
