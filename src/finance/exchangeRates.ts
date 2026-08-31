import type { ExpenseRecord } from "./api";

const API_URL = "https://api.frankfurter.dev/v2/rates";
const CACHE_KEY = "nomi.finance.exchange-rates.v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const DISPLAY_CURRENCIES = ["SGD", "USD", "CNY"] as const;

interface FrankfurterRate {
  date: string;
  base: string;
  quote: string;
  rate: number;
}

export interface ExchangeRateSnapshot {
  base: "USD";
  date: string;
  rates: Record<string, number>;
  fetchedAt: number;
  stale: boolean;
}

export interface ConvertedRecords {
  records: ExpenseRecord[];
  missingCurrencies: string[];
}

export function normalizeCurrencyCode(currency: string): string {
  const code = currency.trim().toUpperCase();
  return code === "RMB" ? "CNY" : code;
}

function validCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

function requestedCurrencies(currencies: string[]): string[] {
  return [
    ...new Set(
      currencies
        .map(normalizeCurrencyCode)
        .filter((currency) => validCurrencyCode(currency) && currency !== "USD"),
    ),
  ].sort();
}

function readCache(): ExchangeRateSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ExchangeRateSnapshot;
    if (parsed.base !== "USD" || !parsed.rates || !Number.isFinite(parsed.fetchedAt)) {
      return null;
    }
    return { ...parsed, rates: { ...parsed.rates, USD: 1 } };
  } catch {
    return null;
  }
}

function writeCache(snapshot: ExchangeRateSnapshot) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ...snapshot, stale: false }));
  } catch {
    // Storage can be disabled; the current session can still use the fetched rates.
  }
}

function cacheCovers(snapshot: ExchangeRateSnapshot, currencies: string[]): boolean {
  return currencies.every(
    (currency) => currency === "USD" || Number.isFinite(snapshot.rates[currency]),
  );
}

/**
 * Latest daily reference rates with a short cache. Frankfurter publishes
 * central-bank/reference data, so this is intentionally presented as a
 * reference conversion rather than a live trading quote.
 */
export async function loadExchangeRates(currencies: string[]): Promise<ExchangeRateSnapshot> {
  const requested = requestedCurrencies(currencies);
  const cached = readCache();
  const now = Date.now();

  if (
    cached &&
    now - cached.fetchedAt < CACHE_TTL_MS &&
    cacheCovers(cached, ["USD", ...requested])
  ) {
    return { ...cached, stale: false };
  }

  if (requested.length === 0) {
    return {
      base: "USD",
      date: new Date().toISOString().slice(0, 10),
      rates: { USD: 1 },
      fetchedAt: now,
      stale: false,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(`${API_URL}?base=USD&quotes=${requested.join(",")}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`汇率服务返回 ${response.status}`);
    }
    const rows = (await response.json()) as FrankfurterRate[];
    const rates: Record<string, number> = { USD: 1 };
    let date = "";
    for (const row of rows) {
      const quote = normalizeCurrencyCode(row.quote);
      if (row.base === "USD" && validCurrencyCode(quote) && row.rate > 0) {
        rates[quote] = row.rate;
        if (row.date > date) {
          date = row.date;
        }
      }
    }
    const snapshot: ExchangeRateSnapshot = {
      base: "USD",
      date: date || new Date().toISOString().slice(0, 10),
      rates,
      fetchedAt: now,
      stale: false,
    };
    if (!cacheCovers(snapshot, ["USD", ...requested])) {
      throw new Error("汇率服务没有返回全部所需币种");
    }
    writeCache(snapshot);
    return snapshot;
  } catch (error) {
    if (cached && cacheCovers(cached, ["USD", ...requested])) {
      return { ...cached, stale: true };
    }
    throw error;
  }
}

/** Convert for presentation only; persisted ledger amounts remain untouched. */
export function convertRecords(
  records: ExpenseRecord[],
  targetCurrency: string,
  snapshot: ExchangeRateSnapshot | null,
): ConvertedRecords {
  const target = normalizeCurrencyCode(targetCurrency);
  const targetRate = target === "USD" ? 1 : snapshot?.rates[target];
  const missing = new Set<string>();
  const converted: ExpenseRecord[] = [];

  for (const record of records) {
    const source = normalizeCurrencyCode(record.currency);
    if (source === target) {
      converted.push({ ...record, currency: target });
      continue;
    }
    const sourceRate = source === "USD" ? 1 : snapshot?.rates[source];
    if (!targetRate || !sourceRate) {
      missing.add(source);
      continue;
    }
    converted.push({
      ...record,
      amount: record.amount * (targetRate / sourceRate),
      currency: target,
    });
  }

  return { records: converted, missingCurrencies: [...missing].sort() };
}
