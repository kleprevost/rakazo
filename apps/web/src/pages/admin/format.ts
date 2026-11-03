import { formatBillingAmount } from "../../lib/billing";

export function formatWhen(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export function formatUsd(usd: number, locale: string): string {
  return formatBillingAmount(Math.round(usd * 100), "usd", locale);
}
