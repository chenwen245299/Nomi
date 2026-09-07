import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
  type ViewStyle,
} from "react-native";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiAttachment2,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiBarChart2Line,
  RiBillLine,
  RiCheckDoubleLine,
  RiCloseLine,
  RiEraserLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiRefreshLine,
  RiScanLine,
  RiSendPlane2Fill,
  RiSparklingLine,
} from "@remixicon/react";
import { AttachmentPreviewModal } from "../AttachmentPreviewModal";
import { ConversationModelPicker } from "../chat/ModelPicker";
import type { Provider } from "../providers/api";
import type { ProvidersController } from "../providers/useProviders";
import { motion, SHELL_HEADER_HEIGHT, useTheme, type Accent, type Theme } from "../theme";
import {
  readReceipt,
  revealFinanceData,
  listRecords,
  type CaptureMessage,
  type ExpenseDraft,
  type ExpenseRecord,
} from "./api";
import { categoryStyle, EXPENSE_COLOR, INCOME_COLOR } from "./categories";
import {
  dayLabel,
  formatMoney,
  formatSigned,
  monthLabel,
  shiftMonth,
  thisMonth,
  todayKey,
} from "./format";
import { RecordDialog } from "./RecordDialog";
import { StatisticsView } from "./StatisticsView";
import type { FinanceData } from "./useFinance";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const localDateTime24 = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatCaptureTimestamp(seconds: number): string {
  return localDateTime24.format(new Date(seconds * 1000));
}

/** Receipts are read on demand and kept for the session — the same picture shows
 *  up in the chat, in the confirm dialog and behind several records. */
const receiptCache = new Map<string, string>();

function useReceiptUrl(path: string | null | undefined): string | null {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    if (!path || receiptCache.has(path)) {
      return;
    }
    let cancelled = false;
    void readReceipt(path)
      .then((data) => {
        if (!cancelled && data) {
          receiptCache.set(path, data);
          redraw();
        }
      })
      .catch(() => {
        /* a missing receipt just renders without a picture */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return path ? (receiptCache.get(path) ?? null) : null;
}

/** The record fields, as the shape the dialog edits. */
function toDraft(record: ExpenseRecord): ExpenseDraft {
  return {
    date: record.date,
    time: record.time ?? "",
    amount: record.amount,
    direction: record.direction,
    currency: record.currency,
    category: record.category,
    merchant: record.merchant,
    method: record.method,
    note: record.note,
  };
}

function blankDraft(currency: string): ExpenseDraft {
  return {
    date: todayKey(),
    time: "",
    amount: 0,
    direction: "expense",
    currency,
    category: "餐饮",
    merchant: "",
    method: "",
    note: "",
  };
}

// ── Styles ───────────────────────────────────────────────────────────────────
function makeFinanceStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Collection column
    collectionBody: { flex: 1, minHeight: 0 },
    monthBar: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 8,
      paddingTop: 10,
    },
    monthButton: {
      alignItems: "center",
      borderRadius: 8,
      flex: 1,
      height: 30,
      justifyContent: "center",
    },
    monthButtonHover: { backgroundColor: t.controlHover },
    monthLabel: { color: t.textPrimary, fontSize: 13, fontWeight: "600" },
    monthArrow: {
      alignItems: "center",
      borderRadius: 7,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    monthArrowHover: { backgroundColor: t.controlHover },
    totals: {
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      gap: 4,
      paddingBottom: 10,
      paddingHorizontal: 12,
      paddingTop: 8,
    },
    totalRow: { alignItems: "baseline", flexDirection: "row", gap: 6 },
    totalLabel: { color: t.textTertiary, fontSize: 11 },
    totalAmount: { fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },
    totalSpacer: { flex: 1 },
    list: { paddingBottom: 14 },
    dayHeader: {
      alignItems: "baseline",
      backgroundColor: t.collectionSolid,
      flexDirection: "row",
      gap: 6,
      paddingBottom: 3,
      paddingHorizontal: 12,
      paddingTop: 12,
    },
    dayLabel: { color: t.textSecondary, flex: 1, fontSize: 11.5, fontWeight: "700" },
    dayTotal: { color: t.textTertiary, fontSize: 11 },
    recordRow: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 9,
      marginHorizontal: 6,
      minHeight: 44,
      paddingHorizontal: 6,
      paddingVertical: 5,
    },
    recordRowHover: { backgroundColor: t.controlHover },
    categoryBadge: {
      alignItems: "center",
      borderRadius: 999,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    recordBody: { flex: 1, minWidth: 0 },
    recordTitle: { color: t.textPrimary, fontSize: 12.5, fontWeight: "500" },
    recordMeta: { color: t.textTertiary, fontSize: 10.5, marginTop: 2 },
    recordAmount: { fontSize: 12.5, fontWeight: "700", letterSpacing: -0.2 },
    empty: { alignItems: "center", gap: 6, paddingHorizontal: 20, paddingVertical: 40 },
    emptyText: { color: t.textTertiary, fontSize: 12, lineHeight: 18, textAlign: "center" },
    collectionFooter: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    footerButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      flexDirection: "row",
      gap: 5,
      height: 30,
      justifyContent: "center",
    },
    footerButtonHover: { backgroundColor: t.controlHover },
    footerButtonText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    iconButton: {
      alignItems: "center",
      borderRadius: 7,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    iconButtonHover: { backgroundColor: t.controlHover },

    // Main column
    mainInner: { flex: 1, minHeight: 0 },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "space-between",
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 20,
    },
    title: { color: t.textPrimary, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
    viewSwitch: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 9,
      flexDirection: "row",
      padding: 2,
    },
    viewButton: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 5,
      height: 28,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    viewButtonActive: { backgroundColor: t.cardSurface, boxShadow: t.e1Solid },
    viewButtonHover: { backgroundColor: t.controlHover },
    viewButtonText: { color: t.textTertiary, fontSize: 11.5, fontWeight: "600" },
    viewButtonTextActive: { color: t.textPrimary },
    headerControls: { alignItems: "center", flexDirection: "row", gap: 8 },
    errorBanner: {
      alignItems: "center",
      backgroundColor: "rgba(178,77,77,0.10)",
      borderColor: "rgba(178,77,77,0.24)",
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      marginHorizontal: 20,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    errorBannerText: { color: t.errorText, flex: 1, fontSize: 12, lineHeight: 17 },

    // Conversation
    chatScroll: { flex: 1, minHeight: 0 },
    chatContent: { paddingBottom: 20, paddingHorizontal: 20, paddingTop: 16 },
    chatInner: { alignSelf: "center", gap: 14, maxWidth: 680, width: "100%" },
    turn: { gap: 6 },
    turnUser: { alignItems: "flex-end" },
    bubble: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      maxWidth: "86%",
      overflow: "hidden",
    },
    bubbleUser: { backgroundColor: accent.selectedFill, borderColor: "transparent" },
    bubbleNote: {
      color: t.textPrimary,
      fontSize: 13,
      lineHeight: 19,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    bubbleBody: { gap: 10, padding: 12 },
    assistantText: { color: t.textPrimary, fontSize: 13, lineHeight: 20 },
    readerRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    readerChip: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 6,
      flexDirection: "row",
      gap: 4,
      height: 20,
      paddingHorizontal: 7,
    },
    readerChipText: { color: t.textSecondary, fontSize: 10.5, fontWeight: "600" },
    draftCard: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 10,
      flexDirection: "row",
      gap: 9,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    draftBody: { flex: 1, minWidth: 0 },
    draftTitle: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    draftMeta: { color: t.textTertiary, fontSize: 10.5, marginTop: 2 },
    draftAmount: { fontSize: 13, fontWeight: "700" },
    actionRow: { alignItems: "center", flexDirection: "row", gap: 8 },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 5,
      height: 32,
      justifyContent: "center",
      paddingHorizontal: 13,
    },
    primaryButtonText: { color: t.onAccent, fontSize: 12.5, fontWeight: "600" },
    ghostButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      height: 30,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    ghostButtonHover: { backgroundColor: t.controlHover },
    ghostButtonText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    savedChip: {
      alignItems: "center",
      backgroundColor: t.statusGreenFill,
      borderColor: t.statusGreenBorder,
      borderRadius: 7,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      height: 26,
      paddingHorizontal: 9,
    },
    savedChipText: { color: t.statusGreenText, fontSize: 11.5, fontWeight: "600" },
    failure: {
      backgroundColor: "rgba(178,77,77,0.08)",
      borderColor: "rgba(178,77,77,0.22)",
    },
    failureText: { color: t.errorText, fontSize: 12.5, lineHeight: 19 },
    ocrText: {
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 8,
      color: t.textSecondary,
      fontSize: 11,
      lineHeight: 17,
      padding: 9,
    },
    timestamp: { color: t.textTertiary, fontSize: 10 },

    // Composer
    composer: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    composerInner: { alignSelf: "center", gap: 9, maxWidth: 680, width: "100%" },
    stagedPreviewRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stagedImage: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      height: 68,
      overflow: "hidden",
      position: "relative",
      width: 84,
    },
    stagedImageFallback: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      flex: 1,
      justifyContent: "center",
    },
    stagedImageRemove: {
      alignItems: "center",
      backgroundColor: "rgba(20,28,40,0.72)",
      borderRadius: 999,
      height: 20,
      justifyContent: "center",
      position: "absolute",
      right: 4,
      top: 4,
      width: 20,
      zIndex: 2,
    },
    stagedImageName: {
      backgroundColor: "rgba(20,28,40,0.66)",
      bottom: 0,
      color: "#FFFFFF",
      fontSize: 9.5,
      left: 0,
      paddingHorizontal: 5,
      paddingVertical: 3,
      position: "absolute",
      right: 0,
      textAlign: "center",
    },
    inputWrap: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      padding: 8,
    },
    inputWrapFocused: {
      borderColor: t.separatorStrong,
      boxShadow: "0 0 0 1px rgba(60,70,85,0.04)",
    },
    inputWrapDragging: {
      backgroundColor: accent.iconBadge,
      borderColor: accent.accent,
    },
    composerInput: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      lineHeight: 20,
      maxHeight: 160,
      minHeight: 40,
      paddingHorizontal: 6,
      paddingVertical: 6,
    },
    composerControls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 2,
      marginTop: 4,
    },
    composerIconButton: {
      alignItems: "center",
      borderRadius: 7,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    composerIconButtonHover: { backgroundColor: t.controlHover },
    composerControlDisabled: { opacity: 0.36 },
    composerControlsSpacer: { flex: 1 },
    composerSendButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 7,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    composerSendButtonDisabled: { opacity: 0.45 },
  });
}

type FinanceStyles = ReturnType<typeof makeFinanceStyles>;

// ── Collection column: the ledger ────────────────────────────────────────────
export function FinanceCollection({ accent, finance }: { accent: Accent; finance: FinanceData }) {
  const theme = useTheme();
  const styles = useMemo(() => makeFinanceStyles(theme, accent), [theme, accent]);
  const today = todayKey();
  const [editing, setEditing] = useState<ExpenseRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const editingReceipt = useReceiptUrl(editing?.receipt ?? null);
  const currency = finance.status?.settings.currency ?? "CNY";
  const categories = finance.status?.categories ?? [];

  /** Sums stay per currency — adding ¥ to $ would be a lie. */
  const totals = useMemo(() => {
    const map = new Map<string, { expense: number; income: number }>();
    for (const record of finance.records) {
      const entry = map.get(record.currency) ?? { expense: 0, income: 0 };
      entry[record.direction === "income" ? "income" : "expense"] += record.amount;
      map.set(record.currency, entry);
    }
    return [...map.entries()];
  }, [finance.records]);

  const days = useMemo(() => {
    const map = new Map<string, ExpenseRecord[]>();
    for (const record of finance.records) {
      map.set(record.date, [...(map.get(record.date) ?? []), record]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [finance.records]);

  return (
    <View style={styles.collectionBody}>
      <View style={styles.monthBar}>
        <Pressable
          accessibilityLabel="上一个月"
          accessibilityRole="button"
          disabled={finance.month === null}
          onPress={() => finance.selectMonth(shiftMonth(finance.month ?? thisMonth(), -1))}
          style={({ hovered }: PressState) => [
            styles.monthArrow,
            motion,
            hovered && styles.monthArrowHover,
            finance.month === null && ({ opacity: 0.3 } as ViewStyle),
          ]}
        >
          <RiArrowLeftSLine color={theme.t.textSecondary} size={18} />
        </Pressable>
        <Pressable
          accessibilityLabel="切换月份或查看全部"
          accessibilityRole="button"
          onPress={() => finance.selectMonth(finance.month === null ? thisMonth() : null)}
          style={({ hovered }: PressState) => [
            styles.monthButton,
            motion,
            hovered && styles.monthButtonHover,
          ]}
        >
          <Text style={styles.monthLabel}>
            {finance.month === null ? "全部账目" : monthLabel(finance.month)}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="下一个月"
          accessibilityRole="button"
          disabled={finance.month === null}
          onPress={() => finance.selectMonth(shiftMonth(finance.month ?? thisMonth(), 1))}
          style={({ hovered }: PressState) => [
            styles.monthArrow,
            motion,
            hovered && styles.monthArrowHover,
            finance.month === null && ({ opacity: 0.3 } as ViewStyle),
          ]}
        >
          <RiArrowRightSLine color={theme.t.textSecondary} size={18} />
        </Pressable>
      </View>

      <View style={styles.totals}>
        {totals.length === 0 ? (
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>支出</Text>
            <Text style={[styles.totalAmount, { color: theme.t.textTertiary } as ViewStyle]}>
              {formatMoney(0, currency)}
            </Text>
          </View>
        ) : (
          totals.map(([code, sums]) => (
            <View key={code} style={styles.totalRow}>
              <Text style={styles.totalLabel}>支出</Text>
              <Text style={[styles.totalAmount, { color: EXPENSE_COLOR } as ViewStyle]}>
                {formatMoney(sums.expense, code)}
              </Text>
              <View style={styles.totalSpacer} />
              {sums.income > 0 ? (
                <>
                  <Text style={styles.totalLabel}>收入</Text>
                  <Text style={[styles.totalAmount, { color: INCOME_COLOR } as ViewStyle]}>
                    {formatMoney(sums.income, code)}
                  </Text>
                </>
              ) : null}
            </View>
          ))
        )}
      </View>

      <ScrollView contentContainerStyle={styles.list} style={{ flex: 1 } as ViewStyle}>
        {days.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {finance.loading
                ? "正在读取账目..."
                : "这个月还没有记录。\n把支付截图发到右侧，或手动记一笔。"}
            </Text>
          </View>
        ) : (
          days.map(([date, records]) => (
            <View key={date}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayLabel}>{dayLabel(date, today)}</Text>
                <Text style={styles.dayTotal}>
                  {formatMoney(
                    records
                      .filter((record) => record.direction !== "income")
                      .reduce((sum, record) => sum + record.amount, 0),
                    records[0].currency,
                  )}
                </Text>
              </View>
              {records.map((record) => (
                <RecordRow
                  key={record.id}
                  onPress={() => setEditing(record)}
                  record={record}
                  styles={styles}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      <View style={styles.collectionFooter}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setAdding(true)}
          style={({ hovered }: PressState) => [
            styles.footerButton,
            motion,
            hovered && styles.footerButtonHover,
          ]}
        >
          <RiAddLine color={accent.accentText} size={15} />
          <Text style={styles.footerButtonText}>手动记一笔</Text>
        </Pressable>
        {isTauriRuntime() ? (
          <Pressable
            accessibilityLabel="在访达中显示账本数据"
            accessibilityRole="button"
            onPress={() => void revealFinanceData()}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              motion,
              hovered && styles.iconButtonHover,
            ]}
          >
            <RiExternalLinkLine color={theme.t.textTertiary} size={15} />
          </Pressable>
        ) : null}
      </View>

      {editing ? (
        <RecordDialog
          accent={accent}
          categories={categories}
          checkDuplicates={finance.findDuplicates}
          duplicateExcludeRecordId={editing.id}
          initial={[toDraft(editing)]}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            const id = editing.id;
            setEditing(null);
            void finance.removeRecord(id);
          }}
          onSubmit={(drafts) => {
            const id = editing.id;
            setEditing(null);
            void finance.patchRecord(id, drafts[0]);
          }}
          receiptUrl={editingReceipt}
          subtitle={editing.source === "manual" ? "手动记录" : "由票据识别，可随时修改"}
          title="编辑账目"
        />
      ) : null}

      {adding ? (
        <RecordDialog
          accent={accent}
          categories={categories}
          checkDuplicates={finance.findDuplicates}
          initial={[blankDraft(currency)]}
          onCancel={() => setAdding(false)}
          onSubmit={(drafts) => {
            setAdding(false);
            void finance.addManual(drafts[0]);
          }}
          receiptUrl={null}
          title="手动记一笔"
        />
      ) : null}
    </View>
  );
}

function RecordRow({
  onPress,
  record,
  styles,
}: {
  onPress: () => void;
  record: ExpenseRecord;
  styles: FinanceStyles;
}) {
  const meta = categoryStyle(record.category);
  const income = record.direction === "income";
  const detail = [record.time, record.category, record.method].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityLabel={`编辑 ${record.merchant || record.category}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.recordRow,
        motion,
        hovered && styles.recordRowHover,
      ]}
    >
      <View style={[styles.categoryBadge, { backgroundColor: `${meta.color}22` } as ViewStyle]}>
        <meta.icon color={meta.color} size={15} />
      </View>
      <View style={styles.recordBody}>
        <Text numberOfLines={1} style={styles.recordTitle}>
          {record.merchant || record.category}
        </Text>
        <Text numberOfLines={1} style={styles.recordMeta}>
          {detail}
        </Text>
      </View>
      <Text
        style={[styles.recordAmount, { color: income ? INCOME_COLOR : EXPENSE_COLOR } as ViewStyle]}
      >
        {formatSigned(record.amount, record.currency, record.direction)}
      </Text>
    </Pressable>
  );
}

// ── Main column: the capture conversation ────────────────────────────────────

/** Which provider/model will actually read the next receipt. */
function effectiveModel(
  providers: Provider[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
) {
  const pinned =
    providerId && modelId ? providers.find((provider) => provider.id === providerId) : undefined;
  if (pinned) {
    const model = pinned.models.find((item) => item.id === modelId);
    if (model) {
      return { providerId: pinned.id, modelId: model.id, model };
    }
  }
  // Nothing pinned (or the pinned model is gone) — follow the starred default,
  // the same rule the backend applies.
  for (const provider of providers.filter((item) => item.enabled)) {
    const model = provider.models.find((item) => item.starred);
    if (model) {
      return { providerId: provider.id, modelId: model.id, model };
    }
  }
  return null;
}

type Staged =
  | {
      kind: "data";
      key: string;
      dataBase64: string;
      mimeType: string;
      previewUrl: string;
      name: string;
    }
  | { kind: "path"; key: string; path: string; name: string };

const MAX_BATCH_IMAGES = 10;

function stagedKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function FinanceMainColumn({
  accent,
  finance,
  providers,
}: {
  accent: Accent;
  finance: FinanceData;
  providers: ProvidersController;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeFinanceStyles(theme, accent), [theme, accent]);
  const [view, setView] = useState<"capture" | "statistics">("capture");
  const [confirmationQueue, setConfirmationQueue] = useState<CaptureMessage[]>([]);
  const [statisticsRecords, setStatisticsRecords] = useState<ExpenseRecord[]>([]);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const confirming = confirmationQueue[0] ?? null;

  const refreshStatistics = useCallback(async () => {
    setStatisticsLoading(true);
    try {
      setStatisticsRecords(await listRecords(null));
      setStatisticsError(null);
    } catch (error) {
      setStatisticsError(String(error));
    } finally {
      setStatisticsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "statistics") {
      return;
    }
    let cancelled = false;
    void listRecords(null)
      .then((records) => {
        if (!cancelled) {
          setStatisticsRecords(records);
          setStatisticsError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatisticsError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatisticsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [finance.records, view]);

  const enqueueConfirmation = useCallback((message: CaptureMessage) => {
    setConfirmationQueue((current) =>
      current.some((item) => item.id === message.id) ? current : [...current, message],
    );
  }, []);

  const finishConfirmation = useCallback((messageId: string) => {
    setConfirmationQueue((current) =>
      current[0]?.id === messageId
        ? current.slice(1)
        : current.filter((message) => message.id !== messageId),
    );
  }, []);

  const settings = finance.status?.settings;
  const active = useMemo(
    () => effectiveModel(providers.providers, settings?.providerId, settings?.modelId),
    [providers.providers, settings?.providerId, settings?.modelId],
  );
  // Follow the conversation as it grows.
  useEffect(() => {
    const timer = window.setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    return () => window.clearTimeout(timer);
  }, [finance.messages.length, finance.capturing]);

  const clearChat = async () => {
    const ok = isTauriRuntime()
      ? await tauriConfirm("清空后对话记录会消失，已记的账目不受影响。", {
          title: "清空对话",
          kind: "warning",
        })
      : window.confirm("清空后对话记录会消失，已记的账目不受影响。");
    if (ok) {
      await finance.clearChat();
      setConfirmationQueue([]);
    }
  };

  /** The receipt behind an assistant message is on its immediately preceding user turn. */
  const receiptFor = (message: CaptureMessage): string | null => {
    const index = finance.messages.findIndex((item) => item.id === message.id);
    const userMessage = index > 0 ? finance.messages[index - 1] : null;
    return userMessage?.role === "user" ? (userMessage.receipt ?? null) : null;
  };
  const visibleError = finance.error ?? statisticsError;

  return (
    <View style={styles.mainInner}>
      <View style={styles.header}>
        <View style={styles.viewSwitch}>
          <Pressable
            accessibilityLabel="打开记账"
            accessibilityRole="button"
            onPress={() => setView("capture")}
            style={({ hovered }: PressState) => [
              styles.viewButton,
              motion,
              view === "capture" && styles.viewButtonActive,
              hovered && view !== "capture" && styles.viewButtonHover,
            ]}
          >
            <RiBillLine
              color={view === "capture" ? accent.accentText : theme.t.textTertiary}
              size={13}
            />
            <Text
              style={[styles.viewButtonText, view === "capture" && styles.viewButtonTextActive]}
            >
              记账
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="打开消费统计"
            accessibilityRole="button"
            onPress={() => {
              if (view !== "statistics") {
                setStatisticsLoading(true);
              }
              setView("statistics");
            }}
            style={({ hovered }: PressState) => [
              styles.viewButton,
              motion,
              view === "statistics" && styles.viewButtonActive,
              hovered && view !== "statistics" && styles.viewButtonHover,
            ]}
          >
            <RiBarChart2Line
              color={view === "statistics" ? accent.accentText : theme.t.textTertiary}
              size={13}
            />
            <Text
              style={[styles.viewButtonText, view === "statistics" && styles.viewButtonTextActive]}
            >
              统计
            </Text>
          </Pressable>
        </View>
        <View style={styles.headerControls}>
          {view === "statistics" ? (
            <Pressable
              accessibilityLabel="刷新统计"
              accessibilityRole="button"
              disabled={statisticsLoading}
              onPress={() => void refreshStatistics()}
              style={({ hovered }: PressState) => [
                styles.iconButton,
                motion,
                hovered && styles.iconButtonHover,
                statisticsLoading && ({ opacity: 0.45 } as ViewStyle),
              ]}
            >
              <RiRefreshLine color={theme.t.textTertiary} size={16} />
            </Pressable>
          ) : finance.messages.length > 0 ? (
            <div title="清空对话">
              <Pressable
                accessibilityLabel="清空对话"
                accessibilityRole="button"
                onPress={() => void clearChat()}
                style={({ hovered }: PressState) => [
                  styles.iconButton,
                  motion,
                  hovered && styles.iconButtonHover,
                ]}
              >
                <RiEraserLine color={theme.t.textTertiary} size={16} />
              </Pressable>
            </div>
          ) : null}
          {view === "capture" ? (
            <ConversationModelPicker
              accent={accent}
              accessibilityLabel="选择识别账单的模型"
              menuTitle="选择识别账单的模型"
              modelId={active?.modelId ?? null}
              onBalance={providers.balance}
              onSelect={(providerId, modelId) => finance.chooseModel(providerId, modelId)}
              providerId={active?.providerId ?? null}
              providers={providers.providers}
            />
          ) : null}
        </View>
      </View>

      {visibleError ? (
        <View style={styles.errorBanner}>
          <RiErrorWarningLine color={theme.t.errorText} size={15} />
          <Text style={styles.errorBannerText}>{visibleError}</Text>
          <Pressable
            accessibilityLabel="忽略"
            accessibilityRole="button"
            onPress={() => {
              if (finance.error) {
                finance.dismissError();
              } else {
                setStatisticsError(null);
              }
            }}
          >
            <RiCloseLine color={theme.t.errorText} size={14} />
          </Pressable>
        </View>
      ) : null}

      {view === "statistics" ? (
        <StatisticsView
          accent={accent}
          loading={statisticsLoading}
          preferredCurrency={finance.status?.settings.currency ?? "CNY"}
          records={statisticsRecords}
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.chatContent}
            ref={scrollRef}
            style={styles.chatScroll}
          >
            <View style={styles.chatInner}>
              {finance.messages.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>
                    输入一笔消费，或把支付成功的截图粘贴、拖到下面，模型会读出金额、商家和分类，
                    {"\n"}确认之后才会记进账本。
                  </Text>
                </View>
              ) : (
                finance.messages.map((message) =>
                  message.role === "user" ? (
                    <UserTurn key={message.id} message={message} styles={styles} />
                  ) : (
                    <AssistantTurn
                      key={message.id}
                      message={message}
                      onConfirm={() => enqueueConfirmation(message)}
                      styles={styles}
                    />
                  ),
                )
              )}
              {finance.capturing ? (
                <View style={styles.turn}>
                  <View style={[styles.bubble, { alignSelf: "flex-start" } as ViewStyle]}>
                    <View style={styles.bubbleBody}>
                      <View style={styles.readerRow}>
                        <ActivityIndicator color={accent.accentText} size="small" />
                        <Text style={styles.assistantText}>正在识别这张票据...</Text>
                      </View>
                    </View>
                  </View>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <Composer
            accent={accent}
            finance={finance}
            hasModel={Boolean(active)}
            onRecognized={enqueueConfirmation}
            styles={styles}
          />

          {confirming ? (
            <ConfirmDialog
              accent={accent}
              categories={finance.status?.categories ?? []}
              checkDuplicates={finance.findDuplicates}
              key={confirming.id}
              message={confirming}
              onClose={() => finishConfirmation(confirming.id)}
              onSubmit={async (drafts) => {
                const id = confirming.id;
                const saved = await finance.confirm(id, drafts);
                if (saved) {
                  finishConfirmation(id);
                }
              }}
              receipt={receiptFor(confirming)}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

/** Thin wrapper so the receipt is loaded only while the dialog is open. */
function ConfirmDialog({
  accent,
  categories,
  checkDuplicates,
  message,
  onClose,
  onSubmit,
  receipt,
}: {
  accent: Accent;
  categories: string[];
  checkDuplicates: FinanceData["findDuplicates"];
  message: CaptureMessage;
  onClose: () => void;
  onSubmit: (drafts: ExpenseDraft[]) => Promise<void>;
  receipt: string | null;
}) {
  const receiptUrl = useReceiptUrl(receipt);
  const [busy, setBusy] = useState(false);
  return (
    <RecordDialog
      accent={accent}
      busy={busy}
      categories={categories}
      checkDuplicates={checkDuplicates}
      initial={message.drafts}
      onCancel={onClose}
      onSubmit={(drafts) => {
        setBusy(true);
        void onSubmit(drafts).finally(() => setBusy(false));
      }}
      receiptUrl={receiptUrl}
      subtitle={
        message.savedIds.length > 0
          ? "这笔已经记过了，保存会再记一次"
          : "核对无误后保存，模型的识别结果可以随意修改"
      }
      title={message.savedIds.length > 0 ? "重新确认" : "确认记账"}
    />
  );
}

function UserTurn({ message, styles }: { message: CaptureMessage; styles: FinanceStyles }) {
  const url = useReceiptUrl(message.receipt);
  const [previewing, setPreviewing] = useState(false);
  return (
    <View style={[styles.turn, styles.turnUser]}>
      <View style={[styles.bubble, styles.bubbleUser]}>
        {url ? (
          <button
            aria-label="预览票据图片"
            onClick={() => setPreviewing(true)}
            style={{
              background: "transparent",
              border: 0,
              cursor: "zoom-in",
              display: "block",
              padding: 0,
            }}
            type="button"
          >
            <img
              alt="票据"
              src={url}
              style={{
                display: "block",
                maxHeight: 260,
                maxWidth: "100%",
                objectFit: "contain",
              }}
            />
          </button>
        ) : null}
        {message.text ? <Text style={styles.bubbleNote}>{message.text}</Text> : null}
      </View>
      <Text style={styles.timestamp}>{formatCaptureTimestamp(message.createdAt)}</Text>
      {previewing && url ? (
        <AttachmentPreviewModal
          kind="image"
          name="票据"
          onClose={() => setPreviewing(false)}
          url={url}
        />
      ) : null}
    </View>
  );
}

function AssistantTurn({
  message,
  onConfirm,
  styles,
}: {
  message: CaptureMessage;
  onConfirm: () => void;
  styles: FinanceStyles;
}) {
  const theme = useTheme();
  const [showOcr, setShowOcr] = useState(false);
  const saved = message.savedIds.length > 0;

  if (message.error) {
    return (
      <View style={styles.turn}>
        <View style={[styles.bubble, styles.failure]}>
          <View style={styles.bubbleBody}>
            <View style={styles.readerRow}>
              <RiErrorWarningLine color={theme.t.errorText} size={15} />
              <Text style={styles.failureText}>{message.error}</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.turn}>
      <View style={styles.bubble}>
        <View style={styles.bubbleBody}>
          {message.text ? <Text style={styles.assistantText}>{message.text}</Text> : null}

          <View style={styles.readerRow}>
            {message.reader ? (
              <View style={styles.readerChip}>
                {message.reader === "ocr" ? (
                  <RiScanLine color={theme.t.textSecondary} size={11} />
                ) : message.reader === "vision" ? (
                  <RiEyeLine color={theme.t.textSecondary} size={11} />
                ) : (
                  <RiSparklingLine color={theme.t.textSecondary} size={11} />
                )}
                <Text style={styles.readerChipText}>
                  {message.reader === "ocr"
                    ? "文字识别 + 模型"
                    : message.reader === "vision"
                      ? "视觉模型"
                      : "文字输入 + 模型"}
                </Text>
              </View>
            ) : null}
            {message.ocrText ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowOcr((value) => !value)}
                style={({ hovered }: PressState) => [
                  styles.ghostButton,
                  motion,
                  { height: 22, paddingHorizontal: 7 } as ViewStyle,
                  hovered && styles.ghostButtonHover,
                ]}
              >
                <Text style={[styles.ghostButtonText, { fontSize: 11 } as ViewStyle]}>
                  {showOcr ? "收起识别文本" : "查看识别文本"}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {showOcr && message.ocrText ? (
            <Text selectable style={styles.ocrText}>
              {message.ocrText}
            </Text>
          ) : null}

          {message.drafts.map((draft, index) => (
            <View key={index} style={styles.draftCard}>
              <View
                style={[
                  styles.categoryBadge,
                  { backgroundColor: `${categoryStyle(draft.category).color}22` } as ViewStyle,
                ]}
              >
                {(() => {
                  const Icon = categoryStyle(draft.category).icon;
                  return <Icon color={categoryStyle(draft.category).color} size={15} />;
                })()}
              </View>
              <View style={styles.draftBody}>
                <Text numberOfLines={1} style={styles.draftTitle}>
                  {draft.merchant || draft.category}
                </Text>
                <Text numberOfLines={1} style={styles.draftMeta}>
                  {[draft.date, draft.category, draft.method].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Text
                style={[
                  styles.draftAmount,
                  {
                    color: draft.direction === "income" ? INCOME_COLOR : EXPENSE_COLOR,
                  } as ViewStyle,
                ]}
              >
                {formatSigned(draft.amount, draft.currency, draft.direction)}
              </Text>
            </View>
          ))}

          {message.drafts.length > 0 ? (
            <View style={styles.actionRow}>
              {saved ? (
                <>
                  <View style={styles.savedChip}>
                    <RiCheckDoubleLine color={theme.t.statusGreenText} size={13} />
                    <Text style={styles.savedChipText}>已记 {message.savedIds.length} 笔</Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    onPress={onConfirm}
                    style={({ hovered }: PressState) => [
                      styles.ghostButton,
                      motion,
                      hovered && styles.ghostButtonHover,
                    ]}
                  >
                    <Text style={styles.ghostButtonText}>重新确认</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={onConfirm}
                  style={({ hovered, pressed }: PressState) => [
                    styles.primaryButton,
                    motion,
                    hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
                    pressed && ({ opacity: 0.92 } as ViewStyle),
                  ]}
                >
                  <RiSparklingLine color={theme.t.onAccent} size={14} />
                  <Text style={styles.primaryButtonText}>
                    确认记账（{message.drafts.length} 笔）
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </View>
      </View>
      <Text style={styles.timestamp}>{formatCaptureTimestamp(message.createdAt)}</Text>
    </View>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────
function Composer({
  accent,
  finance,
  hasModel,
  onRecognized,
  styles,
}: {
  accent: Accent;
  finance: FinanceData;
  hasModel: boolean;
  onRecognized: (message: CaptureMessage) => void;
  styles: FinanceStyles;
}) {
  const theme = useTheme();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const submitRef = useRef<() => void>(() => undefined);
  const stageFilesRef = useRef<(files: File[]) => void>(() => undefined);

  const canSend = hasModel && !finance.capturing && (text.trim().length > 0 || staged.length > 0);

  const stageFiles = useCallback((files: File[]) => {
    const reads = files.map((file) => {
      const extension = file.name.toLowerCase().split(".").pop();
      const mimeType = file.type
        ? file.type.toLowerCase()
        : extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : extension === "png"
            ? "image/png"
            : "";
      if (!/^image\/(png|jpe?g)$/i.test(mimeType)) {
        return Promise.resolve<Staged | null>(null);
      }
      return new Promise<Staged | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== "string") {
            resolve(null);
            return;
          }
          const comma = reader.result.indexOf(",");
          resolve({
            kind: "data",
            key: stagedKey(),
            dataBase64: reader.result.slice(comma + 1),
            mimeType,
            previewUrl: reader.result,
            name: file.name || "截图",
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    });
    void Promise.all(reads).then((results) => {
      const images = results.filter((item): item is Staged => item !== null);
      setStaged((current) => [...current, ...images].slice(0, MAX_BATCH_IMAGES));
    });
  }, []);

  const send = () => {
    if (!canSend) {
      return;
    }
    const batch: Array<Staged | null> = staged.length > 0 ? staged : [null];
    const note = text;
    const today = todayKey();
    setStaged([]);
    setText("");
    void (async () => {
      for (const item of batch) {
        const source = item
          ? item.kind === "data"
            ? ({ kind: "data", dataBase64: item.dataBase64, mimeType: item.mimeType } as const)
            : ({ kind: "path", path: item.path } as const)
          : null;
        const message = await finance.capture(source, note, today);
        if (
          message &&
          !message.error &&
          message.drafts.length > 0 &&
          message.savedIds.length === 0
        ) {
          onRecognized(message);
        }
      }
    })();
  };

  useEffect(() => {
    submitRef.current = send;
    stageFilesRef.current = stageFiles;
  });

  // Match chat's composer: Enter sends, Shift+Enter adds a line, and pasted
  // images become a removable preview without inserting a filename into text.
  useEffect(() => {
    const input = document.getElementById("nomi-finance-composer");
    if (!(input instanceof HTMLTextAreaElement)) {
      return;
    }
    const startComposing = () => {
      composingRef.current = true;
    };
    const stopComposing = () => {
      composingRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (composingRef.current || event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey || event.metaKey) return;
      event.preventDefault();
      submitRef.current();
    };
    const onPaste = (event: ClipboardEvent) => {
      const itemFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const listedFiles = Array.from(event.clipboardData?.files ?? []);
      const images = [...itemFiles, ...listedFiles]
        .filter((file) => {
          const extension = file.name.toLowerCase().split(".").pop();
          return (
            /^image\/(png|jpe?g)$/i.test(file.type) ||
            (!file.type && ["png", "jpg", "jpeg"].includes(extension ?? ""))
          );
        })
        .filter(
          (file, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.name === file.name &&
                candidate.size === file.size &&
                candidate.lastModified === file.lastModified,
            ) === index,
        );
      if (images.length === 0) {
        return;
      }
      event.preventDefault();
      stageFilesRef.current(images);
    };

    input.addEventListener("compositionstart", startComposing);
    input.addEventListener("compositionend", stopComposing);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("paste", onPaste);
    return () => {
      input.removeEventListener("compositionstart", startComposing);
      input.removeEventListener("compositionend", stopComposing);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("paste", onPaste);
    };
  }, []);

  // Tauri intercepts window drops before the webview sees them, so the file
  // arrives as a path rather than a `File`. Keep every supported path in the
  // same capped batch, then send the pictures to the model one at a time.
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "leave") {
          setDragging(false);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = event.payload.paths
            .filter((item) => /\.(png|jpe?g)$/i.test(item))
            .map((path) => ({
              kind: "path" as const,
              key: stagedKey(),
              path,
              name: path.split(/[\\/]/).pop() ?? path,
            }));
          if (paths.length > 0) {
            setStaged((current) => [...current, ...paths].slice(0, MAX_BATCH_IMAGES));
          }
        }
      })
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {
        /* drag-drop is a convenience; paste and the picker still work */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <View style={styles.composer}>
      <View style={styles.composerInner}>
        <input
          accept="image/png,image/jpeg"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) {
              stageFiles(files);
            }
            event.target.value = "";
          }}
          ref={fileInput}
          style={{ display: "none" }}
          type="file"
        />

        {staged.length > 0 ? (
          <View style={styles.stagedPreviewRow}>
            {staged.map((item) => (
              <View key={item.key} style={styles.stagedImage}>
                {item.kind === "data" ? (
                  <img
                    alt={item.name}
                    src={item.previewUrl}
                    style={{
                      display: "block",
                      height: "100%",
                      objectFit: "cover",
                      width: "100%",
                    }}
                  />
                ) : (
                  <View style={styles.stagedImageFallback}>
                    <RiAttachment2 color={accent.accentText} size={20} />
                  </View>
                )}
                <Pressable
                  accessibilityLabel="移除图片"
                  accessibilityRole="button"
                  onPress={() =>
                    setStaged((current) => current.filter((image) => image.key !== item.key))
                  }
                  style={styles.stagedImageRemove}
                >
                  <RiCloseLine color="#FFFFFF" size={13} />
                </Pressable>
                <Text numberOfLines={1} style={styles.stagedImageName}>
                  {item.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View
          style={[
            styles.inputWrap,
            inputFocused && styles.inputWrapFocused,
            dragging && styles.inputWrapDragging,
          ]}
        >
          <TextInput
            multiline
            nativeID="nomi-finance-composer"
            onBlur={() => setInputFocused(false)}
            onChangeText={setText}
            onFocus={() => setInputFocused(true)}
            placeholder={hasModel ? "输入一笔消费，或粘贴支付截图…" : "先在右上角选择模型…"}
            placeholderTextColor={theme.t.textTertiary}
            style={styles.composerInput}
            textAlignVertical="top"
            value={text}
          />
          <View style={styles.composerControls}>
            <div title="添加图片">
              <Pressable
                accessibilityLabel="添加图片"
                accessibilityRole="button"
                disabled={finance.capturing}
                onPress={() => fileInput.current?.click()}
                style={({ hovered, pressed }: PressState) => [
                  styles.composerIconButton,
                  motion,
                  finance.capturing && styles.composerControlDisabled,
                  (hovered || pressed) && !finance.capturing && styles.composerIconButtonHover,
                ]}
              >
                <RiAttachment2 color={theme.t.textSecondary} size={18} />
              </Pressable>
            </div>
            <View style={styles.composerControlsSpacer} />
            <Pressable
              accessibilityLabel="发送并识别账目"
              accessibilityRole="button"
              disabled={!canSend}
              onPress={send}
              style={({ pressed }: PressState) => [
                styles.composerSendButton,
                motion,
                !canSend && styles.composerSendButtonDisabled,
                pressed && canSend && ({ opacity: 0.9 } as ViewStyle),
              ]}
            >
              {finance.capturing ? (
                <ActivityIndicator color={theme.t.onAccent} size="small" />
              ) : (
                <RiSendPlane2Fill color={theme.t.onAccent} size={15} />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
