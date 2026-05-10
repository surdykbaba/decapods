import { ReactNode } from "react";
import clsx from "clsx";

export function Card({ title, children, action, className }: {
  title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={clsx("card p-5", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          {title && <h3 className="h2">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "neutral" }: {
  label: string; value: ReactNode; hint?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneCls = {
    neutral: "text-text",
    good: "text-success",
    warn: "text-warn",
    bad: "text-danger",
  }[tone];
  return (
    <div className="card p-5">
      <div className="label">{label}</div>
      <div className={clsx("text-2xl font-semibold", toneCls)}>{value}</div>
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  const cls = {
    neutral: "bg-border/40 text-muted",
    good: "bg-success/15 text-success",
    warn: "bg-warn/15 text-warn",
    bad: "bg-danger/15 text-danger",
    info: "bg-accent/15 text-accent",
  }[tone];
  return <span className={`pill ${cls}`}>{children}</span>;
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="card p-8 text-center text-muted">
      <div className="font-semibold text-text mb-1">{title}</div>
      {body && <div className="text-sm">{body}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse bg-border/40 rounded", className)} />;
}
