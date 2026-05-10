import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";

const COLS = ["todo", "in_progress", "review", "done"];

export function ProjectBoard() {
  const { id } = useParams();
  const { data } = useQuery<{ columns: Record<string, any[]> }>({
    queryKey: ["board", id], queryFn: () => api(`/api/v1/projects/${id}/board`),
  });
  return (
    <div className="grid grid-cols-4 gap-4">
      {COLS.map((c) => (
        <Card key={c} title={c.replace("_", " ")}>
          <div className="space-y-2">
            {(data?.columns?.[c] ?? []).map((t: any) => (
              <div key={t.id} className="card p-3">
                <div className="text-sm">{t.title}</div>
                <div className="mt-2"><Pill>P{t.priority}</Pill></div>
              </div>
            ))}
            {(data?.columns?.[c]?.length ?? 0) === 0 && (
              <div className="text-xs text-muted">No tasks</div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
