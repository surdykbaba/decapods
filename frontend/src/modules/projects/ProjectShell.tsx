import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Pill } from "@/components/ui";

export function ProjectShell() {
  const { id } = useParams();
  const { data } = useQuery<any>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`),
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-muted">{data?.code}</div>
        <h1 className="h1">{data?.name ?? "Project"}</h1>
        <div className="flex gap-2 mt-2">
          {data?.status && <Pill>{data.status}</Pill>}
          {data?.health && <Pill tone={data.health === "green" ? "good" : data.health === "amber" ? "warn" : "bad"}>{data.health}</Pill>}
        </div>
      </div>
      <nav className="flex gap-6 border-b border-border text-sm">
        {[
          { to: ".", label: "Overview", end: true },
          { to: "board", label: "Board" },
        ].map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) => `pb-3 -mb-px border-b-2 ${
              isActive ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
            }`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
