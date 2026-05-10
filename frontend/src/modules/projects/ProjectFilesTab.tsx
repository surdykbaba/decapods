import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Download, UploadCloud } from "lucide-react";
import { api } from "@/lib/api";

type ProjectMeta = { opportunity_id?: string | null };
type OppDoc = {
  id: string;
  kind: string;
  name: string;
  object_key: string;
  uploaded_at: string;
};

export function ProjectFilesTab() {
  const { project } = useOutletContext<{ project: ProjectMeta | undefined }>();

  // Documents currently live on the source opportunity. Pull them through so
  // the tab is useful out of the box; first-class project-document storage
  // will come with the broader files pipeline.
  const { data: opp } = useQuery<{ documents?: OppDoc[] }>({
    queryKey: ["opp", project?.opportunity_id],
    queryFn: () => api(`/api/v1/opportunities/${project?.opportunity_id}`),
    enabled: !!project?.opportunity_id,
  });
  const docs = opp?.documents ?? [];

  if (!project?.opportunity_id) {
    return <EmptyFiles />;
  }

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-text">Files</h2>
          <div className="text-[11px] text-muted mt-0.5">
            From the source opportunity. Drag-drop upload coming next.
          </div>
        </div>
      </header>
      {docs.length === 0 ? (
        <EmptyFiles />
      ) : (
        <ul className="divide-y divide-border">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-5 py-3">
              <span className="w-9 h-9 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
                <FileText size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-text truncate">{d.name || d.kind}</div>
                <div className="text-[11px] text-muted">
                  {d.kind} · uploaded {new Date(d.uploaded_at).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
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
      )}
    </div>
  );
}

function EmptyFiles() {
  return (
    <div className="bg-surface border border-border rounded-2xl p-12 text-center">
      <UploadCloud size={32} className="text-muted mx-auto mb-3" />
      <h2 className="text-lg font-bold text-text">No files yet</h2>
      <p className="text-sm text-muted mt-1 max-w-md mx-auto">
        Attach the project brief, scope document, NDA and any working artefacts
        from the source opportunity. First-class project file storage is on the
        roadmap.
      </p>
    </div>
  );
}
