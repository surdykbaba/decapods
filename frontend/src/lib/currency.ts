// Tenant default currency — Naira for D'Accubin.
export const DEFAULT_CURRENCY = "NGN";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  NGN: "₦",
  ZAR: "R",
  KES: "KSh",
  GHS: "GH₵",
  XAF: "FCFA",
};

export function symbolFor(ccy: string = DEFAULT_CURRENCY): string {
  return CURRENCY_SYMBOLS[ccy] ?? ccy;
}

/**
 * Compact, human-friendly money formatter — ₦12.5k, ₦1.2M, ₦300.
 */
export function fmtMoney(n: number, ccy: string = DEFAULT_CURRENCY, compact = true): string {
  const sym = symbolFor(ccy);
  if (n === 0 || n === undefined || n === null || isNaN(n)) return `${sym}0`;
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1_000_000_000) return `${sym}${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
    if (abs >= 1_000_000)     return `${sym}${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (abs >= 1_000)         return `${sym}${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Long form — ₦12,500.00 — for tables and detail rows.
 */
export function fmtMoneyFull(n: number, ccy: string = DEFAULT_CURRENCY): string {
  const sym = symbolFor(ccy);
  if (n === 0 || n === undefined || n === null || isNaN(n)) return `${sym}0`;
  return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
