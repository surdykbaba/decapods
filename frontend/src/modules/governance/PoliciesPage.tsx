import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill, Empty } from "@/components/ui";

export function GovernancePoliciesPage() {
  const { data } = useQuery<{ items: any[] }>({
    queryKey: ["policies"], queryFn: () => api("/api/v1/governance/policies"),
  });
  return (
    <div className="space-y-6">
      <h1 className="h1">Governance policies</h1>
      {!data?.items?.length ? <Empty title="No custom policies" body="Built-in governance rules are active. Add custom JSON-Logic rules per tenant via the API." /> : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-muted text-xs uppercase">
              <tr><th className="py-2">Code</th><th>Kind</th><th>Active</th></tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-3 font-mono">{p.code}</td>
                  <td>{p.kind}</td>
                  <td><Pill tone={p.active ? "good" : "neutral"}>{p.active ? "active" : "off"}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
