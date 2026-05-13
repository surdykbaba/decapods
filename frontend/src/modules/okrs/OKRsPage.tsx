// OKRsPage — Phase 1 of the OKR loop.
//
// One page, two tabs:
//   • Mine     — current-cycle objectives + KRs the caller owns. Inline
//                edit, add objective / add KR, slide confidence + bump
//                progress.
//   • Workspace — every objective in the active cycle. Read-only browse
//                 for transparency; clicking opens the same edit drawer
//                 (admin or owner can save).
//
// The data shape mirrors backend okrs.go: objectives + key_results
// share the okrs table; KRs hang off their parent_id. The SPA groups
// them locally so the API doesn't have to.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Target, Plus, Pencil, Trash2, ChevronDown, ChevronRight,
  TrendingUp, Sparkles, Flag, X, Save,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import { SmartButton } from "@/components/SmartButton";

type Cycle = {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: "planning" | "active" | "closed";
};

type OKR = {
  id: string;
  cycle_id: string;
  parent_id: string | null;
  parent_title?: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  kind: "objective" | "key_result";
  title: string;
  description: string;
  target_value: number | null;
  current_value: number;
  unit: string;
  confidence: "green" | "amber" | "red";
  status: "draft" | "in_progress" | "done" | "dropped";
  position: number;
  progress_pct: number;
  // Phase 2 — check-in summary.
  checkin_count: number;
  latest_checkin_at?: string | null;
};

type OKRCheckin = {
  id: string;
  okr_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  current_value: number | null;
  percent: number;
  confidence: "green" | "amber" | "red";
  status?: "draft" | "in_progress" | "done" | "dropped" | null;
  comment: string;
  created_at: string;
};

const CONFIDENCE_META: Record<OKR["confidence"], { label: string; cls: string }> = {
  green: { label: "On track", cls: "bg-success/15 text-success border-success/30" },
  amber: { label: "At risk",  cls: "bg-warn/15 text-warn border-warn/30" },
  red:   { label: "Off track", cls: "bg-danger/15 text-danger border-danger/30" },
};

const STATUS_META: Record<OKR["status"], { label: string; cls: string }> = {
  draft:       { label: "Draft",       cls: "bg-bg text-muted border-border" },
  in_progress: { label: "In progress", cls: "bg-accent-soft text-accent border-accent/30" },
  done:        { label: "Done",        cls: "bg-success/15 text-success border-success/30" },
  dropped:     { label: "Dropped",     cls: "bg-bg text-muted border-border" },
};

export function OKRsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"mine" | "workspace">("mine");
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OKR | null>(null);
  const [creating, setCreating] = useState<{ cycleId: string; kind: OKR["kind"]; parentId?: string } | null>(null);
  // Phase 2 — check-in dialog target + history-popover target.
  const [checkingIn, setCheckingIn] = useState<OKR | null>(null);
  const [historyFor, setHistoryFor] = useState<OKR | null>(null);

  const { data: cyclesData } = useQuery<{ items: Cycle[] }>({
    queryKey: ["okrs", "cycles"],
    queryFn: () => api("/api/v1/okrs/cycles"),
    staleTime: 5 * 60_000,
  });
  const cycles = cyclesData?.items ?? [];
  // Pick the active cycle by default (status='active'), falling back to
  // the newest planning cycle, then the most recent overall.
  const defaultCycle = cycles.find((c) => c.status === "active")
    ?? cycles.find((c) => c.status === "planning")
    ?? cycles[0];
  const cycleId = activeCycleId ?? defaultCycle?.id ?? null;
  const cycle = cycles.find((c) => c.id === cycleId);

  const { data: okrsData, isLoading } = useQuery<{ items: OKR[] }>({
    queryKey: ["okrs", "list", cycleId, tab],
    queryFn: () => {
      const p = new URLSearchParams();
      if (cycleId) p.set("cycle_id", cycleId);
      if (tab === "mine" && user?.id) p.set("owner_id", user.id);
      return api(`/api/v1/okrs?${p.toString()}`);
    },
    enabled: !!cycleId,
    staleTime: 30_000,
  });

  // Group: objectives at the top, KRs nested under their parent.
  const grouped = useMemo(() => {
    const items = okrsData?.items ?? [];
    const objs = items.filter((o) => o.kind === "objective").sort((a, b) => a.position - b.position);
    const krsByParent = new Map<string, OKR[]>();
    items.filter((o) => o.kind === "key_result").forEach((kr) => {
      if (!kr.parent_id) return;
      const list = krsByParent.get(kr.parent_id) ?? [];
      list.push(kr);
      krsByParent.set(kr.parent_id, list);
    });
    krsByParent.forEach((list) => list.sort((a, b) => a.position - b.position));
    return { objs, krsByParent };
  }, [okrsData]);

  return (
    <div className="space-y-5 max-w-5xl">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-accent font-bold">Performance</div>
          <h1 className="h1 mt-1 flex items-center gap-2"><Target size={22} className="text-accent" /> OKRs</h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Quarterly objectives + the measurable key results that prove them. Set targets, bump
            progress as you ship, and watch the confidence band shift from green to red before
            the cycle ends.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {cycles.length > 0 && (
            <select
              value={cycleId ?? ""}
              onChange={(e) => setActiveCycleId(e.target.value)}
              className="bg-surface border border-border rounded-full px-3 py-1.5 text-[12.5px] font-semibold"
            >
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.status === "active" ? "• active" : c.status === "planning" ? "• planning" : ""}
                </option>
              ))}
            </select>
          )}
          {cycle && (
            <button
              type="button"
              onClick={() => setCreating({ cycleId: cycle.id, kind: "objective" })}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
            >
              <Plus size={14} /> Add objective
            </button>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-full w-fit">
        {(["mine", "workspace"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-[12.5px] font-semibold rounded-full transition-colors ${
              tab === t ? "bg-accent text-white" : "text-muted hover:text-text"
            }`}
          >
            {t === "mine" ? "Mine" : "Workspace"}
          </button>
        ))}
      </div>

      {/* Cycle empty-state — show the admin a CTA when no cycles exist */}
      {cycles.length === 0 && (
        <section className="bg-surface border border-border rounded-2xl p-8 text-center">
          <Target size={32} className="mx-auto text-muted mb-3" />
          <div className="text-base font-bold text-text">No OKR cycles yet</div>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            Ask an admin to create the first quarterly cycle in <code className="text-xs">Settings → OKR cycles</code>
            (coming next), or use the Workspace API to seed one.
          </p>
        </section>
      )}

      {/* Body */}
      {cycle && (
        <>
          {isLoading ? (
            <div className="text-muted">Loading…</div>
          ) : grouped.objs.length === 0 ? (
            <section className="bg-surface border border-border rounded-2xl p-8 text-center">
              <Sparkles size={28} className="mx-auto text-muted mb-3" />
              <div className="text-base font-bold text-text">
                {tab === "mine" ? "No objectives this cycle" : "Nothing posted yet for this cycle"}
              </div>
              <p className="text-sm text-muted mt-1 max-w-md mx-auto">
                {tab === "mine"
                  ? "Set 1–3 objectives that capture your priorities for the cycle. Each one gets 2–4 measurable key results underneath."
                  : "When teammates publish objectives they'll appear here."}
              </p>
              {tab === "mine" && (
                <button
                  type="button"
                  onClick={() => setCreating({ cycleId: cycle.id, kind: "objective" })}
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90"
                >
                  <Plus size={14} /> Add my first objective
                </button>
              )}
            </section>
          ) : (
            <ul className="space-y-3">
              {grouped.objs.map((obj) => (
                <ObjectiveCard
                  key={obj.id}
                  objective={obj}
                  keyResults={grouped.krsByParent.get(obj.id) ?? []}
                  canEdit={tab === "mine" || obj.owner_id === user?.id}
                  onEdit={(o) => setEditing(o)}
                  onAddKR={() => setCreating({ cycleId: cycle.id, kind: "key_result", parentId: obj.id })}
                  onCheckin={(o) => setCheckingIn(o)}
                  onHistory={(o) => setHistoryFor(o)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {editing && (
        <EditOKRDialog
          okr={editing}
          cycleObjectives={grouped.objs}
          onClose={() => setEditing(null)}
        />
      )}
      {creating && (
        <CreateOKRDialog
          cycleId={creating.cycleId}
          kind={creating.kind}
          parentId={creating.parentId}
          onClose={() => setCreating(null)}
        />
      )}
      {checkingIn && (
        <CheckinDialog
          okr={checkingIn}
          onClose={() => setCheckingIn(null)}
        />
      )}
      {historyFor && (
        <HistoryDialog
          okr={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}

// ObjectiveCard — one objective + its KRs. Inline progress bar driven
// by the avg of the KR progress percentages (objectives don't carry
// their own quantitative target in v1).
function ObjectiveCard({
  objective, keyResults, canEdit, onEdit, onAddKR, onCheckin, onHistory,
}: {
  objective: OKR;
  keyResults: OKR[];
  canEdit: boolean;
  onEdit: (o: OKR) => void;
  onAddKR: () => void;
  onCheckin: (o: OKR) => void;
  onHistory: (o: OKR) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const avgPct = keyResults.length === 0 ? 0
    : Math.round(keyResults.reduce((s, k) => s + k.progress_pct, 0) / keyResults.length);
  const conf = CONFIDENCE_META[objective.confidence];
  return (
    <li className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
        >
          {expanded ? <ChevronDown size={14} className="mt-1 shrink-0 text-muted" /> : <ChevronRight size={14} className="mt-1 shrink-0 text-muted" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-bold text-text">{objective.title}</span>
              <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${conf.cls}`}>{conf.label}</span>
              <span className="text-[11px] text-muted">{objective.owner_name || objective.owner_email}</span>
              {/* Parent-alignment chip — only when this objective is
                  aligned upward (cascaded from a team/org objective). */}
              {objective.parent_id && objective.parent_title && (
                <span
                  className="pill bg-accent-soft text-accent border border-accent/30 text-[10px] uppercase tracking-wide font-bold inline-flex items-center gap-1"
                  title={`Aligned to: ${objective.parent_title}`}
                >
                  ↗ {objective.parent_title.length > 28 ? objective.parent_title.slice(0, 28) + "…" : objective.parent_title}
                </span>
              )}
            </div>
            {objective.description && (
              <p className="text-[12px] text-muted leading-snug mt-0.5 line-clamp-2">{objective.description}</p>
            )}
            {/* Stale-checkin nudge: when 7+ days since the last check-in
                (or never) and this is the owner's own row. */}
            <CheckinStatus okr={objective} canEdit={canEdit} onCheckin={onCheckin} onHistory={onHistory} />
          </div>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => onCheckin(objective)}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
                title="Log a weekly check-in"
              >
                <TrendingUp size={11} /> Check in
              </button>
              <button
                type="button"
                onClick={() => onEdit(objective)}
                className="text-[11.5px] text-muted hover:text-accent p-1.5"
                title="Edit"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={onAddKR}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline"
              >
                <Plus size={11} /> Add KR
              </button>
            </>
          )}
        </div>
      </header>

      {/* Progress strip — objective avg */}
      <div className="px-4 pb-2">
        <div className="flex items-center justify-between gap-2 text-[11px] mb-1">
          <span className="text-muted">Avg progress · {keyResults.length} KR{keyResults.length === 1 ? "" : "s"}</span>
          <span className="font-semibold text-text">{avgPct}%</span>
        </div>
        <div className="h-1.5 bg-bg/60 rounded-full overflow-hidden">
          <div className={`h-full ${avgPct === 100 ? "bg-success" : avgPct >= 50 ? "bg-accent" : "bg-warn"}`} style={{ width: `${avgPct}%` }} />
        </div>
      </div>

      {expanded && (
        <ul className="px-4 pb-4 space-y-2">
          {keyResults.length === 0 ? (
            <li className="text-[12px] text-muted italic py-2">No key results yet. Add 2–4 to make this objective measurable.</li>
          ) : keyResults.map((kr) => (
            <KRRow
              key={kr.id}
              kr={kr}
              canEdit={canEdit}
              onEdit={() => onEdit(kr)}
              onCheckin={() => onCheckin(kr)}
              onHistory={() => onHistory(kr)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// KRRow — one key result. Shows the title, current/target, a slim
// progress bar, and a confidence pill.
function KRRow({
  kr, canEdit, onEdit, onCheckin, onHistory,
}: {
  kr: OKR;
  canEdit: boolean;
  onEdit: () => void;
  onCheckin: () => void;
  onHistory: () => void;
}) {
  const conf = CONFIDENCE_META[kr.confidence];
  const status = STATUS_META[kr.status];
  return (
    <li className="bg-bg/40 border border-border rounded-xl px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Flag size={11} className="text-muted shrink-0" />
            <span className="text-[12.5px] font-semibold text-text">{kr.title}</span>
            <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${conf.cls}`}>{conf.label}</span>
            {kr.status !== "in_progress" && (
              <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${status.cls}`}>{status.label}</span>
            )}
          </div>
          {kr.description && (
            <p className="text-[11.5px] text-muted leading-snug mt-0.5 line-clamp-2">{kr.description}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 text-[12px]">
          {kr.target_value !== null ? (
            <span className="text-text">
              <span className="font-bold">{formatNum(kr.current_value)}</span>
              <span className="text-muted"> / {formatNum(kr.target_value)}</span>
              {kr.unit && <span className="text-muted"> {kr.unit}</span>}
            </span>
          ) : (
            <span className="text-muted">{kr.status === "done" ? "Done" : "—"}</span>
          )}
          <span className="text-[11px] text-muted">·</span>
          <span className="font-semibold text-text">{kr.progress_pct}%</span>
          {canEdit && (
            <button
              type="button"
              onClick={onCheckin}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              title="Log a weekly check-in"
            >
              <TrendingUp size={11} /> Check in
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="text-muted hover:text-accent p-1"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="h-1 mt-1.5 bg-bg/60 rounded-full overflow-hidden">
        <div className={`h-full ${kr.progress_pct === 100 ? "bg-success" : kr.progress_pct >= 50 ? "bg-accent" : "bg-warn"}`} style={{ width: `${kr.progress_pct}%` }} />
      </div>
      <CheckinStatus okr={kr} canEdit={canEdit} onCheckin={() => onCheckin()} onHistory={() => onHistory()} compact />
    </li>
  );
}

// CheckinStatus — single line below an OKR header / KR row showing how
// recently it was checked in on. Renders nothing when there are no
// check-ins AND the user can't edit; otherwise nudges the owner when
// the most recent is stale (>7 days) and exposes a "history" link.
function CheckinStatus({
  okr, canEdit, onCheckin, onHistory, compact,
}: {
  okr: OKR;
  canEdit: boolean;
  onCheckin: (o: OKR) => void;
  onHistory: (o: OKR) => void;
  compact?: boolean;
}) {
  if (okr.checkin_count === 0 && !canEdit) return null;
  const latest = okr.latest_checkin_at ? new Date(okr.latest_checkin_at) : null;
  const ageDays = latest ? Math.floor((Date.now() - latest.getTime()) / 86_400_000) : null;
  const stale = canEdit && (ageDays === null || ageDays >= 7);
  const fmt = ageDays === null
    ? "No check-ins yet"
    : ageDays === 0 ? "Checked in today"
    : ageDays === 1 ? "Checked in yesterday"
    : `Checked in ${ageDays}d ago`;
  return (
    <div className={`${compact ? "mt-1" : "mt-1.5"} flex items-center gap-2 flex-wrap text-[10.5px]`}>
      <span className={stale ? "text-warn font-semibold" : "text-muted"}>
        {stale && "⚠ "}{fmt}
        {okr.checkin_count > 0 && <span className="text-muted/70"> · {okr.checkin_count} update{okr.checkin_count === 1 ? "" : "s"}</span>}
      </span>
      {okr.checkin_count > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onHistory(okr); }}
          className="text-accent hover:underline"
        >
          See history
        </button>
      )}
      {stale && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCheckin(okr); }}
          className="text-accent hover:underline"
        >
          Update now
        </button>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

// ─────────────────────────────────────────────────────────────────────
// Create / Edit dialogs
// ─────────────────────────────────────────────────────────────────────

function CreateOKRDialog({
  cycleId, kind, parentId, onClose,
}: {
  cycleId: string;
  kind: OKR["kind"];
  parentId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [confidence, setConfidence] = useState<OKR["confidence"]>("green");
  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/okrs", {
        method: "POST",
        body: JSON.stringify({
          cycle_id: cycleId,
          kind,
          parent_id: parentId,
          title: title.trim(),
          description: description.trim(),
          target_value: kind === "key_result" && target.trim() !== "" ? parseFloat(target) : undefined,
          unit: kind === "key_result" ? unit.trim() : undefined,
          confidence,
        }),
      }),
    onSuccess: () => {
      toast.success(kind === "objective" ? "Objective added" : "Key result added");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });
  const isObjective = kind === "objective";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text">{isObjective ? "New objective" : "New key result"}</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Title</div>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isObjective ? "Ship 3 priority features this quarter" : "Land Feature X in production"}
              className="input"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Description (optional)</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="input resize-none"
            />
          </label>
          {!isObjective && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Target</div>
                <input
                  type="number"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="100"
                  className="input"
                />
                <div className="text-[10.5px] text-muted mt-1">Leave empty for done/not-done KRs.</div>
              </label>
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Unit</div>
                <input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="%, signups, ₦"
                  className="input"
                />
              </label>
            </div>
          )}
          <ConfidencePicker value={confidence} onChange={setConfidence} />
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton variant="primary" disabled={!title.trim() || save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
            <Plus size={13} /> Add
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// CheckinDialog — weekly progress update. For quantitative KRs we
// surface a "current value" field + auto-derive percent; qualitative
// rows just collect confidence + comment + optional status change.
function CheckinDialog({ okr, onClose }: { okr: OKR; onClose: () => void }) {
  const qc = useQueryClient();
  const isQuantitative = okr.target_value !== null;
  const [current, setCurrent] = useState(String(okr.current_value));
  const [percent, setPercent] = useState(okr.progress_pct);
  const [confidence, setConfidence] = useState<OKR["confidence"]>(okr.confidence);
  const [status, setStatus] = useState<OKR["status"]>(okr.status);
  const [comment, setComment] = useState("");
  // Auto-recompute percent from current when quantitative.
  const derivedPct = useMemo(() => {
    if (!isQuantitative || okr.target_value === null || okr.target_value === 0) return percent;
    const p = Math.round((parseFloat(current) / okr.target_value) * 100);
    return Math.max(0, Math.min(100, p));
  }, [current, isQuantitative, okr.target_value, percent]);

  const save = useMutation({
    mutationFn: () => api(`/api/v1/okrs/${okr.id}/checkins`, {
      method: "POST",
      body: JSON.stringify({
        ...(isQuantitative ? { current_value: parseFloat(current) || 0 } : {}),
        percent: isQuantitative ? undefined : percent,
        confidence,
        status,
        comment: comment.trim(),
      }),
    }),
    onSuccess: () => {
      toast.success("Check-in saved", "The OKR's progress + confidence are updated.");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Weekly check-in</div>
            <h2 className="text-base font-bold text-text leading-tight mt-0.5 truncate">{okr.title}</h2>
            {okr.parent_title && <div className="text-[11px] text-muted mt-0.5">↗ {okr.parent_title}</div>}
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          {isQuantitative ? (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Current value</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  className="input flex-1"
                  autoFocus
                />
                {okr.unit && <span className="text-[12.5px] text-muted">{okr.unit}</span>}
                <span className="text-muted">/</span>
                <span className="text-[12.5px] font-semibold text-text">{formatNum(okr.target_value ?? 0)}</span>
              </div>
              <div className="text-[10.5px] text-muted mt-1">
                That'll set progress to <span className="font-semibold text-text">{derivedPct}%</span>.
              </div>
            </div>
          ) : (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Progress</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={percent}
                  onChange={(e) => setPercent(parseInt(e.target.value, 10))}
                  className="flex-1"
                />
                <span className="text-[12.5px] font-bold text-text w-10 text-right">{percent}%</span>
              </div>
            </div>
          )}
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1">
              {(["draft", "in_progress", "done", "dropped"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                    status === s ? STATUS_META[s].cls + " border" : "bg-bg text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Comment (optional)</div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="input resize-none text-sm"
              placeholder={confidence === "red" ? "What's blocking? Who can unblock?" : "What moved the needle this week?"}
            />
          </label>
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
          <SmartButton variant="primary" disabled={save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
            <Save size={13} /> Save check-in
          </SmartButton>
        </footer>
      </div>
    </div>
  );
}

// HistoryDialog — reverse-chronological log of every check-in on this OKR.
// Useful for 1:1s + cycle-end retrospective.
function HistoryDialog({ okr, onClose }: { okr: OKR; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ items: OKRCheckin[] }>({
    queryKey: ["okrs", "checkins", okr.id],
    queryFn: () => api(`/api/v1/okrs/${okr.id}/checkins`),
  });
  const items = data?.items ?? [];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-accent font-bold">Check-in history</div>
            <h2 className="text-base font-bold text-text leading-tight mt-0.5 truncate">{okr.title}</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted">No check-ins yet on this OKR.</div>
          ) : (
            <ul className="space-y-3">
              {items.map((ck) => (
                <li key={ck.id} className="bg-bg/40 border border-border rounded-xl px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap text-[11.5px]">
                    <span className="font-bold text-text">{ck.user_name || ck.user_email.split("@")[0]}</span>
                    <span className="text-muted">{new Date(ck.created_at).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${CONFIDENCE_META[ck.confidence].cls}`}>
                      {CONFIDENCE_META[ck.confidence].label}
                    </span>
                    <span className="text-[12px] font-semibold text-text">{ck.percent}%</span>
                    {ck.current_value !== null && (
                      <span className="text-[12px] text-muted">· value {formatNum(ck.current_value)}</span>
                    )}
                    {ck.status && ck.status !== "in_progress" && (
                      <span className={`pill border text-[10px] uppercase tracking-wide font-bold ${STATUS_META[ck.status].cls}`}>
                        {STATUS_META[ck.status].label}
                      </span>
                    )}
                  </div>
                  {ck.comment && (
                    <p className="text-[12.5px] text-text/80 mt-1.5 whitespace-pre-wrap leading-snug">{ck.comment}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function EditOKRDialog({ okr, cycleObjectives, onClose }: { okr: OKR; cycleObjectives: OKR[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(okr.title);
  const [description, setDescription] = useState(okr.description);
  const [current, setCurrent] = useState(String(okr.current_value));
  const [target, setTarget] = useState(okr.target_value === null ? "" : String(okr.target_value));
  const [unit, setUnit] = useState(okr.unit);
  const [confidence, setConfidence] = useState<OKR["confidence"]>(okr.confidence);
  const [status, setStatus] = useState<OKR["status"]>(okr.status);
  const [parentId, setParentId] = useState<string>(okr.parent_id ?? "");
  const isKR = okr.kind === "key_result";
  const parentOptions = cycleObjectives.filter((o) => o.id !== okr.id && o.kind === "objective");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/okrs/${okr.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description,
          current_value: parseFloat(current) || 0,
          target_value: target.trim() === "" ? "" : parseFloat(target),
          unit,
          confidence,
          status,
          ...(isKR ? {} : { parent_id: parentId }),
        }),
      }),
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't save", e?.message),
  });
  const del = useMutation({
    mutationFn: () => api(`/api/v1/okrs/${okr.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["okrs"] });
      onClose();
    },
    onError: (e: any) => toast.error("Couldn't delete", e?.message),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-bold text-text">{isKR ? "Edit key result" : "Edit objective"}</h2>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Title</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Description</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input resize-none" />
          </label>
          {!isKR && (
            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Aligns to parent objective</div>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="input">
                <option value="">— No parent —</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              <div className="text-[11px] text-muted mt-1">Cascades roll up under the chosen parent in the workspace view.</div>
            </label>
          )}
          {isKR && (
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Current</div>
                <input type="number" value={current} onChange={(e) => setCurrent(e.target.value)} className="input" />
              </label>
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Target</div>
                <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className="input" />
              </label>
              <label className="block">
                <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1">Unit</div>
                <input value={unit} onChange={(e) => setUnit(e.target.value)} className="input" />
              </label>
            </div>
          )}
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1">
              {(["draft", "in_progress", "done", "dropped"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                    status === s ? STATUS_META[s].cls + " border" : "bg-bg text-muted border-border hover:border-accent/40"
                  }`}
                >
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 bg-bg/30">
          <button
            onClick={() => { if (confirm("Delete this OKR? It can't be undone.")) del.mutate(); }}
            disabled={del.isPending}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-danger hover:underline"
          >
            <Trash2 size={11} /> Delete
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg text-muted hover:text-text">Cancel</button>
            <SmartButton variant="primary" disabled={save.isPending} loadingLabel="Saving…" onClick={() => save.mutate()}>
              <Save size={13} /> Save
            </SmartButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ConfidencePicker — three-button R/A/G row used by create + edit.
function ConfidencePicker({
  value, onChange,
}: {
  value: OKR["confidence"];
  onChange: (v: OKR["confidence"]) => void;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted font-bold mb-1.5 inline-flex items-center gap-1">
        <TrendingUp size={11} /> Confidence
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {(["green", "amber", "red"] as const).map((c) => {
          const meta = CONFIDENCE_META[c];
          const on = value === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={`text-[11px] font-bold uppercase tracking-wide px-2 py-1.5 rounded-lg border transition-all ${
                on ? meta.cls + " scale-[1.02]" : "border-border text-muted hover:text-text"
              }`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default OKRsPage;
