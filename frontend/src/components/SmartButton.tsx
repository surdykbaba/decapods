import { forwardRef, useState, useRef, useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode, MouseEvent } from "react";
import { Loader2, Check } from "lucide-react";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size    = "sm" | "md" | "lg";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;          // controlled loading (overrides auto)
  loadingLabel?: string;      // text to show while pending (default: original)
  successLabel?: string;      // text to flash after success (default: "Saved")
  showSuccessFlash?: boolean; // briefly show a check + successLabel after async resolves
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** onClick may be async; SmartButton tracks the returned promise to drive loading state. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  children?: ReactNode;
}

const VARIANT_CLS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-[rgb(var(--accent-hover))] shadow-soft disabled:opacity-60 disabled:cursor-not-allowed",
  outline: "border border-border bg-surface text-text hover:bg-bg disabled:opacity-60 disabled:cursor-not-allowed",
  ghost:   "hover:bg-bg text-text disabled:opacity-60 disabled:cursor-not-allowed",
  danger:  "bg-danger text-white hover:bg-danger/90 shadow-soft disabled:opacity-60 disabled:cursor-not-allowed",
};

const SIZE_CLS: Record<Size, string> = {
  sm: "px-3 py-1.5 text-[12.5px] gap-1.5 rounded-full",
  md: "px-4 py-2.5 text-[14px] gap-2 rounded-full",
  lg: "px-5 py-3 text-[15px] gap-2 rounded-full",
};

export const SmartButton = forwardRef<HTMLButtonElement, Props>(function SmartButton(
  { variant = "primary", size = "md", loading, loadingLabel, successLabel = "Saved",
    showSuccessFlash = true, icon, iconRight, onClick, children, className = "",
    disabled, type = "button", ...rest },
  ref,
) {
  const [autoLoading, setAutoLoading] = useState(false);
  const [flashSuccess, setFlashSuccess] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const isLoading = loading ?? autoLoading;

  async function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (!onClick || isLoading || disabled) return;
    let r: unknown;
    try {
      r = onClick(e);
    } catch {
      // sync throw — let it propagate elsewhere; nothing to do here
      return;
    }
    // If the handler returned a Promise, drive loading state automatically
    if (r && typeof (r as Promise<unknown>).then === "function") {
      setAutoLoading(true);
      try {
        await r;
        if (mounted.current && showSuccessFlash) {
          setFlashSuccess(true);
          setTimeout(() => mounted.current && setFlashSuccess(false), 1400);
        }
      } catch {
        /* error surfaces through caller (toast/etc) */
      } finally {
        if (mounted.current) setAutoLoading(false);
      }
    }
  }

  const showSuccess = flashSuccess && !isLoading;

  return (
    <button
      ref={ref}
      type={type}
      onClick={handleClick}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={`inline-flex items-center justify-center font-semibold transition-all active:scale-[0.97] ${SIZE_CLS[size]} ${VARIANT_CLS[variant]} ${className}`}
      {...rest}
    >
      {isLoading ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{loadingLabel ?? children}</span>
        </>
      ) : showSuccess ? (
        <>
          <Check size={14} />
          <span>{successLabel}</span>
        </>
      ) : (
        <>
          {icon}
          <span>{children}</span>
          {iconRight}
        </>
      )}
    </button>
  );
});
