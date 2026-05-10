import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ProjectOperationalOverview } from "./ProjectOperationalOverview";

type ProjectLink = { label: string; url: string; kind?: string };

type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  budget: number;
  currency: string;
  description?: string;
  links: ProjectLink[];
  opportunity_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  lead_type?: string;
  client_name?: string;
};

type Task = {
  id: string;
  title: string;
  description: string;
  priority: number;
  due_on: string | null;
  assignee_id?: string | null;
};

type Board = {
  columns: { todo: Task[]; in_progress: Task[]; review: Task[]; done: Task[] };
};

type Stakeholder = {
  id: string;
  name: string;
  role: string;
  kind: "internal" | "external";
  email?: string;
  phone?: string;
};

export function ProjectOverview() {
  const { id } = useParams();

  const { data: project } = useQuery<Project>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`), enabled: !!id,
  });
  const { data: board } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`), enabled: !!id,
  });
  const { data: stakeholdersData } = useQuery<{ items: Stakeholder[] }>({
    queryKey: ["project-stakeholders", id], queryFn: () => api(`/api/v1/projects/${id}/stakeholders`), enabled: !!id,
  });

  if (!project) return <div className="text-muted">Loading…</div>;

  return (
    <ProjectOperationalOverview
      project={project as any}
      board={board}
      stakeholders={stakeholdersData?.items ?? []}
    />
  );
}
