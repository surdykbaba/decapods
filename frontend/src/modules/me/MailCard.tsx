// MailCard — compact Inbox preview on the Today briefing.
//
// Same Microsoft connection as MeetingsCard — if the user is connected we
// show the latest few inbox messages with sender, subject and a preview.
// Hidden entirely when Microsoft isn't configured / connected (the calendar
// card already drives the connect CTA, no need to double up).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Mail as MailIcon, Paperclip, ExternalLink, Loader2, AlertTriangle, AlertCircle, Star, X, ListChecks } from "lucide-react";

type Msg = {
  id: string;
  subject: string;
  from: string;
  from_name: string;
  preview: string;
  web_link: string;
  received: string;
  is_read: boolean;
  has_attachments: boolean;
  importance: string;
};

type Mailbox = {
  connected: boolean;
  connected_account?: string;
  items?: Msg[];
  error?: string;
};

type Status = { configured: boolean; connected: boolean; account: string };

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function initials(name: string): string {
  const s = (name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MailCard() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: status } = useQuery<Status>({
    queryKey: ["me", "ms-status"],
    queryFn: () => api("/api/v1/me/microsoft/status"),
  });

  const enabled = !!status?.connected;
  const { data: mail, isLoading } = useQuery<Mailbox>({
    queryKey: ["me", "mail"],
    queryFn: () => api("/api/v1/me/mail?top=8"),
    enabled,
    refetchInterval: 2 * 60_000,
  });

  const unread = useMemo(
    () => (mail?.items ?? []).filter((m) => !m.is_read).length,
    [mail?.items],
  );

  // Same hide rule as MeetingsCard — if Microsoft isn't configured at all,
  // don't render a second silent CTA. If configured-but-not-connected, the
  // calendar card already shows the Connect button.
  if (!status?.connected) return null;

  return (
    <section className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
            <MailIcon size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-text leading-tight">Inbox</h2>
            <div className="text-[11px] text-muted truncate">
              Latest from {mail?.connected_account || status.account}
              {unread > 0 && <> · <span className="text-accent font-semibold">{unread} unread</span></>}
            </div>
          </div>
        </div>
      </header>

      {isLoading ? (
        <div className="px-5 py-6 text-muted text-sm inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading messages…
        </div>
      ) : mail?.error ? (
        <div className="px-5 py-4 text-[13px] text-danger inline-flex items-center gap-2">
          <AlertTriangle size={13} /> {mail.error}
        </div>
      ) : (mail?.items ?? []).length === 0 ? (
        <div className="px-5 py-6 text-[13px] text-muted">
          Inbox zero — nothing new.
        </div>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto">
          {mail!.items!.map((m) => (
            <li
              key={m.id}
              className={`border-t border-border first:border-t-0 ${m.is_read ? "" : "bg-accent-soft/30"}`}
            >
              <button
                type="button"
                onClick={() => setOpenId(m.id)}
                className="w-full text-left px-5 py-3 hover:bg-bg/40 transition-colors"
                aria-label={`Read message: ${m.subject || "no subject"}`}
              >
                <div className="flex items-start gap-3">
                  <span className="w-8 h-8 rounded-full bg-bg border border-border text-text font-bold text-[11px] grid place-items-center shrink-0">
                    {initials(m.from_name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] truncate ${m.is_read ? "text-text" : "font-bold text-text"}`}>
                        {m.from_name}
                      </span>
                      {m.importance === "high" && (
                        <span title="High importance" className="text-danger shrink-0">
                          <AlertCircle size={11} />
                        </span>
                      )}
                      {!m.is_read && (
                        <span title="Unread" className="text-accent shrink-0">
                          <Star size={10} fill="currentColor" />
                        </span>
                      )}
                      <span className="ml-auto text-[10.5px] text-muted whitespace-nowrap shrink-0">
                        {fmtRelative(m.received)}
                      </span>
                    </div>
                    <div className={`text-[12.5px] truncate mt-0.5 ${m.is_read ? "text-muted" : "text-text font-semibold"}`}>
                      {m.subject || "(no subject)"}
                    </div>
                    {m.preview && (
                      <div className="text-[11.5px] text-muted truncate mt-0.5">
                        {m.preview}
                      </div>
                    )}
                    {m.has_attachments && (
                      <div className="text-[10.5px] text-muted inline-flex items-center gap-1 mt-1.5">
                        <Paperclip size={10} /> Attachments
                      </div>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId && <MessageReader id={openId} onClose={() => setOpenId(null)} />}
    </section>
  );
}

type MsgFull = Msg & {
  body_content_type: "html" | "text" | string;
  body: string;
  to: string[];
  cc: string[];
};

function MessageReader({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<MsgFull>({
    queryKey: ["me", "mail", id],
    queryFn: () => api(`/api/v1/me/mail/${encodeURIComponent(id)}`),
  });
  const [convertOpen, setConvertOpen] = useState(false);

  // Wrap the body in a tiny shell so plain-text mails get sensible defaults
  // and HTML mails can't break out of the iframe sandbox. sandbox=""
  // disables JS, forms, popups, top-nav — pure rendering only.
  const srcDoc = data
    ? (data.body_content_type === "html"
        ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Manrope,sans-serif;color:#0b1220;margin:0;padding:16px;background:#fff} img{max-width:100%;height:auto} a{color:#107B97}</style></head><body>${data.body || data.preview || ""}</body></html>`
        : `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Manrope,sans-serif;color:#0b1220;margin:0;padding:16px;white-space:pre-wrap;background:#fff}</style></head><body>${escapeHtml(data.body || data.preview || "")}</body></html>`)
    : "";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-5xl h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            {isLoading ? (
              <div className="h-5 w-48 bg-bg/60 rounded animate-pulse" />
            ) : (
              <>
                <h3 className="text-base font-bold text-text leading-tight truncate">
                  {data?.subject || "(no subject)"}
                </h3>
                <div className="text-[12px] text-muted truncate mt-0.5">
                  {data?.from_name}
                  {data?.from && data.from !== data.from_name && <> · {data.from}</>}
                  {data?.received && <> · {fmtRelative(data.received)}</>}
                </div>
                {data && (data.to?.length || data.cc?.length) && (
                  <div className="text-[11px] text-muted mt-0.5 truncate">
                    {data.to?.length ? <>To: {data.to.join(", ")}</> : null}
                    {data.cc?.length ? <> · Cc: {data.cc.join(", ")}</> : null}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {data && (
              <button
                type="button"
                onClick={() => setConvertOpen(true)}
                className="inline-flex items-center gap-1.5 text-[11.5px] font-bold bg-accent text-white px-3 py-1.5 rounded-full hover:bg-accent/90"
                title="Create a project task from this email"
              >
                <ListChecks size={12} /> Convert to task
              </button>
            )}
            {data?.web_link && (
              <a
                href={data.web_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent hover:underline"
                title="Open in Outlook"
              >
                <ExternalLink size={12} /> Outlook
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-bg text-muted hover:text-text"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {convertOpen && data && (
          <EmailToTaskDialog
            message={data}
            onClose={() => setConvertOpen(false)}
            onCreated={() => { setConvertOpen(false); onClose(); }}
          />
        )}

        {isLoading ? (
          <div className="px-5 py-10 text-muted inline-flex items-center gap-2 text-sm">
            <Loader2 size={14} className="animate-spin" /> Loading message…
          </div>
        ) : error ? (
          <div className="px-5 py-6 text-[13px] text-danger inline-flex items-center gap-2">
            <AlertTriangle size={13} /> Could not load this message.
          </div>
        ) : (
          <iframe
            title="Email body"
            sandbox=""
            srcDoc={srcDoc}
            className="flex-1 w-full bg-white rounded-b-2xl border-0"
          />
        )}
      </div>
    </div>
  );
}

type ProjectLite = { id: string; name: string; code: string; status: string };

function EmailToTaskDialog({
  message, onClose, onCreated,
}: {
  message: MsgFull;
  onClose: () => void;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  // Active projects only — closed/archived ones rarely take new work, and a
  // long picker is friction during quick triage.
  const { data: projects, isLoading: projectsLoading } = useQuery<ProjectLite[]>({
    queryKey: ["projects", "lite"],
    queryFn: () => api<{ items: ProjectLite[] }>("/api/v1/projects").then((r) =>
      r.items.filter((p) => !["closed", "archived"].includes(p.status))
    ),
    staleTime: 60_000,
  });

  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState(message.subject || "(no subject)");
  // Body of the task includes a clear "From email" preamble so the next
  // reader knows where it came from, plus the sender, a snippet of the
  // preview and a deep-link back to the original Outlook message.
  const initialDescription = useMemo(() => {
    const lines: string[] = [];
    lines.push(`From email: ${message.from_name} <${message.from}>`);
    if (message.received) lines.push(`Received: ${new Date(message.received).toLocaleString()}`);
    if (message.preview) lines.push("", message.preview);
    if (message.web_link) lines.push("", `Outlook link: ${message.web_link}`);
    return lines.join("\n");
  }, [message]);
  const [description, setDescription] = useState(initialDescription);
  const [priority, setPriority] = useState(3);
  const [dueOn, setDueOn] = useState("");

  const create = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Pick a project first");
      if (!title.trim()) throw new Error("Title required");
      return api(`/api/v1/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          priority,
          due_on: dueOn,
        }),
      });
    },
    onSuccess: () => {
      toast.success("Task created", "We've filed this email under the project.");
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["me", "work"] });
      onCreated();
    },
    onError: (e: any) => toast.error("Could not create task", e?.message),
  });

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 grid place-items-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-card w-full max-w-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ListChecks size={16} className="text-accent shrink-0" />
            <h3 className="text-base font-bold text-text leading-tight truncate">
              Convert email to task
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg text-muted hover:text-text"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto max-h-[70vh]">
          <label className="block">
            <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">Project</div>
            {projectsLoading ? (
              <div className="text-[12px] text-muted inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading projects…
              </div>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">— Pick a project —</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code ? `${p.code} · ` : ""}{p.name}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">Title</div>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">Description</div>
            <textarea
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono leading-relaxed"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={8}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">Priority</div>
              <select
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value, 10))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm"
              >
                <option value={1}>1 — Critical</option>
                <option value={2}>2 — High</option>
                <option value={3}>3 — Normal</option>
                <option value={4}>4 — Low</option>
                <option value={5}>5 — Backlog</option>
              </select>
            </label>
            <label className="block">
              <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">Due on</div>
              <input
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-2 rounded-lg text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || !projectId || !title.trim()}
            className="inline-flex items-center gap-1.5 text-sm font-bold bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <ListChecks size={13} />}
            {create.isPending ? "Creating…" : "Create task"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
