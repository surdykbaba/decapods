import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";

export function OpportunityDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data } = useQuery<any>({
    queryKey: ["opp", id], queryFn: () => api(`/api/v1/opportunities/${id}`),
  });
  const submit = useMutation({
    mutationFn: () => api(`/api/v1/opportunities/${id}/submit`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opp", id] }),
  });

  if (!data) return <div className="text-muted">Loading…</div>;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">{data.title}</h1>
          <div className="flex gap-2 mt-1">
            <Pill>{data.lead_type}</Pill>
            <Pill tone="info">{data.stage}</Pill>
          </div>
        </div>
        <button className="btn-primary" onClick={() => submit.mutate()}>Submit for review</button>
      </div>
      {submit.error && (
        <Card title="Governance blocked submission">
          <pre className="text-xs">{JSON.stringify((submit.error as any).body, null, 2)}</pre>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-6">
        <Card title="Scope"><p className="text-sm whitespace-pre-wrap">{data.technical_scope || "—"}</p></Card>
        <Card title="Proposal"><p className="text-sm whitespace-pre-wrap">{data.proposal_summary || "—"}</p></Card>
      </div>
    </div>
  );
}
