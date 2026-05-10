import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat, Pill } from "@/components/ui";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, BarChart, Bar, CartesianGrid,
} from "recharts";

type Exec = {
  portfolio: { total: number; delayed: number; at_risk: number };
  revenue: { invoiced: number; paid: number; outstanding: number };
  governance: { open_violations: number; sla_breaches: number; pending_approvals: number };
  workforce: { avg_utilization: number };
};

const fakeTrend = Array.from({ length: 12 }).map((_, i) => ({
  m: `M${i + 1}`,
  invoiced: 120 + Math.round(Math.random() * 80),
  paid: 80 + Math.round(Math.random() * 60),
}));

export function DashboardPage() {
  const { data, isLoading } = useQuery<Exec>({
    queryKey: ["analytics", "executive"],
    queryFn: () => api("/api/v1/analytics/executive"),
  });

  const fmt = (n?: number) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct = (n?: number) => `${Math.round((n ?? 0) * 100)}%`;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="h1">Executive overview</h1>
          <p className="text-sm text-muted">Portfolio, revenue, governance, and workforce — at a glance.</p>
        </div>
        <Pill tone="info">Live • refresh 5m</Pill>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Total projects" value={isLoading ? "…" : fmt(data?.portfolio.total)} />
        <Stat label="Delayed" value={isLoading ? "…" : fmt(data?.portfolio.delayed)}
              tone={(data?.portfolio.delayed ?? 0) > 0 ? "warn" : "good"} />
        <Stat label="At risk" value={isLoading ? "…" : fmt(data?.portfolio.at_risk)}
              tone={(data?.portfolio.at_risk ?? 0) > 0 ? "bad" : "good"} />
        <Stat label="Avg utilization" value={isLoading ? "…" : pct(data?.workforce.avg_utilization)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Revenue trend" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={fakeTrend}>
                <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
                <XAxis dataKey="m" stroke="rgb(var(--muted))" fontSize={12} />
                <YAxis stroke="rgb(var(--muted))" fontSize={12} />
                <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--border))" }} />
                <Line type="monotone" dataKey="invoiced" stroke="rgb(var(--accent))" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="paid" stroke="rgb(var(--success))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Governance">
          <div className="space-y-3">
            <Row label="Open violations" value={data?.governance.open_violations} tone="bad" />
            <Row label="SLA breaches" value={data?.governance.sla_breaches} tone="warn" />
            <Row label="Pending approvals" value={data?.governance.pending_approvals} tone="info" />
          </div>
        </Card>
      </div>

      <Card title="Receivables (mock)">
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={[
              { b: "current", v: 120 },
              { b: "0-30", v: 60 },
              { b: "31-60", v: 35 },
              { b: "61-90", v: 18 },
              { b: "90+", v: 9 },
            ]}>
              <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="b" stroke="rgb(var(--muted))" fontSize={12} />
              <YAxis stroke="rgb(var(--muted))" fontSize={12} />
              <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--border))" }} />
              <Bar dataKey="v" fill="rgb(var(--accent))" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value?: number; tone: "bad" | "warn" | "info" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted">{label}</span>
      <Pill tone={tone}>{value ?? 0}</Pill>
    </div>
  );
}
