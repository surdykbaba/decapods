import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Calendar as CalendarIcon, Flag, Circle } from "lucide-react";
import { api } from "@/lib/api";

type Project = {
  milestones?: { id: string; title: string; due_date: string | null; status: string }[];
};
type Task = { id: string; title: string; status: string; due_on: string | null };
type Board = { columns: { todo: Task[]; in_progress: Task[]; review: Task[]; done: Task[] } };

export function ProjectCalendarTab() {
  const { id } = useParams();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const { data: project } = useQuery<Project>({
    queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`), enabled: !!id,
  });
  const { data: board } = useQuery<Board>({
    queryKey: ["project-board", id], queryFn: () => api(`/api/v1/projects/${id}/board`), enabled: !!id,
  });

  // Aggregate every item with a date — milestones + dated tasks — into a
  // single day-keyed map for the grid.
  const byDay = useMemo(() => {
    const m = new Map<string, { kind: "milestone" | "task"; title: string; status: string }[]>();
    (project?.milestones ?? []).forEach((mi) => {
      if (!mi.due_date) return;
      const key = mi.due_date.slice(0, 10);
      const arr = m.get(key) ?? [];
      arr.push({ kind: "milestone", title: mi.title, status: mi.status });
      m.set(key, arr);
    });
    if (board) {
      [...board.columns.todo, ...board.columns.in_progress, ...board.columns.review, ...board.columns.done]
        .forEach((t) => {
          if (!t.due_on) return;
          const key = t.due_on.slice(0, 10);
          const arr = m.get(key) ?? [];
          arr.push({ kind: "task", title: t.title, status: t.status });
          m.set(key, arr);
        });
    }
    return m;
  }, [project, board]);

  const cells = useMemo(() => buildGrid(month), [month]);

  function shift(n: number) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  }

  return (
    <div className="bg-surface border border-border rounded-2xl p-5">
      <header className="flex items-center justify-between mb-3">
        <button onClick={() => shift(-1)} className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text hover:bg-bg">← Prev</button>
        <div className="text-base font-bold text-text inline-flex items-center gap-2">
          <CalendarIcon size={14} className="text-accent" />
          {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        <button onClick={() => shift(1)} className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text hover:bg-bg">Next →</button>
      </header>
      <div className="grid grid-cols-7 gap-1 text-[10.5px] uppercase tracking-wider font-bold text-muted mb-1">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => <div key={d} className="px-2">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const items = byDay.get(cell.iso) ?? [];
          return (
            <div
              key={cell.iso}
              className={`min-h-[88px] rounded-lg border p-1.5 text-left text-[11px] ${
                cell.inMonth ? "border-border bg-bg/30" : "border-transparent bg-transparent text-muted/50"
              }`}
            >
              <div className={`font-semibold mb-1 ${cell.inMonth ? "text-text" : "text-muted/60"}`}>{cell.date.getDate()}</div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((it, i) => (
                  <div
                    key={i}
                    className={`truncate rounded px-1 py-0.5 inline-flex items-center gap-1 w-full ${
                      it.kind === "milestone"
                        ? "bg-accent-soft text-accent"
                        : it.status === "done"
                          ? "bg-success/15 text-success"
                          : "bg-bg text-text"
                    }`}
                    title={`${it.kind}: ${it.title}`}
                  >
                    {it.kind === "milestone" ? <Flag size={9} /> : <Circle size={7} />}
                    <span className="truncate">{it.title}</span>
                  </div>
                ))}
                {items.length > 3 && <div className="text-muted">+{items.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildGrid(month: Date) {
  const first = new Date(month);
  const last  = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const startOffset = first.getDay() === 0 ? 6 : first.getDay() - 1;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  const totalDays = startOffset + last.getDate();
  const totalCells = Math.ceil(totalDays / 7) * 7;
  const cells: { date: Date; iso: string; inMonth: boolean }[] = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, iso: d.toISOString().slice(0, 10), inMonth: d.getMonth() === month.getMonth() });
  }
  return cells;
}
