// ── Dates and money ──────────────────────────────────────────────────────────
// Ledger dates are bare `YYYY-MM-DD` strings and months bare `YYYY-MM`, both in
// the user's local calendar. Everything here works on those strings, so no Date
// arithmetic can shift a day across a timezone or DST boundary.

/** `YYYY-MM-DD` for a local Date (never the UTC-shifted `toISOString`). */
export function dateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayKey(): string {
  return dateKey(new Date());
}

/** The `YYYY-MM` a date belongs to. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function thisMonth(): string {
  return monthOf(todayKey());
}

/** `YYYY-MM` shifted by whole months, staying in the local calendar. */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const shifted = new Date(year, index - 1 + delta, 1);
  return `${shifted.getFullYear()}-${`${shifted.getMonth() + 1}`.padStart(2, "0")}`;
}

/** "2026年8月" */
export function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return `${year}年${index}月`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "8月28日 周五", or "今天" / "昨天" when it is one of those. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "今天";
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year, month - 1, day);
  const [ty, tm, td] = today.split("-").map(Number);
  const delta = Math.round((value.getTime() - new Date(ty, tm - 1, td).getTime()) / 86_400_000);
  if (delta === -1) return "昨天";
  return `${month}月${day}日 ${WEEKDAYS[value.getDay()]}`;
}

const SYMBOLS: Record<string, string> = {
  CNY: "¥",
  RMB: "¥",
  JPY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  HKD: "HK$",
  TWD: "NT$",
  KRW: "₩",
  SGD: "S$",
};

/** "¥68.50" — grouped thousands, always two decimals. */
export function formatMoney(amount: number, currency: string): string {
  const symbol = SYMBOLS[currency.toUpperCase()];
  const digits = Math.abs(amount)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return symbol ? `${symbol}${digits}` : `${digits} ${currency}`;
}

/** The same, with the sign the direction implies: "-¥68.50" / "+¥12.00". */
export function formatSigned(amount: number, currency: string, direction: string): string {
  return `${direction === "income" ? "+" : "-"}${formatMoney(amount, currency)}`;
}
