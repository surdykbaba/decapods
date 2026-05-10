import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const FALLBACK_CURRENCY = "NGN";

export const SUPPORTED_CURRENCIES: { code: string; label: string; symbol: string }[] = [
  { code: "NGN", label: "Nigerian Naira",      symbol: "₦" },
  { code: "USD", label: "US Dollar",           symbol: "$" },
  { code: "EUR", label: "Euro",                symbol: "€" },
  { code: "GBP", label: "British Pound",       symbol: "£" },
  { code: "ZAR", label: "South African Rand",  symbol: "R" },
  { code: "KES", label: "Kenyan Shilling",     symbol: "KSh" },
  { code: "GHS", label: "Ghanaian Cedi",       symbol: "GH₵" },
  { code: "XAF", label: "Central African Franc", symbol: "FCFA" },
];

export const CURRENCY_SYMBOLS: Record<string, string> = Object.fromEntries(
  SUPPORTED_CURRENCIES.map((c) => [c.code, c.symbol]),
);

let cachedDefault = FALLBACK_CURRENCY;

/** Read-once accessor used by non-React helpers. Set on app boot via setDefaultCurrency. */
export function getDefaultCurrency(): string {
  return cachedDefault;
}

export function setDefaultCurrency(ccy: string) {
  if (ccy) cachedDefault = ccy;
}

/** Live tenant default currency. Falls back to NGN until the request resolves. */
export function useDefaultCurrency(): string {
  const { data } = useQuery<{ default_currency: string }>({
    queryKey: ["settings-general"],
    queryFn: () => api("/api/v1/settings/general"),
    staleTime: 5 * 60_000,
  });
  if (data?.default_currency) setDefaultCurrency(data.default_currency);
  return data?.default_currency ?? cachedDefault;
}

export function symbolFor(ccy: string = getDefaultCurrency()): string {
  return CURRENCY_SYMBOLS[ccy] ?? ccy;
}

/**
 * Compact, human-friendly money formatter — ₦12.5k, ₦1.2M, ₦300.
 */
export function fmtMoney(n: number, ccy: string = getDefaultCurrency(), compact = true): string {
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
export function fmtMoneyFull(n: number, ccy: string = getDefaultCurrency()): string {
  const sym = symbolFor(ccy);
  if (n === 0 || n === undefined || n === null || isNaN(n)) return `${sym}0`;
  return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Backwards-compat shim — many callsites still import DEFAULT_CURRENCY. */
export const DEFAULT_CURRENCY = FALLBACK_CURRENCY;
