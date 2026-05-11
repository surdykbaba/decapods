// WorkPolicyPage — tenant work-hours configuration.
//
// Mirrored on the backend by handlers/work_policy.go. Drives the heartbeat
// detector that fires attendance warnings (and downstream appraisal hits)
// when staff are away beyond the threshold during work hours.
//
// Each field has a short "why this matters" hint so HR understands what the
// number actually does before they tune it.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, AlertTriangle, Coffee, Globe2, CalendarDays } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { SmartButton } from "@/components/SmartButton";

type Policy = {
  work_days: number[];      // 0=Sun..6=Sat
  start_hour: number;       // 0..23 inclusive
  end_hour: number;         // 1..24 exclusive (>start_hour)
  break_minutes_per_day: number;
  away_threshold_minutes: number;
  timezone: string;
};

const DAY_LABELS: { value: number; short: string; full: string }[] = [
  { value: 1, short: "Mon", full: "Monday" },
  { value: 2, short: "Tue", full: "Tuesday" },
  { value: 3, short: "Wed", full: "Wednesday" },
  { value: 4, short: "Thu", full: "Thursday" },
  { value: 5, short: "Fri", full: "Friday" },
  { value: 6, short: "Sat", full: "Saturday" },
  { value: 0, short: "Sun", full: "Sunday" },
];

// Common timezones up-front. Anything not on the list falls through to the
// free-text override below, so an admin in Karachi or Honolulu isn't stuck.
const COMMON_TZ = [
  "Africa/Lagos", "Africa/Cairo", "Africa/Johannesburg",
  "Europe/London", "Europe/Berlin", "Europe/Paris",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo",
  "Pacific/Auckland",
];

function hourLabel(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}

export function WorkPolicyPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Policy>({
    queryKey: ["work-policy"],
    queryFn: () => api("/api/v1/settings/work-policy"),
  });

  // Local form state — hydrated from the API on first arrival. dirty fires on
  // any change so the Save button reflects pending edits.
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState(9);
  const [end, setEnd] = useState(17);
  const [breakMin, setBreakMin] = useState(60);
  const [thresholdMin, setThresholdMin] = useState(30);
  const [tz, setTz] = useState("");

  useEffect(() => {
    if (!data) return;
    setDays(data.work_days?.length ? data.work_days : [1, 2, 3, 4, 5]);
    setStart(data.start_hour ?? 9);
    setEnd(data.end_hour ?? 17);
    setBreakMin(data.break_minutes_per_day ?? 60);
    setThresholdMin(data.away_threshold_minutes ?? 30);
    setTz(data.timezone ?? "");
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const sameDays =
      data.work_days?.length === days.length &&
      data.work_days?.every((d) => days.includes(d));
    return !(
      sameDays &&
      data.start_hour === start &&
      data.end_hour === end &&
      data.break_minutes_per_day === breakMin &&
      data.away_threshold_minutes === thresholdMin &&
      (data.timezone ?? "") === tz
    );
  }, [data, days, start, end, breakMin, thresholdMin, tz]);

  const save = useMutation({
    mutationFn: () =>
      api<Policy>("/api/v1/settings/work-policy", {
        method: "PUT",
        body: JSON.stringify({
          work_days: days,
          start_hour: start,
          end_hour: end,
          break_minutes_per_day: breakMin,
          away_threshold_minutes: thresholdMin,
          timezone: tz.trim(),
        }),
      }),
    onSuccess: (resp) => {
      qc.setQueryData(["work-policy"], resp);
      toast.success("Work hours saved", "Attendance detection now uses the new policy.");
    },
    onError: (e: any) => toast.error("Could not save", e?.message),
  });

  function toggleDay(d: number) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  }

  // Browser-detected timezone — handy "use this" pill so the admin doesn't
  // have to type it.
  const browserTZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; }
    catch { return ""; }
  })();

  if (isLoading) return <div className="text-muted text-sm">Loading…</div>;

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h2 className="h2">Work hours & attendance policy</h2>
        <p className="text-sm text-muted mt-1">
          Used to derive on-time starts, break-time tolerance, and the long-away warnings
          that feed appraisal scorecards. Changes take effect on the next heartbeat.
        </p>
      </div>

      {/* Working days */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays size={15} className="text-accent" />
          <h3 className="text-sm font-bold">Working days</h3>
        </div>
        <p className="text-[12px] text-muted mb-3">
          The days attendance detection treats as company time. Heartbeat gaps on other days don't trigger warnings.
        </p>
        <div className="flex flex-wrap gap-2">
          {DAY_LABELS.map((d) => {
            const active = days.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                title={d.full}
                className={`px-3 py-1.5 rounded-full text-[12.5px] font-semibold border transition-colors ${
                  active
                    ? "bg-accent text-white border-accent"
                    : "bg-bg text-muted border-border hover:border-accent/40 hover:text-text"
                }`}
              >
                {d.short}
              </button>
            );
          })}
        </div>
      </section>

      {/* Hours */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={15} className="text-accent" />
          <h3 className="text-sm font-bold">Daily hours</h3>
        </div>
        <p className="text-[12px] text-muted mb-3">
          Standard start and end times. First heartbeats after <strong>{hourLabel(start)} + 1h</strong> count
          as a "late start" on the Attendance dashboard.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Start</div>
            <select className="input" value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">End</div>
            <select className="input" value={end} onChange={(e) => setEnd(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h} disabled={h <= start}>
                  {h === 24 ? "12:00 AM (midnight)" : hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Break + away threshold */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Coffee size={15} className="text-accent" />
          <h3 className="text-sm font-bold">Break & away tolerance</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1">Daily break allowance (minutes)</div>
            <input
              className="input"
              type="number" min={0} max={240} step={5}
              value={breakMin}
              onChange={(e) => setBreakMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
            />
            <div className="text-[11px] text-muted mt-1">
              How much of the day is OK to be away (lunch, calls). Display-only — the threshold below is what actually triggers warnings.
            </div>
          </label>
          <label className="block">
            <div className="text-[11px] text-muted font-medium mb-1 inline-flex items-center gap-1.5">
              <AlertTriangle size={11} className="text-warn" /> Long-away threshold (minutes)
            </div>
            <input
              className="input"
              type="number" min={5} max={240} step={5}
              value={thresholdMin}
              onChange={(e) => setThresholdMin(Math.max(5, Math.min(240, Number(e.target.value) || 5)))}
            />
            <div className="text-[11px] text-muted mt-1">
              Unbroken gaps longer than this during work hours fire an attendance warning and dock the
              appraisal Wellbeing score.
            </div>
          </label>
        </div>
        {breakMin > thresholdMin && (
          <div className="mt-3 bg-warn/10 border border-warn/30 rounded-lg px-3 py-2 text-[12px] text-warn">
            Heads-up: your break allowance ({breakMin}m) is larger than the away threshold ({thresholdMin}m).
            Staff taking a normal lunch will get flagged. Bump the threshold or trim the allowance.
          </div>
        )}
      </section>

      {/* Timezone */}
      <section className="bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Globe2 size={15} className="text-accent" />
          <h3 className="text-sm font-bold">Timezone</h3>
        </div>
        <p className="text-[12px] text-muted mb-3">
          IANA zone used to interpret start/end hours. When blank, each user's own browser timezone wins on a per-heartbeat basis.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input max-w-xs"
            value={COMMON_TZ.includes(tz) ? tz : ""}
            onChange={(e) => setTz(e.target.value)}
          >
            <option value="">— Use each user's local zone —</option>
            {COMMON_TZ.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <input
            className="input flex-1 min-w-[200px]"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="Or type a custom IANA zone (e.g. Africa/Accra)"
          />
          {browserTZ && browserTZ !== tz && (
            <button
              type="button"
              onClick={() => setTz(browserTZ)}
              className="text-[11.5px] font-semibold text-accent hover:underline whitespace-nowrap"
            >
              Use my browser ({browserTZ})
            </button>
          )}
        </div>
      </section>

      {/* Save bar */}
      <div className="flex items-center justify-end gap-3">
        {!dirty && <span className="text-xs text-muted">No changes</span>}
        <SmartButton
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutateAsync()}
          loadingLabel="Saving…"
          successLabel="Saved"
        >
          Save work policy
        </SmartButton>
      </div>
    </div>
  );
}
