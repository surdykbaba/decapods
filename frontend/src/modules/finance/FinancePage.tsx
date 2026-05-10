import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat } from "@/components/ui";

export function FinancePage() {
  const { data } = useQuery<{ aging: Record<string, number> }>({
    queryKey: ["finance", "receivables"], queryFn: () => api("/api/v1/finance/receivables"),
  });
  const a = data?.aging ?? {};
  return (
    <div className="space-y-6">
      <h1 className="h1">Finance</h1>
      <div className="grid grid-cols-5 gap-4">
        <Stat label="Current" value={`$${(a.current ?? 0).toLocaleString()}`} />
        <Stat label="0-30" value={`$${(a["0_30"] ?? 0).toLocaleString()}`} />
        <Stat label="31-60" value={`$${(a["31_60"] ?? 0).toLocaleString()}`} tone="warn" />
        <Stat label="61-90" value={`$${(a["61_90"] ?? 0).toLocaleString()}`} tone="warn" />
        <Stat label="90+" value={`$${(a["90_plus"] ?? 0).toLocaleString()}`} tone="bad" />
      </div>
      <Card title="Notes">
        <p className="text-sm text-muted">Drill into invoices, payments, P&L, and revenue recognition from the sub-pages.</p>
      </Card>
    </div>
  );
}
