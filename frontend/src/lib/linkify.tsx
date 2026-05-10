import React from "react";

// Conservative URL detector — matches http(s) and bare www.* runs. Punctuation
// at the very end of a URL is trimmed off so "see https://example.com." doesn't
// link the trailing dot.
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const TRAIL_PUNCT_RE = /[.,;:!?)\]"']+$/;

/**
 * Turn a plain string into a React fragment with clickable URLs. Anything
 * that's not a URL is rendered as a text node verbatim — no markdown, no
 * HTML injection. Safe for arbitrary user content.
 */
export function linkify(text: string | null | undefined): React.ReactNode {
  if (!text) return text ?? null;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let raw = match[1];
    let trailing = "";
    const t = raw.match(TRAIL_PUNCT_RE);
    if (t) {
      trailing = t[0];
      raw = raw.slice(0, raw.length - trailing.length);
    }
    if (start > last) out.push(text.slice(last, start));
    const href = raw.startsWith("http") ? raw : `https://${raw}`;
    out.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline hover:no-underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {raw}
      </a>,
    );
    if (trailing) out.push(trailing);
    last = start + match[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
