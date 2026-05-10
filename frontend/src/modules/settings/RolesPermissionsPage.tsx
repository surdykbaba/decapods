import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { ShieldCheck, Check, Lock, Info, Eye } from "lucide-react";

type Section = { key: string; label: string; fixed: boolean };
type Role    = { name: string; label: string };
type Resp    = { sections: Section[]; roles: Role[]; matrix: Record<string, string[]> };

export function RolesPermissionsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = (user?.roles ?? []).includes("super_admin");

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["role-visibility"],
    queryFn: () => api("/api/v1/settings/role-visibility"),
  });

  // "Preview as role" — picks one role and shows the resulting visible
  // sections so admins can sanity-check the matrix without signing out as
  // a super_admin (who always sees everything).
  const [previewRole, setPreviewRole] = useState<string>("");

  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  useEffect(() => {
    if (!data) return;
    const m: Record<string, Set<string>> = {};
    for (const s of data.sections) {
      const list = data.matrix[s.key] ?? [];
      // "*" means everyone — expand to every role for the UI.
      if (list.includes("*")) {
        m[s.key] = new Set(data.roles.map((r) => r.name));
      } else {
        m[s.key] = new Set(list);
      }
    }
    setDraft(m);
  }, [data]);

  const save = useMutation({
    mutationFn: (matrix: Record<string, string[]>) =>
      api("/api/v1/settings/role-visibility", { method: "PUT", body: JSON.stringify({ matrix }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["role-visibility"] });
      qc.invalidateQueries({ queryKey: ["me-visibility"] });
      toast.success("Permissions updated", "Members will see the new sidebar within a minute, or on next refresh.");
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  function toggle(sectionKey: string, roleName: string) {
    setDraft((d) => {
      const next = { ...d };
      const set = new Set(next[sectionKey] ?? []);
      if (set.has(roleName)) set.delete(roleName);
      else set.add(roleName);
      // super_admin can never lose access — guardrail mirrored on backend too.
      if (roleName === "super_admin") set.add("super_admin");
      next[sectionKey] = set;
      return next;
    });
  }

  function submit() {
    const matrix: Record<string, string[]> = {};
    for (const [k, set] of Object.entries(draft)) {
      matrix[k] = Array.from(set);
    }
    save.mutate(matrix);
  }

  if (isLoading || !data) {
    return <div className="text-muted">Loading roles &amp; permissions…</div>;
  }

  const dirty = (() => {
    if (!data) return false;
    for (const s of data.sections) {
      const orig = new Set(
        (data.matrix[s.key] ?? []).includes("*")
          ? data.roles.map((r) => r.name)
          : data.matrix[s.key] ?? [],
      );
      const cur = draft[s.key] ?? new Set<string>();
      if (orig.size !== cur.size) return true;
      for (const r of orig) if (!cur.has(r)) return true;
    }
    return false;
  })();

  const previewSections = !previewRole ? null : data.sections.filter((s) => {
    if (s.fixed) return true;
    const allowed = Array.from(draft[s.key] ?? new Set<string>(data.matrix[s.key] ?? []));
    return allowed.includes("*") || allowed.includes(previewRole);
  });

  return (
    <div className="space-y-5 max-w-6xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="h1 flex items-center gap-2">
            <ShieldCheck size={26} className="text-accent" /> Roles &amp; permissions
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Decide which roles can see each section of the app. Only users with at least one allowed
            role will see the sidebar item — and the page itself returns "forbidden" for everyone else.
            <span className="block mt-1 inline-flex items-center gap-1 text-[12px]">
              <Info size={12} /> "My Accubin" and "Settings" are always visible to keep the workspace recoverable.
            </span>
          </p>
        </div>
        <SmartButton
          variant="primary"
          icon={<Check size={14} />}
          disabled={!dirty}
          loadingLabel="Saving…"
          onClick={submit}
        >
          Save permissions
        </SmartButton>
      </header>

      {isSuperAdmin && (
        <div className="bg-accent-soft/40 border border-accent/20 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <Info size={16} className="text-accent shrink-0 mt-0.5" />
            <div className="text-sm text-text">
              You're signed in as a <span className="font-mono font-semibold">super_admin</span>, so your own sidebar will keep
              showing every section regardless of what you toggle here — that's an intentional recovery guardrail. Use the{" "}
              <span className="font-semibold">Preview as role</span> picker below to see what a different role would see, or sign in
              as a member with that role to confirm.
            </div>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-2 text-sm text-muted">
          <Eye size={14} /> Preview the sidebar as
        </div>
        <select
          value={previewRole}
          onChange={(e) => setPreviewRole(e.target.value)}
          className="bg-bg border border-border rounded-full text-sm px-3 py-1.5 focus:outline-none focus:border-accent"
        >
          <option value="">— pick a role —</option>
          {data.roles.filter((r) => r.name !== "super_admin").map((r) => (
            <option key={r.name} value={r.name}>{r.name}</option>
          ))}
        </select>
        {previewSections && (
          <div className="text-sm text-text flex flex-wrap items-center gap-2">
            <span className="text-muted">→ would see</span>
            {previewSections.length === 0 ? (
              <span className="text-warn font-semibold">nothing (locked out of every section)</span>
            ) : (
              previewSections.map((s) => (
                <span key={s.key} className="pill bg-accent-soft text-accent">{s.label}</span>
              ))
            )}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
              <tr>
                <th className="text-left px-5 py-3">Section</th>
                {data.roles.map((r) => (
                  <th key={r.name} className="text-center px-3 py-3 whitespace-nowrap">
                    <div className="font-bold text-text normal-case text-[12px]">{r.name}</div>
                    {r.label && r.label !== r.name && (
                      <div className="text-[10px] text-muted font-normal normal-case mt-0.5">{r.label}</div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sections.map((s) => (
                <tr key={s.key} className="border-t border-border">
                  <td className="px-5 py-3">
                    <div className="font-semibold text-text inline-flex items-center gap-2">
                      {s.label}
                      {s.fixed && (
                        <span className="text-[10px] inline-flex items-center gap-1 text-muted">
                          <Lock size={10} /> always on
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted">/{s.key.replace(/_/g, "-")}</div>
                  </td>
                  {data.roles.map((r) => {
                    const on = s.fixed || (draft[s.key]?.has(r.name) ?? false);
                    const disabled = s.fixed || r.name === "super_admin";
                    return (
                      <td key={r.name} className="text-center px-3 py-3">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          onChange={() => toggle(s.key, r.name)}
                          className="w-4 h-4 accent-accent disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                          aria-label={`Allow ${r.name} to see ${s.label}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
