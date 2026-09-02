import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// ── Ledger data access ───────────────────────────────────────────────────────
// Real Tauri commands in the app; an in-memory stand-in (including a canned
// extraction) so `pnpm dev` renders and the whole capture flow can be exercised
// in a plain browser without a provider key.

/** One confirmed entry in the ledger. */
export interface ExpenseRecord {
  id: string;
  /** `YYYY-MM-DD` in the user's local calendar. */
  date: string;
  /** `HH:MM` (24-hour) transaction time, or "" when unknown. Distinguishes
   *  same-day, same-amount purchases at one merchant. */
  time: string;
  /** Always positive — `direction` carries the sign. */
  amount: number;
  direction: "expense" | "income";
  currency: string;
  category: string;
  merchant: string;
  method: string;
  note: string;
  /** Path of the receipt image relative to `finance/`, when it came from one. */
  receipt?: string | null;
  /** "vision" | "ocr" | "text" | "manual" */
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** What the model proposed, before anyone agreed to it. */
export interface ExpenseDraft {
  date: string;
  /** `HH:MM` (24-hour) or "" when unknown. */
  time: string;
  amount: number;
  direction: "expense" | "income";
  currency: string;
  category: string;
  merchant: string;
  method: string;
  note: string;
}

export interface DuplicateMatch {
  draftIndex: number;
  recordId: string;
  date: string;
  time: string;
  amount: number;
  direction: "expense" | "income";
  currency: string;
  merchant: string;
  category: string;
}

/** One turn of the capture conversation. */
export interface CaptureMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  receipt?: string | null;
  drafts: ExpenseDraft[];
  /** Ids of the records written from this message; empty until confirmed. */
  savedIds: string[];
  /** "vision" | "ocr" | "text" — how the input was read. */
  reader?: string | null;
  ocrText?: string | null;
  error?: string | null;
  createdAt: number;
}

export interface FinanceSettings {
  providerId: string | null;
  modelId: string | null;
  currency: string;
}

export interface FinanceStatus {
  settings: FinanceSettings;
  categories: string[];
  /** Whether the OCR fallback can run on this machine. */
  ocrAvailable: boolean;
  ocrEngine: string;
}

/** Partial edit of a record — only the keys present are changed. */
export interface RecordPatch {
  date?: string;
  time?: string;
  amount?: number;
  direction?: "expense" | "income";
  currency?: string;
  category?: string;
  merchant?: string;
  method?: string;
  note?: string;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Normalise a wall-clock time to `HH:MM`, or "" when absent/unparseable. */
export function normalizeTime(value: string | null | undefined): string {
  const match = (value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

// ── Browser-preview in-memory store ──────────────────────────────────────────
const PREVIEW_CATEGORIES = [
  "餐饮",
  "交通",
  "购物",
  "居住",
  "娱乐",
  "医疗",
  "教育",
  "人情",
  "通讯",
  "旅行",
  "其他",
];

const preview: {
  records: ExpenseRecord[];
  messages: CaptureMessage[];
  receipts: Map<string, string>;
  settings: FinanceSettings;
  seq: number;
} = {
  records: [],
  messages: [],
  receipts: new Map(),
  settings: { providerId: null, modelId: null, currency: "CNY" },
  seq: 1,
};

const previewId = (prefix: string) => `${prefix}-preview-${preview.seq++}`;

// ── Status + settings ────────────────────────────────────────────────────────

export async function financeStatus(): Promise<FinanceStatus> {
  if (isTauri()) {
    return invoke<FinanceStatus>("finance_status");
  }
  return {
    settings: preview.settings,
    categories: PREVIEW_CATEGORIES,
    ocrAvailable: true,
    ocrEngine: "浏览器预览",
  };
}

export async function setFinanceModel(
  providerId: string | null,
  modelId: string | null,
): Promise<FinanceSettings> {
  if (isTauri()) {
    return invoke<FinanceSettings>("finance_set_model", { providerId, modelId });
  }
  preview.settings = { ...preview.settings, providerId, modelId };
  return preview.settings;
}

// ── Records ──────────────────────────────────────────────────────────────────

export async function listMonths(): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("finance_list_months");
  }
  return [...new Set(preview.records.map((record) => record.date.slice(0, 7)))].sort().reverse();
}

export async function listRecords(month: string | null): Promise<ExpenseRecord[]> {
  if (isTauri()) {
    return invoke<ExpenseRecord[]>("finance_list_records", { month });
  }
  return preview.records
    .filter((record) => month === null || record.date.startsWith(month))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

/** Find likely duplicate drafts across every saved month. */
export async function findDuplicateRecords(
  drafts: ExpenseDraft[],
  excludeRecordId: string | null = null,
): Promise<DuplicateMatch[]> {
  if (isTauri()) {
    return invoke<DuplicateMatch[]>("finance_find_duplicates", { drafts, excludeRecordId });
  }
  const merchantKey = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  // Two known times on an otherwise-identical transaction mean two purchases; an
  // unknown time on either side never rules a match out (mirrors the Rust logic).
  const timesConflict = (a: string, b: string) => a !== "" && b !== "" && a !== b;
  return drafts.flatMap((draft, draftIndex) => {
    const merchant = merchantKey(draft.merchant);
    if (!merchant) {
      return [];
    }
    const draftTime = normalizeTime(draft.time);
    const record = preview.records.find(
      (candidate) =>
        candidate.id !== excludeRecordId &&
        candidate.date === draft.date.trim() &&
        !timesConflict(candidate.time ?? "", draftTime) &&
        Math.abs(candidate.amount - draft.amount) < 0.005 &&
        candidate.direction === draft.direction &&
        candidate.currency.toLocaleLowerCase() === draft.currency.trim().toLocaleLowerCase() &&
        merchantKey(candidate.merchant) === merchant,
    );
    return record
      ? [
          {
            draftIndex,
            recordId: record.id,
            date: record.date,
            time: record.time ?? "",
            amount: record.amount,
            direction: record.direction,
            currency: record.currency,
            merchant: record.merchant,
            category: record.category,
          },
        ]
      : [];
  });
}

export async function addRecord(draft: ExpenseDraft): Promise<ExpenseRecord> {
  if (isTauri()) {
    return invoke<ExpenseRecord>("finance_add_record", { draft });
  }
  const record: ExpenseRecord = {
    ...draft,
    id: previewId("exp"),
    receipt: null,
    source: "manual",
    createdAt: nowSec(),
    updatedAt: nowSec(),
  };
  preview.records.push(record);
  return record;
}

export async function updateRecord(id: string, patch: RecordPatch): Promise<ExpenseRecord> {
  if (isTauri()) {
    return invoke<ExpenseRecord>("finance_update_record", { id, patch });
  }
  const record = preview.records.find((item) => item.id === id);
  if (!record) {
    throw new Error("账目不存在。");
  }
  Object.assign(record, patch, { updatedAt: nowSec() });
  return { ...record };
}

export async function deleteRecord(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("finance_delete_record", { id });
    return;
  }
  preview.records = preview.records.filter((record) => record.id !== id);
}

// ── Capture conversation ─────────────────────────────────────────────────────

export async function listMessages(): Promise<CaptureMessage[]> {
  if (isTauri()) {
    return invoke<CaptureMessage[]>("finance_list_messages");
  }
  return [...preview.messages];
}

export async function clearMessages(): Promise<void> {
  if (isTauri()) {
    await invoke("finance_clear_messages");
    return;
  }
  preview.messages = [];
}

/**
 * Ask the model to read text, an optional receipt, or both. Resolves to the two
 * messages the chat should append — the user's, and the assistant's proposal.
 * A model failure arrives as an assistant message carrying `error`, not as a rejection.
 */
export async function captureInput(
  image: { dataBase64: string; mimeType: string } | null,
  note: string,
  today: string,
): Promise<CaptureMessage[]> {
  if (isTauri()) {
    return invoke<CaptureMessage[]>("finance_capture", {
      dataBase64: image?.dataBase64 ?? null,
      mimeType: image?.mimeType ?? null,
      note,
      today,
    });
  }
  const receipt = image ? `receipts/${today.slice(0, 7)}/${previewId("img")}.png` : null;
  if (image && receipt) {
    preview.receipts.set(receipt, `data:${image.mimeType};base64,${image.dataBase64}`);
  }
  const user: CaptureMessage = {
    id: previewId("msg"),
    role: "user",
    text: note,
    receipt,
    drafts: [],
    savedIds: [],
    createdAt: nowSec(),
  };
  // A canned proposal so the confirm-and-edit flow is testable in the browser.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const assistant: CaptureMessage = {
    id: previewId("msg"),
    role: "assistant",
    text: "识别到 1 笔支出（浏览器预览为示例数据）。",
    drafts: [
      {
        date: today,
        time: "09:12",
        amount: 68.5,
        direction: "expense",
        currency: "CNY",
        category: "餐饮",
        merchant: "瑞幸咖啡(中关村店)",
        method: "招商银行储蓄卡(1234)",
        note: "",
      },
    ],
    savedIds: [],
    reader: image ? "vision" : "text",
    createdAt: nowSec(),
  };
  preview.messages.push(user, assistant);
  return [user, assistant];
}

/**
 * The same flow for a picture dropped onto the window, which Tauri reports as a
 * filesystem path rather than bytes.
 */
export async function captureReceiptFile(
  path: string,
  note: string,
  today: string,
): Promise<CaptureMessage[]> {
  if (isTauri()) {
    return invoke<CaptureMessage[]>("finance_capture_file", { path, note, today });
  }
  throw new Error("浏览器预览不支持拖放文件。");
}

/** Write the drafts the user confirmed into the ledger. */
export async function confirmDrafts(
  messageId: string,
  drafts: ExpenseDraft[],
): Promise<ExpenseRecord[]> {
  if (isTauri()) {
    return invoke<ExpenseRecord[]>("finance_confirm_drafts", { messageId, drafts });
  }
  const message = preview.messages.find((item) => item.id === messageId);
  const messageIndex = preview.messages.findIndex((item) => item.id === messageId);
  const userMessage = messageIndex > 0 ? preview.messages[messageIndex - 1] : null;
  const receipt = userMessage?.role === "user" ? (userMessage.receipt ?? null) : null;
  const records = drafts.map((draft) => ({
    ...draft,
    id: previewId("exp"),
    receipt,
    source: message?.reader ?? "manual",
    createdAt: nowSec(),
    updatedAt: nowSec(),
  }));
  preview.records.push(...records);
  if (message) {
    message.drafts = drafts;
    message.savedIds = records.map((record) => record.id);
  }
  return records;
}

// ── Receipts ─────────────────────────────────────────────────────────────────

/** A stored receipt as a `data:` URL, for display in the chat and the dialog. */
export async function readReceipt(path: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("finance_read_receipt", { path });
  }
  return preview.receipts.get(path) ?? "";
}

/** Reveal the `finance/` data folder in the OS file manager. */
export async function revealFinanceData(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  await revealItemInDir(await invoke<string>("finance_reveal_path"));
}
