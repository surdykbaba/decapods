import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui";
import { Archive, RotateCcw, X, AlertTriangle, ShieldCheck, Lock } from "lucide-react";

type ArchivedProject = {
  id: string;
  code: string;
  name: string;
  status: string;
  client_name: string;
  lead_type: string;
  budget: number;
  currency: string;
  updated_at: string;          // here it carries deleted_at
  opportunity_id?: string | null;
};

function fmtMoney(n: number, ccy = "NGN"): string {
  if (!n) return "—";
  const sym = ({ USD: "$", EUR: "€", GBP: "£", NGN: "₦" } as Record<string, string>)[ccy] ?? ccy;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function ArchivedProjectsPage() {
  const { user } = useAuth();
  const isSuperAdmin = (user?.roles ?? []).includes("super_admin");

  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<{ items: ArchivedProject[] }>({
    queryKey: ["archived-projects"],
    queryFn: () => api(`/api/v1/settings/archived-projects`),
    enabled: isSuperAdmin,
  });

  const restore = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api(`/api/v1/projects/${id}/restore`, { method: "POST", body: JSON.stringify({ password }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["archived-projects"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const [confirming, setConfirming] = useState<ArchivedProject | null>(null);

  if (!isSuperAdmin) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-full bg-warn/15 text-warn grid place-items-center shrink-0">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h2 className="text-base font-bold text-text">Super-admin only</h2>
            <p className="text-sm text-muted mt-1 max-w-prose">
              Restoring archived projects can re-introduce work that was intentionally hidden. To
              keep that audit trail honest, only users with the <code className="text-xs bg-bg px-1 rounded">super_admin</code>{" "}
              role can see this page or restore a project.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-5 max-w-4xl">
      <header>
        <h1 className="h1 flex items-center gap-2"><Archive size={22} /> Archived projects</h1>
        <p className="text-sm text-muted mt-1 max-w-prose">
          Soft-deleted projects stay here so nothing's lost forever. Restoring requires you to
          re-enter your password — restore is logged on the audit trail.
        </p>
      </header>

      {isLoading ? (
        <Card><div className="text-sm text-muted">Loading…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-danger">{(error as Error).message}</div></Card>
      ) : items.length === 0 ? (
        <Card>
          <div className="text-sm text-muted text-center py-8">
            Nothing in the archive — every project is live.
          </div>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="text-left font-medium px-3 py-2">Project</th>
                <th className="text-left font-medium px-3 py-2 w-36">Stage at archive</th>
                <th className="text-right font-medium px-3 py-2 w-28">Budget</th>
                <th className="text-left font-medium px-3 py-2 w-36">Archived</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-muted">{p.code}</span>
                      <span className="font-semibold text-text">{p.name}</span>
                    </div>
                    <div className="text-xs text-muted truncate mt-0.5">
                      {p.client_name || p.lead_type || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-3 capitalize">{p.status.replace(/_/g, " ")}</td>
                  <td className="px-3 py-3 text-right font-medium">{fmtMoney(p.budget, p.currency)}</td>
                  <td className="px-3 py-3 text-muted">{fmtDate(p.updated_at)}</td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => setConfirming(p)}
                      className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
                    >
                      <RotateCcw size={12} /> Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {confirming && (
        <RestoreDialog
          project={confirming}
          submitting={restore.isPending}
          error={restore.error}
          onClose={() => { setConfirming(null); restore.reset(); }}
          onConfirm={(password) => {
            restore.mutate(
              { id: confirming.id, password },
              { onSuccess: () => { setConfirming(null); restore.reset(); } }
            );
          }}
        />
      )}
    </div>
  );
}

function RestoreDialog({
  project, submitting, error, onClose, onConfirm,
}: {
  project: ArchivedProject;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const errMessage = error instanceof ApiError
    ? ((error.body as any)?.error ?? error.message)
    : (error as Error | undefined)?.message;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start gap-3 p-5 border-b border-border">
          <span className="w-10 h-10 rounded-full bg-warn/15 text-warn grid place-items-center shrink-0">
            <AlertTriangle size={20} />
          </span>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text">Restore project?</h2>
            <p className="text-sm text-muted mt-0.5">
              <strong className="text-text">{project.code}</strong> — {project.name}
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          <p className="text-sm text-muted">
            This will bring the project back to active. Anyone with project access will see it
            again and the linked opportunity will reappear in reports. Confirm with your password.
          </p>
          <label className="block">
            <div className="label">Password</div>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="password"
                autoFocus
                className="input pl-9"
                value={password}
                placeholder="Your account password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && password) onConfirm(password); }}
              />
            </div>
          </label>
          {errMessage && <div className="text-danger text-sm">{errMessage}</div>}
        </div>
        <footer className="flex justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <button
            onClick={() => onConfirm(password)}
            disabled={!password || submitting}
            className="btn-primary"
          >
            <RotateCcw size={14} /> {submitting ? "Restoring…" : "Restore project"}
          </button>
        </footer>
      </div>
    </div>
  );
}
