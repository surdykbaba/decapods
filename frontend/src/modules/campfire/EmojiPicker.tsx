// EmojiPicker — a compact, batteries-included emoji + sticker palette.
//
// Tabs:
//   • Recent     — last 16 emojis the user picked (localStorage-backed)
//   • Smileys    — faces & emotions
//   • Gestures   — hands & people
//   • Hearts     — love & affection
//   • Party      — celebration, fireworks, confetti
//   • Nature     — animals, plants, food
//   • Symbols    — checkmarks, arrows, sparkles
//   • Stickers   — animated CSS stickers for an extra dollop of mood
//
// "Stickers" emit shortcodes (e.g. ":confetti-burst:") instead of raw emojis;
// SmartBody renders them as the looping animated component. Plain emojis
// round-trip as their literal unicode character.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Clock, Smile, Hand, Heart, PartyPopper, Leaf, Sparkles, X } from "lucide-react";

const LS_RECENT = "pgdp:emoji-recent";

type Tab = "recent" | "smileys" | "gestures" | "hearts" | "party" | "nature" | "symbols" | "stickers";

// Curated lists — chosen for workplace tone. Not an exhaustive emoji set but
// enough breadth that nobody runs out of ways to react.
const CATALOG: Record<Exclude<Tab, "recent" | "stickers">, string[]> = {
  smileys: [
    "😀","😄","😁","😊","🙂","😉","😍","🤩","😎","🤓","🤔","🙃","😅","😂","🤣","😭",
    "😴","🤤","🤯","🥳","😏","😬","😱","😳","🙄","😤","😡","🥺","🤗","🤝","🤞","🙌",
  ],
  gestures: [
    "👍","👎","👏","🙏","💪","🤝","🤜","🤛","👌","🤌","🤏","✌️","🤘","👋","🤙","🫡",
    "🫶","💁","🙋","🙆","🙇","🤷","🤦","🧑‍💻","👀","🧠","👁️","🫵","✊","✋","🖐️","👆",
  ],
  hearts: [
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💖","💗","💘","💝",
  ],
  party: [
    "🎉","🎊","🥳","🎈","🎁","🪅","🍾","🥂","🎂","🍻","🎆","🎇","🪄","🌟","⭐","✨",
    "💯","🏆","🏅","🥇","🎖️","🚀","🔥","⚡","💫","🤩","👑","💐",
  ],
  nature: [
    "🌸","🌻","🌷","🌹","🪷","🌱","🌲","🍀","🍎","🍌","🍓","🍔","🍕","☕","🍵","🍰",
    "🐶","🐱","🦊","🦁","🐯","🐼","🦄","🐝","🦋","🐙","🐳","🐢",
  ],
  symbols: [
    "✅","☑️","✔️","❌","❎","⚠️","🚫","⛔","💡","🔔","📌","📍","📎","🗂️","📊","📈",
    "📅","🗓️","🕐","🎯","🛠️","🔧","🔒","🔓","🆘","🆗","➡️","⬅️","⬆️","⬇️","🔁","🔂",
  ],
};

// Stickers — short-codes that SmartBody renders as a tiny animated SVG.
// The picker shows a preview tile + label.
export type StickerCode =
  | ":confetti-burst:"
  | ":fire-flicker:"
  | ":clap-loop:"
  | ":heart-pulse:"
  | ":star-spin:"
  | ":rocket-launch:"
  | ":thumbs-up-bounce:"
  | ":party-popper:";

const STICKERS: { code: StickerCode; emoji: string; label: string }[] = [
  { code: ":confetti-burst:",    emoji: "🎉", label: "Confetti burst" },
  { code: ":fire-flicker:",      emoji: "🔥", label: "On fire" },
  { code: ":clap-loop:",         emoji: "👏", label: "Applause" },
  { code: ":heart-pulse:",       emoji: "💖", label: "Pulsing heart" },
  { code: ":star-spin:",         emoji: "⭐", label: "Spinning star" },
  { code: ":rocket-launch:",     emoji: "🚀", label: "Rocket launch" },
  { code: ":thumbs-up-bounce:",  emoji: "👍", label: "Bouncing thumbs" },
  { code: ":party-popper:",      emoji: "🥳", label: "Party time" },
];

const TABS: { key: Tab; label: string; icon: React.ComponentType<any> }[] = [
  { key: "recent",   label: "Recent",   icon: Clock },
  { key: "smileys",  label: "Smileys",  icon: Smile },
  { key: "gestures", label: "Hands",    icon: Hand },
  { key: "hearts",   label: "Hearts",   icon: Heart },
  { key: "party",    label: "Party",    icon: PartyPopper },
  { key: "nature",   label: "Nature",   icon: Leaf },
  { key: "symbols",  label: "Symbols",  icon: Sparkles },
  { key: "stickers", label: "Stickers", icon: Sparkles },
];

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function pushRecent(emoji: string) {
  try {
    const cur = readRecent().filter((e) => e !== emoji);
    cur.unshift(emoji);
    localStorage.setItem(LS_RECENT, JSON.stringify(cur.slice(0, 16)));
  } catch { /* private mode etc — non-fatal */ }
}

/**
 * Inline picker — caller decides positioning. Use Popover wrapper component
 * below for an absolute-positioned popup with outside-click dismissal.
 */
export function EmojiPicker({ onPick, onClose }: { onPick: (s: string) => void; onClose?: () => void }) {
  const [tab, setTab] = useState<Tab>(readRecent().length > 0 ? "recent" : "smileys");
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [q, setQ] = useState("");

  function pick(s: string) {
    // Only emoji round-trip to recents; sticker shortcodes wouldn't render
    // as a tile in the Recent grid since they need the animated component.
    if (!s.startsWith(":")) {
      pushRecent(s);
      setRecent(readRecent());
    }
    onPick(s);
  }

  const list = useMemo(() => {
    if (tab === "stickers") return [];
    if (q.trim()) {
      // Quick text-match against the emoji char itself isn't useful, so this
      // falls back to "show all" — kept here for future keyword catalogues.
      return Object.values(CATALOG).flat();
    }
    if (tab === "recent") return recent;
    return CATALOG[tab];
  }, [tab, q, recent]);

  return (
    <div className="bg-surface border border-border rounded-2xl shadow-card w-[320px] overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search emoji…"
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-bg border border-border rounded-md focus:outline-none focus:border-accent/40"
          />
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 rounded hover:bg-bg text-muted">
            <X size={13} />
          </button>
        )}
      </header>

      {/* Tab strip */}
      <nav className="flex items-center px-2 py-1.5 gap-0.5 border-b border-border overflow-x-auto">
        {TABS.map((t) => {
          if (t.key === "recent" && recent.length === 0) return null;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.label}
              className={`p-1.5 rounded-md text-[12.5px] ${
                active ? "bg-accent-soft text-accent" : "text-muted hover:text-text hover:bg-bg/40"
              }`}
            >
              <t.icon size={13} />
            </button>
          );
        })}
      </nav>

      {/* Grid */}
      <div className="max-h-[240px] overflow-y-auto p-2">
        {tab === "stickers" ? (
          <div className="grid grid-cols-2 gap-2">
            {STICKERS.map((s) => (
              <button
                key={s.code}
                onClick={() => pick(s.code)}
                className="flex items-center gap-2 px-2 py-2 rounded-lg border border-border hover:border-accent/40 hover:bg-bg/40 text-left"
                title={s.label}
              >
                <span className="w-7 h-7 grid place-items-center bg-accent-soft rounded-md">
                  <AnimatedSticker code={s.code} size={18} />
                </span>
                <span className="text-[12px] font-semibold text-text">{s.label}</span>
              </button>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="text-center text-[11px] text-muted py-6">
            Nothing here yet.
          </div>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {list.map((e, i) => (
              <button
                key={e + i}
                onClick={() => pick(e)}
                className="w-9 h-9 rounded-md hover:bg-bg/60 text-xl leading-none"
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Popover wrapper — fixed-position emoji picker that dismisses on outside
 * click. Use this from buttons.
 */
export function EmojiPopover({
  open, onClose, onPick, anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (s: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Render into document.body so the picker isn't constrained by any
  // ancestor's stacking context, overflow:hidden, or transforms. Plain
  // `absolute z-50` inside a comment row got pushed behind sibling rows.
  // Computed in layout effect so the position is correct on first paint.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const PICKER_W = 320; // matches w-[320px] on the inner card
  const PICKER_H = 340; // worst-case height of the picker card + grid

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    function place() {
      const a = anchorRef.current!.getBoundingClientRect();
      // Default to below the anchor, aligned to its left edge.
      let top  = a.bottom + 6;
      let left = a.left;
      // Flip above when there isn't room below.
      if (top + PICKER_H > window.innerHeight - 8) {
        top = Math.max(8, a.top - PICKER_H - 6);
      }
      // Keep the right edge inside the viewport.
      if (left + PICKER_W > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - PICKER_W - 8);
      }
      setPos({ top, left });
    }
    place();
    // Re-place on scroll/resize so the popover sticks with its trigger.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[1000]"
      style={{ top: pos.top, left: pos.left }}
    >
      <EmojiPicker onPick={(s) => { onPick(s); onClose(); }} onClose={onClose} />
    </div>,
    document.body,
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * Animated stickers
 *
 * Tiny per-sticker CSS — emoji + transform keyframes. Self-contained, no
 * extra deps. Each sticker is just the source emoji with a custom animation
 * applied via `animationName`. Defined in tailwind.config.ts.
 * ─────────────────────────────────────────────────────────────────────────── */

export function AnimatedSticker({ code, size = 22 }: { code: string; size?: number }) {
  const s = STICKERS.find((x) => x.code === code);
  if (!s) return <span style={{ fontSize: size }}>{code}</span>;

  // Map sticker → tailwind animation class. Keeps the JSX boring.
  const animClass: Record<StickerCode, string> = {
    ":confetti-burst:":    "animate-sticker-confetti",
    ":fire-flicker:":      "animate-sticker-flame",
    ":clap-loop:":         "animate-sticker-clap",
    ":heart-pulse:":       "animate-sticker-heart",
    ":star-spin:":         "animate-sticker-star",
    ":rocket-launch:":     "animate-sticker-rocket",
    ":thumbs-up-bounce:":  "animate-sticker-thumbs",
    ":party-popper:":      "animate-sticker-popper",
  };
  return (
    <span
      className={`inline-block leading-none ${animClass[s.code]}`}
      style={{ fontSize: size }}
      aria-label={s.label}
      role="img"
    >
      {s.emoji}
    </span>
  );
}

/**
 * Helper: is this a sticker shortcode? Used by SmartBody to decide whether
 * to render the animated component instead of plain text.
 */
export function isStickerCode(s: string): s is StickerCode {
  return STICKERS.some((x) => x.code === s);
}

/**
 * Fires a quick confetti burst at the centre of the given element. Plain
 * DOM, no React reconciliation — particles are absolutely-positioned divs
 * that fall back to the GC when the animation ends.
 */
export function celebrateAt(el: HTMLElement | null) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colours = ["#facc15", "#f97316", "#ef4444", "#22c55e", "#0ea5e9", "#a855f7"];

  for (let i = 0; i < 24; i++) {
    const p = document.createElement("span");
    const size = 6 + Math.random() * 6;
    p.style.position = "fixed";
    p.style.left = cx + "px";
    p.style.top = cy + "px";
    p.style.width = size + "px";
    p.style.height = size + "px";
    p.style.background = colours[Math.floor(Math.random() * colours.length)];
    p.style.borderRadius = "2px";
    p.style.zIndex = "9999";
    p.style.pointerEvents = "none";
    p.style.willChange = "transform, opacity";
    const angle = Math.random() * Math.PI * 2;
    const distance = 60 + Math.random() * 60;
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance - 40; // bias upward — feels celebratory
    const rot = (Math.random() * 720 - 360).toFixed(0);
    p.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0)", opacity: 1 },
        { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1100);
  }
}

/** Emoji codes that trigger the confetti burst on click. */
const CONFETTI_EMOJI = new Set(["🎉", "🥳", "🎊", "🍾", "🏆", "🥇"]);
export function isCelebratory(s: string): boolean {
  return CONFETTI_EMOJI.has(s) || s === ":confetti-burst:" || s === ":party-popper:" || s === ":rocket-launch:";
}
