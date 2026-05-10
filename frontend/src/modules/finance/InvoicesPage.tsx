import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";

type Invoice = { id: string; number: string; amount: number; currency: string; status: string; due_on?: string };

export function InvoicesPage() {
  const { data } = useQuery<{ items: Invoice[] }>({
    queryKey: ["invoices"], queryFn: () => api("/api/v1/finance/invoices"),
  });
  return (
    <div className="space-y-6">
      <h1 className="h1">Invoices</h1>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-muted text-xs uppercase">
            <tr><th className="py-2">Number</th><th>Amount</th><th>Status</th><th>Due</th></tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((i) => (
              <tr key={i.id} className="border-t border-border">
                <td className="py-3 font-mono">{i.number}</td>
                <td>{i.currency} {i.amount.toLocaleString()}</td>
                <td><Pill tone={i.status === "paid" ? "good" : i.status === "draft" ? "neutral" : "warn"}>{i.status}</Pill></td>
                <td>{i.due_on ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
