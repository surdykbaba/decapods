// MeetingsCard — surfaces the connected user's Microsoft calendar inside
// D'Accubin. Three states:
//
//   1. Not configured  — quietly hidden; nothing for the user to do.
//   2. Configured, not connected — Connect Microsoft CTA.
//   3. Connected       — list of upcoming events grouped by day, with a
//      "Join" button on online meetings and a webLink fallback.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";
import { useMeetingNotifications } from "@/lib/meetingNotifications";
import {
  CalendarClock, Video, MapPin, LogIn, LogOut, ExternalLink, Loader2, AlertTriangle,
  Bell, BellOff, Clock, Check, X as XIcon, HelpCircle,
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

  // A ticking clock so "in 12 min" / "starts in 30 sec" labels stay live.
  // setInterval re-renders every 30s — cheap and reads accurately.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Classify each event into past / now / next / future and tag the very
  // next one with countdown copy + a prominent "Up next" treatment.
  const annotated = useMemo(() => classify(todays, now), [todays, now]);
  const upNext = annotated.find((a) => a.state === "next");
  const nowItem = annotated.find((a) => a.state === "now");

  // Browser-notification scheduler — reads the same event list and fires
  // 5 minutes before each meeting if permission was granted. Hook lives in
  // /lib so the Inbox card (and future modules) can reuse the plumbing.
  const notif = useMeetingNotifications(todays);

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
          {status?.connected && (
            <button
              onClick={notif.toggle}
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold ${
                notif.enabled ? "text-accent" : "text-muted hover:text-text"
              }`}
              title={
                notif.enabled
                  ? "Browser notifications on — 5 minutes before each meeting"
                  : notif.denied
                    ? "Browser blocked notifications — change site permission to enable"
                    : "Get a browser notification 5 minutes before each meeting"
              }
            >
              {notif.enabled ? <Bell size={12} /> : <BellOff size={12} />}
              {notif.enabled ? "Reminders on" : "Reminders"}
            </button>
          )}
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
          Nothing on your calendar for today. Block time for deep work.
        </div>
      ) : (
        <>
          {(nowItem || upNext) && (
            <FocusBanner item={(nowItem ?? upNext)!} now={now} />
          )}
        <div className="max-h-[420px] overflow-y-auto">
          <ul>
            {annotated.map(({ event: ev, state, label }) => (
              <li
                key={ev.id}
                className={`px-5 py-2.5 border-t border-border first:border-t-0 ${
                  state === "past" ? "opacity-55" : ""
                } ${state === "now" ? "bg-success/5" : state === "next" ? "bg-accent-soft/30" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <div className="text-[11px] font-mono whitespace-nowrap pt-0.5 w-[100px]">
                    <div className={state === "past" ? "text-muted line-through" : "text-text"}>
                      {ev.is_all_day
                        ? "All day"
                        : `${fmtTime(ev.start)} → ${fmtTime(ev.end)}`}
                    </div>
                    {label && (
                      <div className={`text-[10.5px] font-semibold mt-0.5 ${
                        state === "now" ? "text-success" : state === "next" ? "text-accent" : "text-muted"
                      }`}>
                        {label}
                      </div>
                    )}
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
                        <RsvpButtons eventId={ev.id} />
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
        </>
      )}
    </section>
  );
}

/* ---------- Smart classification helpers ---------- */

type EventState = "past" | "now" | "next" | "future";
type Annotated = { event: Event; state: EventState; label?: string };

function classify(events: Event[], now: number): Annotated[] {
  // Order by start time so the "next" search returns the soonest upcoming.
  const sorted = [...events].sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  // Find the first future-start event for "Up next".
  const nextIdx = sorted.findIndex((e) => new Date(e.start).getTime() > now);
  return sorted.map((ev, i): Annotated => {
    const start = new Date(ev.start).getTime();
    const end = new Date(ev.end).getTime();
    if (now >= start && now <= end) {
      const minsLeft = Math.max(1, Math.round((end - now) / 60_000));
      return { event: ev, state: "now", label: `Now · ${minsLeft}m left` };
    }
    if (now > end) {
      return { event: ev, state: "past" };
    }
    if (i === nextIdx) {
      return { event: ev, state: "next", label: untilLabel(start - now) };
    }
    return { event: ev, state: "future" };
  });
}

function untilLabel(ms: number): string {
  if (ms <= 0) return "Starting now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

function FocusBanner({ item, now }: { item: Annotated; now: number }) {
  const { event: ev, state } = item;
  const start = new Date(ev.start).getTime();
  const tone =
    state === "now"
      ? { bg: "bg-success/10", border: "border-success/30", chip: "bg-success text-white", label: "Now" }
      : { bg: "bg-accent-soft", border: "border-accent/30", chip: "bg-accent text-white", label: "Up next" };
  const sub = state === "now"
    ? `Ends ${fmtTime(ev.end)}`
    : untilLabel(start - now);
  return (
    <div className={`mx-5 mt-4 mb-2 rounded-2xl border ${tone.border} ${tone.bg} px-4 py-3 flex items-center gap-3 flex-wrap`}>
      <span className={`inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${tone.chip}`}>
        <Clock size={10} /> {tone.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-text truncate">{ev.subject || "(no subject)"}</div>
        <div className="text-[11.5px] text-muted">
          {fmtTime(ev.start)} → {fmtTime(ev.end)} · {sub}
        </div>
      </div>
      {ev.is_online && ev.join_url && (
        <a
          href={ev.join_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-white text-[12px] font-bold hover:bg-accent/90"
        >
          <Video size={12} /> Join
        </a>
      )}
    </div>
  );
}

/* ---------- RSVP buttons ----------
 *
 * Accept / Tentative / Decline a calendar invite from inside D'Accubin via
 * Microsoft Graph. Once a response goes in we optimistically set "answered"
 * locally so the buttons collapse to a single confirmation pill — Graph
 * doesn't return the new responseStatus in the call, and a Meetings refetch
 * would slow the feedback.
 */
type Response = "accept" | "decline" | "tentative";

function RsvpButtons({ eventId }: { eventId: string }) {
  const qc = useQueryClient();
  const [answered, setAnswered] = useState<Response | null>(null);
  const respond = useMutation({
    mutationFn: (response: Response) =>
      api(`/api/v1/me/meetings/${encodeURIComponent(eventId)}/respond`, {
        method: "POST",
        body: JSON.stringify({ response }),
      }),
    onSuccess: (_data, response) => {
      setAnswered(response);
      // Refresh the list in the background so showAs / response state flips.
      qc.invalidateQueries({ queryKey: ["me", "meetings"] });
      const label = response === "accept" ? "Accepted" : response === "decline" ? "Declined" : "Tentative";
      toast.success(label, "Your response is on the way to the organiser.");
    },
    onError: (e: any) => toast.error("Could not RSVP", e?.message),
  });

  if (answered) {
    const meta =
      answered === "accept"
        ? { label: "Accepted", cls: "bg-success/15 text-success", Icon: Check }
        : answered === "decline"
          ? { label: "Declined",  cls: "bg-danger/15 text-danger",   Icon: XIcon }
          : { label: "Tentative", cls: "bg-warn/15 text-warn",       Icon: HelpCircle };
    const Icon = meta.Icon;
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold ${meta.cls}`}>
        <Icon size={11} /> {meta.label}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => respond.mutate("accept")}
        disabled={respond.isPending}
        title="Accept invite"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] font-semibold bg-success/10 text-success hover:bg-success/20 disabled:opacity-50"
      >
        <Check size={11} /> Accept
      </button>
      <button
        onClick={() => respond.mutate("tentative")}
        disabled={respond.isPending}
        title="Tentative"
        className="inline-flex items-center px-1.5 py-1 rounded-lg text-muted hover:text-warn hover:bg-warn/10 disabled:opacity-50"
      >
        <HelpCircle size={11} />
      </button>
      <button
        onClick={() => respond.mutate("decline")}
        disabled={respond.isPending}
        title="Decline"
        className="inline-flex items-center px-1.5 py-1 rounded-lg text-muted hover:text-danger hover:bg-danger/10 disabled:opacity-50"
      >
        <XIcon size={11} />
      </button>
    </div>
  );
}
