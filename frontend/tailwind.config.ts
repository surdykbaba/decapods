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
      },
      animation: {
        flicker: "flicker 1.6s ease-in-out infinite",
        "cloud-drift-a": "cloud-drift-a 42s ease-in-out infinite",
        "cloud-drift-b": "cloud-drift-b 56s ease-in-out infinite",
        "cloud-drift-c": "cloud-drift-c 48s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
