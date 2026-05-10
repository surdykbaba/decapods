import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";

export function AuditPage() {
  const { data } = useQuery<{ items: any[] }>({
    queryKey: ["audit"], queryFn: () => api("/api/v1/audit"),
  });
  return (
    <div className="space-y-6">
      <h1 className="h1">Audit log</h1>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-muted text-xs uppercase">
            <tr><th className="py-2">When</th><th>Actor</th><th>Action</th><th>Entity</th></tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-3 text-xs text-muted">{new Date(r.created_at).toLocaleString()}</td>
                <td className="font-mono text-xs">{r.actor_id}</td>
                <td>{r.action}</td>
                <td>{r.entity}/{r.entity_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
