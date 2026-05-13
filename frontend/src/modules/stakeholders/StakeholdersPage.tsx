import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SmartButton } from "@/components/SmartButton";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/lib/confirm";
import {
  Users, Search, Mail, Phone, Briefcase, FolderKanban, Pencil, Trash2, X,
  LayoutGrid, Rows3, UserCheck, UserPlus,
} from "lucide-react";
import { SortHeader, TablePager, usePagedSort, type SortState } from "@/components/TableTools";

type Stakeholder = {
  id: string;
  name: string;
  role: string;
  kind: "internal" | "external";
  email: string;
  phone: string;
  notes: string;
  created_at: string;
  entity_type: "opportunity" | "project";
  entity_id: string;
  entity_name: string;
  entity_code: string;
};

const KIND_META: Record<Stakeholder["kind"], { label: string; cls: string }> = {
  internal: { label: "Internal", cls: "bg-accent-soft text-accent" },
  external: { label: "External", cls: "bg-warn/15 text-warn" },
};

function fmtRel(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export function StakeholdersPage() {
  const qc = useQueryClient();
  const [query, setQuery]     = useState("");
  const [kind,  setKind]      = useState<"all" | "internal" | "external">("all");
  const [scope, setScope]     = useState<"all" | "opportunity" | "project">("all");
  const [view,  setView]      = useState<"table" | "cards">("table");
  const [editing, setEditing] = useState<Stakeholder | null>(null);

  const { data, isLoading } = useQuery<{ items: Stakeholder[] }>({
    queryKey: ["stakeholders"],
    queryFn:  () => api("/api/v1/stakeholders"),
  });
  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    let list = items;
    if (kind  !== "all") list = list.filter((s) => s.kind === kind);
    if (scope !== "all") list = list.filter((s) => s.entity_type === scope);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.role.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        s.entity_name.toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, kind, scope, query]);

  const counts = useMemo(() => {
    const c = { all: items.length, internal: 0, external: 0, opportunity: 0, project: 0 };
    items.forEach((s) => {
      c[s.kind]++;
      c[s.entity_type]++;
    });
    return c;
  }, [items]);

  // Group by entity for the card view — "everyone on Project X" reads better than a flat list.
  const groups = useMemo(() => {
    const map = new Map<string, { entity_type: string; entity_name: string; entity_code: string; entity_id: string; items: Stakeholder[] }>();
    filtered.forEach((s) => {
      const key = `${s.entity_type}:${s.entity_id}`;
      const g = map.get(key);
      if (g) g.items.push(s);
      else map.set(key, {
        entity_type: s.entity_type, entity_name: s.entity_name,
        entity_code: s.entity_code, entity_id: s.entity_id, items: [s],
      });
    });
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
  }, [filtered]);

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Stakeholder> }) =>
      api(`/api/v1/stakeholders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Stakeholder updated");
      qc.invalidateQueries({ queryKey: ["stakeholders"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error("Update failed", e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/stakeholders/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Stakeholder removed");
      qc.invalidateQueries({ queryKey: ["stakeholders"] });
    },
  });

  return (
    <div className="space-y-5 max-w-7xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Directory</div>
          <h1 className="h1 mt-1 flex items-center gap-2">
            <Users size={26} className="text-accent" /> Stakeholders
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Everyone tied to your live opportunities and projects — sponsors, project owners, client contacts,
            external reviewers. Stakeholders are added on the source pipeline or project page; this directory is
            the cross-cut view for searching, filtering and updating contact details.
          </p>
        </div>
      </header>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        <Pills
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { v: "all",      label: "All kinds",     count: counts.all },
            { v: "internal", label: "Internal",      count: counts.internal },
            { v: "external", label: "External",      count: counts.external },
          ]}
        />
        <Pills
          value={scope}
          onChange={(v) => setScope(v as typeof scope)}
          options={[
            { v: "all",         label: "All scopes",  count: counts.all },
            { v: "opportunity", label: "On pipeline", count: counts.opportunity },
            { v: "project",     label: "On project",  count: counts.project },
          ]}
        />
      </div>

      {/* Search + view toggle */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, role, email, or entity…"
            className="pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-full w-[300px] focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-1 p-1 bg-surface border border-border rounded-full">
          <button onClick={() => setView("table")}
            className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "table" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
            aria-label="Table"><Rows3 size={13} /></button>
          <button onClick={() => setView("cards")}
            className={`grid place-items-center w-7 h-7 rounded-full transition-colors ${view === "cards" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"}`}
            aria-label="Grouped cards"><LayoutGrid size={13} /></button>
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="text-muted">Loading stakeholders…</div>
      ) : filtered.length === 0 ? (
        <EmptyState totalItems={items.length} />
      ) : view === "table" ? (
        <StakeholderTable rows={filtered} onEdit={setEditing} onRemove={(id) => remove.mutate(id)} />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(360px,1fr))]">
          {groups.map((g) => (
            <EntityCard key={`${g.entity_type}:${g.entity_id}`} group={g} onEdit={setEditing} onRemove={(id) => remove.mutate(id)} />
          ))}
        </div>
      )}

      {editing && (
        <EditDialog
          stakeholder={editing}
          submitting={update.isPending}
          onClose={() => setEditing(null)}
          onSave={(patch) => update.mutate({ id: editing.id, patch })}
        />
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function Pills<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string; count: number }[];
}) {
  return (
    <div className="flex gap-1 p-1 bg-surface border border-border rounded-full">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`text-[12px] font-semibold px-3 py-1.5 rounded-full transition-colors ${
            value === o.v ? "bg-accent text-white" : "text-muted hover:text-text"
          }`}
        >
          {o.label}<span className="ml-1.5 opacity-70">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

function EmptyState({ totalItems }: { totalItems: number }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-accent-soft text-accent grid place-items-center mb-3">
        <UserPlus size={22} />
      </div>
      <div className="text-base font-bold text-text">
        {totalItems === 0 ? "No stakeholders yet" : "Nothing matches those filters"}
      </div>
      <p className="text-sm text-muted mt-1 max-w-md mx-auto">
        {totalItems === 0
          ? "Stakeholders are added from each opportunity or project page — open one and use the Stakeholders side rail."
          : "Try clearing the filters or the search term."}
      </p>
    </div>
  );
}

function StakeholderTable({
  rows, onEdit, onRemove,
}: { rows: Stakeholder[]; onEdit: (s: Stakeholder) => void; onRemove: (id: string) => void }) {
  type SortCol = "name" | "role" | "kind" | "contact" | "entity" | "added";
  const compare = useCallback((a: Stakeholder, b: Stakeholder, s: SortState<SortCol>) => {
    const mul = s.dir === "asc" ? 1 : -1;
    switch (s.col) {
      case "name":    return mul * a.name.localeCompare(b.name);
      case "role":    return mul * a.role.localeCompare(b.role);
      case "kind":    return mul * a.kind.localeCompare(b.kind);
      case "contact": return mul * (a.email || a.phone).localeCompare(b.email || b.phone);
      case "entity":  return mul * a.entity_name.localeCompare(b.entity_name);
      case "added":   return mul * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
  }, []);
  const ps = usePagedSort<Stakeholder, SortCol>({
    rows,
    storageKey: "stakeholders-page-size",
    defaultSort: { col: "added", dir: "desc" },
    compare,
  });
  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg/40 text-[10.5px] uppercase tracking-wider font-bold text-muted">
            <tr>
              <SortHeader col="name"    label="Name"      sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="role"    label="Role"      sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="kind"    label="Kind"      sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="contact" label="Contact"   sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="entity"  label="Linked to" sort={ps.sort} onSort={(c) => ps.toggleSort(c, "asc")} />
              <SortHeader col="added"   label="Added"     sort={ps.sort} onSort={(c) => ps.toggleSort(c)} />
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {ps.pageRows.map((s) => {
              const km = KIND_META[s.kind];
              const entityHref = s.entity_type === "project"
                ? `/projects/${s.entity_id}`
                : `/pipeline/${s.entity_id}`;
              return (
                <tr key={s.id} className="border-t border-border hover:bg-bg/40 transition-colors">
                  <td className="px-4 py-3 min-w-[200px]">
                    <div className="font-bold text-text">{s.name}</div>
                    {s.notes && <div className="text-[11px] text-muted truncate max-w-[260px]" title={s.notes}>{s.notes}</div>}
                  </td>
                  <td className="px-3 py-3 text-text">{s.role}</td>
                  <td className="px-3 py-3"><span className={`pill ${km.cls}`}>{km.label}</span></td>
                  <td className="px-3 py-3 min-w-[200px]">
                    {s.email && <a href={`mailto:${s.email}`} className="text-[12.5px] text-accent hover:underline inline-flex items-center gap-1"><Mail size={11} /> {s.email}</a>}
                    {s.email && s.phone && <span className="text-muted"> · </span>}
                    {s.phone && <span className="text-[12.5px] text-text inline-flex items-center gap-1"><Phone size={11} /> {s.phone}</span>}
                    {!s.email && !s.phone && <span className="text-muted text-xs">—</span>}
                  </td>
                  <td className="px-3 py-3 min-w-[200px]">
                    <Link to={entityHref} className="inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline">
                      {s.entity_type === "project" ? <FolderKanban size={11} /> : <Briefcase size={11} />}
                      <span className="truncate max-w-[180px]">{s.entity_name}</span>
                    </Link>
                    {s.entity_code && <div className="text-[10.5px] text-muted">{s.entity_code}</div>}
                  </td>
                  <td className="px-3 py-3 text-[11px] text-muted whitespace-nowrap">{fmtRel(s.created_at)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <button onClick={() => onEdit(s)} className="text-muted hover:text-accent p-1" title="Edit"><Pencil size={13} /></button>
                    <button onClick={async () => {
                      const ok = await confirmAction({
                        title: `Remove ${s.name}?`,
                        body: `They'll be detached from ${s.entity_name}. The original entity is unaffected.`,
                        confirmLabel: "Remove stakeholder",
                        danger: true,
                      });
                      if (ok) onRemove(s.id);
                    }} className="text-muted hover:text-danger p-1 ml-1" title="Remove"><Trash2 size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TablePager
        total={ps.total}
        pageSize={ps.pageSize}
        pickPageSize={ps.pickPageSize}
        page={ps.page}
        setPage={ps.setPage}
        totalPages={ps.totalPages}
        firstShown={ps.firstShown}
        lastShown={ps.lastShown}
        label="stakeholder"
      />
    </div>
  );
}

function EntityCard({
  group, onEdit, onRemove,
}: {
  group: { entity_type: string; entity_name: string; entity_code: string; entity_id: string; items: Stakeholder[] };
  onEdit: (s: Stakeholder) => void;
  onRemove: (id: string) => void;
}) {
  const href = group.entity_type === "project"
    ? `/projects/${group.entity_id}`
    : `/pipeline/${group.entity_id}`;
  const Icon = group.entity_type === "project" ? FolderKanban : Briefcase;
  return (
    <section className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 py-3 bg-bg/40 border-b border-border">
        <div className="min-w-0 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
            <Icon size={13} />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
              {group.entity_type === "project" ? "Project" : "Pipeline"}{group.entity_code ? ` · ${group.entity_code}` : ""}
            </div>
            <Link to={href} className="text-[13.5px] font-bold text-text hover:text-accent truncate block">{group.entity_name}</Link>
          </div>
        </div>
        <span className="text-[11px] text-muted shrink-0">{group.items.length} stakeholder{group.items.length === 1 ? "" : "s"}</span>
      </header>
      <ul className="divide-y divide-border">
        {group.items.map((s) => (
          <li key={s.id} className="flex items-start gap-3 p-3 hover:bg-bg/30 transition-colors">
            <span className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-extrabold shrink-0 ${
              s.kind === "internal" ? "bg-accent-soft text-accent" : "bg-warn/15 text-warn"
            }`}>
              <UserCheck size={12} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-text truncate">{s.name}</span>
                <span className={`pill ${KIND_META[s.kind].cls}`} style={{ fontSize: 9.5 }}>{KIND_META[s.kind].label}</span>
              </div>
              <div className="text-[11.5px] text-muted truncate">{s.role}</div>
              {(s.email || s.phone) && (
                <div className="text-[11px] text-muted truncate mt-0.5">
                  {s.email && <a href={`mailto:${s.email}`} className="hover:text-accent">{s.email}</a>}
                  {s.email && s.phone && " · "}
                  {s.phone}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => onEdit(s)} className="text-muted hover:text-accent p-1" title="Edit"><Pencil size={11} /></button>
              <button onClick={async () => {
                const ok = await confirmAction({ title: `Remove ${s.name}?`, confirmLabel: "Remove", danger: true });
                if (ok) onRemove(s.id);
              }} className="text-muted hover:text-danger p-1" title="Remove"><Trash2 size={11} /></button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EditDialog({
  stakeholder, submitting, onClose, onSave,
}: {
  stakeholder: Stakeholder;
  submitting: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Stakeholder>) => void;
}) {
  const [form, setForm] = useState({
    name: stakeholder.name,
    role: stakeholder.role,
    kind: stakeholder.kind,
    email: stakeholder.email,
    phone: stakeholder.phone,
    notes: stakeholder.notes,
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.name.trim() && form.role.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card overflow-hidden">
        <header className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-base font-bold text-text">Edit stakeholder</h2>
            <p className="text-[11px] text-muted">Linked to {stakeholder.entity_type === "project" ? "project" : "pipeline"}: {stakeholder.entity_name}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="label">Name</div>
              <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus />
            </label>
            <label className="block">
              <div className="label">Role</div>
              <input className="input" value={form.role} onChange={(e) => set("role", e.target.value)} placeholder="e.g. Project sponsor" />
            </label>
            <label className="block">
              <div className="label">Kind</div>
              <select className="input" value={form.kind} onChange={(e) => set("kind", e.target.value as "internal" | "external")}>
                <option value="internal">Internal</option>
                <option value="external">External</option>
              </select>
            </label>
            <label className="block">
              <div className="label">Phone</div>
              <input className="input" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <div className="label">Email</div>
              <input className="input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </label>
            <label className="block md:col-span-2">
              <div className="label">Notes</div>
              <textarea className="input" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </label>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 p-4 border-t border-border bg-bg">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <SmartButton variant="primary" disabled={!valid || submitting} loading={submitting} onClick={() => onSave(form)}>Save</SmartButton>
        </footer>
      </div>
    </div>
  );
}
