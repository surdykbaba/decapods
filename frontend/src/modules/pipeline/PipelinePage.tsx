import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Pill, Empty, Skeleton } from "@/components/ui";
import { Plus } from "lucide-react";

const STAGES = [
  "new_request", "under_review", "approved", "contracting", "planning",
  "in_progress", "qa_review", "client_acceptance", "invoiced", "paid", "closed",
];

type Opp = {
  id: string; title: string; stage: string; lead_type: string;
  estimated_value: number; priority: number; risk_level: string;
};

export function PipelinePage() {
  const { data, isLoading } = useQuery<{ items: Opp[] }>({
    queryKey: ["opps"], queryFn: () => api("/api/v1/opportunities"),
  });
  const grouped = STAGES.map((s) => ({
    stage: s,
    items: (data?.items ?? []).filter((o) => o.stage === s),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">Pipeline</h1>
          <p className="text-sm text-muted">From request to closed engagement, gated by governance.</p>
        </div>
        <Link to="/pipeline/new" className="btn-primary"><Plus size={16} />New opportunity</Link>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : (data?.items?.length ?? 0) === 0 ? (
        <Empty title="No opportunities yet" body="Create your first opportunity to begin governance." />
      ) : (
        <div className="overflow-x-auto">
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${STAGES.length}, minmax(240px, 1fr))` }}>
            {grouped.map((col) => (
              <div key={col.stage} className="card p-3 min-h-[200px]">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs uppercase tracking-wide text-muted">{col.stage.replaceAll("_", " ")}</div>
                  <Pill>{col.items.length}</Pill>
                </div>
                <div className="space-y-2">
                  {col.items.map((o) => (
                    <Link to={`/pipeline/${o.id}`} key={o.id}
                          className="block card p-3 hover:border-accent transition">
                      <div className="text-sm font-medium">{o.title}</div>
                      <div className="text-xs text-muted mt-1">{o.lead_type} • ${(o.estimated_value || 0).toLocaleString()}</div>
                      <div className="mt-2 flex gap-1">
                        {o.risk_level && <Pill tone={o.risk_level === "high" ? "bad" : "warn"}>{o.risk_level}</Pill>}
                        <Pill>P{o.priority}</Pill>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
