import type { ExpenseRecord } from "./api";
import { DISPLAY_CURRENCIES, normalizeCurrencyCode } from "./exchangeRates";
import { dateKey } from "./format";

export type TrendRange = "day" | "week" | "month";

export interface TrendPoint {
  key: string;
  label: string;
  longLabel: string;
  value: number;
}

export interface RankedSpend {
  name: string;
  amount: number;
  share: number;
  count: number;
}

export interface CategorySpend extends RankedSpend {
  color: string;
}

export interface StatisticInsight {
  title: string;
  detail: string;
  tone: "accent" | "good" | "neutral" | "warning";
}

export interface FinanceStatistics {
  today: number;
  week: number;
  month: number;
  dailyAverage: number;
  tomorrowForecast: number;
  weekForecast: number;
  monthForecast: number;
  forecastConfidence: "高" | "中" | "低";
  monthChange: number | null;
  weekChange: number | null;
  transactionCount: number;
  monthTransactionCount: number;
  noSpendDays: number;
  trends: Record<TrendRange, TrendPoint[]>;
  categories: CategorySpend[];
  merchants: RankedSpend[];
  insights: StatisticInsight[];
}

const DAY_MS = 86_400_000;

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDays(value: string, amount: number): string {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

function addMonths(value: string, amount: number): string {
  const date = parseDate(`${value.slice(0, 7)}-01`);
  date.setMonth(date.getMonth() + amount);
  return dateKey(date).slice(0, 7);
}

function startOfWeek(value: string): string {
  const date = parseDate(value);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return dateKey(date);
}

function daysInMonth(value: string): number {
  const [year, month] = value.slice(0, 7).split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

function rangeDays(start: string, end: string): string[] {
  const count = Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / DAY_MS);
  if (count < 0) {
    return [];
  }
  return Array.from({ length: count + 1 }, (_, index) => addDays(start, index));
}

function percentageChange(current: number, previous: number): number | null {
  if (previous <= 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function amountBetween(records: ExpenseRecord[], start: string, end: string): number {
  return records.reduce(
    (sum, record) =>
      record.date >= start && record.date <= end && record.direction === "expense"
        ? sum + record.amount
        : sum,
    0,
  );
}

function countBetween(records: ExpenseRecord[], start: string, end: string): number {
  return records.filter(
    (record) => record.direction === "expense" && record.date >= start && record.date <= end,
  ).length;
}

function compactDate(value: string): string {
  const date = parseDate(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function chineseDate(value: string): string {
  const date = parseDate(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function trendSeries(records: ExpenseRecord[], today: string, range: TrendRange): TrendPoint[] {
  if (range === "day") {
    return rangeDays(addDays(today, -13), today).map((key) => ({
      key,
      label: compactDate(key),
      longLabel: chineseDate(key),
      value: amountBetween(records, key, key),
    }));
  }

  if (range === "week") {
    const currentStart = startOfWeek(today);
    return Array.from({ length: 10 }, (_, index) => {
      const start = addDays(currentStart, (index - 9) * 7);
      const end = addDays(start, 6);
      return {
        key: start,
        label: `${parseDate(start).getMonth() + 1}/${parseDate(start).getDate()}`,
        longLabel: `${chineseDate(start)}－${compactDate(end)}`,
        value: amountBetween(records, start, end),
      };
    });
  }

  const currentMonth = today.slice(0, 7);
  return Array.from({ length: 10 }, (_, index) => {
    const month = addMonths(`${currentMonth}-01`, index - 9);
    const [year, monthNumber] = month.split("-").map(Number);
    return {
      key: month,
      label: `${monthNumber}月`,
      longLabel: `${year}年${monthNumber}月`,
      value: records.reduce(
        (sum, record) =>
          record.direction === "expense" && record.date.startsWith(month)
            ? sum + record.amount
            : sum,
        0,
      ),
    };
  });
}

function expectedForDate(day: string, today: string, dailyTotals: Map<string, number>): number {
  const weekday = parseDate(day).getDay();
  const sameWeekdays = rangeDays(addDays(today, -56), addDays(today, -1))
    .filter((candidate) => parseDate(candidate).getDay() === weekday)
    .map((candidate) => dailyTotals.get(candidate) ?? 0);
  const recent = rangeDays(addDays(today, -13), today).map(
    (candidate) => dailyTotals.get(candidate) ?? 0,
  );
  const weekdayAverage =
    sameWeekdays.reduce((sum, amount) => sum + amount, 0) / Math.max(1, sameWeekdays.length);
  const recentAverage = recent.reduce((sum, amount) => sum + amount, 0) / recent.length;
  return weekdayAverage * 0.6 + recentAverage * 0.4;
}

function ranked(
  records: ExpenseRecord[],
  pickName: (record: ExpenseRecord) => string,
): RankedSpend[] {
  const totals = new Map<string, { amount: number; count: number }>();
  for (const record of records) {
    const name = pickName(record).trim() || "未命名";
    const current = totals.get(name) ?? { amount: 0, count: 0 };
    current.amount += record.amount;
    current.count += 1;
    totals.set(name, current);
  }
  const overall = [...totals.values()].reduce((sum, item) => sum + item.amount, 0);
  return [...totals.entries()]
    .map(([name, item]) => ({
      name,
      amount: item.amount,
      count: item.count,
      share: overall > 0 ? item.amount / overall : 0,
    }))
    .sort((left, right) => right.amount - left.amount);
}

export function availableCurrencies(records: ExpenseRecord[], preferred: string): string[] {
  const currencies = [
    ...new Set(
      records
        .filter((record) => record.direction === "expense")
        .map((record) => normalizeCurrencyCode(record.currency))
        .filter(Boolean),
    ),
  ];
  const preferredCode = normalizeCurrencyCode(preferred);
  const ordered = currencies.includes(preferredCode)
    ? [preferredCode, ...currencies.filter((code) => code !== preferredCode)]
    : currencies.length > 0
      ? currencies
      : [preferredCode];
  return [...new Set([...ordered, ...DISPLAY_CURRENCIES])];
}

export function buildFinanceStatistics(
  allRecords: ExpenseRecord[],
  currency: string,
  today: string,
  categoryColor: (category: string) => string,
): FinanceStatistics {
  const records = allRecords.filter(
    (record) =>
      record.direction === "expense" &&
      record.date <= today &&
      record.currency.toUpperCase() === currency.toUpperCase(),
  );
  const dailyTotals = new Map<string, number>();
  for (const record of records) {
    dailyTotals.set(record.date, (dailyTotals.get(record.date) ?? 0) + record.amount);
  }

  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${`${daysInMonth(month)}`.padStart(2, "0")}`;
  const previousMonth = addMonths(`${month}-01`, -1);
  const dayOfMonth = Number(today.slice(8, 10));
  const previousMonthComparableEnd = `${previousMonth}-${`${Math.min(
    dayOfMonth,
    daysInMonth(previousMonth),
  )}`.padStart(2, "0")}`;

  const todaySpend = dailyTotals.get(today) ?? 0;
  const weekSpend = amountBetween(records, weekStart, today);
  const monthSpend = amountBetween(records, monthStart, today);
  const recent30 = rangeDays(addDays(today, -29), today);
  const recent30Spend = recent30.reduce(
    (sum, candidate) => sum + (dailyTotals.get(candidate) ?? 0),
    0,
  );
  const dailyAverage = recent30Spend / recent30.length;
  const tomorrowForecast = expectedForDate(addDays(today, 1), today, dailyTotals);
  const weekForecast =
    weekSpend +
    rangeDays(addDays(today, 1), weekEnd).reduce(
      (sum, candidate) => sum + expectedForDate(candidate, today, dailyTotals),
      0,
    );
  const monthForecast =
    monthSpend +
    rangeDays(addDays(today, 1), monthEnd).reduce(
      (sum, candidate) => sum + expectedForDate(candidate, today, dailyTotals),
      0,
    );

  const previousWeekStart = addDays(weekStart, -7);
  const previousWeekComparableEnd = addDays(previousWeekStart, (parseDate(today).getDay() + 6) % 7);
  const previousWeekSpend = amountBetween(records, previousWeekStart, previousWeekComparableEnd);
  const previousMonthSpend = amountBetween(
    records,
    `${previousMonth}-01`,
    previousMonthComparableEnd,
  );

  const monthRecords = records.filter(
    (record) => record.date >= monthStart && record.date <= today,
  );
  const categories = ranked(monthRecords, (record) => record.category).map((item) => ({
    ...item,
    color: categoryColor(item.name),
  }));
  const merchants = ranked(monthRecords, (record) => record.merchant || record.category);

  const activeHistoryDays = rangeDays(addDays(today, -55), today).filter(
    (candidate) => (dailyTotals.get(candidate) ?? 0) > 0,
  ).length;
  const forecastConfidence = activeHistoryDays >= 20 ? "高" : activeHistoryDays >= 8 ? "中" : "低";
  const noSpendDays = recent30.filter((candidate) => !(dailyTotals.get(candidate) ?? 0)).length;
  const highestDay = recent30
    .map((candidate) => ({ day: candidate, amount: dailyTotals.get(candidate) ?? 0 }))
    .sort((left, right) => right.amount - left.amount)[0];
  const largestRecord = [...records]
    .filter((record) => record.date >= addDays(today, -29) && record.date <= today)
    .sort((left, right) => right.amount - left.amount)[0];
  const topMerchant = merchants[0];
  const monthChange = percentageChange(monthSpend, previousMonthSpend);
  const weekChange = percentageChange(weekSpend, previousWeekSpend);

  const insights: StatisticInsight[] = [];
  if (monthChange === null) {
    insights.push({
      title: "本月基线正在建立",
      detail:
        monthSpend > 0 ? "上月同期没有足够记录，继续记账后环比会更准确。" : "本月还没有支出记录。",
      tone: "neutral",
    });
  } else {
    insights.push({
      title: `本月同期${monthChange <= 0 ? "少花" : "多花"} ${Math.abs(monthChange).toFixed(0)}%`,
      detail: "按本月已过去的天数，与上月相同天数比较。",
      tone: monthChange <= 0 ? "good" : "warning",
    });
  }
  if (highestDay?.amount) {
    insights.push({
      title: `近30天消费高峰在 ${compactDate(highestDay.day)}`,
      detail: `当天共发生 ${countBetween(records, highestDay.day, highestDay.day)} 笔支出。`,
      tone: "accent",
    });
  }
  if (topMerchant) {
    insights.push({
      title: `${topMerchant.name} 是本月第一大商家`,
      detail: `占本月支出的 ${(topMerchant.share * 100).toFixed(0)}%，共 ${topMerchant.count} 笔。`,
      tone: topMerchant.share >= 0.5 ? "warning" : "neutral",
    });
  }
  if (largestRecord) {
    insights.push({
      title: `近30天最大单笔来自 ${largestRecord.merchant || largestRecord.category}`,
      detail: `${compactDate(largestRecord.date)} · ${largestRecord.category}`,
      tone: "neutral",
    });
  }
  insights.push({
    title: `近30天有 ${noSpendDays} 天零消费`,
    detail:
      noSpendDays >= 8
        ? "无消费日保持得不错。"
        : "如果想控预算，可以先从每周安排一个无消费日开始。",
    tone: noSpendDays >= 8 ? "good" : "neutral",
  });

  return {
    today: todaySpend,
    week: weekSpend,
    month: monthSpend,
    dailyAverage,
    tomorrowForecast,
    weekForecast,
    monthForecast,
    forecastConfidence,
    monthChange,
    weekChange,
    transactionCount: records.length,
    monthTransactionCount: monthRecords.length,
    noSpendDays,
    trends: {
      day: trendSeries(records, today, "day"),
      week: trendSeries(records, today, "week"),
      month: trendSeries(records, today, "month"),
    },
    categories,
    merchants,
    insights,
  };
}
