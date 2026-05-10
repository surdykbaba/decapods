import { Outlet, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ArrowLeft, MoreHorizontal } from "lucide-react";

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  budget?: number;
  opportunity_id?: string | null;
};

type Board = {
  columns: { todo: any[]; in_progress: any[]; review: any[]; done: any[] };
};

export function ProjectShell() {
  const { id } = useParams();
  const { data } = useQuery<Project>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`),
  });
  const { data: board } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`),
    enabled: !!id,
  });

  const completion = (() => {
    if (!board) return null;
    const done = board.columns.done?.length ?? 0;
    const total = (board.columns.todo?.length ?? 0)
      + (board.columns.in_progress?.length ?? 0)
      + (board.columns.review?.length ?? 0)
      + done;
    if (total === 0) return 0;
    return Math.round((done / total) * 100);
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-muted hover:text-text"
        >
          <ArrowLeft size={13} /> All projects
        </Link>

        <div className="flex items-end justify-between gap-6 mt-3 flex-wrap">
          <h1 className="h1 leading-none">{data?.name ?? "…"}</h1>

          {completion !== null && (
            <div className="flex items-center gap-3 min-w-[300px]">
              <div className="text-sm text-muted shrink-0">Completion rate</div>
              <div className="flex-1 h-8 bg-surface border border-border rounded-full overflow-hidden relative min-w-[180px]">
                <div
                  className="h-full bg-lime transition-all"
                  style={{ width: `${completion}%` }}
                />
                <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-text">
                  {completion}%
                </span>
              </div>
              <button className="w-9 h-9 rounded-full border border-border bg-surface hover:bg-bg grid place-items-center text-muted">
                <MoreHorizontal size={16} />
              </button>
            </div>
          )}
        </div>

        {data?.opportunity_id && (
          <Link
            to={`/pipeline/${data.opportunity_id}`}
            className="inline-block text-xs text-muted hover:text-accent mt-2"
          >
            ← back to source opportunity
          </Link>
        )}
      </div>

      <Outlet />
    </div>
  );
}
