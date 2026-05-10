// MentionInput — a tiny textarea wrapper that pops a member-picker when the
// user types "@" at the start of a word. It rewrites the underlying string so
// the server still receives a plain "@first.name" handle; visually the picker
// is just an autocomplete affordance, not a rich-text widget.
//
// Designed to drop into existing composer forms with the same API as a normal
// <textarea>. Pass `members` and we'll do the rest.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Member = { id: string; name: string; email: string };

export function MentionInput({
  value, onChange, placeholder, className, members: membersProp, autoFocus, minRows,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  members?: Member[];
  autoFocus?: boolean;
  minRows?: number;
  /** Optional Enter-to-submit handler (Shift+Enter still inserts a newline). */
  onSubmit?: () => void;
}) {
  // Lazy-fetch the directory when no list was supplied. The TanStack cache
  // dedupes the call across every MentionInput on the page.
  const { data: dirData } = useQuery<{ items: Member[] }>({
    queryKey: ["members", "for-mention"],
    queryFn: () => api("/api/v1/members?status=active"),
    enabled: !membersProp,
    staleTime: 5 * 60_000,
  });
  const members = membersProp ?? dirData?.items ?? [];
  const ref = useRef<HTMLTextAreaElement>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Detect when the caret is inside a freshly typed "@something" run. We open
  // the picker, capture the start index, and watch the query update as the
  // user keeps typing. Backspacing past the @ closes it.
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    const caret = e.target.selectionStart ?? next.length;
    const upTo = next.slice(0, caret);
    const at = upTo.lastIndexOf("@");
    if (at === -1) { setOpenAt(null); return; }
    // Make sure the @ is at start-of-string or preceded by whitespace.
    if (at > 0 && !/\s/.test(upTo[at - 1])) { setOpenAt(null); return; }
    const fragment = upTo.slice(at + 1);
    if (/\s/.test(fragment)) { setOpenAt(null); return; }
    setOpenAt(at);
    setQuery(fragment.toLowerCase());
    setHighlight(0);
  }

  const filtered = useMemo(() => {
    if (openAt === null) return [];
    const q = query.trim();
    const score = (m: Member) => {
      const haystack = `${m.name} ${m.email}`.toLowerCase();
      if (!q) return 1;
      return haystack.includes(q) ? 1 : 0;
    };
    return members
      .map((m) => ({ m, s: score(m) }))
      .filter((r) => r.s > 0)
      .slice(0, 6)
      .map((r) => r.m);
  }, [members, query, openAt]);

  function pick(m: Member) {
    if (openAt === null) return;
    // Use the local-part of the email as the handle so it round-trips to the
    // mention regex on the server. Falls back to the first name if no email
    // (shouldn't happen for real members, but stay defensive).
    const handle = (m.email.split("@")[0] || m.name.split(" ")[0] || "user").toLowerCase();
    const before = value.slice(0, openAt);
    const afterCaretStart = openAt + 1 + query.length;
    const after = value.slice(afterCaretStart);
    const inserted = `@${handle} `;
    const next = before + inserted + after;
    onChange(next);
    setOpenAt(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      const pos = (before + inserted).length;
      ref.current?.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (openAt === null || filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(filtered[highlight]);
    } else if (e.key === "Escape") {
      setOpenAt(null);
    }
  }

  // Outer Enter-to-send (e.g. room messages). Only fires when the mention
  // picker is closed and Shift isn't held.
  function handleOuterKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    handleKeyDown(e);
    if (onSubmit && openAt === null && e.key === "Enter" && !e.shiftKey && !e.isDefaultPrevented()) {
      e.preventDefault();
      onSubmit();
    }
  }

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={minRows ?? 3}
        className={className ?? "input min-h-[80px]"}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleOuterKey}
      />
      {openAt !== null && filtered.length > 0 && (
        <div className="absolute z-30 left-2 top-full mt-1 bg-surface border border-border rounded-xl shadow-card overflow-hidden min-w-[240px]">
          {filtered.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-[13px] ${
                i === highlight ? "bg-accent-soft text-accent" : "hover:bg-bg/40"
              }`}
            >
              <span className="w-6 h-6 rounded-full bg-accent-soft text-accent text-[10px] font-bold grid place-items-center shrink-0">
                {(m.name || m.email).charAt(0).toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <div className="font-semibold truncate">{m.name || m.email}</div>
                <div className="text-[10.5px] text-muted truncate">{m.email}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
