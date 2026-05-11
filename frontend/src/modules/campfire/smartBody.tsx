// SmartBody — renders user-authored body text with three layers of polish:
//   1. URLs become anchor tags (re-uses linkify).
//   2. @mentions render as accent-coloured pills.
//   3. The first URL in the body gets an Open Graph preview card underneath.
//
// All three are best-effort. If link preview fetch fails we just drop the card
// silently; mention pills don't need anything from the server to look right.
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { AnimatedSticker, isStickerCode } from "@/modules/campfire/EmojiPicker";

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const TRAIL_PUNCT_RE = /[.,;:!?)\]"']+$/;
const MENTION_RE = /@([a-zA-Z0-9_.+-]+)/g;
// Sticker shortcodes round-trip inside post bodies as :name-with-dashes:
// SmartBody swaps each match for the animated AnimatedSticker component.
const STICKER_RE = /:([a-z0-9][a-z0-9-]{2,30}):/gi;

export function extractFirstURL(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m || m.length === 0) return null;
  let raw = m[0];
  const t = raw.match(TRAIL_PUNCT_RE);
  if (t) raw = raw.slice(0, raw.length - t[0].length);
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

// renderRich walks the string once, splitting on whichever pattern (URL or
// mention) hits first. Keeping it linear avoids the classic "two passes
// double-render" trap and lets us put mention pills *inside* link-free runs.
function renderRich(text: string): React.ReactNode {
  if (!text) return null;
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  // Find next match (whichever comes first) starting at index `from`.
  function nextMatch(from: number): { kind: "url" | "mention" | "sticker"; index: number; raw: string; len: number } | null {
    URL_RE.lastIndex = from;
    const u = URL_RE.exec(text);
    MENTION_RE.lastIndex = from;
    const m = MENTION_RE.exec(text);
    STICKER_RE.lastIndex = from;
    const s = STICKER_RE.exec(text);

    type Cand = { kind: "url" | "mention" | "sticker"; index: number; raw: string; len: number };
    const cands: Cand[] = [];
    if (u) {
      let raw = u[1];
      let trailLen = 0;
      const t = raw.match(TRAIL_PUNCT_RE);
      if (t) { trailLen = t[0].length; raw = raw.slice(0, raw.length - trailLen); }
      cands.push({ kind: "url", index: u.index, raw, len: u[1].length - trailLen });
    }
    if (m) cands.push({ kind: "mention", index: m.index, raw: m[1], len: m[0].length });
    if (s) cands.push({ kind: "sticker", index: s.index, raw: s[0], len: s[0].length });
    if (cands.length === 0) return null;
    return cands.sort((a, b) => a.index - b.index)[0];
  }

  while (i < text.length) {
    const hit = nextMatch(i);
    if (!hit) {
      out.push(text.slice(i));
      break;
    }
    if (hit.index > i) out.push(text.slice(i, hit.index));
    if (hit.kind === "url") {
      const href = hit.raw.startsWith("http") ? hit.raw : `https://${hit.raw}`;
      out.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline hover:no-underline break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {hit.raw}
        </a>,
      );
    } else if (hit.kind === "sticker") {
      // Render known sticker codes as the animated component. Unknown codes
      // fall through to plain text so we don't eat legitimate `:foo:`
      // references that aren't meant to be stickers.
      if (isStickerCode(hit.raw)) {
        out.push(
          <span key={key++} className="inline-block align-middle mx-0.5">
            <AnimatedSticker code={hit.raw} size={20} />
          </span>,
        );
      } else {
        out.push(hit.raw);
      }
    } else {
      out.push(
        <span
          key={key++}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-accent-soft text-accent font-semibold text-[12.5px]"
        >
          @{hit.raw}
        </span>,
      );
    }
    i = hit.index + hit.len;
  }
  return <>{out}</>;
}

export function SmartBody({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const firstURL = extractFirstURL(text);
  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words">{renderRich(text)}</div>
      {firstURL && <LinkEmbed url={firstURL} />}
    </div>
  );
}

type Preview = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  site_name?: string;
};

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

export function LinkEmbed({ url }: { url: string }) {
  const { data, isLoading } = useQuery<Preview>({
    queryKey: ["campfire", "link-preview", url],
    queryFn: () => api(`/api/v1/campfire/link-preview?url=${encodeURIComponent(url)}`),
    staleTime: 30 * 60_000, // mirrors the server cache TTL
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mt-2 border border-border rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-muted bg-bg/30">
        <ImageIcon size={13} className="opacity-40 animate-pulse" />
        Loading preview…
      </div>
    );
  }

  const host = data?.site_name || hostname(url);
  const hasRichMeta = !!(data?.title || data?.description || data?.image);

  // Even when the upstream blocks our fetch, give the user a clickable hostname
  // pill so the link is never "naked" in the body. Rich metadata renders the
  // full image+title card; bare fetches still get the slim chip.
  if (!hasRichMeta) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border hover:border-accent/40 bg-bg/30 text-[12px] text-text transition-colors"
      >
        {data?.favicon ? (
          <img src={data.favicon} alt="" className="w-4 h-4 rounded-sm" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <ExternalLink size={12} className="text-muted" />
        )}
        <span className="font-semibold">{host}</span>
        <span className="text-muted">Open link</span>
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="mt-2 block border border-border rounded-xl overflow-hidden hover:border-accent/40 transition-colors bg-bg/20"
    >
      <div className="flex">
        {data?.image ? (
          <img
            src={data.image}
            alt=""
            className="w-28 h-28 object-cover shrink-0 bg-bg"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : data?.favicon ? (
          <div className="w-28 h-28 shrink-0 bg-bg grid place-items-center">
            <img src={data.favicon} alt="" className="w-10 h-10 opacity-80" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          </div>
        ) : null}
        <div className="flex-1 min-w-0 p-3">
          <div className="text-[10.5px] uppercase tracking-wider text-muted font-bold flex items-center gap-1">
            <ExternalLink size={10} /> {host}
          </div>
          {data?.title && (
            <div className="text-[13px] font-bold text-text mt-0.5 line-clamp-2">{data.title}</div>
          )}
          {data?.description && (
            <div className="text-[12px] text-muted mt-0.5 line-clamp-2">{data.description}</div>
          )}
        </div>
      </div>
    </a>
  );
}
