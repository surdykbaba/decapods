import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { TaskBoardCard, TaskDrawer, type TaskRow, type ProjectMember } from "./TaskCard";

const COLS: { key: string; label: string; cls: string }[] = [
  { key: "todo",        label: "Not started", cls: "text-muted" },
  { key: "in_progress", label: "In progress", cls: "text-accent" },
  { key: "blocked",     label: "Blocked",     cls: "text-danger" },
  { key: "review",      label: "In review",   cls: "text-warn" },
  { key: "done",        label: "Done",        cls: "text-success" },
];

export function ProjectBoard() {
  const { id } = useParams();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const { data } = useQuery<{ columns: Record<string, TaskRow[]> }>({
    queryKey: ["project-board", id],
    queryFn: () => api(`/api/v1/projects/${id}/board`),
    enabled: !!id,
  });
  const { data: membersData } = useQuery<{ items: ProjectMember[] }>({
    queryKey: ["project-members", id],
    queryFn: () => api(`/api/v1/projects/${id}/members`),
    enabled: !!id,
  });
  const members = membersData?.items ?? [];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
      {COLS.map((c) => {
        const items = data?.columns?.[c.key] ?? [];
        return (
          <div key={c.key} className="bg-bg/40 border border-border rounded-2xl overflow-hidden flex flex-col">
            <header className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <div className={`text-xs font-bold uppercase tracking-wider ${c.cls}`}>{c.label}</div>
              <span className="text-[11px] text-muted">{items.length}</span>
            </header>
            <div className="p-2 space-y-2 min-h-[120px]">
              {items.length === 0 ? (
                <div className="text-[11px] text-muted/70 text-center py-4">No tasks</div>
              ) : (
                items.map((t) => (
                  <TaskBoardCard
                    key={t.id}
                    task={t}
                    projectId={id!}
                    members={members}
                    onOpen={setOpenTaskId}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}

      {openTaskId && id && (
        <TaskDrawer
          projectId={id}
          taskId={openTaskId}
          members={members}
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  );
}
