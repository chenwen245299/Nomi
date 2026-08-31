// Finance feature: a ledger you fill through a chat-style composer with text,
// payment screenshots, or both. A vision model reads pictures (or the OS text
// recogniser reads them first when the chosen model has no vision), proposes
// structured entries, and nothing reaches the ledger until the user confirms it.
//
// Everything persists under the data folder's `finance/` directory: one JSON
// file per month, plus the receipt images.

export { FinanceCollection, FinanceMainColumn } from "./FinanceSection";
export { useFinance, type FinanceData } from "./useFinance";
export type { ExpenseDraft, ExpenseRecord } from "./api";
