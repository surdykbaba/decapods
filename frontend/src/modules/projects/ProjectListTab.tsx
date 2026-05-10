import { useOutletContext, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, AlertCircle, Hourglass, ListChecks } from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/Avatar";

type Stakeholder = { id: string; name: string; role: string; email?: string };
type Task = {
  id: string; title: string; status: string; priority: number;
  due_on: string | null; assignee_id?: string | null;
};
type Board = { columns: { todo: Task[]; in_progress: Task[]; review: Task[]; done: Task[] } };

const STATUS: Record<string, { label: string; icon: React.ComponentType<any>; cls: string }> = {
  todo:        { label: "Not started", icon: Hourglass,    cls: "text-muted" },
  in_progress: { label: "In progress", icon: Clock,        cls: "text-accent" },
  review:      { label: "Review",      icon: AlertCircle,  cls: "text-warn" },
  done:        { label: "Done",        icon: CheckCircle2, cls: "text-success" },
};

const PRIORITY_LABEL = ["", "Lowest", "Low", "Medium", "High", "Highest"];

export function ProjectListTab() {
  const { id } = useParams();
  const { stakeholders } = useOutletContext<{ stakeholders: Stakeholder[] }>();
  const { data } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`), enabled: !!id,
  });

  const tasks: Task[] = data
    ? [...data.columns.todo, ...data.columns.in_progress, ...data.columns.review, ...data.columns.done]
    : [];

  if (tasks.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-12 text-center">
        <ListChecks size={32} className="text-muted mx-auto mb-3" />
        <h2 className="text-lg font-bold text-text">No tasks yet</h2>
        <p className="text-sm text-muted mt-1 max-w-md mx-auto">
          Tasks created from the Overview tab or the Board show up here in a flat list,
          grouped by status.
        </p>
      </div>
    );
  }

  // Group by status in the canonical workflow order.
  const groups: { status: string; items: Task[] }[] = ["todo", "in_progress", "review", "done"].map((s) => ({
    status: s,
    items: tasks.filter((t) => t.status === s),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const meta = STATUS[g.status] ?? STATUS.todo;
        const Icon = meta.icon;
        return (
          <section key={g.status} className="bg-surface border border-border rounded-2xl overflow-hidden">
            <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg/30">
              <div className={`inline-flex items-center gap-2 text-sm font-bold ${meta.cls}`}>
                <Icon size={14} /> {meta.label}
              </div>
              <span className="text-xs text-muted">{g.items.length}</span>
            </header>
            <ul className="divide-y divide-border">
              {g.items.map((t) => {
                const assignee = stakeholders.find((s) => s.id === t.assignee_id);
                return (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${g.status === "done" ? "line-through text-muted" : "text-text"}`}>
                        {t.title}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {PRIORITY_LABEL[t.priority] ?? "Medium"}
                        {t.due_on && ` · due ${new Date(t.due_on).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                      </div>
                    </div>
                    {assignee ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <Avatar name={assignee.name} email={assignee.email} size={24} />
                        <span className="text-xs text-text">{assignee.name.split(" ")[0]}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted shrink-0">Unassigned</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
