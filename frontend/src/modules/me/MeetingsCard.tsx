// MeetingsCard — surfaces the connected user's Microsoft calendar inside
// D'Accubin. Three states:
//
//   1. Not configured  — quietly hidden; nothing for the user to do.
//   2. Configured, not connected — Connect Microsoft CTA.
//   3. Connected       — list of upcoming events grouped by day, with a
//      "Join" button on online meetings and a webLink fallback.
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import {
  CalendarClock, Video, MapPin, LogIn, LogOut, ExternalLink, Loader2, AlertTriangle,
} from "lucide-react";

type Event = {
  id: string;
  subject: string;
  start: string;
  end: string;
  is_all_day: boolean;
  is_online: boolean;
  join_url?: string;
  web_link?: string;
  organizer?: string;
  location?: string;
  body_preview?: string;
  attendees?: string[];
  show_as?: string;
};

type Status = { configured: boolean; connected: boolean; account: string; expires_at?: string };
type Meetings = { connected: boolean; connected_account?: string; items: Event[]; error?: string };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function isToday(iso: string): boolean {
  const d = new Date(iso); const t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

export function MeetingsCard() {
  const qc = useQueryClient();
  // The ?ms=connected callback toast + status invalidation is handled at the
  // page level (MyWorkPage) so it fires no matter which tab is active.

  const { data: status } = useQuery<Status>({
    queryKey: ["me", "ms-status"],
    queryFn: () => api("/api/v1/me/microsoft/status"),
  });

  const enabled = !!status?.connected;
  // Today only — anything further out belongs on the full calendar view, not
  // the Today briefing card. Day=1 covers ~24h from now; we additionally
  // filter client-side to "starts today" so a late-evening fetch doesn't
  // bleed tomorrow's first meeting into the list.
  const { data: meetings, isLoading } = useQuery<Meetings>({
    queryKey: ["me", "meetings", "today"],
    queryFn: () => api("/api/v1/me/meetings?days=1"),
    enabled,
    refetchInterval: 5 * 60_000,
  });

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>("/api/v1/me/microsoft/start"),
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e: any) => toast.error("Could not start sign-in", e?.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api("/api/v1/me/microsoft/disconnect", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "ms-status"] });
      qc.invalidateQueries({ queryKey: ["me", "meetings"] });
      toast.success("Disconnected");
    },
    onError: (e: any) => toast.error("Could not disconnect", e?.message),
  });

  // Today only — filter out anything that doesn't start today (catches the
  // edge where a 24h window from a late-evening fetch includes early-morning
  // tomorrow events). No day grouping because there's only one day.
  const todays = useMemo(
    () => (meetings?.items ?? []).filter((ev) => isToday(ev.start)),
    [meetings?.items],
  );

  // Hide the card entirely when the workspace hasn't been wired — nothing
  // for the user to do, no point in noise.
  if (status && !status.configured && !status.connected) {
    return null;
  }

  return (
    <section className="bg-surface border border-border rounded-2xl overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
            <CalendarClock size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-text leading-tight">Microsoft calendar</h2>
            <div className="text-[11px] text-muted truncate">
              {status?.connected
                ? `Connected as ${meetings?.connected_account || status.account}`
                : "Bring your meetings into D'Accubin"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status?.connected ? (
            <button
              onClick={() => disconnect.mutate()}
              className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-danger"
              title="Sign Microsoft account out of D'Accubin"
            >
              <LogOut size={12} /> Disconnect
            </button>
          ) : (
            <SmartButton
              variant="primary"
              disabled={connect.isPending || !status?.configured}
              loadingLabel="Redirecting…"
              icon={<LogIn size={13} />}
              onClick={() => connect.mutateAsync()}
            >
              Connect Microsoft
            </SmartButton>
          )}
        </div>
      </header>

      {/* Body */}
      {!status?.connected ? (
        <div className="px-5 py-6 text-[13px] text-muted">
          See your Outlook / Teams calendar inline. Each user signs in
          individually — you only ever see your own meetings.
        </div>
      ) : isLoading ? (
        <div className="px-5 py-6 text-muted text-sm inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading meetings…
        </div>
      ) : meetings?.error ? (
        <div className="px-5 py-4 text-[13px] text-danger inline-flex items-center gap-2">
          <AlertTriangle size={13} /> {meetings.error}
        </div>
      ) : todays.length === 0 ? (
        <div className="px-5 py-6 text-[13px] text-muted">
          Nothing on your calendar for today.
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <ul>
            {todays.map((ev) => (
              <li key={ev.id} className="px-5 py-2.5 border-t border-border first:border-t-0">
                <div className="flex items-start gap-3">
                  <div className="text-[11px] text-muted font-mono whitespace-nowrap pt-0.5 w-[88px]">
                    {ev.is_all_day
                      ? "All day"
                      : `${fmtTime(ev.start)} → ${fmtTime(ev.end)}`}
                  </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-text truncate">{ev.subject || "(no subject)"}</div>
                        <div className="text-[11.5px] text-muted flex items-center gap-2 flex-wrap mt-0.5">
                          {ev.organizer && <span className="truncate">{ev.organizer}</span>}
                          {ev.location && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin size={10} /> {ev.location}
                            </span>
                          )}
                          {(ev.attendees?.length ?? 0) > 0 && (
                            <span>· {ev.attendees!.length} attendee{ev.attendees!.length === 1 ? "" : "s"}</span>
                          )}
                          {ev.show_as && ev.show_as !== "busy" && (
                            <span className="capitalize">· {ev.show_as}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {ev.is_online && ev.join_url && (
                          <a
                            href={ev.join_url}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent text-white text-[11.5px] font-semibold hover:bg-accent/90"
                            title="Open Teams join link"
                          >
                            <Video size={11} /> Join
                          </a>
                        )}
                        {ev.web_link && (
                          <a
                            href={ev.web_link}
                            target="_blank" rel="noopener noreferrer"
                            className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-bg"
                            title="Open in Outlook"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
