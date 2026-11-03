import { formatBillingAmount } from "../../lib/billing";

export function formatWhen(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export function formatUsd(usd: number, locale: string): string {
  return formatBillingAmount(Math.round(usd * 100), "usd", locale);
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit] ?? "byte",
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}
