// Time-of-day- AND weekday-aware labels for the daily check-in form.
//
// Morning users do a classic standup (recap → plan); by mid-afternoon the
// framing flips to "this morning → rest of today"; late afternoon onward
// it's the wrap-up framing (today → tomorrow).
//
// Weekend awareness: "yesterday" is wrong on a Monday — yesterday was
// Sunday, nobody shipped. The morning recap looks back to the previous
// *working* day, so Monday (and a Sunday check-in) asks "How did last
// week go?" instead. Symmetrically, a Friday-evening plan looks forward
// to the next working day, so it asks about "next week", not "tomorrow".
//
// Buckets are driven by the user's local clock — the standup window the
// admin configures controls reminders, not vocabulary.

export type CheckinPhrasing = {
  recapLabel:       string; // header above the first textarea
  recapPlaceholder: string;
  planLabel:        string; // header above the second textarea
  planPlaceholder:  string;
};

export function checkinPhrasing(now: Date = new Date()): CheckinPhrasing {
  const h = now.getHours();
  const dow = now.getDay(); // 0=Sun … 6=Sat

  // Previous working day is in *last* week when today is Monday, or when
  // someone checks in on a Sunday (last work was Friday either way).
  const recapIsLastWeek = dow === 1 || dow === 0;
  // Next working day is in *next* week from Friday onward through the
  // weekend (Fri → Mon, Sat → Mon, Sun → Mon).
  const planIsNextWeek = dow === 5 || dow === 6 || dow === 0;

  if (h < 12) {
    return recapIsLastWeek
      ? {
          recapLabel:       "Last week — how did it go?",
          recapPlaceholder: "What shipped, what slipped, what carried over from last week?",
          planLabel:        "This week — what's on",
          planPlaceholder:  "Your focus for the week ahead — one or two priorities.",
        }
      : {
          recapLabel:       "Yesterday — what shipped",
          recapPlaceholder: "What did you finish, hand off, or get stuck on?",
          planLabel:        "Today — what's on",
          planPlaceholder:  "One or two things you're owning today.",
        };
  }
  if (h < 16) {
    return {
      recapLabel:       "This morning — what shipped",
      recapPlaceholder: "What did you wrap, hand off, or get stuck on this morning?",
      planLabel:        "Rest of today — what's on",
      planPlaceholder:  "What you're picking up for the afternoon.",
    };
  }
  return planIsNextWeek
    ? {
        recapLabel:       "Today — what shipped",
        recapPlaceholder: "What did you finish, hand off, or get stuck on today?",
        planLabel:        "Next week — what's on",
        planPlaceholder:  "What you're picking up when the week starts again.",
      }
    : {
        recapLabel:       "Today — what shipped",
        recapPlaceholder: "What did you finish, hand off, or get stuck on today?",
        planLabel:        "Tomorrow — what's on",
        planPlaceholder:  "One or two things you're picking up tomorrow.",
      };
}
