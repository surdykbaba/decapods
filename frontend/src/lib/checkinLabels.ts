// Time-of-day-aware labels for the daily check-in form. Morning users do a
// classic standup (yesterday → today); by mid-afternoon the framing flips to
// "this morning → rest of today"; late afternoon onward the wrap-up framing
// (today → tomorrow) makes more sense than asking about "yesterday" when the
// user has clearly been working since.
//
// Buckets are driven by the user's local clock — the standup window the admin
// configures controls reminders, not vocabulary.

export type CheckinPhrasing = {
  recapLabel:       string; // header above the first textarea
  recapPlaceholder: string;
  planLabel:        string; // header above the second textarea
  planPlaceholder:  string;
};

export function checkinPhrasing(now: Date = new Date()): CheckinPhrasing {
  const h = now.getHours();
  if (h < 12) {
    return {
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
  return {
    recapLabel:       "Today — what shipped",
    recapPlaceholder: "What did you finish, hand off, or get stuck on today?",
    planLabel:        "Tomorrow — what's on",
    planPlaceholder:  "One or two things you're picking up tomorrow.",
  };
}
