import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  TaskBoardCard, TaskDrawer, useTaskPatch,
  type TaskRow, type ProjectMember,
} from "./TaskCard";

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
  const [dragOver, setDragOver] = useState<string | null>(null);
  const patch = useTaskPatch(id ?? "");

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

  // Lookup status of any task quickly so we can no-op when a card is dropped
  // back on its current column.
  const statusOf = (taskId: string): string | undefined => {
    if (!data) return;
    for (const col of Object.keys(data.columns)) {
      if (data.columns[col].some((t) => t.id === taskId)) return col;
    }
  };

  function onDrop(colKey: string, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;
    if (statusOf(taskId) === colKey) return;
    patch.mutate({ taskId, patch: { status: colKey } });
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
      {COLS.map((c) => {
        const items = data?.columns?.[c.key] ?? [];
        const hot = dragOver === c.key;
        return (
          <div
            key={c.key}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOver !== c.key) setDragOver(c.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOver((prev) => (prev === c.key ? null : prev));
              }
            }}
            onDrop={(e) => onDrop(c.key, e)}
            className={`bg-bg/40 border rounded-2xl overflow-hidden flex flex-col transition-colors ${
              hot ? "border-accent bg-accent/5" : "border-border"
            }`}
          >
            <header className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <div className={`text-xs font-bold uppercase tracking-wider ${c.cls}`}>{c.label}</div>
              <span className="text-[11px] text-muted">{items.length}</span>
            </header>
            <div className="p-2 space-y-2 min-h-[120px]">
              {items.length === 0 ? (
                <div className="text-[11px] text-muted/70 text-center py-4">
                  {hot ? "Drop to move here" : "No tasks"}
                </div>
              ) : (
                items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      // Don't initiate drag when grabbing a control inside the
                      // card (status select, assignee select, etc.) — those
                      // need their own click behaviour.
                      const tag = (e.target as HTMLElement).tagName;
                      if (tag === "SELECT" || tag === "OPTION" || tag === "BUTTON" || tag === "INPUT") {
                        e.preventDefault();
                        return;
                      }
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <TaskBoardCard
                      task={t}
                      projectId={id!}
                      members={members}
                      onOpen={setOpenTaskId}
                    />
                  </div>
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
