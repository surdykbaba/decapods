import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";

type Row = { user_id: string; name: string; score: number; band: string };

export function BurnoutPage() {
  const { data } = useQuery<{ watchlist: Row[] }>({
    queryKey: ["workforce", "burnout"], queryFn: () => api("/api/v1/workforce/burnout"),
  });
  const tone = (b: string) =>
    b === "critical" ? "bad" : b === "elevated" ? "warn" : b === "watch" ? "info" : "good";
  return (
    <div className="space-y-6">
      <h1 className="h1">Burnout watchlist</h1>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-muted text-xs uppercase">
            <tr><th className="py-2">Person</th><th>Score</th><th>Band</th></tr>
          </thead>
          <tbody>
            {(data?.watchlist ?? []).map((r) => (
              <tr key={r.user_id} className="border-t border-border">
                <td className="py-3">{r.name}</td>
                <td>{r.score.toFixed(0)}</td>
                <td><Pill tone={tone(r.band) as any}>{r.band}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
