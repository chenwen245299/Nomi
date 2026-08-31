import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addRecord,
  captureInput,
  captureReceiptFile,
  clearMessages,
  confirmDrafts,
  deleteRecord,
  financeStatus,
  findDuplicateRecords,
  listMessages,
  listMonths,
  listRecords,
  setFinanceModel,
  updateRecord,
  type CaptureMessage,
  type DuplicateMatch,
  type ExpenseDraft,
  type ExpenseRecord,
  type FinanceStatus,
  type RecordPatch,
} from "./api";
import { monthOf, thisMonth } from "./format";

/**
 * Shared store for the finance section: the ledger, the capture conversation and
 * the model the reader uses.
 *
 * The capture call is the one slow thing here (a model round-trip on the input),
 * so `capturing` is exposed for the composer to disable itself, and a failed read
 * comes back as an assistant message carrying `error` rather than throwing — the
 * conversation is the log of what happened, successes and failures alike.
 */
export interface FinanceData {
  status: FinanceStatus | null;
  /** Selected `YYYY-MM`, or null for "every month". */
  month: string | null;
  months: string[];
  records: ExpenseRecord[];
  messages: CaptureMessage[];
  loading: boolean;
  capturing: boolean;
  error: string | null;
  selectMonth: (month: string | null) => void;
  refresh: () => Promise<void>;
  capture: (
    source: CaptureSource | null,
    note: string,
    today: string,
  ) => Promise<CaptureMessage | null>;
  findDuplicates: (
    drafts: ExpenseDraft[],
    excludeRecordId?: string | null,
  ) => Promise<DuplicateMatch[]>;
  confirm: (messageId: string, drafts: ExpenseDraft[]) => Promise<ExpenseRecord[] | null>;
  addManual: (draft: ExpenseDraft) => Promise<ExpenseRecord | null>;
  patchRecord: (id: string, patch: RecordPatch) => Promise<ExpenseRecord | null>;
  removeRecord: (id: string) => Promise<void>;
  clearChat: () => Promise<void>;
  chooseModel: (providerId: string, modelId: string) => Promise<void>;
  dismissError: () => void;
}

/**
 * Where an optional receipt came from. Pasting and the file picker hand over bytes; a
 * picture dropped on the window arrives as a path, because Tauri intercepts the
 * drop before the webview sees a `File`.
 */
export type CaptureSource =
  { kind: "data"; dataBase64: string; mimeType: string } | { kind: "path"; path: string };

export function useFinance(active: boolean): FinanceData {
  const [status, setStatus] = useState<FinanceStatus | null>(null);
  const [month, setMonth] = useState<string | null>(thisMonth);
  const [months, setMonths] = useState<string[]>([]);
  const [records, setRecords] = useState<ExpenseRecord[]>([]);
  const [messages, setMessages] = useState<CaptureMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const loadLedger = useCallback(async (target: string | null) => {
    const [nextMonths, nextRecords] = await Promise.all([listMonths(), listRecords(target)]);
    setMonths(nextMonths);
    setRecords(nextRecords);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextMessages] = await Promise.all([financeStatus(), listMessages()]);
      setStatus(nextStatus);
      setMessages(nextMessages);
      await loadLedger(month);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [loadLedger, month]);

  useEffect(() => {
    if (!active || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  const selectMonth = useCallback((next: string | null) => {
    setMonth(next);
    // The ledger for a month is a cheap read; fetch it rather than filtering a
    // stale "all months" list that may never have been loaded.
    void listRecords(next)
      .then(setRecords)
      .catch((err) => setError(String(err)));
  }, []);

  const capture = useCallback(async (source: CaptureSource | null, note: string, today: string) => {
    setCapturing(true);
    try {
      const appended =
        source?.kind === "path"
          ? await captureReceiptFile(source.path, note, today)
          : await captureInput(
              source?.kind === "data"
                ? { dataBase64: source.dataBase64, mimeType: source.mimeType }
                : null,
              note,
              today,
            );
      setMessages((previous) => [...previous, ...appended]);
      setError(null);
      return appended[appended.length - 1] ?? null;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setCapturing(false);
    }
  }, []);

  const confirm = useCallback(
    async (messageId: string, drafts: ExpenseDraft[]) => {
      try {
        const saved = await confirmDrafts(messageId, drafts);
        setMessages((previous) =>
          previous.map((message) =>
            message.id === messageId
              ? { ...message, drafts, savedIds: saved.map((record) => record.id) }
              : message,
          ),
        );
        // A saved record may land outside the month on screen; jump there so the
        // user can see what they just filed.
        const target = saved[0] ? monthOf(saved[0].date) : month;
        if (target !== month) {
          setMonth(target);
        }
        await loadLedger(target ?? null);
        setError(null);
        return saved;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [loadLedger, month],
  );

  const findDuplicates = useCallback(
    (drafts: ExpenseDraft[], excludeRecordId: string | null = null) =>
      findDuplicateRecords(drafts, excludeRecordId),
    [],
  );

  const addManual = useCallback(
    async (draft: ExpenseDraft) => {
      try {
        const record = await addRecord(draft);
        const target = monthOf(record.date);
        if (target !== month) {
          setMonth(target);
        }
        await loadLedger(target);
        setError(null);
        return record;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [loadLedger, month],
  );

  const patchRecord = useCallback(
    async (id: string, patch: RecordPatch) => {
      try {
        const updated = await updateRecord(id, patch);
        await loadLedger(month);
        setError(null);
        return updated;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [loadLedger, month],
  );

  const removeRecord = useCallback(
    async (id: string) => {
      try {
        await deleteRecord(id);
        await loadLedger(month);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    },
    [loadLedger, month],
  );

  const clearChat = useCallback(async () => {
    try {
      await clearMessages();
      setMessages([]);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const chooseModel = useCallback(async (providerId: string, modelId: string) => {
    try {
      const settings = await setFinanceModel(providerId, modelId);
      setStatus((previous) => (previous ? { ...previous, settings } : previous));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      status,
      month,
      months,
      records,
      messages,
      loading,
      capturing,
      error,
      selectMonth,
      refresh,
      capture,
      findDuplicates,
      confirm,
      addManual,
      patchRecord,
      removeRecord,
      clearChat,
      chooseModel,
      dismissError,
    }),
    [
      status,
      month,
      months,
      records,
      messages,
      loading,
      capturing,
      error,
      selectMonth,
      refresh,
      capture,
      findDuplicates,
      confirm,
      addManual,
      patchRecord,
      removeRecord,
      clearChat,
      chooseModel,
      dismissError,
    ],
  );
}
