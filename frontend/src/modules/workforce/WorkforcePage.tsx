import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";

type Person = { id: string; name: string; weeks: { week: string; hours: number; utilization: number }[] };

export function WorkforcePage() {
  const { data } = useQuery<{ people: Person[] }>({
    queryKey: ["workforce", "load"], queryFn: () => api("/api/v1/workforce/load"),
  });

  const heat = (u: number) => {
    if (u >= 1.1) return "bg-danger/70";
    if (u >= 0.9) return "bg-warn/60";
    if (u >= 0.5) return "bg-success/50";
    return "bg-border/50";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Workforce</h1>
        <p className="text-sm text-muted">Utilization heatmap — last 8 weeks.</p>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {(data?.people ?? []).map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2 pr-4 whitespace-nowrap text-sm">{p.name}</td>
                  {p.weeks.map((w) => (
                    <td key={w.week} className="px-1 py-2">
                      <div className={`h-6 w-12 rounded ${heat(w.utilization)}`} title={`${w.hours}h • ${(w.utilization * 100).toFixed(0)}%`} />
                    </td>
                  ))}
                </tr>
              ))}
              {(data?.people ?? []).length === 0 && (
                <tr><td className="text-muted py-6">No data yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
