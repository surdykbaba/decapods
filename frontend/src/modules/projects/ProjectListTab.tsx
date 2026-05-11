import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { api } from "@/lib/api";
import { TaskRowItem, TaskDrawer, type TaskRow, type ProjectMember } from "./TaskCard";

type Board = { columns: Record<string, TaskRow[]> };

const STATUS_ORDER = ["todo", "in_progress", "blocked", "review", "done"];
const STATUS_LABEL: Record<string, string> = {
  todo: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "In review",
  done: "Done",
};

export function ProjectListTab() {
  const { id } = useParams();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const { data: board } = useQuery<Board>({
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

  const tasks: TaskRow[] = board ? Object.values(board.columns).flat() : [];

  if (tasks.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-12 text-center">
        <ListChecks size={32} className="text-muted mx-auto mb-3" />
        <h2 className="text-lg font-bold text-text">No tasks yet</h2>
        <p className="text-sm text-muted mt-1 max-w-md mx-auto">
          Create one from the Overview tab and it will appear here, grouped by status.
        </p>
      </div>
    );
  }

  const groups = STATUS_ORDER
    .map((s) => ({ status: s, items: tasks.filter((t) => t.status === s) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.status} className="bg-surface border border-border rounded-2xl overflow-hidden">
          <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg/30">
            <div className="text-sm font-bold text-text">{STATUS_LABEL[g.status]}</div>
            <span className="text-xs text-muted">{g.items.length}</span>
          </header>
          <div className="hidden sm:grid grid-cols-[1fr_180px_140px_120px_90px] gap-3 px-4 py-2 text-[10.5px] uppercase tracking-wider font-bold text-muted bg-bg/20">
            <div>Task</div>
            <div>Assignee</div>
            <div>Status</div>
            <div>Due / age</div>
            <div className="justify-self-end">💬</div>
          </div>
          {g.items.map((t) => (
            <TaskRowItem
              key={t.id}
              task={t}
              projectId={id!}
              members={members}
              onOpen={setOpenTaskId}
            />
          ))}
        </section>
      ))}

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
