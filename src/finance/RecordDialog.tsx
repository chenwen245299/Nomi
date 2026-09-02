import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { createPortal } from "react-dom";
import { RiCloseLine, RiDeleteBinLine, RiErrorWarningLine } from "@remixicon/react";
import { AttachmentPreviewModal } from "../AttachmentPreviewModal";
import {
  enterFade,
  enterModal,
  glass,
  modalShadow,
  motion,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { categoryStyle, EXPENSE_COLOR, INCOME_COLOR } from "./categories";
import type { DuplicateMatch, ExpenseDraft } from "./api";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

/**
 * The gate between "the model read a screenshot" and "this is in my ledger".
 *
 * The same dialog does both jobs it needs to: confirming a batch the model
 * proposed (several rows, each with a checkbox so a wrong one can be dropped)
 * and editing a single record that is already saved. Every field is editable in
 * both — the model's answer is a starting point, never the last word.
 */
export function RecordDialog({
  accent,
  busy,
  categories,
  checkDuplicates,
  duplicateExcludeRecordId,
  initial,
  onCancel,
  onDelete,
  onSubmit,
  receiptUrl,
  subtitle,
  title,
}: {
  accent: Accent;
  busy?: boolean;
  categories: string[];
  checkDuplicates?: (
    drafts: ExpenseDraft[],
    excludeRecordId?: string | null,
  ) => Promise<DuplicateMatch[]>;
  duplicateExcludeRecordId?: string | null;
  initial: ExpenseDraft[];
  onCancel: () => void;
  /** Present when editing a saved record. */
  onDelete?: () => void;
  onSubmit: (drafts: ExpenseDraft[]) => void;
  receiptUrl: string | null;
  subtitle?: string;
  title: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const initialRef = useRef(initial);
  const [rows, setRows] = useState(() => initial.map((draft) => ({ draft, include: true })));
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(Boolean(checkDuplicates));
  const [duplicateApprovalKey, setDuplicateApprovalKey] = useState<string | null>(null);
  const [previewingReceipt, setPreviewingReceipt] = useState(false);
  const multiple = rows.length > 1;

  useEffect(() => {
    if (!checkDuplicates) {
      return;
    }
    let cancelled = false;
    void checkDuplicates(initialRef.current, duplicateExcludeRecordId)
      .then((matches) => {
        if (!cancelled) setDuplicates(matches);
      })
      .catch(() => {
        if (!cancelled) setError("暂时无法检查重复记录，请稍后重试。");
      })
      .finally(() => {
        if (!cancelled) setCheckingDuplicates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [checkDuplicates, duplicateExcludeRecordId]);

  const resetDuplicateApproval = () => {
    setDuplicates([]);
    setDuplicateApprovalKey(null);
    setError(null);
  };

  const patch = (index: number, change: Partial<ExpenseDraft>) => {
    resetDuplicateApproval();
    setRows((previous) =>
      previous.map((row, at) =>
        at === index ? { ...row, draft: { ...row.draft, ...change } } : row,
      ),
    );
  };

  const toggleInclude = (index: number) => {
    resetDuplicateApproval();
    setRows((previous) =>
      previous.map((item, at) => (at === index ? { ...item, include: !item.include } : item)),
    );
  };

  const chosen = rows.filter((row) => row.include).map((row) => row.draft);
  const chosenKey = JSON.stringify(chosen);

  const submit = () => {
    if (chosen.length === 0) {
      setError("至少要选择一笔。");
      return;
    }
    const invalid = chosen.find(
      (draft) => !(draft.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date),
    );
    if (invalid) {
      setError("每一笔都需要大于 0 的金额和 YYYY-MM-DD 格式的日期。");
      return;
    }
    if (!checkDuplicates) {
      setError(null);
      onSubmit(chosen);
      return;
    }

    setCheckingDuplicates(true);
    void checkDuplicates(chosen, duplicateExcludeRecordId)
      .then((matches) => {
        setDuplicates(matches);
        if (matches.length > 0 && duplicateApprovalKey !== chosenKey) {
          setDuplicateApprovalKey(chosenKey);
          setError("这条记录已经有了；如果仍要重复记账，请再次点击保存。");
          return;
        }
        setError(null);
        onSubmit(chosen);
      })
      .catch(() => setError("暂时无法检查重复记录，请稍后重试。"))
      .finally(() => setCheckingDuplicates(false));
  };

  return createPortal(
    <View style={[styles.scrim, glass(8, 115), enterFade()]}>
      {/* Clicking the backdrop dismisses; the card swallows the press. */}
      <Pressable accessibilityLabel="关闭" onPress={onCancel} style={styles.scrimHit} />
      <View style={[styles.card, glass(40, 180), enterModal()]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          <Pressable
            accessibilityLabel="关闭"
            accessibilityRole="button"
            onPress={onCancel}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              motion,
              hovered && styles.iconButtonHover,
            ]}
          >
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} style={styles.bodyScroll}>
          {receiptUrl ? (
            <button
              aria-label="预览票据图片"
              onClick={() => setPreviewingReceipt(true)}
              style={{
                background: theme.t.cardSurfaceAlt,
                border: `1px solid ${theme.t.separator}`,
                borderRadius: 10,
                cursor: "zoom-in",
                display: "block",
                marginBottom: 14,
                overflow: "hidden",
                padding: 0,
                width: "100%",
              }}
              type="button"
            >
              <img
                alt="票据"
                src={receiptUrl}
                style={{ display: "block", maxHeight: 180, objectFit: "contain", width: "100%" }}
              />
            </button>
          ) : null}

          {rows.map((row, index) => (
            <RecordFields
              accent={accent}
              categories={categories}
              draft={row.draft}
              include={row.include}
              key={index}
              onChange={(change) => patch(index, change)}
              onToggleInclude={multiple ? () => toggleInclude(index) : undefined}
              styles={styles}
              theme={theme}
            />
          ))}

          {duplicates.length > 0 ? (
            <View style={styles.duplicateWarning}>
              <RiErrorWarningLine color={theme.t.errorText} size={16} />
              <View style={styles.duplicateWarningBody}>
                <Text style={styles.duplicateWarningTitle}>
                  {duplicates.length === 1
                    ? "这条记录已经有了"
                    : `其中 ${duplicates.length} 条记录已经有了`}
                </Text>
                {duplicates.slice(0, 3).map((match) => (
                  <Text
                    key={`${match.recordId}-${match.draftIndex}`}
                    style={styles.duplicateWarningDetail}
                  >
                    {[
                      [match.date, match.time].filter(Boolean).join(" "),
                      match.merchant || match.category,
                      `${match.currency} ${match.amount.toFixed(2)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.footer}>
          {onDelete ? (
            <Pressable
              accessibilityRole="button"
              onPress={onDelete}
              style={({ hovered }: PressState) => [
                styles.dangerButton,
                motion,
                hovered && styles.dangerButtonHover,
              ]}
            >
              <RiDeleteBinLine color={theme.t.errorText} size={15} />
              <Text style={styles.dangerButtonText}>删除</Text>
            </Pressable>
          ) : null}
          <View style={styles.footerSpacer} />
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={({ hovered }: PressState) => [
              styles.secondaryButton,
              motion,
              hovered && styles.secondaryButtonHover,
            ]}
          >
            <Text style={styles.secondaryButtonText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || checkingDuplicates}
            onPress={submit}
            style={({ hovered, pressed }: PressState) => [
              styles.primaryButton,
              motion,
              hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
              pressed && ({ opacity: 0.92 } as ViewStyle),
              (busy || checkingDuplicates) && ({ opacity: 0.6 } as ViewStyle),
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {checkingDuplicates
                ? "正在检查…"
                : duplicates.length > 0 && duplicateApprovalKey === chosenKey
                  ? "仍然保存"
                  : multiple
                    ? `保存 ${chosen.length} 笔`
                    : "保存"}
            </Text>
          </Pressable>
        </View>
      </View>
      {previewingReceipt && receiptUrl ? (
        <AttachmentPreviewModal
          kind="image"
          name="票据"
          onClose={() => setPreviewingReceipt(false)}
          url={receiptUrl}
        />
      ) : null}
    </View>,
    document.body,
  );
}

function RecordFields({
  accent,
  categories,
  draft,
  include,
  onChange,
  onToggleInclude,
  styles,
  theme,
}: {
  accent: Accent;
  categories: string[];
  draft: ExpenseDraft;
  include: boolean;
  onChange: (change: Partial<ExpenseDraft>) => void;
  /** Present only when several rows are being confirmed at once. */
  onToggleInclude?: () => void;
  styles: DialogStyles;
  theme: Theme;
}) {
  const money = draft.direction === "income" ? INCOME_COLOR : EXPENSE_COLOR;
  // Native inputs for date and amount: a real calendar popover and real numeric
  // stepping beat anything re-implemented on top of a text field.
  const nativeInput: React.CSSProperties = {
    background: theme.t.cardSurface,
    border: `1px solid ${theme.t.controlBorder}`,
    borderRadius: 8,
    color: theme.t.textPrimary,
    fontFamily: "inherit",
    fontSize: 13,
    outline: "none",
    padding: "7px 9px",
    width: "100%",
  };

  return (
    <View style={[styles.row, !include && styles.rowExcluded]}>
      <View style={styles.rowHeader}>
        {onToggleInclude ? (
          <Pressable
            accessibilityLabel={include ? "不记这一笔" : "记这一笔"}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: include }}
            onPress={onToggleInclude}
            style={({ hovered }: PressState) => [
              styles.checkbox,
              motion,
              {
                backgroundColor: include
                  ? accent.accent
                  : hovered
                    ? accent.iconBadge
                    : "transparent",
                borderColor: include ? accent.accent : theme.t.controlBorder,
              } as ViewStyle,
            ]}
          >
            {include ? <Text style={styles.checkboxMark}>✓</Text> : null}
          </Pressable>
        ) : null}

        <View style={styles.segment}>
          {(["expense", "income"] as const).map((direction) => {
            const active = draft.direction === direction;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={direction}
                onPress={() => onChange({ direction })}
                style={({ hovered }: PressState) => [
                  styles.segmentButton,
                  motion,
                  active && styles.segmentButtonActive,
                  !active && hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    {
                      color: active
                        ? direction === "income"
                          ? INCOME_COLOR
                          : EXPENSE_COLOR
                        : theme.t.textTertiary,
                    } as ViewStyle,
                  ]}
                >
                  {direction === "income" ? "收入" : "支出"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.amountWrap}>
          <input
            aria-label="金额"
            min="0"
            onChange={(event) => onChange({ amount: Number(event.target.value) })}
            step="0.01"
            style={{
              ...nativeInput,
              color: money,
              fontSize: 17,
              fontWeight: 600,
              textAlign: "right",
            }}
            type="number"
            value={Number.isFinite(draft.amount) ? draft.amount : 0}
          />
        </View>
        <TextInput
          accessibilityLabel="币种"
          onChangeText={(currency) => onChange({ currency: currency.toUpperCase() })}
          style={styles.currencyInput}
          value={draft.currency}
        />
      </View>

      <View style={styles.fieldGrid}>
        <View style={styles.field}>
          <Text style={styles.label}>日期</Text>
          <input
            aria-label="日期"
            onChange={(event) => onChange({ date: event.target.value })}
            style={nativeInput}
            type="date"
            value={draft.date}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>时间（可留空）</Text>
          <input
            aria-label="时间"
            onChange={(event) => onChange({ time: event.target.value })}
            style={nativeInput}
            type="time"
            value={draft.time ?? ""}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>商家</Text>
          <TextInput
            accessibilityLabel="商家"
            onChangeText={(merchant) => onChange({ merchant })}
            placeholder="例如 瑞幸咖啡"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.input}
            value={draft.merchant}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>支付方式</Text>
          <TextInput
            accessibilityLabel="支付方式"
            onChangeText={(method) => onChange({ method })}
            placeholder="例如 微信零钱"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.input}
            value={draft.method}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>备注</Text>
          <TextInput
            accessibilityLabel="备注"
            onChangeText={(note) => onChange({ note })}
            placeholder="可留空"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.input}
            value={draft.note}
          />
        </View>
      </View>

      <Text style={styles.label}>分类</Text>
      <View style={styles.categoryWrap}>
        {categories.map((category) => {
          const meta = categoryStyle(category);
          const active = draft.category === category;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              key={category}
              onPress={() => onChange({ category })}
              style={({ hovered }: PressState) => [
                styles.categoryChip,
                motion,
                {
                  backgroundColor: active
                    ? meta.color
                    : hovered
                      ? theme.t.controlHover
                      : theme.t.controlIdle,
                  borderColor: active ? meta.color : theme.t.controlBorder,
                } as ViewStyle,
              ]}
            >
              <meta.icon color={active ? "#FFFFFF" : meta.color} size={13} />
              <Text
                style={[
                  styles.categoryChipText,
                  { color: active ? "#FFFFFF" : theme.t.textSecondary } as ViewStyle,
                ]}
              >
                {category}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

type DialogStyles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Portalled to <body>, which is sized to the window, so an absolute inset-0
    // box covers the whole app (RN-Web's ViewStyle has no `fixed`).
    scrim: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 24,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 2400,
    },
    scrimHit: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    card: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 18,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      maxHeight: "86%",
      maxWidth: 560,
      overflow: "hidden",
      width: "100%",
    },
    header: {
      alignItems: "flex-start",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 18,
      paddingVertical: 14,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { color: t.textPrimary, fontSize: 15.5, fontWeight: "700", letterSpacing: -0.2 },
    subtitle: { color: t.textTertiary, fontSize: 12, lineHeight: 17, marginTop: 3 },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    iconButtonHover: { backgroundColor: t.controlHover },
    bodyScroll: { flexGrow: 0, minHeight: 0 },
    body: { gap: 12, padding: 18 },
    row: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      gap: 10,
      padding: 12,
    },
    rowExcluded: { opacity: 0.45 },
    rowHeader: { alignItems: "center", flexDirection: "row", gap: 8 },
    checkbox: {
      alignItems: "center",
      borderRadius: 6,
      borderWidth: 1.5,
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    checkboxMark: { color: t.onAccent, fontSize: 12, fontWeight: "700", lineHeight: 14 },
    segment: {
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      padding: 2,
    },
    segmentButton: {
      alignItems: "center",
      borderRadius: 6,
      height: 24,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    segmentButtonActive: {
      backgroundColor: t.cardSurface,
      boxShadow: "0 1px 2px rgba(20,28,40,0.10)",
    },
    segmentText: { fontSize: 12, fontWeight: "600" },
    amountWrap: { flex: 1, minWidth: 0 },
    currencyInput: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textSecondary,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 8,
      textAlign: "center",
      width: 62,
    },
    fieldGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    field: { flexBasis: "47%", flexGrow: 1, gap: 4, minWidth: 150 },
    label: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
    input: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      paddingHorizontal: 9,
      paddingVertical: 8,
      width: "100%",
    },
    categoryWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    categoryChip: {
      alignItems: "center",
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      height: 26,
      paddingHorizontal: 9,
    },
    categoryChipText: { fontSize: 11.5, fontWeight: "600" },
    duplicateWarning: {
      alignItems: "flex-start",
      backgroundColor: "rgba(178,77,77,0.08)",
      borderColor: "rgba(178,77,77,0.22)",
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      padding: 10,
    },
    duplicateWarningBody: { flex: 1, gap: 3, minWidth: 0 },
    duplicateWarningTitle: { color: t.errorText, fontSize: 12.5, fontWeight: "700" },
    duplicateWarningDetail: { color: t.textSecondary, fontSize: 11.5, lineHeight: 17 },
    error: {
      color: t.errorText,
      fontSize: 12,
      paddingHorizontal: 18,
      paddingTop: 4,
    },
    footer: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    footerSpacer: { flex: 1 },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    primaryButtonText: { color: t.onAccent, fontSize: 13, fontWeight: "600" },
    secondaryButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    secondaryButtonHover: { backgroundColor: t.controlHover },
    secondaryButtonText: { color: t.textSecondary, fontSize: 13, fontWeight: "600" },
    dangerButton: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 5,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    dangerButtonHover: { backgroundColor: "rgba(178,77,77,0.10)" },
    dangerButtonText: { color: t.errorText, fontSize: 13, fontWeight: "600" },
  });
}
