import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, Pill, Empty } from "@/components/ui";

type Project = {
  id: string; code: string; name: string; status: string;
  health: "green" | "amber" | "red"; risk_score: number; budget: number;
};

export function ProjectsPage() {
  const { data } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api<{ items: Project[] }>("/api/v1/projects").then((r) => r.items),
  });

  return (
    <div className="space-y-6">
      <h1 className="h1">Projects</h1>
      {!data?.length ? <Empty title="No projects yet" /> : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-muted text-xs uppercase">
              <tr><th className="py-2">Code</th><th>Name</th><th>Status</th><th>Health</th><th>Risk</th><th>Budget</th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-t border-border hover:bg-border/20">
                  <td className="py-3 font-mono text-xs">{p.code}</td>
                  <td><Link to={`/projects/${p.id}`} className="hover:underline">{p.name}</Link></td>
                  <td><Pill>{p.status}</Pill></td>
                  <td><Pill tone={p.health === "green" ? "good" : p.health === "amber" ? "warn" : "bad"}>{p.health}</Pill></td>
                  <td>{p.risk_score?.toFixed?.(0) ?? 0}</td>
                  <td>${(p.budget || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
