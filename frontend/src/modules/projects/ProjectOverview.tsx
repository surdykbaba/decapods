import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat } from "@/components/ui";

export function ProjectOverview() {
  const { id } = useParams();
  const qc = useQueryClient();
  const recalc = useMutation({
    mutationFn: () => api(`/api/v1/projects/${id}/risk/recalculate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Stat label="Open tasks" value="—" />
      <Stat label="Velocity" value="—" />
      <Stat label="On-time milestones" value="—" />
      <Stat label="Burn rate" value="—" />
      <Card className="col-span-2 lg:col-span-4" title="Risk">
        <p className="text-sm text-muted mb-3">
          Recompute risk by aggregating delivery, financial, dependency, staffing, and compliance dimensions.
        </p>
        <button className="btn-primary" onClick={() => recalc.mutate()} disabled={recalc.isPending}>
          {recalc.isPending ? "Recomputing…" : "Recalculate risk"}
        </button>
      </Card>
    </div>
  );
}
