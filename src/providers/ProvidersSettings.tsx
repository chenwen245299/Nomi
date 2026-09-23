import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import {
  RiAddLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiEdit2Line,
  RiRefreshLine,
  RiSearch2Line,
  RiStarFill,
  RiStarLine,
  RiWallet3Line,
} from "@remixicon/react";
import {
  accentFor,
  cardShadow,
  motion,
  useTheme,
  withGlow,
  type Accent,
  type Theme,
} from "../theme";
import {
  CAPABILITIES,
  DEEPSEEK_PEAK_TIME_RANGES,
  MODEL_CATEGORIES,
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  fetchedModelCnyPrices,
  findDefaultModel,
  inferModelCapabilities,
  inferModelCategory,
  inferProviderKind,
  isChatModel,
  kindLabel,
  normalizeCategory,
  pricingTimeRanges,
  type FetchedProviderModel,
  type Provider,
  type ProviderBalance,
  type ProviderModel,
  type PricingTimeRange,
} from "./api";
import { BrandIcon } from "./BrandIcon";
import { modelIconUrl, providerIconUrl } from "./icons";
import type { ProvidersController } from "./useProviders";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBalanceDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Resolve a balance's expiry into a rendered date + past/future flag. Kept out
 * of the component body so the `now` read isn't an impure call during render. */
function balanceExpiry(balance: ProviderBalance): { text: string; expired: boolean } | null {
  const at = balance.expiresAt ?? null;
  if (at == null) return null;
  const expired = at * 1000 <= Date.now();
  return {
    expired,
    text: expired ? `已于 ${formatBalanceDate(at)} 过期` : `有效期至 ${formatBalanceDate(at)}`,
  };
}

/**
 * The account-balance card. DeepSeek/OpenRouter fill the granted/credits inline
 * detail; MoleAPI instead reports `unlimited` (无限额度 keys have no ceiling, so
 * "不限额" replaces the amount), an optional expiry, and packs its 已用/密钥剩余
 * breakdown into `note`.
 */
function BalanceCard({ balance }: { balance: ProviderBalance }) {
  const { styles } = useProviderStyles();
  const expiry = balanceExpiry(balance);
  return (
    <View style={styles.balanceCard}>
      <View style={styles.balanceRow}>
        <Text style={styles.balanceAmount}>
          {balance.unlimited ? "不限额" : `${formatAmount(balance.remaining)} ${balance.currency}`}
        </Text>
        {balance.granted != null || balance.toppedUp != null ? (
          <Text style={styles.balanceDetail}>
            充值 {formatAmount(balance.toppedUp ?? 0)} · 赠金 {formatAmount(balance.granted ?? 0)}
          </Text>
        ) : balance.totalCredits != null || balance.totalUsage != null ? (
          <Text style={styles.balanceDetail}>
            额度 {formatAmount(balance.totalCredits ?? 0)} · 已用{" "}
            {formatAmount(balance.totalUsage ?? 0)}
          </Text>
        ) : null}
      </View>
      {balance.note ? <Text style={styles.balanceDetail}>{balance.note}</Text> : null}
      {expiry ? (
        <Text style={expiry.expired ? styles.testResultErr : styles.balanceDetail}>
          {expiry.text}
        </Text>
      ) : null}
      {balance.otherCurrencies?.map((info) => (
        <View key={info.currency} style={styles.balanceRow}>
          <Text style={styles.balanceAmount}>
            {formatAmount(info.remaining)} {info.currency}
          </Text>
        </View>
      ))}
      {!balance.isAvailable && !balance.unlimited && !expiry?.expired && (
        <Text style={styles.testResultErr}>余额不足，接口调用可能被拒绝。</Text>
      )}
    </View>
  );
}

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function confirmDefaultReplacement(message: string): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      return await tauriConfirm(message, { title: "更换全局默认模型", kind: "warning" });
    } catch {
      // Fall back to the web dialog when the native plugin is unavailable.
    }
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

const capabilityLabel = (value: string) =>
  CAPABILITIES.find((item) => item.value === value)?.label ?? value;

function modelCapabilities(model: ProviderModel): string[] {
  const values = new Set(
    model.capabilities.map((capability) => (capability === "vision" ? "image" : capability)),
  );
  if (normalizeCategory(model.category) === "vision") values.add("image");
  return [...values];
}

function formatPrice(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}/M`;
}

function basePriceSummary(model: ProviderModel): string | null {
  const input = formatPrice(model.inputPrice);
  const output = formatPrice(model.outputPrice);
  const cache = formatPrice(model.cacheHitInputPrice);
  if (!input && !output && !cache) return null;
  return [input && `入 ${input}`, output && `出 ${output}`, cache && `缓存 ${cache}`]
    .filter(Boolean)
    .join(" · ");
}

function peakPriceSummary(model: ProviderModel): string | null {
  if (!model.peakPricingEnabled) return null;
  const input = formatPrice(model.peakInputPrice ?? model.inputPrice);
  const output = formatPrice(model.peakOutputPrice ?? model.outputPrice);
  const cache = formatPrice(model.peakCacheHitInputPrice ?? model.cacheHitInputPrice);
  const window = pricingTimeRanges(model)
    .map(
      ({ startHour, endHour }) =>
        `${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00`,
    )
    .join("、");
  return [
    "波峰",
    window,
    input && `入 ${input}`,
    output && `出 ${output}`,
    cache && `缓存 ${cache}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    root: {
      flex: 1,
      flexDirection: "row",
      minHeight: 0,
    },
    // Left pane — provider list
    left: {
      borderRightColor: t.separator,
      borderRightWidth: 1,
      width: 232,
    },
    leftHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 10,
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    leftTitle: {
      color: t.textSecondary,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    addButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    addButtonHover: {
      backgroundColor: t.controlHover,
    },
    listContent: {
      paddingBottom: 12,
      paddingHorizontal: 8,
    },
    providerRow: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    providerRowHover: {
      backgroundColor: t.controlHover,
    },
    providerRowActive: {
      backgroundColor: accent.selectedFill,
    },
    providerAvatar: {
      alignItems: "center",
      borderRadius: 8,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    providerAvatarText: {
      color: t.onAccent,
      fontSize: 13,
      fontWeight: "700",
    },
    providerName: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      fontWeight: "600",
    },
    providerNameMuted: {
      color: t.textTertiary,
    },
    // Right pane — detail
    right: {
      flex: 1,
      minWidth: 0,
    },
    detailContent: {
      gap: 14,
      maxWidth: 820,
      padding: 20,
    },
    detailTop: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
    },
    detailAvatar: {
      alignItems: "center",
      borderRadius: 10,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    detailTitle: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.3,
    },
    testButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 32,
      paddingHorizontal: 12,
    },
    testButtonHover: {
      backgroundColor: t.controlHover,
    },
    testButtonText: {
      color: t.textSecondary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    testResultOk: {
      color: t.statusGreenText,
      fontSize: 12,
      marginTop: -8,
    },
    testResultErr: {
      color: t.errorText,
      fontSize: 12,
      lineHeight: 18,
      marginTop: -8,
    },
    fieldLabel: {
      color: t.textSecondary,
      fontSize: 11.5,
      fontWeight: "700",
      marginBottom: 6,
    },
    input: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 12.5,
      height: 36,
      minHeight: 36,
      paddingHorizontal: 11,
      paddingVertical: 0,
    },
    inputFocused: {
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.22)`,
    },
    keyRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
    },
    keyDots: {
      color: t.statusGreenText,
      fontSize: 15,
      letterSpacing: 2,
    },
    smallButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      minHeight: 30,
      paddingHorizontal: 11,
    },
    smallButtonHover: {
      backgroundColor: t.controlHover,
    },
    smallButtonText: {
      color: accent.accentText,
      fontSize: 12,
      fontWeight: "600",
    },
    select: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 12.5,
      height: 36,
      minHeight: 36,
      paddingHorizontal: 11,
    },
    balanceHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
      marginBottom: 8,
    },
    balanceCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      gap: 6,
      padding: 14,
    },
    balanceRow: {
      alignItems: "baseline",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      justifyContent: "space-between",
    },
    balanceAmount: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
    },
    balanceDetail: {
      color: t.textTertiary,
      fontSize: 12,
    },
    // New-provider modal
    modalCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 16,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      gap: 12,
      maxWidth: "92%",
      padding: 20,
      width: 420,
    },
    modalTitle: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.2,
    },
    modalHint: {
      color: t.textSecondary,
      fontSize: 12.5,
      lineHeight: 19,
    },
    modalDetected: {
      color: t.textTertiary,
      fontSize: 12,
    },
    modalActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: 2,
    },
    // Right-click context menu
    contextMenu: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      minWidth: 160,
      padding: 5,
    },
    contextMenuItem: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    contextMenuDanger: {
      color: t.errorText,
      fontSize: 13,
      fontWeight: "600",
    },
    // Model picker modal
    pickerCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 16,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      gap: 12,
      maxWidth: "92%",
      padding: 18,
      width: 480,
    },
    pickerHeader: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
    },
    pickerSearch: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 7,
      paddingHorizontal: 11,
    },
    pickerSearchInput: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      height: 36,
      minHeight: 36,
      paddingVertical: 0,
    },
    pickerStatus: {
      color: t.textTertiary,
      fontSize: 12.5,
      paddingVertical: 16,
      textAlign: "center",
    },
    pickerAllRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 9,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    pickerAllText: {
      color: t.textSecondary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    pickerList: {
      maxHeight: 340,
    },
    pickerGroupHeader: {
      color: t.textTertiary,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.3,
      marginTop: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    pickerRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 9,
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    pickerRowText: {
      color: t.textPrimary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
    },
    pickerRowBody: {
      flex: 1,
      minWidth: 0,
    },
    pickerRowName: {
      color: t.textPrimary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    pickerRowMeta: {
      color: t.textTertiary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 10.5,
      marginTop: 2,
    },
    pickerRowCapabilities: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 3,
      justifyContent: "flex-end",
      maxWidth: 160,
    },
    pickerCapability: {
      backgroundColor: accent.iconBadge,
      borderRadius: 999,
      color: accent.accentText,
      fontSize: 9.5,
      fontWeight: "600",
      overflow: "hidden",
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    pickerRowTextMuted: {
      color: t.textTertiary,
    },
    pickerAdded: {
      color: t.textTertiary,
      fontSize: 11,
    },
    checkbox: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.controlBorder,
      borderRadius: 5,
      borderWidth: 1,
      height: 18,
      justifyContent: "center",
      width: 18,
    },
    modelsHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    modelsTitle: {
      color: t.textPrimary,
      fontSize: 13,
      fontWeight: "700",
    },
    modelsTitleCount: {
      color: t.textTertiary,
      fontSize: 12,
      fontWeight: "400",
    },
    modelsActions: {
      flexDirection: "row",
      gap: 8,
    },
    modelCard: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      flexDirection: "row",
      gap: 8,
      marginTop: 8,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    modelBody: {
      flex: 1,
      minWidth: 0,
    },
    modelTopRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    modelName: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "600",
    },
    tag: {
      backgroundColor: t.statusGreenFill,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    tagText: {
      color: t.statusGreenText,
      fontSize: 11,
      fontWeight: "500",
    },
    modelSize: {
      color: t.textTertiary,
      fontSize: 11.5,
    },
    modelId: {
      color: t.textTertiary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      marginTop: 3,
    },
    modelPriceRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
      marginTop: 4,
    },
    modelPrice: {
      color: t.textTertiary,
      fontSize: 10.5,
    },
    modelPeakPrice: {
      color: "#C46A1A",
      fontSize: 10.5,
      fontWeight: "600",
    },
    iconButton: {
      alignItems: "center",
      borderRadius: 7,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    iconButtonHover: {
      backgroundColor: t.controlHover,
    },
    modelsEmpty: {
      color: t.textTertiary,
      fontSize: 12,
      marginTop: 8,
      paddingVertical: 8,
    },
    modelGroup: {
      marginTop: 12,
    },
    modelGroupHeader: {
      color: t.textSecondary,
      fontSize: 11.5,
      fontWeight: "700",
      letterSpacing: 0.3,
    },
    modelGroupCount: {
      color: t.textTertiary,
      fontWeight: "400",
    },
    // Editor
    editorField: {
      flex: 1,
      minWidth: 0,
    },
    editorFieldLabel: {
      color: t.textTertiary,
      fontSize: 10,
      fontWeight: "600",
      lineHeight: 14,
      marginBottom: 4,
    },
    editorCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      gap: 8,
      marginTop: 8,
      padding: 10,
    },
    editorInput: {
      borderRadius: 8,
      fontSize: 12,
      height: 32,
      minHeight: 32,
      paddingHorizontal: 10,
      width: "100%",
    },
    editorRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    editorSection: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      gap: 8,
      paddingTop: 9,
    },
    editorPricingHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    editorPricingTitle: {
      color: t.textSecondary,
      fontSize: 11.5,
      fontWeight: "700",
    },
    editorPricingHint: {
      color: t.textTertiary,
      flex: 1,
      fontSize: 10,
      lineHeight: 14,
    },
    editorPeakToggle: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 0,
      gap: 7,
    },
    peakPanel: {
      backgroundColor: "rgba(196,106,26,0.055)",
      borderColor: "rgba(196,106,26,0.16)",
      borderRadius: 9,
      borderWidth: 1,
      gap: 8,
      padding: 8,
    },
    peakRangeRow: {
      alignItems: "flex-end",
      flexDirection: "row",
      gap: 8,
    },
    peakRangeNumber: {
      color: t.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      lineHeight: 32,
      width: 42,
    },
    peakRangeDelete: {
      alignItems: "center",
      borderRadius: 8,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    peakRangeAdd: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderRadius: 8,
      flexDirection: "row",
      gap: 4,
      height: 28,
      paddingHorizontal: 8,
    },
    peakRangeAddText: {
      color: accent.accentText,
      fontSize: 11,
      fontWeight: "600",
    },
    chip: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 999,
      borderWidth: 1,
      height: 28,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    chipActive: {
      backgroundColor: accent.selectedFill,
      borderColor: accent.accent,
    },
    chipText: {
      color: t.textSecondary,
      fontSize: 11.5,
      fontWeight: "500",
    },
    chipTextActive: {
      color: accent.accentText,
    },
    editorActions: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 0,
      gap: 6,
    },
    editorFooter: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "space-between",
    },
    editorCapabilityRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      flex: 1,
      gap: 6,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      boxShadow: withGlow("inset 0 1px 0 rgba(255,255,255,0.22)", accent),
      minHeight: 32,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    primaryButtonText: {
      color: t.onAccent,
      fontSize: 12.5,
      fontWeight: "600",
    },
    ghostButton: {
      alignItems: "center",
      borderRadius: 9,
      justifyContent: "center",
      minHeight: 32,
      paddingHorizontal: 12,
    },
    ghostButtonText: {
      color: t.textSecondary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    dangerText: {
      color: t.errorText,
    },
    // Toggle
    track: {
      borderRadius: 999,
      height: 22,
      width: 38,
    },
    knob: {
      backgroundColor: "#FFFFFF",
      borderRadius: 999,
      height: 18,
      position: "absolute",
      top: 2,
      width: 18,
      boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
    },
    // Empty
    empty: {
      alignItems: "center",
      flex: 1,
      gap: 6,
      justifyContent: "center",
      padding: 40,
    },
    emptyTitle: {
      color: t.textSecondary,
      fontSize: 13,
      fontWeight: "600",
    },
    emptyText: {
      color: t.textTertiary,
      fontSize: 12,
      textAlign: "center",
    },
  });
}

function useProviderStyles() {
  const theme = useTheme();
  const accent = accentFor("chat");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  return { styles, theme, accent };
}

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const { styles, theme, accent } = useProviderStyles();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={[
        styles.track,
        motion,
        { backgroundColor: value ? accent.accent : theme.t.controlPressed },
      ]}
    >
      <View style={[styles.knob, motion, { transform: [{ translateX: value ? 18 : 2 }] }]} />
    </Pressable>
  );
}

/** Close an overlay when Escape is pressed. */
function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

type ContextMenu = { x: number; y: number; provider: Provider };

export function ProvidersSettings({ providers }: { providers: ProvidersController }) {
  const { styles, theme, accent } = useProviderStyles();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<ContextMenu | null>(null);

  return (
    <View style={styles.root}>
      <View style={styles.left}>
        <View style={styles.leftHeader}>
          <Text style={styles.leftTitle}>API 供应商</Text>
          <Pressable
            accessibilityLabel="添加服务商"
            accessibilityRole="button"
            onPress={() => setCreating(true)}
            style={({ hovered, pressed }: PressState) => [
              styles.addButton,
              motion,
              hovered && styles.addButtonHover,
              pressed && ({ opacity: 0.7 } as ViewStyle),
            ]}
          >
            <RiAddLine color={theme.t.textSecondary} size={18} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.listContent}>
          {providers.providers.map((provider) => (
            <ProviderRow
              accent={accent}
              active={provider.id === providers.selectedId}
              key={provider.id}
              onContextMenu={(x, y) => {
                // Highlight the target row so it's clear which provider the menu acts on.
                providers.select(provider.id);
                setMenu({ x, y, provider });
              }}
              onSelect={() => providers.select(provider.id)}
              onToggle={(enabled) => void providers.toggleEnabled(provider.id, enabled)}
              provider={provider}
            />
          ))}
        </ScrollView>
      </View>

      <View style={styles.right}>
        {providers.selected ? (
          <ProviderDetail
            controller={providers}
            key={providers.selected.id}
            provider={providers.selected}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有 API 服务商</Text>
            <Text style={styles.emptyText}>点击左上角 + 添加一个服务商并填写 API 密钥。</Text>
          </View>
        )}
      </View>

      {creating && (
        <NewProviderModal
          onClose={() => setCreating(false)}
          onCreate={(spec) => {
            setCreating(false);
            void providers.add(spec);
          }}
        />
      )}

      {menu && (
        <ProviderContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onDelete={() => {
            void providers.remove(menu.provider.id);
            setMenu(null);
          }}
        />
      )}
    </View>
  );
}

/** Ask for a name, infer the kind from it, and pre-fill any known provider URL. */
function NewProviderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (spec: {
    name: string;
    kind: string;
    baseUrl: string;
    models: ProviderModel[];
  }) => void;
}) {
  const { styles, theme } = useProviderStyles();
  const [name, setName] = useState("");
  const [focused, setFocused] = useState(false);
  const kind = inferProviderKind(name);
  const preset = PROVIDER_PRESETS[kind];
  useCloseOnEscape(onClose);

  function submit() {
    onCreate({
      name: name.trim() || "新服务商",
      kind,
      baseUrl: preset?.baseUrl ?? "",
      models: preset?.models ?? [],
    });
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{
        alignItems: "center",
        background: "rgba(15,23,42,0.32)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        position: "fixed",
        zIndex: 40,
      }}
    >
      <div onClick={(event) => event.stopPropagation()}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>新建服务商</Text>
          <Text style={styles.modalHint}>
            先给它起个名字。填 DeepSeek、Kimi 等可识别的名称时，会自动选择类型并预填 API
            地址与模型。
          </Text>
          <TextInput
            autoFocus
            onBlur={() => setFocused(false)}
            onChangeText={setName}
            onFocus={() => setFocused(true)}
            onSubmitEditing={submit}
            placeholder="服务商名称，如 DeepSeek"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, focused && styles.inputFocused]}
            value={name}
          />
          <Text style={styles.modalDetected}>
            识别类型：{kindLabel(kind)}
            {preset ? "（将预填 API 地址与模型）" : ""}
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ hovered, pressed }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                pressed && ({ opacity: 0.7 } as ViewStyle),
              ]}
            >
              <Text style={styles.ghostButtonText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={submit}
              style={({ hovered, pressed }: PressState) => [
                styles.primaryButton,
                motion,
                hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
                pressed && ({ opacity: 0.9 } as ViewStyle),
              ]}
            >
              <Text style={styles.primaryButtonText}>创建</Text>
            </Pressable>
          </View>
        </View>
      </div>
    </div>,
    document.body,
  );
}

/** A right-click menu anchored at the cursor with a single destructive action. */
function ProviderContextMenu({
  menu,
  onClose,
  onDelete,
}: {
  menu: ContextMenu;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { styles, theme } = useProviderStyles();
  useCloseOnEscape(onClose);
  // Keep the menu on-screen near every edge.
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 180));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 80));
  return createPortal(
    <div
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ inset: 0, position: "fixed", zIndex: 50 }}
    >
      <div onClick={(event) => event.stopPropagation()} style={{ left, position: "fixed", top }}>
        <View style={styles.contextMenu}>
          <Pressable
            accessibilityRole="button"
            onPress={onDelete}
            style={({ hovered, pressed }: PressState) => [
              styles.contextMenuItem,
              motion,
              (hovered || pressed) && ({ backgroundColor: "rgba(178,77,77,0.10)" } as ViewStyle),
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={15} />
            <Text style={styles.contextMenuDanger}>删除服务商</Text>
          </Pressable>
        </View>
      </div>
    </div>,
    document.body,
  );
}

function providerInitial(provider: Provider): string {
  const trimmed = provider.name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "N";
}

function ProviderRow({
  accent,
  active,
  onContextMenu,
  onSelect,
  onToggle,
  provider,
}: {
  accent: Accent;
  active: boolean;
  onContextMenu: (x: number, y: number) => void;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  provider: Provider;
}) {
  const { styles } = useProviderStyles();
  // Raw div wrapper: react-native-web's Pressable doesn't expose onContextMenu.
  // display:flex so the Pressable child stretches to the full row width (as it
  // would as a direct RN View child of the list).
  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ display: "flex", flexDirection: "column" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={onSelect}
        style={({ hovered, pressed }: PressState) => [
          styles.providerRow,
          motion,
          hovered && !active && styles.providerRowHover,
          active && styles.providerRowActive,
          pressed && ({ opacity: 0.9 } as ViewStyle),
        ]}
      >
        <BrandIcon
          accent={accent}
          fallback={providerInitial(provider)}
          size={26}
          url={providerIconUrl(provider.name, provider.kind)}
        />
        <Text
          numberOfLines={1}
          style={[styles.providerName, !provider.enabled && styles.providerNameMuted]}
        >
          {provider.name || "未命名"}
        </Text>
        <Toggle onChange={onToggle} value={provider.enabled} />
      </Pressable>
    </div>
  );
}

function ProviderDetail({
  controller,
  provider,
}: {
  controller: ProvidersController;
  provider: Provider;
}) {
  const { styles, theme, accent } = useProviderStyles();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [focused, setFocused] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [editingModel, setEditingModel] = useState<ProviderModel | "new" | null>(null);
  const [picking, setPicking] = useState(false);
  const [balance, setBalance] = useState<ProviderBalance | null>(null);
  const [balanceState, setBalanceState] = useState<"idle" | "loading" | "error">("idle");
  const [balanceError, setBalanceError] = useState("");
  const editingModelId = editingModel && editingModel !== "new" ? editingModel.id : null;

  function persist(patch: Partial<Provider>) {
    void controller.save({ ...provider, name, baseUrl, ...patch });
  }

  function saveModels(models: ProviderModel[]) {
    void controller.save({ ...provider, name, baseUrl, models });
  }

  // Switching to a known kind fills its base URL and any preset models when
  // those are still empty — never clobbering what the user has typed. Providers
  // such as MiMo keep the preset model list empty and fetch `/models` live.
  function changeKind(kind: string) {
    const preset = PROVIDER_PRESETS[kind];
    const patch: Partial<Provider> = { kind };
    if (preset) {
      if (!baseUrl.trim()) {
        setBaseUrl(preset.baseUrl);
        patch.baseUrl = preset.baseUrl;
      }
      if (provider.models.length === 0) {
        patch.models = preset.models;
      }
    }
    persist(patch);
  }

  async function loadBalance() {
    setBalanceState("loading");
    setBalanceError("");
    try {
      setBalance(await controller.balance(provider.id));
      setBalanceState("idle");
    } catch (err) {
      setBalanceError(String(err));
      setBalanceState("error");
    }
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    const result = await controller.test(provider.id);
    setTestResult(result);
    setTesting(false);
  }

  // Add only the models the user picked (dedup against existing), preserving
  // provider-reported modalities/capabilities instead of guessing from the id.
  function addModels(fetched: FetchedProviderModel[]) {
    const existing = new Set(provider.models.map((m) => m.id));
    const added = fetched
      .filter((model) => !existing.has(model.id))
      .map<ProviderModel>((model) => {
        const capabilities = [
          ...new Set([...model.capabilities, ...inferModelCapabilities(model.id)]),
        ];
        // MoleAPI reports USD rates in the catalogue; convert to the CNY price
        // fields. Providers that don't report prices leave these null (unset).
        const { inputPrice, outputPrice } = fetchedModelCnyPrices(model);
        return {
          id: model.id,
          name: model.name || model.id,
          capabilities,
          category: model.category
            ? normalizeCategory(model.category)
            : inferModelCategory(model.id),
          size: "",
          starred: false,
          contextLength: model.contextLength,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          inputPrice,
          outputPrice,
        };
      });
    if (added.length) {
      saveModels([...provider.models, ...added]);
    }
  }

  async function refreshFetchedMetadata(fetched: FetchedProviderModel[]) {
    const catalogue = new Map(fetched.map((model) => [model.id, model]));
    let changed = false;
    const models = provider.models.map((model) => {
      const fresh = catalogue.get(model.id);
      if (!fresh) return model;
      const capabilities = [
        ...new Set([
          ...model.capabilities,
          ...fresh.capabilities,
          ...inferModelCapabilities(model.id),
        ]),
      ];
      // Refresh only the objective catalogue metadata (name/caps/category/context/
      // modalities). Prices are user-maintained and are filled once, at add time
      // (see addModels): a refresh must not touch them, otherwise a price the user
      // deliberately cleared would come back — the backend serialises an unset
      // price as `null`, so a cleared price and a never-set one are indistinguishable.
      const next: ProviderModel = {
        ...model,
        name: !model.name.trim() || model.name === model.id ? fresh.name || model.id : model.name,
        capabilities,
        category: fresh.category ? normalizeCategory(fresh.category) : model.category,
        contextLength: fresh.contextLength ?? model.contextLength,
        inputModalities:
          fresh.inputModalities.length > 0 ? fresh.inputModalities : (model.inputModalities ?? []),
        outputModalities:
          fresh.outputModalities.length > 0
            ? fresh.outputModalities
            : (model.outputModalities ?? []),
      };
      if (JSON.stringify(next) !== JSON.stringify(model)) changed = true;
      return next;
    });
    if (changed) {
      await controller.save({ ...provider, name, baseUrl, models });
    }
  }

  function upsertModel(model: ProviderModel) {
    const exists = provider.models.some((m) => m.id === model.id);
    const models = exists
      ? provider.models.map((m) => (m.id === model.id ? model : m))
      : [...provider.models, model];
    saveModels(models);
    setEditingModel(null);
  }

  async function chooseDefaultModel(model: ProviderModel) {
    if (model.starred || !isChatModel(model)) return;
    const current = findDefaultModel(controller.providers);
    if (current && (current.provider.id !== provider.id || current.model.id !== model.id)) {
      const confirmed = await confirmDefaultReplacement(
        `当前全局默认模型是「${current.provider.name} · ${current.model.name || current.model.id}」。\n\n确认更换为「${provider.name} · ${model.name || model.id}」吗？`,
      );
      if (!confirmed) return;
    }
    await controller.setDefaultModel(provider.id, model.id);
  }

  function deleteModel(id: string) {
    saveModels(provider.models.filter((m) => m.id !== id));
  }

  return (
    <ScrollView contentContainerStyle={styles.detailContent}>
      <View style={styles.detailTop}>
        <BrandIcon
          accent={accent}
          fallback={providerInitial(provider)}
          size={34}
          url={providerIconUrl(provider.name, provider.kind)}
        />
        <Text numberOfLines={1} style={styles.detailTitle}>
          {name || "未命名服务商"}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={testing}
          onPress={() => void runTest()}
          style={({ hovered, pressed }: PressState) => [
            styles.testButton,
            motion,
            hovered && styles.testButtonHover,
            pressed && ({ opacity: 0.8 } as ViewStyle),
            testing && ({ opacity: 0.6 } as ViewStyle),
          ]}
        >
          <RiRefreshLine color={theme.t.textSecondary} size={15} />
          <Text style={styles.testButtonText}>{testing ? "测试中…" : "测试连接"}</Text>
        </Pressable>
        <Toggle
          onChange={(enabled) => void controller.toggleEnabled(provider.id, enabled)}
          value={provider.enabled}
        />
      </View>

      {testResult && (
        <Text style={testResult.ok ? styles.testResultOk : styles.testResultErr}>
          {testResult.message}
        </Text>
      )}

      <View>
        <Text style={styles.fieldLabel}>服务商名称</Text>
        <TextInput
          onBlur={() => {
            setFocused(null);
            persist({});
          }}
          onChangeText={setName}
          onFocus={() => setFocused("name")}
          placeholder="服务商名称"
          placeholderTextColor={theme.t.textTertiary}
          style={[styles.input, focused === "name" && styles.inputFocused]}
          value={name}
        />
      </View>

      <View>
        <Text style={styles.fieldLabel}>API 密钥</Text>
        <ApiKeyField controller={controller} provider={provider} />
      </View>

      {provider.supportsAccessToken && (
        <View>
          <Text style={styles.fieldLabel}>系统访问令牌（可选）</Text>
          <AccessTokenField controller={controller} provider={provider} />
        </View>
      )}

      <View>
        <Text style={styles.fieldLabel}>API 地址</Text>
        <TextInput
          autoCapitalize="none"
          onBlur={() => {
            setFocused(null);
            persist({});
          }}
          onChangeText={setBaseUrl}
          onFocus={() => setFocused("baseUrl")}
          placeholder="https://api.example.com/v1"
          placeholderTextColor={theme.t.textTertiary}
          style={[styles.input, focused === "baseUrl" && styles.inputFocused]}
          value={baseUrl}
        />
      </View>

      <View>
        <Text style={styles.fieldLabel}>服务类型</Text>
        {/* Raw DOM select — native chevrons, works in react-native-web */}
        <select
          onChange={(event) => changeKind(event.target.value)}
          style={{
            appearance: "auto",
            backgroundColor: theme.t.cardSurfaceAlt,
            border: `1px solid ${theme.t.separator}`,
            borderRadius: 10,
            color: theme.t.textPrimary,
            fontSize: 12.5,
            height: 36,
            padding: "0 11px",
            width: "100%",
          }}
          value={provider.kind || "openai"}
          title={kindLabel(provider.kind)}
        >
          {PROVIDER_KINDS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </View>

      {provider.supportsBalance && (
        <View>
          <View style={styles.balanceHeader}>
            <Text style={styles.fieldLabel}>账户余额</Text>
            <Pressable
              accessibilityRole="button"
              disabled={balanceState === "loading"}
              onPress={() => void loadBalance()}
              style={({ hovered, pressed }: PressState) => [
                styles.smallButton,
                motion,
                hovered && styles.smallButtonHover,
                pressed && ({ opacity: 0.8 } as ViewStyle),
                balanceState === "loading" && ({ opacity: 0.6 } as ViewStyle),
              ]}
            >
              <RiWallet3Line color={accent.accentText} size={14} />
              <Text style={styles.smallButtonText}>
                {balanceState === "loading" ? "查询中…" : "查询余额"}
              </Text>
            </Pressable>
          </View>
          {balanceState === "error" ? (
            <Text style={styles.testResultErr}>{balanceError}</Text>
          ) : balance ? (
            <BalanceCard balance={balance} />
          ) : null}
        </View>
      )}

      <View>
        <View style={styles.modelsHeader}>
          <Text style={styles.modelsTitle}>
            模型 <Text style={styles.modelsTitleCount}>({provider.models.length})</Text>
          </Text>
          <View style={styles.modelsActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPicking(true)}
              style={({ hovered, pressed }: PressState) => [
                styles.smallButton,
                motion,
                hovered && styles.smallButtonHover,
                pressed && ({ opacity: 0.8 } as ViewStyle),
              ]}
            >
              <RiRefreshLine color={accent.accentText} size={14} />
              <Text style={styles.smallButtonText}>获取模型列表</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditingModel("new")}
              style={({ hovered, pressed }: PressState) => [
                styles.smallButton,
                motion,
                hovered && styles.smallButtonHover,
                pressed && ({ opacity: 0.8 } as ViewStyle),
              ]}
            >
              <RiAddLine color={accent.accentText} size={14} />
              <Text style={styles.smallButtonText}>手动添加</Text>
            </Pressable>
          </View>
        </View>

        {editingModel === "new" && (
          <ModelEditor
            existingIds={provider.models.map((m) => m.id)}
            initial={null}
            onCancel={() => setEditingModel(null)}
            onSave={upsertModel}
            providerKind={provider.kind}
          />
        )}

        {picking && (
          <ModelPickerModal
            existingIds={provider.models.map((m) => m.id)}
            fetchModels={() => controller.fetchModels(provider.id)}
            onAdd={(models) => {
              addModels(models);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
            onFetched={refreshFetchedMetadata}
          />
        )}

        {provider.models.length === 0 && !editingModel ? (
          <Text style={styles.modelsEmpty}>还没有模型。点击「获取模型列表」或「手动添加」。</Text>
        ) : (
          MODEL_CATEGORIES.map((cat) => {
            const group = provider.models.filter(
              (m) => normalizeCategory(m.category) === cat.value,
            );
            if (group.length === 0) {
              return null;
            }
            return (
              <View key={cat.value} style={styles.modelGroup}>
                <Text style={styles.modelGroupHeader}>
                  {cat.label} <Text style={styles.modelGroupCount}>({group.length})</Text>
                </Text>
                {group.map((model) => (
                  <View key={model.id}>
                    <View style={styles.modelCard}>
                      <BrandIcon
                        accent={accent}
                        fallback={(model.name || model.id).trim()[0]?.toUpperCase() ?? "M"}
                        size={28}
                        url={
                          modelIconUrl(model.id, model.name) ??
                          providerIconUrl(provider.name, provider.kind)
                        }
                      />
                      <View style={styles.modelBody}>
                        <View style={styles.modelTopRow}>
                          <Text style={styles.modelName}>{model.name || model.id}</Text>
                          {modelCapabilities(model).map((cap) => (
                            <View key={cap} style={styles.tag}>
                              <Text style={styles.tagText}>{capabilityLabel(cap)}</Text>
                            </View>
                          ))}
                          {model.size ? <Text style={styles.modelSize}>{model.size}</Text> : null}
                        </View>
                        <Text style={styles.modelId}>{model.id}</Text>
                        {basePriceSummary(model) || peakPriceSummary(model) ? (
                          <View style={styles.modelPriceRow}>
                            {basePriceSummary(model) ? (
                              <Text style={styles.modelPrice}>
                                {model.peakPricingEnabled ? "波谷 · " : ""}
                                {basePriceSummary(model)}
                              </Text>
                            ) : null}
                            {peakPriceSummary(model) ? (
                              <Text style={styles.modelPeakPrice}>{peakPriceSummary(model)}</Text>
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                      <Pressable
                        accessibilityLabel={model.starred ? "当前全局默认模型" : "设为全局默认模型"}
                        accessibilityRole="button"
                        disabled={!isChatModel(model)}
                        onPress={() => void chooseDefaultModel(model)}
                        style={({ hovered, pressed }: PressState) => [
                          styles.iconButton,
                          motion,
                          (hovered || pressed) && styles.iconButtonHover,
                          !isChatModel(model) && ({ opacity: 0.35 } as ViewStyle),
                        ]}
                      >
                        {model.starred ? (
                          <RiStarFill color={accent.accent} size={16} />
                        ) : (
                          <RiStarLine color={theme.t.textTertiary} size={16} />
                        )}
                      </Pressable>
                      <Pressable
                        accessibilityLabel="编辑模型"
                        accessibilityRole="button"
                        onPress={() =>
                          setEditingModel((current) =>
                            current !== "new" && current?.id === model.id ? null : model,
                          )
                        }
                        style={({ hovered, pressed }: PressState) => [
                          styles.iconButton,
                          motion,
                          (hovered || pressed) && styles.iconButtonHover,
                        ]}
                      >
                        <RiEdit2Line color={theme.t.textTertiary} size={15} />
                      </Pressable>
                      <Pressable
                        accessibilityLabel="删除模型"
                        accessibilityRole="button"
                        onPress={() => deleteModel(model.id)}
                        style={({ hovered, pressed }: PressState) => [
                          styles.iconButton,
                          motion,
                          (hovered || pressed) && styles.iconButtonHover,
                        ]}
                      >
                        <RiDeleteBinLine color={theme.t.textTertiary} size={15} />
                      </Pressable>
                    </View>
                    {editingModelId === model.id ? (
                      <ModelEditor
                        existingIds={provider.models.map((item) => item.id)}
                        initial={model}
                        onCancel={() => setEditingModel(null)}
                        onSave={upsertModel}
                        providerKind={provider.kind}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            );
          })
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => void controller.remove(provider.id)}
        style={({ hovered, pressed }: PressState) => [
          styles.ghostButton,
          motion,
          { alignSelf: "flex-start" } as ViewStyle,
          hovered && ({ backgroundColor: "rgba(178,77,77,0.10)" } as ViewStyle),
          pressed && ({ opacity: 0.7 } as ViewStyle),
        ]}
      >
        <Text style={[styles.ghostButtonText, styles.dangerText]}>删除该服务商</Text>
      </Pressable>
    </ScrollView>
  );
}

function ApiKeyField({
  controller,
  provider,
}: {
  controller: ProvidersController;
  provider: Provider;
}) {
  const { styles, theme } = useProviderStyles();
  const [editing, setEditing] = useState(!provider.hasKey);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  if (provider.hasKey && !editing) {
    return (
      <View style={styles.keyRow}>
        <Text style={styles.keyDots}>••••••••</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setEditing(true);
            setValue("");
          }}
          style={({ hovered, pressed }: PressState) => [
            styles.smallButton,
            motion,
            hovered && styles.smallButtonHover,
            pressed && ({ opacity: 0.8 } as ViewStyle),
          ]}
        >
          <Text style={styles.smallButtonText}>修改密钥</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.keyRow}>
      <TextInput
        autoCapitalize="none"
        onChangeText={setValue}
        onBlur={() => setFocused(false)}
        onFocus={() => setFocused(true)}
        placeholder="sk-..."
        placeholderTextColor={theme.t.textTertiary}
        secureTextEntry
        style={[styles.input, { flex: 1 } as ViewStyle, focused && styles.inputFocused]}
        value={value}
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void controller.saveKey(provider.id, value).then(() => {
            setValue("");
            setEditing(false);
          });
        }}
        style={({ hovered, pressed }: PressState) => [
          styles.primaryButton,
          motion,
          hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
          pressed && ({ opacity: 0.9 } as ViewStyle),
        ]}
      >
        <Text style={styles.primaryButtonText}>保存</Text>
      </Pressable>
      {provider.hasKey && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setEditing(false);
            setValue("");
          }}
          style={({ hovered, pressed }: PressState) => [
            styles.ghostButton,
            motion,
            hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
            pressed && ({ opacity: 0.7 } as ViewStyle),
          ]}
        >
          <Text style={styles.ghostButtonText}>取消</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * MoleAPI's optional 系统访问令牌 — a second encrypted secret. A key issued as
 * 无限额度 can't report its own balance, but this console token can read the
 * account's. Mirrors {@link ApiKeyField}, with a hint + a link to where to mint it.
 */
function AccessTokenField({
  controller,
  provider,
}: {
  controller: ProvidersController;
  provider: Provider;
}) {
  const { styles, theme } = useProviderStyles();
  const [editing, setEditing] = useState(!provider.hasAccessToken);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: 6 } as ViewStyle}>
      {provider.hasAccessToken && !editing ? (
        <View style={styles.keyRow}>
          <Text style={styles.keyDots}>••••••••</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setEditing(true);
              setValue("");
            }}
            style={({ hovered, pressed }: PressState) => [
              styles.smallButton,
              motion,
              hovered && styles.smallButtonHover,
              pressed && ({ opacity: 0.8 } as ViewStyle),
            ]}
          >
            <Text style={styles.smallButtonText}>修改令牌</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.keyRow}>
          <TextInput
            autoCapitalize="none"
            onChangeText={setValue}
            onBlur={() => setFocused(false)}
            onFocus={() => setFocused(true)}
            placeholder="填入后可显示账户余额（无限额度密钥适用）"
            placeholderTextColor={theme.t.textTertiary}
            secureTextEntry
            style={[styles.input, { flex: 1 } as ViewStyle, focused && styles.inputFocused]}
            value={value}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void controller.saveAccessToken(provider.id, value).then(() => {
                setValue("");
                setEditing(false);
              });
            }}
            style={({ hovered, pressed }: PressState) => [
              styles.primaryButton,
              motion,
              hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
              pressed && ({ opacity: 0.9 } as ViewStyle),
            ]}
          >
            <Text style={styles.primaryButtonText}>保存</Text>
          </Pressable>
          {provider.hasAccessToken && (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setEditing(false);
                setValue("");
              }}
              style={({ hovered, pressed }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                pressed && ({ opacity: 0.7 } as ViewStyle),
              ]}
            >
              <Text style={styles.ghostButtonText}>取消</Text>
            </Pressable>
          )}
        </View>
      )}
      <Text style={styles.modalHint}>
        密钥设为「无限额度」时本身查不到余额；填入系统访问令牌即可显示账户余额与已用金额。获取方式：MoleAPI
        控制台 → 安全 → 系统访问令牌 → 生成。
      </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => void openUrl("https://home.moleapi.com/security")}
        style={({ hovered }: PressState) => [
          { alignSelf: "flex-start" } as ViewStyle,
          hovered && ({ opacity: 0.8 } as ViewStyle),
        ]}
      >
        <Text style={styles.smallButtonText}>打开 MoleAPI 安全页 ↗</Text>
      </Pressable>
    </View>
  );
}

/**
 * A modal that fetches the provider's full model catalogue (可能上百个, e.g.
 * OpenRouter), lets the user search + multi-select, and adds only the picked ones.
 */
function ModelPickerModal({
  existingIds,
  fetchModels,
  onAdd,
  onClose,
  onFetched,
}: {
  existingIds: string[];
  fetchModels: () => Promise<FetchedProviderModel[]>;
  onAdd: (models: FetchedProviderModel[]) => void;
  onClose: () => void;
  onFetched: (models: FetchedProviderModel[]) => Promise<void>;
}) {
  const { styles, theme, accent } = useProviderStyles();
  useCloseOnEscape(onClose);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [models, setModels] = useState<FetchedProviderModel[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // State transitions happen only after the await (never synchronously in the
    // effect body); the retry handler resets to "loading" before bumping `nonce`.
    void (async () => {
      try {
        const list = await fetchModels();
        if (!cancelled) {
          await onFetched(list);
        }
        if (!cancelled) {
          setModels(list);
          setState("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `nonce` re-triggers a manual retry; `fetchModels` is created per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  function retry() {
    setState("loading");
    setError("");
    setNonce((n) => n + 1);
  }

  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const q = query.trim().toLowerCase();
  // Memoized so a keystroke/toggle doesn't re-filter + re-render the whole
  // (possibly ~300-item) list; combined with the memoized PickerRow below only
  // the rows that actually change re-render.
  const filtered = useMemo(
    () =>
      q
        ? models.filter(
            (model) => model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q),
          )
        : models,
    [models, q],
  );
  const selectable = useMemo(
    () => filtered.filter((model) => !existing.has(model.id)),
    [filtered, existing],
  );
  const allSelected = selectable.length > 0 && selectable.every((model) => selected.has(model.id));

  // Prefer the provider catalogue's category. Plain OpenAI-compatible APIs
  // that expose only ids still use the existing name-based fallback.
  const grouped = useMemo(
    () =>
      MODEL_CATEGORIES.map((cat) => ({
        cat,
        items: filtered.filter((model) => {
          const category = model.category
            ? normalizeCategory(model.category)
            : inferModelCategory(model.id);
          return category === cat.value;
        }),
      })).filter((group) => group.items.length > 0),
    [filtered],
  );

  // Stable identity so React.memo on PickerRow holds across re-renders.
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        selectable.forEach((model) => next.delete(model.id));
      } else {
        selectable.forEach((model) => next.add(model.id));
      }
      return next;
    });
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{
        alignItems: "center",
        background: "rgba(15,23,42,0.32)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        position: "fixed",
        zIndex: 40,
      }}
    >
      <div onClick={(event) => event.stopPropagation()}>
        <View style={styles.pickerCard}>
          <View style={styles.pickerHeader}>
            <Text style={styles.modalTitle}>选择模型</Text>
            <Text style={styles.modalDetected}>
              {state === "ready" ? `共 ${models.length} 个可用` : ""}
            </Text>
          </View>

          <View style={[styles.pickerSearch, motion]}>
            <RiSearch2Line color={theme.t.textTertiary} size={15} />
            <TextInput
              autoFocus
              onChangeText={setQuery}
              placeholder="搜索模型 ID…"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.pickerSearchInput}
              value={query}
            />
          </View>

          {state === "loading" ? (
            <Text style={styles.pickerStatus}>正在获取模型列表…</Text>
          ) : state === "error" ? (
            <View style={{ gap: 8 } as ViewStyle}>
              <Text style={styles.testResultErr}>{error}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={retry}
                style={({ hovered, pressed }: PressState) => [
                  styles.smallButton,
                  motion,
                  { alignSelf: "flex-start" } as ViewStyle,
                  hovered && styles.smallButtonHover,
                  pressed && ({ opacity: 0.8 } as ViewStyle),
                ]}
              >
                <RiRefreshLine color={accent.accentText} size={14} />
                <Text style={styles.smallButtonText}>重试</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={selectable.length === 0}
                onPress={toggleAll}
                style={({ hovered }: PressState) => [
                  styles.pickerAllRow,
                  motion,
                  hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                ]}
              >
                <Checkbox accent={accent} checked={allSelected} theme={theme} />
                <Text style={styles.pickerAllText}>
                  {allSelected ? "取消全选" : "全选"}
                  {q ? "（当前筛选）" : ""}
                </Text>
              </Pressable>

              <ScrollView style={styles.pickerList}>
                {filtered.length === 0 ? (
                  <Text style={styles.pickerStatus}>没有匹配的模型。</Text>
                ) : (
                  grouped.map(({ cat, items }) => (
                    <View key={cat.value}>
                      <Text style={styles.pickerGroupHeader}>
                        {cat.label} ({items.length})
                      </Text>
                      {items.map((model) => (
                        <PickerRow
                          added={existing.has(model.id)}
                          checked={existing.has(model.id) || selected.has(model.id)}
                          key={model.id}
                          model={model}
                          onToggle={toggle}
                        />
                      ))}
                    </View>
                  ))
                )}
              </ScrollView>
            </>
          )}

          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ hovered, pressed }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                pressed && ({ opacity: 0.7 } as ViewStyle),
              ]}
            >
              <Text style={styles.ghostButtonText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={selected.size === 0}
              onPress={() => onAdd(models.filter((model) => selected.has(model.id)))}
              style={({ hovered, pressed }: PressState) => [
                styles.primaryButton,
                motion,
                hovered && selected.size > 0 && ({ filter: "brightness(1.06)" } as ViewStyle),
                pressed && ({ opacity: 0.9 } as ViewStyle),
                selected.size === 0 && ({ opacity: 0.5 } as ViewStyle),
              ]}
            >
              <Text style={styles.primaryButtonText}>
                添加{selected.size > 0 ? ` (${selected.size})` : ""}
              </Text>
            </Pressable>
          </View>
        </View>
      </div>
    </div>,
    document.body,
  );
}

function Checkbox({
  accent,
  checked,
  muted,
  theme,
}: {
  accent: Accent;
  checked: boolean;
  muted?: boolean;
  theme: Theme;
}) {
  const { styles } = useProviderStyles();
  return (
    <View
      style={[
        styles.checkbox,
        checked && {
          backgroundColor: muted ? theme.t.textTertiary : accent.accent,
          borderColor: muted ? theme.t.textTertiary : accent.accent,
        },
      ]}
    >
      {checked ? <RiCheckLine color={theme.t.onAccent} size={13} /> : null}
    </View>
  );
}

/**
 * One model row. Memoized so a single checkbox toggle (or a search keystroke)
 * only re-renders the rows that actually changed — the list can hold ~300 models.
 */
const PickerRow = memo(function PickerRow({
  added,
  checked,
  model,
  onToggle,
}: {
  added: boolean;
  checked: boolean;
  model: FetchedProviderModel;
  onToggle: (id: string) => void;
}) {
  const { styles, theme, accent } = useProviderStyles();
  const displayName = model.name.trim() || model.id;
  const showsSeparateId = displayName.toLowerCase() !== model.id.toLowerCase();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: added }}
      disabled={added}
      onPress={() => onToggle(model.id)}
      style={({ hovered }: PressState) => [
        styles.pickerRow,
        motion,
        hovered && !added && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
      ]}
    >
      <Checkbox accent={accent} checked={checked} muted={added} theme={theme} />
      <View style={styles.pickerRowBody}>
        <Text
          numberOfLines={1}
          style={[
            showsSeparateId ? styles.pickerRowName : styles.pickerRowText,
            added && styles.pickerRowTextMuted,
          ]}
        >
          {displayName}
        </Text>
        {showsSeparateId ? (
          <Text
            numberOfLines={1}
            style={[styles.pickerRowMeta, added && styles.pickerRowTextMuted]}
          >
            {model.id}
          </Text>
        ) : null}
      </View>
      {model.capabilities.length > 0 ? (
        <View style={styles.pickerRowCapabilities}>
          {model.capabilities.map((capability) => (
            <Text key={capability} style={styles.pickerCapability}>
              {capabilityLabel(capability)}
            </Text>
          ))}
        </View>
      ) : null}
      {added ? <Text style={styles.pickerAdded}>已添加</Text> : null}
    </Pressable>
  );
});

function optionalNonNegative(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function optionalNonNegativeInteger(value: string): number | null {
  const parsed = optionalNonNegative(value);
  return parsed == null ? null : Math.floor(parsed);
}

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, hour) => hour);

function ModelEditor({
  existingIds,
  initial,
  onCancel,
  onSave,
  providerKind,
}: {
  existingIds: string[];
  initial: ProviderModel | null;
  onCancel: () => void;
  onSave: (model: ProviderModel) => void;
  providerKind: string;
}) {
  const { styles, theme, accent } = useProviderStyles();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [size, setSize] = useState(initial?.size ?? "");
  const [contextLength, setContextLength] = useState(
    initial?.contextLength == null ? "" : String(initial.contextLength),
  );
  const [inputPrice, setInputPrice] = useState(
    initial?.inputPrice == null ? "" : String(initial.inputPrice),
  );
  const [outputPrice, setOutputPrice] = useState(
    initial?.outputPrice == null ? "" : String(initial.outputPrice),
  );
  const [cacheHitInputPrice, setCacheHitInputPrice] = useState(
    initial?.cacheHitInputPrice == null ? "" : String(initial.cacheHitInputPrice),
  );
  const [peakPricingEnabled, setPeakPricingEnabled] = useState(
    initial?.peakPricingEnabled ?? false,
  );
  const [peakInputPrice, setPeakInputPrice] = useState(
    initial?.peakInputPrice == null ? "" : String(initial.peakInputPrice),
  );
  const [peakOutputPrice, setPeakOutputPrice] = useState(
    initial?.peakOutputPrice == null ? "" : String(initial.peakOutputPrice),
  );
  const [peakCacheHitInputPrice, setPeakCacheHitInputPrice] = useState(
    initial?.peakCacheHitInputPrice == null ? "" : String(initial.peakCacheHitInputPrice),
  );
  const [peakTimeRanges, setPeakTimeRanges] = useState<PricingTimeRange[]>(() => {
    const configured = pricingTimeRanges(initial);
    const defaults =
      providerKind === "deepseek" ? DEEPSEEK_PEAK_TIME_RANGES : [{ startHour: 8, endHour: 24 }];
    return (configured.length > 0 ? configured : defaults).map((range) => ({ ...range }));
  });
  const [caps, setCaps] = useState<string[]>(initial ? modelCapabilities(initial) : []);
  const isEdit = initial != null;
  const idTaken = !isEdit && existingIds.includes(id.trim());
  const peakTimeRangesValid =
    !peakPricingEnabled || peakTimeRanges.every((range) => range.startHour !== range.endHour);
  const canSave = id.trim().length > 0 && !idTaken && peakTimeRangesValid;
  const editorSelectStyle: CSSProperties = {
    appearance: "auto",
    backgroundColor: theme.t.cardSurfaceAlt,
    border: `1px solid ${theme.t.separator}`,
    borderRadius: 8,
    boxSizing: "border-box",
    color: theme.t.textPrimary,
    fontSize: 12,
    height: 32,
    minHeight: 32,
    padding: "0 10px",
    width: "100%",
  };

  function toggleCap(value: string) {
    setCaps((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function updatePeakTimeRange(index: number, field: keyof PricingTimeRange, value: number) {
    setPeakTimeRanges((current) =>
      current.map((range, rangeIndex) =>
        rangeIndex === index ? { ...range, [field]: value } : range,
      ),
    );
  }

  return (
    <View style={styles.editorCard}>
      <View style={styles.editorRow}>
        <View style={styles.editorField}>
          <Text style={styles.editorFieldLabel}>模型 ID</Text>
          <TextInput
            autoCapitalize="none"
            editable={!isEdit}
            onChangeText={setId}
            placeholder="如 gpt-4o"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, styles.editorInput, isEdit && ({ opacity: 0.6 } as ViewStyle)]}
            value={id}
          />
        </View>
        <View style={styles.editorField}>
          <Text style={styles.editorFieldLabel}>显示名称</Text>
          <TextInput
            onChangeText={setName}
            placeholder="可选"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, styles.editorInput]}
            value={name}
          />
        </View>
      </View>
      <View style={styles.editorRow}>
        <View style={styles.editorField}>
          <Text style={styles.editorFieldLabel}>规模</Text>
          <TextInput
            onChangeText={setSize}
            placeholder="如 ~100B"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, styles.editorInput]}
            value={size}
          />
        </View>
        <View style={styles.editorField}>
          <Text style={styles.editorFieldLabel}>上下文长度</Text>
          <TextInput
            inputMode="numeric"
            onChangeText={setContextLength}
            placeholder="如 1000000"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, styles.editorInput]}
            value={contextLength}
          />
        </View>
      </View>

      <View style={styles.editorSection}>
        <View style={styles.editorPricingHeader}>
          <Text style={styles.editorPricingTitle}>模型定价</Text>
          <Text style={styles.editorPricingHint}>人民币 / 百万 tokens；留空则不估算</Text>
          <View style={styles.editorPeakToggle}>
            <Text style={styles.editorPricingTitle}>分时定价</Text>
            <Toggle onChange={setPeakPricingEnabled} value={peakPricingEnabled} />
          </View>
        </View>
        <View style={styles.editorRow}>
          <View style={styles.editorField}>
            <Text style={styles.editorFieldLabel}>输入价格</Text>
            <TextInput
              inputMode="decimal"
              onChangeText={setInputPrice}
              placeholder="如 1"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.editorInput]}
              value={inputPrice}
            />
          </View>
          <View style={styles.editorField}>
            <Text style={styles.editorFieldLabel}>输出价格</Text>
            <TextInput
              inputMode="decimal"
              onChangeText={setOutputPrice}
              placeholder="如 2"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.editorInput]}
              value={outputPrice}
            />
          </View>
          <View style={styles.editorField}>
            <Text style={styles.editorFieldLabel}>缓存命中输入价</Text>
            <TextInput
              inputMode="decimal"
              onChangeText={setCacheHitInputPrice}
              placeholder="如 0.02"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.editorInput]}
              value={cacheHitInputPrice}
            />
          </View>
        </View>

        {peakPricingEnabled ? (
          <View style={styles.peakPanel}>
            <View style={styles.editorPricingHeader}>
              <Text style={styles.editorPricingTitle}>波峰时段（北京时间）</Text>
              <Text style={styles.editorPricingHint}>可添加多个时段；结束时间不包含在内</Text>
            </View>
            {peakTimeRanges.map((range, index) => (
              <View key={index} style={styles.peakRangeRow}>
                <Text style={styles.peakRangeNumber}>时段 {index + 1}</Text>
                <View style={styles.editorField}>
                  <Text style={styles.editorFieldLabel}>开始</Text>
                  <select
                    aria-label={`波峰时段 ${index + 1} 开始`}
                    onChange={(event) =>
                      updatePeakTimeRange(index, "startHour", Number(event.target.value))
                    }
                    style={editorSelectStyle}
                    value={range.startHour}
                  >
                    {HOUR_OPTIONS.slice(0, 24).map((hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </View>
                <View style={styles.editorField}>
                  <Text style={styles.editorFieldLabel}>结束</Text>
                  <select
                    aria-label={`波峰时段 ${index + 1} 结束`}
                    onChange={(event) =>
                      updatePeakTimeRange(index, "endHour", Number(event.target.value))
                    }
                    style={editorSelectStyle}
                    value={range.endHour}
                  >
                    {HOUR_OPTIONS.map((hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </View>
                <Pressable
                  accessibilityLabel={`删除波峰时段 ${index + 1}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: peakTimeRanges.length === 1 }}
                  disabled={peakTimeRanges.length === 1}
                  onPress={() =>
                    setPeakTimeRanges((current) =>
                      current.filter((_, rangeIndex) => rangeIndex !== index),
                    )
                  }
                  style={({ hovered, pressed }: PressState) => [
                    styles.peakRangeDelete,
                    motion,
                    (hovered || pressed) && peakTimeRanges.length > 1 && styles.iconButtonHover,
                    peakTimeRanges.length === 1 && ({ opacity: 0.35 } as ViewStyle),
                  ]}
                >
                  <RiDeleteBinLine color={theme.t.textTertiary} size={14} />
                </Pressable>
              </View>
            ))}
            <Pressable
              accessibilityLabel="添加波峰时段"
              accessibilityRole="button"
              onPress={() =>
                setPeakTimeRanges((current) => [...current, { startHour: 8, endHour: 24 }])
              }
              style={({ hovered, pressed }: PressState) => [
                styles.peakRangeAdd,
                motion,
                (hovered || pressed) && styles.iconButtonHover,
              ]}
            >
              <RiAddLine color={accent.accentText} size={13} />
              <Text style={styles.peakRangeAddText}>添加时段</Text>
            </Pressable>
            {!peakTimeRangesValid ? (
              <Text style={styles.testResultErr}>波峰时段的开始和结束时间不能相同。</Text>
            ) : null}
            <View style={styles.editorRow}>
              <View style={styles.editorField}>
                <Text style={styles.editorFieldLabel}>波峰输入价格</Text>
                <TextInput
                  inputMode="decimal"
                  onChangeText={setPeakInputPrice}
                  placeholder={inputPrice || "如 2"}
                  placeholderTextColor={theme.t.textTertiary}
                  style={[styles.input, styles.editorInput]}
                  value={peakInputPrice}
                />
              </View>
              <View style={styles.editorField}>
                <Text style={styles.editorFieldLabel}>波峰输出价格</Text>
                <TextInput
                  inputMode="decimal"
                  onChangeText={setPeakOutputPrice}
                  placeholder={outputPrice || "如 4"}
                  placeholderTextColor={theme.t.textTertiary}
                  style={[styles.input, styles.editorInput]}
                  value={peakOutputPrice}
                />
              </View>
              <View style={styles.editorField}>
                <Text style={styles.editorFieldLabel}>波峰缓存输入价</Text>
                <TextInput
                  inputMode="decimal"
                  onChangeText={setPeakCacheHitInputPrice}
                  placeholder={cacheHitInputPrice || "沿用波谷价"}
                  placeholderTextColor={theme.t.textTertiary}
                  style={[styles.input, styles.editorInput]}
                  value={peakCacheHitInputPrice}
                />
              </View>
            </View>
          </View>
        ) : null}
      </View>
      <View style={styles.editorSection}>
        <View style={styles.editorPricingHeader}>
          <Text style={styles.editorPricingTitle}>模型能力</Text>
          <Text style={styles.editorPricingHint}>自动识别可能不完整，可在这里手动修正</Text>
        </View>
        <View style={styles.editorFooter}>
          <View style={styles.editorCapabilityRow}>
            {CAPABILITIES.map((cap) => {
              const on = caps.includes(cap.value);
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  key={cap.value}
                  onPress={() => toggleCap(cap.value)}
                  style={[styles.chip, motion, on && styles.chipActive]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextActive]}>{cap.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.editorActions}>
            <Pressable
              accessibilityRole="button"
              disabled={!canSave}
              onPress={() => {
                const previousCategory = normalizeCategory(initial?.category);
                const inferredCategory = inferModelCategory(id);
                // Non-chat categories: preserved as-is on save so a name/price
                // edit can't recompute an image/audio/video/embedding model into a
                // chat category (which would leak it into the chat model pickers).
                const specialCategories = new Set(["embedding", "audio", "video", "image"]);
                const category = specialCategories.has(previousCategory)
                  ? previousCategory
                  : specialCategories.has(inferredCategory)
                    ? inferredCategory
                    : caps.includes("image") || caps.includes("video")
                      ? "vision"
                      : "text";
                onSave({
                  id: id.trim(),
                  name: name.trim(),
                  capabilities: caps,
                  category,
                  size: size.trim(),
                  starred: initial?.starred ?? false,
                  contextLength: optionalNonNegativeInteger(contextLength),
                  inputModalities: initial?.inputModalities ?? [],
                  outputModalities: initial?.outputModalities ?? [],
                  inputPrice: optionalNonNegative(inputPrice),
                  outputPrice: optionalNonNegative(outputPrice),
                  cacheHitInputPrice: optionalNonNegative(cacheHitInputPrice),
                  peakPricingEnabled,
                  peakInputPrice: optionalNonNegative(peakInputPrice),
                  peakOutputPrice: optionalNonNegative(peakOutputPrice),
                  peakCacheHitInputPrice: optionalNonNegative(peakCacheHitInputPrice),
                  peakTimeRanges,
                });
              }}
              style={({ hovered, pressed }: PressState) => [
                styles.primaryButton,
                motion,
                hovered && canSave && ({ filter: "brightness(1.06)" } as ViewStyle),
                pressed && ({ opacity: 0.9 } as ViewStyle),
                !canSave && ({ opacity: 0.5 } as ViewStyle),
              ]}
            >
              <Text style={styles.primaryButtonText}>{isEdit ? "保存" : "添加"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ hovered, pressed }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                pressed && ({ opacity: 0.7 } as ViewStyle),
              ]}
            >
              <Text style={styles.ghostButtonText}>取消</Text>
            </Pressable>
          </View>
          {idTaken && <Text style={styles.testResultErr}>该模型 ID 已存在</Text>}
        </View>
      </View>
    </View>
  );
}
