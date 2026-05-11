// MailCard — compact Inbox preview on the Today briefing.
//
// Same Microsoft connection as MeetingsCard — if the user is connected we
// show the latest few inbox messages with sender, subject and a preview.
// Hidden entirely when Microsoft isn't configured / connected (the calendar
// card already drives the connect CTA, no need to double up).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Mail as MailIcon, Paperclip, ExternalLink, Loader2, AlertTriangle, AlertCircle, Star } from "lucide-react";

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
              className={`px-5 py-3 border-t border-border first:border-t-0 ${
                m.is_read ? "" : "bg-accent-soft/30"
              }`}
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
                  <div className="flex items-center gap-2 mt-1.5">
                    {m.has_attachments && (
                      <span className="text-[10.5px] text-muted inline-flex items-center gap-1">
                        <Paperclip size={10} /> Attachments
                      </span>
                    )}
                    {m.web_link && (
                      <a
                        href={m.web_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-semibold text-accent hover:underline inline-flex items-center gap-1"
                        title="Open in Outlook"
                      >
                        Open <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
