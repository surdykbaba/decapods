import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        text: "rgb(var(--text) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft) / <alpha-value>)",
        lime: "rgb(var(--lime) / <alpha-value>)",
        "lime-soft": "rgb(var(--lime-soft) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      borderRadius: { xl: "0.875rem", "2xl": "1.25rem", "3xl": "1.75rem" },
      fontFamily: {
        sans: ["Manrope", "InterVariable", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.03)",
        card: "0 8px 28px rgba(15, 23, 42, 0.06)",
      },
      // Campfire flame flicker — tiny scale + hue wobble. Keep amplitude low so
      // it reads as "alive", not "loading spinner".
      keyframes: {
        flicker: {
          "0%, 100%": { transform: "scale(1) rotate(-1deg)", filter: "drop-shadow(0 0 4px rgba(249,115,22,0.5))" },
          "25%":      { transform: "scale(1.08) rotate(2deg)", filter: "drop-shadow(0 0 6px rgba(249,115,22,0.7))" },
          "50%":      { transform: "scale(0.96) rotate(-2deg)", filter: "drop-shadow(0 0 3px rgba(234,88,12,0.6))" },
          "75%":      { transform: "scale(1.04) rotate(1deg)", filter: "drop-shadow(0 0 5px rgba(249,115,22,0.65))" },
        },
        // Gentle horizontal drift for cloud decoration. Three variants share
        // the same animation but use different durations + offsets so each
        // cloud feels independent rather than locked to a parade.
        "cloud-drift-a": {
          "0%, 100%": { transform: "translateX(0)" },
          "50%":      { transform: "translateX(-18px)" },
        },
        "cloud-drift-b": {
          "0%, 100%": { transform: "translateX(0)" },
          "50%":      { transform: "translateX(24px)" },
        },
        "cloud-drift-c": {
          "0%, 100%": { transform: "translateX(0)" },
          "50%":      { transform: "translateX(-14px)" },
        },
        // Campfire sticker keyframes — each picked so the emoji's own glyph
        // tells most of the story; we just add motion that fits the mood.
        "sticker-confetti": {
          "0%, 100%": { transform: "scale(1) rotate(-3deg)" },
          "30%":      { transform: "scale(1.25) rotate(8deg)" },
          "60%":      { transform: "scale(0.95) rotate(-6deg)" },
        },
        "sticker-flame": {
          "0%, 100%": { transform: "scale(1) translateY(0)", filter: "drop-shadow(0 0 3px rgba(249,115,22,0.6))" },
          "50%":      { transform: "scale(1.18) translateY(-2px)", filter: "drop-shadow(0 0 8px rgba(249,115,22,0.9))" },
        },
        "sticker-clap": {
          "0%, 100%": { transform: "translateX(0) rotate(-8deg)" },
          "50%":      { transform: "translateX(4px) rotate(8deg)" },
        },
        "sticker-heart": {
          "0%, 100%": { transform: "scale(1)" },
          "20%":      { transform: "scale(1.25)" },
          "40%":      { transform: "scale(0.92)" },
          "60%":      { transform: "scale(1.18)" },
          "80%":      { transform: "scale(0.98)" },
        },
        "sticker-star": {
          "0%":   { transform: "rotate(0deg) scale(1)" },
          "50%":  { transform: "rotate(180deg) scale(1.15)" },
          "100%": { transform: "rotate(360deg) scale(1)" },
        },
        "sticker-rocket": {
          "0%, 100%": { transform: "translateY(0) rotate(-12deg)" },
          "50%":      { transform: "translateY(-6px) rotate(-6deg)" },
        },
        "sticker-thumbs": {
          "0%, 100%": { transform: "translateY(0) rotate(-4deg)" },
          "50%":      { transform: "translateY(-4px) rotate(6deg)" },
        },
        "sticker-popper": {
          "0%, 100%": { transform: "rotate(-10deg) scale(1)" },
          "25%":      { transform: "rotate(10deg) scale(1.15)" },
          "50%":      { transform: "rotate(-6deg) scale(0.95)" },
          "75%":      { transform: "rotate(6deg) scale(1.1)" },
        },
      },
      animation: {
        flicker: "flicker 1.6s ease-in-out infinite",
        "cloud-drift-a": "cloud-drift-a 42s ease-in-out infinite",
        "cloud-drift-b": "cloud-drift-b 56s ease-in-out infinite",
        "cloud-drift-c": "cloud-drift-c 48s ease-in-out infinite",
        "sticker-confetti": "sticker-confetti 0.9s ease-in-out infinite",
        "sticker-flame":    "sticker-flame 0.7s ease-in-out infinite",
        "sticker-clap":     "sticker-clap 0.4s ease-in-out infinite",
        "sticker-heart":    "sticker-heart 1.1s ease-in-out infinite",
        "sticker-star":     "sticker-star 2.4s linear infinite",
        "sticker-rocket":   "sticker-rocket 1.1s ease-in-out infinite",
        "sticker-thumbs":   "sticker-thumbs 0.7s ease-in-out infinite",
        "sticker-popper":   "sticker-popper 0.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
