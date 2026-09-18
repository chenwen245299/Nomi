import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { RiArrowDownSLine, RiCheckLine, RiRefreshLine } from "@remixicon/react";
import { BrandIcon } from "../providers/BrandIcon";
import { modelIconUrl } from "../providers/icons";
import {
  currentPricingPeriod,
  isChatModel,
  type Provider,
  type ProviderBalance,
  type ProviderModel,
} from "../providers/api";
import { modalShadow, motion, useTheme, type Accent, type Theme } from "../theme";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
type LoadState =
  | { status: "loading" }
  | { status: "ready"; balance: ProviderBalance }
  | { status: "error"; error: string };

type MenuPosition = { left: number; maxHeight: number; top: number; width: number };

function providerInitial(provider: Provider): string {
  return provider.name.trim().slice(0, 1).toUpperCase() || "M";
}

function formatContextLength(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }
  return String(value);
}

function modelContextLength(model: ProviderModel): number | null {
  if (model.contextLength != null && model.contextLength > 0) return model.contextLength;
  const id = model.id.toLowerCase();
  if (id === "deepseek-v4-flash" || id === "deepseek-v4-pro") return 1_000_000;
  return null;
}

function modelMeta(model: ProviderModel): string {
  const parts = [model.size.trim()];
  if (model.category === "vision") {
    parts.push("视觉");
  }
  if (model.capabilities.includes("reasoning")) {
    parts.push("推理");
  }
  if (model.capabilities.includes("tool")) {
    parts.push("工具");
  }
  const contextLength = modelContextLength(model);
  if (contextLength) {
    parts.push(formatContextLength(contextLength));
  }
  return parts.filter(Boolean).join(" · ");
}

function periodLabel(period: ReturnType<typeof currentPricingPeriod>): string | null {
  if (period === "peak") return "波峰";
  if (period === "offPeak") return "波谷";
  return null;
}

function currencySymbol(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (code === "CNY" || code === "RMB") return "¥";
  if (code === "USD") return "$";
  if (code === "EUR") return "€";
  return `${code} `;
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function balanceLabel(state: LoadState | undefined, provider: Provider): string {
  if (!provider.hasKey) return "未配置密钥";
  if (!state) return "--";
  if (state.status === "loading") return "";
  if (state.status === "error") return "查询失败";
  // A MoleAPI 无限额度 key has no meaningful remaining figure.
  if (state.balance.unlimited) return "不限额";
  const { currency, remaining } = state.balance;
  return `${currencySymbol(currency)}${formatAmount(remaining)}`;
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    trigger: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 30,
      maxWidth: 250,
      minWidth: 164,
      paddingHorizontal: 8,
    },
    triggerHover: { backgroundColor: t.controlHover },
    triggerOpen: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.12)`,
    },
    triggerText: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 11.5,
      fontWeight: "600",
      minWidth: 0,
    },
    overlay: {
      bottom: 0,
      left: 0,
      position: "fixed",
      right: 0,
      top: 0,
      zIndex: 90,
    } as unknown as ViewStyle,
    menu: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 12,
      borderWidth: 1,
      overflow: "hidden",
      position: "relative",
      boxShadow: modalShadow(t),
    },
    menuHeader: {
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      paddingBottom: 9,
      paddingHorizontal: 12,
      paddingTop: 10,
    },
    menuTitle: { color: t.textPrimary, fontSize: 11.5, fontWeight: "700" },
    menuError: { color: t.errorText, fontSize: 10.5, marginTop: 4 },
    menuScroll: { minHeight: 72 },
    menuContent: { paddingBottom: 7, paddingHorizontal: 6, paddingTop: 2 },
    providerGroup: { marginTop: 5 },
    providerHeader: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 24,
      paddingHorizontal: 7,
    },
    providerName: {
      color: t.textTertiary,
      flex: 1,
      fontSize: 9.5,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    balancePill: {
      backgroundColor: t.controlIdle,
      borderRadius: 6,
      marginLeft: 4,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    balanceText: { color: t.textSecondary, fontSize: 10, fontWeight: "600" },
    periodPill: {
      backgroundColor: "rgba(48,142,120,0.10)",
      borderColor: "rgba(48,142,120,0.20)",
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    periodPillPeak: {
      backgroundColor: "rgba(196,106,26,0.09)",
      borderColor: "rgba(196,106,26,0.20)",
    },
    periodText: { color: t.statusGreenText, fontSize: 9.5, fontWeight: "700" },
    periodTextPeak: { color: "#B65F16" },
    refreshButton: {
      alignItems: "center",
      borderRadius: 7,
      height: 22,
      justifyContent: "center",
      marginLeft: 4,
      width: 22,
    },
    refreshButtonHover: { backgroundColor: t.controlHover },
    refreshButtonDisabled: { opacity: 0.45 },
    modelRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 8,
      minHeight: 42,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    modelRowHover: { backgroundColor: t.controlHover },
    modelRowSelected: { backgroundColor: accent.selectedFill },
    modelBody: { flex: 1, minWidth: 0 },
    modelName: { color: t.textPrimary, fontSize: 11.5, fontWeight: "600" },
    modelMeta: { color: t.textTertiary, fontSize: 9.5, marginTop: 2 },
    selectedMark: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 16,
      justifyContent: "center",
      width: 16,
    },
    empty: { alignItems: "center", justifyContent: "center", padding: 22 },
    emptyText: { color: t.textTertiary, fontSize: 11, textAlign: "center" },
  });
}

export function ConversationModelPicker({
  accent,
  accessibilityLabel = "选择回答模型",
  inheritOption,
  modelId,
  menuTitle = "选择回答模型",
  onBalance,
  onSelect,
  providerId,
  providers,
}: {
  accent: Accent;
  accessibilityLabel?: string;
  inheritOption?: {
    active: boolean;
    label: string;
    onSelect: () => Promise<void>;
  };
  modelId: string | null;
  menuTitle?: string;
  onBalance: (providerId: string) => Promise<ProviderBalance>;
  onSelect: (providerId: string, modelId: string) => Promise<void>;
  providerId: string | null;
  providers: Provider[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // `entered` drives the open/close transition; the menu stays mounted while
  // `open` is true and only unmounts after the exit animation finishes.
  const [entered, setEntered] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [balances, setBalances] = useState<Record<string, LoadState>>({});
  const [selectError, setSelectError] = useState("");

  const groups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(isChatModel),
        }))
        .filter((group) => group.models.length > 0),
    [providers],
  );

  const selectedProvider = groups.find((group) => group.provider.id === providerId)?.provider;
  const selectedModel = selectedProvider?.models.find((model) => model.id === modelId);
  const selectedPeriod = currentPricingPeriod(selectedModel);
  const selectedPeriodLabel = periodLabel(selectedPeriod);
  const selectedLabel =
    selectedProvider && selectedModel
      ? `${selectedProvider.name}: ${selectedModel.name || selectedModel.id}`
      : "选择模型";

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Match the dropdown width to the trigger button so they line up flush.
    const width = Math.min(rect.width, window.innerWidth - 24);
    const top = rect.bottom + 6;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      maxHeight: Math.max(180, window.innerHeight - top - 12),
      top,
      width,
    });
  }, []);

  const requestOpen = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    requestAnimationFrame(updatePosition);
    setOpen(true);
    // Re-trigger the enter animation even if a close was mid-flight (still mounted).
    requestAnimationFrame(() => setEntered(true));
  }, [updatePosition]);

  const requestClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setEntered(false);
    closeTimer.current = window.setTimeout(() => setOpen(false), 190);
  }, []);

  // Flip `entered` on the frame after mount so the enter transition plays.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const loadBalance = useCallback(
    async (provider: Provider) => {
      setBalances((prev) => ({ ...prev, [provider.id]: { status: "loading" } }));
      try {
        const balance = await onBalance(provider.id);
        setBalances((prev) => ({ ...prev, [provider.id]: { status: "ready", balance } }));
      } catch (error) {
        setBalances((prev) => ({
          ...prev,
          [provider.id]: { status: "error", error: String(error) },
        }));
      }
    },
    [onBalance],
  );

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    for (const { provider } of groups) {
      if (provider.supportsBalance && provider.hasKey && !balances[provider.id]) {
        void loadBalance(provider);
      }
    }
  }, [balances, groups, loadBalance, open]);

  async function choose(provider: Provider, model: ProviderModel) {
    setSelectError("");
    try {
      await onSelect(provider.id, model.id);
      requestClose();
    } catch (error) {
      setSelectError(String(error));
    }
  }

  async function chooseInherited() {
    if (!inheritOption) return;
    setSelectError("");
    try {
      await inheritOption.onSelect();
      requestClose();
    } catch (error) {
      setSelectError(String(error));
    }
  }

  return (
    <>
      <div ref={triggerRef} style={{ flexShrink: 0 }}>
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => (open ? requestClose() : requestOpen())}
          style={({ hovered, pressed }: PressState) => [
            styles.trigger,
            motion,
            hovered && !open && styles.triggerHover,
            open && styles.triggerOpen,
            pressed && ({ opacity: 0.82 } as ViewStyle),
          ]}
        >
          <BrandIcon
            accent={accent}
            fallback={selectedProvider ? providerInitial(selectedProvider) : "M"}
            size={20}
            url={
              selectedModel
                ? modelIconUrl(selectedModel.id, selectedModel.name)
                : selectedProvider
                  ? modelIconUrl(selectedProvider.kind, selectedProvider.name)
                  : null
            }
          />
          <Text numberOfLines={1} style={styles.triggerText}>
            {selectedLabel}
          </Text>
          {selectedPeriodLabel ? (
            <View style={[styles.periodPill, selectedPeriod === "peak" && styles.periodPillPeak]}>
              <Text style={[styles.periodText, selectedPeriod === "peak" && styles.periodTextPeak]}>
                {selectedPeriodLabel}
              </Text>
            </View>
          ) : null}
          <RiArrowDownSLine
            color={theme.t.textTertiary}
            size={14}
            style={{
              transform: open ? "rotate(180deg)" : undefined,
              transition: "transform 0.15s",
            }}
          />
        </Pressable>
      </div>

      {open && position
        ? createPortal(
            <div
              onMouseDown={() => requestClose()}
              style={{ inset: 0, position: "fixed", zIndex: 90 }}
            >
              <View style={styles.overlay} />
              <div
                onMouseDown={(event) => event.stopPropagation()}
                role="dialog"
                aria-label={menuTitle}
                style={{
                  left: position.left,
                  maxHeight: position.maxHeight,
                  position: "fixed",
                  top: position.top,
                  width: position.width,
                  zIndex: 91,
                  transformOrigin: "top center",
                  opacity: entered ? 1 : 0,
                  transform: entered ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.97)",
                  transition: theme.reduceMotion
                    ? "none"
                    : "opacity 150ms ease, transform 200ms cubic-bezier(0.32,0.72,0,1)",
                  willChange: "opacity, transform",
                }}
              >
                <View
                  style={[styles.menu, { maxHeight: position.maxHeight, width: position.width }]}
                >
                  <View style={styles.menuHeader}>
                    <Text style={styles.menuTitle}>{menuTitle}</Text>
                    {selectError ? (
                      <Text numberOfLines={2} style={styles.menuError}>
                        {selectError}
                      </Text>
                    ) : null}
                  </View>
                  <ScrollView
                    contentContainerStyle={styles.menuContent}
                    style={[styles.menuScroll, { maxHeight: position.maxHeight - 42 }]}
                  >
                    {inheritOption ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: inheritOption.active }}
                        onPress={() => void chooseInherited()}
                        style={({ hovered, pressed }: PressState) => [
                          styles.modelRow,
                          { marginTop: 5 } as ViewStyle,
                          motion,
                          hovered && !inheritOption.active && styles.modelRowHover,
                          inheritOption.active && styles.modelRowSelected,
                          pressed && ({ opacity: 0.8 } as ViewStyle),
                        ]}
                      >
                        <BrandIcon
                          accent={accent}
                          fallback={selectedProvider ? providerInitial(selectedProvider) : "M"}
                          size={26}
                          url={
                            selectedModel
                              ? modelIconUrl(selectedModel.id, selectedModel.name)
                              : null
                          }
                        />
                        <View style={styles.modelBody}>
                          <Text numberOfLines={1} style={styles.modelName}>
                            {inheritOption.label}
                          </Text>
                          <Text numberOfLines={1} style={styles.modelMeta}>
                            全局默认模型变更时自动跟随
                          </Text>
                        </View>
                        {inheritOption.active ? (
                          <View style={styles.selectedMark}>
                            <RiCheckLine color={theme.t.onAccent} size={11} />
                          </View>
                        ) : null}
                      </Pressable>
                    ) : null}
                    {groups.length === 0 ? (
                      <View style={styles.empty}>
                        <Text style={styles.emptyText}>
                          暂无可用模型，请先在设置中启用服务商并添加模型。
                        </Text>
                      </View>
                    ) : (
                      groups.map(({ provider, models }) => {
                        const balanceState = balances[provider.id];
                        const supportsBalance = provider.supportsBalance ?? false;
                        // Peak / off-peak applies provider-wide — surface it on the
                        // group header too, not just the selected-model button.
                        const providerPeriod =
                          models
                            .map((model) => currentPricingPeriod(model))
                            .find((period) => period != null) ?? null;
                        return (
                          <View key={provider.id} style={styles.providerGroup}>
                            <View style={styles.providerHeader}>
                              <Text numberOfLines={1} style={styles.providerName}>
                                {provider.name || "未命名服务商"}
                              </Text>
                              {providerPeriod ? (
                                <View
                                  style={[
                                    styles.periodPill,
                                    { marginLeft: 6 } as ViewStyle,
                                    providerPeriod === "peak" && styles.periodPillPeak,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.periodText,
                                      providerPeriod === "peak" && styles.periodTextPeak,
                                    ]}
                                  >
                                    {periodLabel(providerPeriod)}
                                  </Text>
                                </View>
                              ) : null}
                              {supportsBalance ? (
                                <>
                                  <Pressable
                                    accessibilityLabel={`刷新${provider.name || "DeepSeek"}余额`}
                                    accessibilityRole="button"
                                    disabled={
                                      !provider.hasKey || balanceState?.status === "loading"
                                    }
                                    onPress={() => void loadBalance(provider)}
                                    style={({ hovered, pressed }: PressState) => [
                                      styles.refreshButton,
                                      motion,
                                      hovered && styles.refreshButtonHover,
                                      pressed && ({ opacity: 0.72 } as ViewStyle),
                                      (!provider.hasKey || balanceState?.status === "loading") &&
                                        styles.refreshButtonDisabled,
                                    ]}
                                  >
                                    <RiRefreshLine color={theme.t.textTertiary} size={13} />
                                  </Pressable>
                                  <View style={styles.balancePill}>
                                    {balanceState?.status === "loading" ? (
                                      <ActivityIndicator
                                        color={theme.t.textTertiary}
                                        size="small"
                                      />
                                    ) : (
                                      <Text style={styles.balanceText}>
                                        {balanceLabel(balanceState, provider)}
                                      </Text>
                                    )}
                                  </View>
                                </>
                              ) : null}
                            </View>

                            {models.map((model) => {
                              const selected =
                                !inheritOption?.active &&
                                provider.id === providerId &&
                                model.id === modelId;
                              return (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityState={{ selected }}
                                  key={model.id}
                                  onPress={() => void choose(provider, model)}
                                  style={({ hovered, pressed }: PressState) => [
                                    styles.modelRow,
                                    motion,
                                    hovered && !selected && styles.modelRowHover,
                                    selected && styles.modelRowSelected,
                                    pressed && ({ opacity: 0.8 } as ViewStyle),
                                  ]}
                                >
                                  <BrandIcon
                                    accent={accent}
                                    fallback={providerInitial(provider)}
                                    size={26}
                                    url={modelIconUrl(model.id, model.name)}
                                  />
                                  <View style={styles.modelBody}>
                                    <Text numberOfLines={1} style={styles.modelName}>
                                      {model.name || model.id}
                                    </Text>
                                    {modelMeta(model) ? (
                                      <Text numberOfLines={1} style={styles.modelMeta}>
                                        {modelMeta(model)}
                                      </Text>
                                    ) : null}
                                  </View>
                                  {selected ? (
                                    <View style={styles.selectedMark}>
                                      <RiCheckLine color={theme.t.onAccent} size={11} />
                                    </View>
                                  ) : null}
                                </Pressable>
                              );
                            })}
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
