import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Empty, Skeleton } from "@/components/ui";
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors,
  DragOverlay, type DragEndEvent,
} from "@dnd-kit/core";
import {
  Plus, Search, MoreHorizontal, Wallet, Calendar, Sparkles,
  Filter, ChevronDown, X, FileText, AlertTriangle, CheckCircle2,
  ArrowRight, Bell, GripVertical, List, LayoutGrid, ExternalLink,
} from "lucide-react";

type Transition = { from: string; to: string; label?: string; roles?: string[] };

type Opp = {
  id: string;
  title: string;
  stage: string;
  lead_type: string;
  estimated_value: number;
  priority: number;
  risk_level: string;
  created_at: string;
  updated_at: string;
  client_name: string;
  docs_attached: number;
  docs_required: number;
  next_stages: Transition[];
};

const STAGES: { key: string; label: string; dot: string }[] = [
  { key: "new_request",       label: "New request",     dot: "bg-[#1e212a]" },
  { key: "under_review",      label: "Under review",    dot: "bg-[#ef4444]" },
  { key: "approved",          label: "Approved",        dot: "bg-[#3b82f6]" },
  { key: "contracting",       label: "Contracting",     dot: "bg-[#a855f7]" },
  { key: "planning",          label: "Planning",        dot: "bg-[#f59e0b]" },
  { key: "in_progress",       label: "In progress",     dot: "bg-[#10b981]" },
  { key: "qa_review",         label: "QA review",       dot: "bg-[#06b6d4]" },
  { key: "client_acceptance", label: "Client accept",   dot: "bg-[#0ea5e9]" },
  { key: "invoiced",          label: "Invoiced",        dot: "bg-[#8b5cf6]" },
  { key: "paid",              label: "Paid",            dot: "bg-[#22c55e]" },
  { key: "closed",            label: "Closed",          dot: "bg-[#6b7280]" },
];

function fmtMoney(n: number, compact = true): string {
  if (!n) return "₦0";
  if (compact) {
    if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `₦${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `₦${n.toLocaleString()}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function daysSince(iso: string): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

type CardStatus = "on_track" | "attention" | "blocked" | "ready" | "review" | "missing_docs";
type CardSignal = { status: CardStatus; label: string };

function signalOf(o: Opp): CardSignal {
  const days = daysSince(o.updated_at);
  const missing = Math.max(0, o.docs_required - o.docs_attached);
  if (o.stage === "new_request") {
    if (missing > 0) return { status: "missing_docs", label: `${missing} doc${missing === 1 ? "" : "s"} to attach` };
    return { status: "ready", label: "Ready to submit" };
  }
  if (o.stage === "under_review" && o.next_stages?.length) {
    return { status: "review", label: "Awaiting your review" };
  }
  if (days >= 14 && o.stage !== "closed" && o.stage !== "paid") return { status: "blocked", label: `Stalled ${days}d` };
  if (o.risk_level === "high" && o.stage !== "closed") return { status: "attention", label: "High risk" };
  if (days >= 7 && o.stage !== "closed" && o.stage !== "paid") return { status: "attention", label: `${days}d in stage` };
  return { status: "on_track", label: "On track" };
}

type DropError = {
  oppId: string;
  oppTitle: string;
  to: string;
  message: string;
  violations?: { code: string; message: string; field?: string }[];
};

type ViewMode = "kanban" | "list";

// Saved views — the pipeline questions a BD lead actually opens this
// page to ask. Predicates run on the already-tenant-scoped list.
type PipelineView = { id: string; label: string; match: (o: Opp) => boolean };
const PIPELINE_VIEWS: PipelineView[] = [
  { id: "attention", label: "Needs attention", match: (o) => {
      const s = signalOf(o).status;
      return s !== "on_track" && s !== "ready";
    } },
  { id: "high_risk", label: "High risk",     match: (o) => o.risk_level === "high" && o.stage !== "closed" },
  { id: "stalled",   label: "Stalled",       match: (o) => signalOf(o).status === "blocked" },
  { id: "priority",  label: "High priority", match: (o) => o.priority <= 2 },
  { id: "open",      label: "Open",          match: (o) => o.stage !== "closed" && o.stage !== "paid" },
];

const PL_VIEW = "pipeline_view";
const PL_LEAD = "pipeline_lead";
const PL_FILTER = "pipeline_filter";

export function PipelinePage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, isLoading } = useQuery<{ items: Opp[] }>({
    queryKey: ["opps"], queryFn: () => api("/api/v1/opportunities"),
  });

  const [view, setView] = useState<ViewMode>(
    () => (typeof window !== "undefined" && (localStorage.getItem(PL_VIEW) as ViewMode)) || "kanban",
  );
  const [query, setQuery] = useState("");
  const [leadType, setLeadType] = useState(
    () => (typeof window !== "undefined" && localStorage.getItem(PL_LEAD)) || "",
  );
  const [savedView, setSavedView] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem(PL_FILTER)) || "all",
  );
  useEffect(() => { try { localStorage.setItem(PL_VIEW, view); } catch { /* private */ } }, [view]);
  useEffect(() => { try { localStorage.setItem(PL_LEAD, leadType); } catch { /* private */ } }, [leadType]);
  useEffect(() => { try { localStorage.setItem(PL_FILTER, savedView); } catch { /* private */ } }, [savedView]);
  const [errors, setErrors] = useState<DropError[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function pushError(e: DropError) {
    setErrors((prev) => [...prev.filter((p) => p.oppId !== e.oppId || p.to !== e.to), e]);
  }
  function dismissError(idx: number) {
    setErrors((prev) => prev.filter((_, i) => i !== idx));
  }

  // Single mutation that picks /submit or /transition based on the move.
  const moveMutation = useMutation({
    mutationFn: async ({ opp, to }: { opp: Opp; to: string }) => {
      if (opp.stage === "new_request" && to === "under_review") {
        return api(`/api/v1/opportunities/${opp.id}/submit`, { method: "POST" });
      }
      return api(`/api/v1/opportunities/${opp.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opps"] });
    },
    onError: (err: unknown, vars) => {
      const opp = vars.opp;
      let message = "Move failed.";
      let violations: DropError["violations"] | undefined;
      if (err instanceof ApiError) {
        const body = (err.body as any) ?? {};
        if (err.status === 422 && Array.isArray(body.violations)) {
          violations = body.violations;
          const missing = body.violations.filter((v: any) => v.code === "missing_document").length;
          message = missing
            ? `Can't move to ${prettyStage(vars.to)} — ${missing} required document${missing === 1 ? "" : "s"} still missing.`
            : `Governance blocked the move.`;
        } else if (err.status === 403) {
          message = body.error === "transition not allowed for your role"
            ? `You don't have a role permitted to move this card to ${prettyStage(vars.to)}.`
            : (body.error || "You don't have permission for this move.");
        } else if (err.status === 409 || /invalid transition/i.test(body.error ?? "")) {
          message = `${prettyStage(opp.stage)} → ${prettyStage(vars.to)} isn't a valid step in this workflow.`;
        } else {
          message = body.error || (err as Error).message || message;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      pushError({ oppId: opp.id, oppTitle: opp.title, to: vars.to, message, violations });
    },
  });

  const items = data?.items ?? [];
  const savedViewMatch = useMemo(
    () => PIPELINE_VIEWS.find((v) => v.id === savedView)?.match,
    [savedView],
  );
  const filtered = useMemo(() => items.filter((o) => {
    if (query && !`${o.title} ${o.client_name}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (leadType && o.lead_type !== leadType) return false;
    if (savedViewMatch && !savedViewMatch(o)) return false;
    return true;
  }), [items, query, leadType, savedViewMatch]);

  const attentionCount = items.filter((o) => {
    const s = signalOf(o).status;
    return s !== "on_track" && s !== "ready";
  }).length;
  const leadTypes = useMemo(() => Array.from(new Set(items.map((o) => o.lead_type))).filter(Boolean), [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const draggedOpp = items.find((o) => o.id === draggingId) ?? null;

  function canDrop(opp: Opp, toKey: string): boolean {
    if (opp.stage === toKey) return false;
    if (opp.stage === "new_request" && toKey === "under_review") return true;
    return (opp.next_stages ?? []).some((t) => t.to === toKey);
  }

  function describeRejection(opp: Opp, toKey: string): string {
    // Special-case: new_request only progresses via submission, and submission has a doc gate.
    if (opp.stage === "new_request") {
      const missing = Math.max(0, opp.docs_required - opp.docs_attached);
      if (missing > 0) {
        return `${opp.title} needs ${missing} required document${missing === 1 ? "" : "s"} attached before it can move. New requests must go through "Under review" first — they can't jump to ${prettyStage(toKey)}.`;
      }
      return `New requests must move into "Under review" first (drag it there to submit). Skipping to ${prettyStage(toKey)} isn't allowed.`;
    }

    const allowed = (opp.next_stages ?? []).map((t) => prettyStage(t.to));
    if (allowed.length === 0) {
      return `${opp.title} is in ${prettyStage(opp.stage)} — there are no allowed moves from here. ${
        opp.stage === "closed" || opp.stage === "paid"
          ? "This stage is terminal."
          : "Your role might not permit any transitions out of this stage — check the workflow in Settings."
      }`;
    }
    return `${prettyStage(opp.stage)} → ${prettyStage(toKey)} isn't a step in this workflow. Allowed next from ${prettyStage(opp.stage)}: ${allowed.join(", ")}.`;
  }

  function onDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const oppId = String(e.active.id);
    const toKey = e.over ? String(e.over.id) : "";
    const opp = items.find((o) => o.id === oppId);
    if (!opp || !toKey || !STAGES.some((s) => s.key === toKey)) return;
    if (opp.stage === toKey) return;
    if (!canDrop(opp, toKey)) {
      pushError({ oppId, oppTitle: opp.title, to: toKey, message: describeRejection(opp, toKey) });
      return;
    }
    moveMutation.mutate({ opp, to: toKey });
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1">Pipeline</h1>
          <p className="text-sm text-muted">From request to closed engagement, gated by governance.</p>
        </div>
        <Link to="/pipeline/new" className="btn-primary"><Plus size={16} />New opportunity</Link>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-8"
            placeholder="Search deal name or company…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="inline-flex border border-border bg-surface rounded-md p-0.5">
          <ViewToggle on={view === "kanban"} onClick={() => setView("kanban")} icon={<LayoutGrid size={14} />} label="Kanban" />
          <ViewToggle on={view === "list"} onClick={() => setView("list")} icon={<List size={14} />} label="List" />
        </div>

        <Dropdown label={leadType ? `${leadType[0].toUpperCase()}${leadType.slice(1)} pipeline` : "All pipelines"}>
          <button onClick={() => setLeadType("")} className={`block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-bg ${!leadType ? "text-accent font-medium" : "text-text"}`}>All pipelines</button>
          {leadTypes.map((lt) => (
            <button key={lt} onClick={() => setLeadType(lt)} className={`block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-bg capitalize ${leadType === lt ? "text-accent font-medium" : "text-text"}`}>{lt}</button>
          ))}
        </Dropdown>

        {/* Saved views — persisted, counted presets. Replaces the old
            single "Filter" toggle with the questions people actually
            ask of the pipeline. */}
        <div className="flex items-center gap-1 border border-border bg-surface rounded-md p-1 text-xs flex-wrap">
          <button
            onClick={() => setSavedView("all")}
            className={`px-2 py-1 rounded font-medium ${savedView === "all" ? "bg-accent text-white" : "text-muted hover:text-text"}`}
          >
            All ({items.length})
          </button>
          {PIPELINE_VIEWS.map((v) => {
            const count = items.filter(v.match).length;
            return (
              <button
                key={v.id}
                onClick={() => setSavedView(v.id)}
                className={`px-2 py-1 rounded font-medium inline-flex items-center gap-1 ${
                  savedView === v.id ? "bg-accent text-white" : "text-muted hover:text-text"
                }`}
              >
                {v.id === "attention" && <Filter size={11} />}
                {v.label} ({count})
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-sm font-medium">
          <Sparkles size={14} />
          AI Insight {attentionCount > 0 && <span className="ml-0.5 text-xs bg-accent text-white px-1 rounded-full">{attentionCount}</span>}
        </div>
      </div>

      {/* Error banner */}
      {errors.length > 0 && (
        <div className="border border-danger/30 bg-danger/5 rounded-md p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-danger">
              <AlertTriangle size={16} />
              {errors.length} {errors.length === 1 ? "move was rejected" : "moves were rejected"}
            </div>
            <button className="text-xs text-muted hover:text-text" onClick={() => setErrors([])}>Dismiss all</button>
          </div>
          <ul className="space-y-1.5">
            {errors.map((e, i) => (
              <li key={`${e.oppId}-${e.to}-${i}`} className="flex items-start gap-2 text-sm">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-text">{e.oppTitle}</span>{" "}
                  <span className="text-muted">— {e.message}</span>
                  {e.violations && e.violations.length > 0 && (
                    <ul className="mt-1 ml-3 text-xs text-muted list-disc">
                      {e.violations.slice(0, 4).map((v, j) => (
                        <li key={j}>{v.message}</li>
                      ))}
                      {e.violations.length > 4 && <li>+{e.violations.length - 4} more…</li>}
                    </ul>
                  )}
                </div>
                <button
                  className="text-xs font-medium text-accent hover:underline shrink-0 inline-flex items-center gap-1"
                  onClick={() => nav(`/pipeline/${e.oppId}`)}
                >
                  Open <ExternalLink size={11} />
                </button>
                <button
                  className="text-muted hover:text-text"
                  onClick={() => dismissError(i)}
                  aria-label="Dismiss"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : items.length === 0 ? (
        <Empty title="No opportunities yet" body="Create your first opportunity to begin governance." />
      ) : view === "list" ? (
        <ListView
          items={filtered}
          onOpen={(id) => nav(`/pipeline/${id}`)}
          onMove={(opp, to) => moveMutation.mutate({ opp, to })}
          moving={moveMutation.isPending}
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(e) => setDraggingId(String(e.active.id))}
          onDragCancel={() => setDraggingId(null)}
          onDragEnd={onDragEnd}
        >
          <KanbanBoard
            items={filtered}
            ownerName={user?.name ?? "You"}
            onOpen={(id) => nav(`/pipeline/${id}`)}
            onMove={(opp, to) => moveMutation.mutate({ opp, to })}
            moving={moveMutation.isPending}
            draggingId={draggingId}
            canDrop={canDrop}
          />
          <DragOverlay>
            {draggedOpp ? (
              <div className="bg-surface border border-accent shadow-lg rounded-lg p-4 opacity-95 cursor-grabbing w-[300px]">
                <div className="text-[15px] font-semibold text-text truncate">{draggedOpp.title}</div>
                <div className="text-xs text-muted">{draggedOpp.client_name || draggedOpp.lead_type}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function prettyStage(s: string) { return s.replace(/_/g, " "); }

function KanbanBoard({
  items, ownerName, onOpen, onMove, moving, draggingId, canDrop,
}: {
  items: Opp[];
  ownerName: string;
  onOpen: (id: string) => void;
  onMove: (opp: Opp, to: string) => void;
  moving: boolean;
  draggingId: string | null;
  canDrop: (opp: Opp, toKey: string) => boolean;
}) {
  const grouped = STAGES.map((s) => ({
    stage: s,
    items: items.filter((o) => o.stage === s.key),
  })).filter((c) => c.items.length > 0 || ["new_request","under_review","approved","contracting","planning","in_progress"].includes(c.stage.key));

  const draggingOpp = draggingId ? items.find((o) => o.id === draggingId) ?? null : null;

  return (
    <div className="overflow-x-auto pb-4 -mx-2 px-2">
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${grouped.length}, minmax(300px, 1fr))` }}>
        {grouped.map((col) => (
          <DroppableColumn
            key={col.stage.key}
            stage={col.stage}
            items={col.items}
            ownerName={ownerName}
            onOpen={onOpen}
            onMove={onMove}
            moving={moving}
            highlight={draggingOpp ? canDrop(draggingOpp, col.stage.key) : false}
            dimmed={draggingOpp ? !canDrop(draggingOpp, col.stage.key) && draggingOpp.stage !== col.stage.key : false}
          />
        ))}
      </div>
    </div>
  );
}

function DroppableColumn({
  stage, items, ownerName, onOpen, onMove, moving, highlight, dimmed,
}: {
  stage: { key: string; label: string; dot: string };
  items: Opp[];
  ownerName: string;
  onOpen: (id: string) => void;
  onMove: (opp: Opp, to: string) => void;
  moving: boolean;
  highlight: boolean;
  dimmed: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  const colTotal = items.reduce((s, o) => s + (o.estimated_value || 0), 0);
  return (
    <div className={`flex flex-col transition-opacity ${dimmed ? "opacity-40" : ""}`}>
      <div className="bg-surface border border-border rounded-md px-4 py-3 mb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${stage.dot}`} />
            <span className="text-[15px] font-semibold text-text">{stage.label}</span>
          </div>
          <div className="text-xs text-muted">
            {items.length} {items.length === 1 ? "deal" : "deals"}
            {colTotal > 0 && <> · <span className="text-text font-medium">{fmtMoney(colTotal)}</span></>}
          </div>
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={`space-y-3 min-h-[120px] rounded-md transition-colors p-1 -m-1 ${
          isOver && highlight ? "bg-accent-soft outline-2 outline-dashed outline-accent" :
          isOver && !highlight ? "bg-danger/10 outline-2 outline-dashed outline-danger/50" :
          highlight ? "outline-1 outline-dashed outline-accent/40" : ""
        }`}
      >
        {items.length === 0 ? (
          <div className="text-xs text-muted/60 italic py-6 text-center border border-dashed border-border rounded-md">
            {highlight ? "Drop here" : "Nothing here yet"}
          </div>
        ) : (
          items.map((o) => (
            <DraggableCard
              key={o.id}
              opp={o}
              ownerName={ownerName}
              onOpen={() => onOpen(o.id)}
              onTransition={(to) => onMove(o, to)}
              transitioning={moving}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DraggableCard({
  opp, ownerName, onOpen, onTransition, transitioning,
}: {
  opp: Opp;
  ownerName: string;
  onOpen: () => void;
  onTransition: (to: string) => void;
  transitioning: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: opp.id });
  return (
    <div ref={setNodeRef} className={isDragging ? "opacity-30" : ""}>
      <DealCard
        opp={opp}
        ownerName={ownerName}
        onOpen={onOpen}
        onTransition={onTransition}
        transitioning={transitioning}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function DealCard({
  opp, ownerName, onOpen, onTransition, transitioning, dragHandleProps,
}: {
  opp: Opp;
  ownerName: string;
  onOpen: () => void;
  onTransition: (to: string) => void;
  transitioning: boolean;
  dragHandleProps?: any;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const signal = signalOf(opp);
  const next = opp.next_stages?.[0];
  const initial = (ownerName || "U")[0].toUpperCase();
  const days = daysSince(opp.updated_at);
  const missing = Math.max(0, opp.docs_required - opp.docs_attached);

  const statusBadge = {
    on_track:     "bg-[#dcf5ec] text-[#0e7c54] border-[#bdedd6]",
    ready:        "bg-[#dbeafe] text-[#1d4ed8] border-[#bfdbfe]",
    review:       "bg-accent-soft text-accent border-accent/30",
    attention:    "bg-[#fef3c7] text-[#a16207] border-[#fde68a]",
    missing_docs: "bg-[#fef3c7] text-[#a16207] border-[#fde68a]",
    blocked:      "bg-[#fee2e2] text-[#b91c1c] border-[#fecaca]",
  }[signal.status];
  const StatusIcon = {
    on_track: CheckCircle2, ready: CheckCircle2, review: Bell,
    attention: AlertTriangle, missing_docs: FileText, blocked: Bell,
  }[signal.status];

  let quickAction: { label: string; onClick: (e: React.MouseEvent) => void; tone: "primary" | "outline" } | null = null;
  if (signal.status === "missing_docs") {
    quickAction = { label: `Attach ${missing} doc${missing === 1 ? "" : "s"}`, onClick: (e) => { e.stopPropagation(); onOpen(); }, tone: "outline" };
  } else if (signal.status === "ready") {
    quickAction = { label: "Open & submit", onClick: (e) => { e.stopPropagation(); onOpen(); }, tone: "primary" };
  } else if (next) {
    quickAction = { label: next.label || `Move to ${prettyStage(next.to)}`, onClick: (e) => { e.stopPropagation(); onTransition(next.to); }, tone: "primary" };
  }

  return (
    <div
      className="group relative bg-surface border border-border rounded-lg p-4 hover:border-accent hover:shadow-md transition-all"
      role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1 min-w-0 flex-1">
          {dragHandleProps && (
            <button
              type="button"
              className="text-muted/50 hover:text-muted cursor-grab active:cursor-grabbing -ml-1 mt-0.5 p-0.5 rounded"
              {...dragHandleProps}
              aria-label="Drag to move"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <GripVertical size={14} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-text truncate">{opp.title}</div>
            <div className="text-xs text-muted truncate mt-0.5">{opp.client_name || opp.lead_type}</div>
          </div>
        </div>
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            className="p-1 -m-1 rounded hover:bg-bg text-muted"
            aria-label="More options"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }} />
              <div className="absolute right-0 top-7 z-20 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[180px]">
                <MenuItem onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onOpen(); }}>Open details</MenuItem>
                {next && <MenuItem onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onTransition(next.to); }}>{next.label || `Move to ${prettyStage(next.to)}`}</MenuItem>}
                <MenuItem onClick={(e) => { e.stopPropagation(); setMenuOpen(false); navigator.clipboard?.writeText(window.location.origin + `/pipeline/${opp.id}`); }}>Copy link</MenuItem>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3 text-sm">
        <span className="inline-flex items-center gap-1.5 text-text font-medium">
          <Wallet size={14} className="text-muted" />
          {fmtMoney(opp.estimated_value)}
        </span>
        <span className="text-muted">·</span>
        <span className="inline-flex items-center gap-1.5 text-muted">
          <Calendar size={14} />
          {fmtDate(opp.updated_at)}
        </span>
      </div>

      {opp.stage === "new_request" && opp.docs_required > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-muted mb-1">
            <span className="inline-flex items-center gap-1"><FileText size={11} /> Documents</span>
            <span>{opp.docs_attached}/{opp.docs_required}</span>
          </div>
          <div className="h-1 bg-bg rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                opp.docs_attached === opp.docs_required ? "bg-success"
                : opp.docs_attached >= opp.docs_required / 2 ? "bg-warn"
                : "bg-danger"
              }`}
              style={{ width: `${Math.round((opp.docs_attached / Math.max(1, opp.docs_required)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/70">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-full bg-accent-soft text-accent text-[11px] font-bold grid place-items-center shrink-0">{initial}</div>
          <span className="text-xs text-text truncate">{ownerName}</span>
        </div>
        <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${statusBadge}`}>
          <StatusIcon size={11} />
          {signal.label}
        </span>
      </div>

      {quickAction && (
        <div className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            disabled={transitioning}
            onClick={quickAction.onClick}
            className={`w-full text-[12px] font-medium px-2 py-1 rounded inline-flex items-center justify-center gap-1 ${
              quickAction.tone === "primary" ? "bg-accent text-white hover:opacity-90" : "border border-border hover:bg-bg text-text"
            }`}
            title={next?.roles?.length ? `Allowed roles: ${next.roles.join(", ")}` : ""}
          >
            {transitioning ? "Working…" : quickAction.label}
            <ArrowRight size={12} />
          </button>
        </div>
      )}

      {days >= 7 && opp.stage !== "closed" && opp.stage !== "paid" && (
        <span className="absolute top-2 right-9 text-[10px] text-muted/70" title={`${days} days in this stage`}>
          {days}d
        </span>
      )}
    </div>
  );
}

function ListView({
  items, onOpen, onMove, moving,
}: {
  items: Opp[];
  onOpen: (id: string) => void;
  onMove: (opp: Opp, to: string) => void;
  moving: boolean;
}) {
  return (
    <div className="border border-border rounded-md bg-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg text-muted text-xs">
          <tr>
            <Th>Title</Th>
            <Th>Stage</Th>
            <Th>Client</Th>
            <Th className="text-right">Value</Th>
            <Th className="text-right">Docs</Th>
            <Th>Updated</Th>
            <Th>Status</Th>
            <Th className="text-right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={8} className="text-center text-muted text-sm py-10">No matching opportunities.</td></tr>
          ) : items.map((o) => {
            const sig = signalOf(o);
            const stage = STAGES.find((s) => s.key === o.stage);
            const next = o.next_stages?.[0];
            return (
              <tr
                key={o.id}
                className="border-t border-border hover:bg-bg cursor-pointer"
                onClick={() => onOpen(o.id)}
              >
                <Td>
                  <div className="font-medium text-text">{o.title}</div>
                  <div className="text-xs text-muted capitalize">{o.lead_type}</div>
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${stage?.dot ?? "bg-muted"}`} />
                    {stage?.label ?? prettyStage(o.stage)}
                  </span>
                </Td>
                <Td className="text-muted">{o.client_name || "—"}</Td>
                <Td className="text-right font-medium">{fmtMoney(o.estimated_value)}</Td>
                <Td className="text-right text-muted">
                  {o.docs_required > 0 ? `${o.docs_attached}/${o.docs_required}` : "—"}
                </Td>
                <Td className="text-muted whitespace-nowrap">{fmtDate(o.updated_at)}</Td>
                <Td>
                  <StatusPill signal={sig} />
                </Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  {next ? (
                    <button
                      disabled={moving}
                      onClick={() => onMove(o, next.to)}
                      className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
                      title={next.roles?.length ? `Allowed roles: ${next.roles.join(", ")}` : ""}
                    >
                      {next.label || `Move to ${prettyStage(next.to)}`} <ArrowRight size={11} />
                    </button>
                  ) : <span className="text-xs text-muted">—</span>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ signal }: { signal: CardSignal }) {
  const cls = {
    on_track:     "bg-[#dcf5ec] text-[#0e7c54] border-[#bdedd6]",
    ready:        "bg-[#dbeafe] text-[#1d4ed8] border-[#bfdbfe]",
    review:       "bg-accent-soft text-accent border-accent/30",
    attention:    "bg-[#fef3c7] text-[#a16207] border-[#fde68a]",
    missing_docs: "bg-[#fef3c7] text-[#a16207] border-[#fde68a]",
    blocked:      "bg-[#fee2e2] text-[#b91c1c] border-[#fecaca]",
  }[signal.status];
  return (
    <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {signal.label}
    </span>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`text-left font-medium px-3 py-2 ${className}`}>{children}</th>;
}
function Td({ children, className = "", onClick }: { children: React.ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return <td className={`px-3 py-3 ${className}`} onClick={onClick}>{children}</td>;
}

function ViewToggle({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded transition-colors ${
        on ? "bg-bg text-text font-medium" : "text-muted hover:text-text"
      }`}
    >
      {icon} {label}
    </button>
  );
}

function Dropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 border border-border bg-surface text-sm text-text px-3 py-2 rounded-md hover:bg-bg"
      >
        {label}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-border rounded-md shadow-lg p-1 min-w-[200px]" onClick={() => setOpen(false)}>
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button onClick={onClick} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-bg text-text">
      {children}
    </button>
  );
}
