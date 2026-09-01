import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiExternalLinkLine,
  RiFolderOpenLine,
  RiGlobalLine,
  RiRefreshLine,
} from "@remixicon/react";
import {
  enterFade,
  enterModal,
  glass,
  modalShadow,
  motion,
  shimmerStyle,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { deleteMap, downloadMap, importMap, revealMaps, updateMap, type OfflineMap } from "./api";

type PressState = { pressed: boolean; hovered?: boolean };

interface ProgressPayload {
  name: string;
  received: number;
  total: number;
  done: boolean;
}

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/**
 * Manage offline basemaps: choose the active basemap (online Protomaps or a
 * downloaded archive), download a `.pmtiles` from a URL (with a live progress
 * bar), import one from disk, update, or delete. Everything lands in the
 * `travel/maps` folder.
 */
export function OfflineMaps({
  accent,
  basemap,
  maps,
  onSelectBasemap,
  onChanged,
  onClose,
}: {
  accent: Accent;
  basemap: string;
  maps: OfflineMap[];
  onSelectBasemap: (basemap: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({});

  // Live download / update progress from the backend.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let dispose: (() => void) | undefined;
    void listen<ProgressPayload>("travel://map-progress", (event) => {
      const payload = event.payload;
      setProgress((prev) => ({ ...prev, [payload.name]: payload }));
      if (payload.done) {
        window.setTimeout(() => {
          setProgress((prev) => {
            const next = { ...prev };
            delete next[payload.name];
            return next;
          });
        }, 800);
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  const guard = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const startDownload = () =>
    guard("download", async () => {
      const trimmedName = name.trim() || "离线地图";
      if (!url.trim()) throw new Error("请填写 .pmtiles 下载地址。");
      await downloadMap(trimmedName, url.trim());
      setName("");
      setUrl("");
    });

  const startImport = () =>
    guard("import", async () => {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
      });
      if (typeof picked !== "string") return;
      const stem =
        picked
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.pmtiles$/i, "") ?? "离线地图";
      await importMap(name.trim() || stem, picked);
      setName("");
    });

  return createPortal(
    <View style={[styles.scrim, glass(8, 115), enterFade()]}>
      <Pressable accessibilityLabel="关闭" onPress={onClose} style={styles.scrimHit} />
      <View style={[styles.card, glass(40, 180), enterModal()]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>离线地图</Text>
            <Text style={styles.subtitle}>
              下载后即可离线浏览，数据保存在 travel/maps 文件夹，可随时更新。
            </Text>
          </View>
          <Pressable
            accessibilityLabel="关闭"
            accessibilityRole="button"
            onPress={onClose}
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
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {/* Online basemap */}
          <BasemapRow
            active={basemap === "online"}
            accent={accent}
            icon={
              <RiGlobalLine
                color={basemap === "online" ? accent.accentText : theme.t.textSecondary}
                size={16}
              />
            }
            onSelect={() => onSelectBasemap("online")}
            styles={styles}
            subtitle="OpenFreeMap 在线矢量底图（需要联网）"
            theme={theme}
            title="在线地图"
          />

          {maps.map((map) => {
            const prog = progress[map.name];
            const active = basemap === map.name;
            return (
              <View key={map.name} style={styles.mapCard}>
                <BasemapRow
                  active={active}
                  accent={accent}
                  onSelect={() => onSelectBasemap(map.name)}
                  styles={styles}
                  subtitle={`${formatBytes(map.bytes)}${map.sourceUrl ? " · 可更新" : " · 本地导入"}`}
                  theme={theme}
                  title={map.name}
                />
                {prog ? (
                  <View style={styles.progressWrap}>
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: prog.total
                              ? `${Math.min(100, (prog.received / prog.total) * 100)}%`
                              : "40%",
                          } as ViewStyle,
                        ]}
                      >
                        <View style={[styles.progressShimmer, shimmerStyle]} />
                      </View>
                    </View>
                    <Text style={styles.progressText}>
                      {formatBytes(prog.received)}
                      {prog.total ? ` / ${formatBytes(prog.total)}` : ""}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.mapActions}>
                    {map.sourceUrl ? (
                      <MiniButton
                        busy={busy === `update-${map.name}`}
                        icon={<RiRefreshLine color={theme.t.textSecondary} size={14} />}
                        label="更新"
                        onPress={() =>
                          void guard(`update-${map.name}`, () =>
                            updateMap(map.name).then(() => undefined),
                          )
                        }
                        styles={styles}
                        theme={theme}
                      />
                    ) : null}
                    <MiniButton
                      danger
                      icon={<RiDeleteBinLine color={theme.t.errorText} size={14} />}
                      label="删除"
                      onPress={() =>
                        void guard(`delete-${map.name}`, async () => {
                          await deleteMap(map.name);
                          if (active) onSelectBasemap("online");
                        })
                      }
                      styles={styles}
                      theme={theme}
                    />
                  </View>
                )}
              </View>
            );
          })}

          {/* Add new */}
          <View style={styles.addSection}>
            <Text style={styles.sectionTitle}>添加离线地图</Text>
            <TextInput
              accessibilityLabel="地图名称"
              onChangeText={setName}
              placeholder="名称，例如 华东 / 中国"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={name}
            />
            <TextInput
              accessibilityLabel="下载地址"
              autoCapitalize="none"
              onChangeText={setUrl}
              placeholder="https://…/area.pmtiles 下载地址"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={url}
            />
            <View style={styles.addActions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy === "download"}
                onPress={() => void startDownload()}
                style={[styles.primaryButton, busy === "download" && { opacity: 0.6 }]}
              >
                {busy === "download" ? (
                  <ActivityIndicator color={theme.t.onAccent} size="small" />
                ) : (
                  <RiDownload2Line color={theme.t.onAccent} size={15} />
                )}
                <Text style={styles.primaryButtonText}>下载</Text>
              </Pressable>
              {isTauriRuntime() ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy === "import"}
                  onPress={() => void startImport()}
                  style={({ hovered }: PressState) => [
                    styles.secondaryButton,
                    motion,
                    hovered && { backgroundColor: theme.t.controlHover },
                    busy === "import" && { opacity: 0.6 },
                  ]}
                >
                  <RiFolderOpenLine color={theme.t.textSecondary} size={15} />
                  <Text style={styles.secondaryButtonText}>导入本地文件</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.hint}>
              没有下载地址？用 Protomaps 免费框选任意区域生成
              .pmtiles，把它给出的链接粘到上面即可下载（或下载文件后用「导入本地文件」）。
            </Text>
            <Pressable
              accessibilityRole="link"
              onPress={() => void openUrl("https://app.protomaps.com/")}
              style={({ hovered }: PressState) => [
                styles.linkButton,
                motion,
                hovered && { backgroundColor: theme.t.controlHover },
              ]}
            >
              <RiExternalLinkLine color={accent.accentText} size={14} />
              <Text style={styles.linkText}>打开 Protomaps 下载页</Text>
            </Pressable>
          </View>
        </ScrollView>

        {isTauriRuntime() ? (
          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void revealMaps()}
              style={({ hovered }: PressState) => [
                styles.footerButton,
                motion,
                hovered && { backgroundColor: theme.t.controlHover },
              ]}
            >
              <RiFolderOpenLine color={theme.t.textTertiary} size={14} />
              <Text style={styles.footerButtonText}>打开地图数据文件夹</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>,
    document.body,
  );
}

function BasemapRow({
  accent,
  active,
  icon,
  onSelect,
  styles,
  subtitle,
  theme,
  title,
}: {
  accent: Accent;
  active: boolean;
  icon?: React.ReactNode;
  onSelect: () => void;
  styles: OfflineStyles;
  subtitle: string;
  theme: Theme;
  title: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onSelect}
      style={({ hovered }: PressState) => [
        styles.basemapRow,
        motion,
        active && styles.basemapRowActive,
        !active && hovered && { backgroundColor: theme.t.controlHover },
      ]}
    >
      {icon ?? <View style={{ width: 16 }} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={styles.basemapTitle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.basemapSubtitle}>
          {subtitle}
        </Text>
      </View>
      {active ? (
        <View style={styles.activeBadge}>
          <RiCheckLine color={accent.accentText} size={13} />
          <Text style={styles.activeBadgeText}>使用中</Text>
        </View>
      ) : (
        <Text style={styles.selectHint}>选用</Text>
      )}
    </Pressable>
  );
}

function MiniButton({
  busy,
  danger,
  icon,
  label,
  onPress,
  styles,
  theme,
}: {
  busy?: boolean;
  danger?: boolean;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  styles: OfflineStyles;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.miniButton,
        motion,
        hovered && { backgroundColor: danger ? "rgba(178,77,77,0.10)" : theme.t.controlHover },
        busy && { opacity: 0.6 },
      ]}
    >
      {busy ? <ActivityIndicator color={theme.t.textTertiary} size="small" /> : icon}
      <Text style={[styles.miniButtonText, danger && { color: theme.t.errorText }]}>{label}</Text>
    </Pressable>
  );
}

type OfflineStyles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
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
      zIndex: 2500,
    },
    scrimHit: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    card: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 18,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      maxHeight: "88%",
      maxWidth: 520,
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
    title: { color: t.textPrimary, fontSize: 15.5, fontWeight: "700", letterSpacing: -0.2 },
    subtitle: {
      color: t.textTertiary,
      fontSize: 11.5,
      lineHeight: 16,
      marginTop: 3,
      maxWidth: 400,
    },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    iconButtonHover: { backgroundColor: t.controlHover },
    bodyScroll: { flexGrow: 0, minHeight: 0 },
    body: { gap: 8, padding: 16 },
    error: {
      backgroundColor: "rgba(178,77,77,0.08)",
      borderRadius: 8,
      color: t.errorText,
      fontSize: 12,
      padding: 9,
    },
    basemapRow: {
      alignItems: "center",
      borderRadius: 11,
      flexDirection: "row",
      gap: 11,
      paddingHorizontal: 12,
      paddingVertical: 11,
    },
    basemapRowActive: { backgroundColor: accent.selectedFill },
    basemapTitle: { color: t.textPrimary, fontSize: 13.5, fontWeight: "600" },
    basemapSubtitle: { color: t.textTertiary, fontSize: 11, marginTop: 2 },
    activeBadge: { alignItems: "center", flexDirection: "row", gap: 3 },
    activeBadgeText: { color: accent.accentText, fontSize: 11.5, fontWeight: "600" },
    selectHint: { color: t.textTertiary, fontSize: 12 },
    mapCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 13,
      borderWidth: 1,
      overflow: "hidden",
    },
    mapActions: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 6,
      justifyContent: "flex-end",
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    miniButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    miniButtonText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    progressWrap: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    progressTrack: {
      backgroundColor: t.progressTrack,
      borderRadius: 999,
      flex: 1,
      height: 6,
      overflow: "hidden",
    },
    progressFill: {
      backgroundColor: accent.accent,
      borderRadius: 999,
      height: 6,
      overflow: "hidden",
      position: "relative",
    },
    progressShimmer: {
      backgroundColor: "rgba(255,255,255,0.5)",
      bottom: 0,
      position: "absolute",
      top: 0,
      width: 40,
    },
    progressText: { color: t.textTertiary, fontSize: 11, minWidth: 96, textAlign: "right" },
    addSection: {
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 13,
      gap: 8,
      marginTop: 4,
      padding: 12,
    },
    sectionTitle: { color: t.textSecondary, fontSize: 12, fontWeight: "700" },
    input: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    addActions: { flexDirection: "row", gap: 8 },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      height: 36,
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
      flexDirection: "row",
      gap: 6,
      height: 36,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    secondaryButtonText: { color: t.textSecondary, fontSize: 13, fontWeight: "600" },
    hint: { color: t.textTertiary, fontSize: 10.5, lineHeight: 15 },
    linkButton: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      marginTop: 2,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    linkText: { color: accent.accentText, fontSize: 12, fontWeight: "600" },
    footer: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    footerButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    footerButtonText: { color: t.textTertiary, fontSize: 12, fontWeight: "500" },
  });
}
