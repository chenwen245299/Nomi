import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import {
  RiCheckboxCircleFill,
  RiCloseLine,
  RiDownload2Line,
  RiErrorWarningLine,
  RiRefreshLine,
  RiSparkling2Fill,
} from "@remixicon/react";
import { useUpdater } from "./useUpdater";
import { checkForUpdates, closeDialog, downloadAndInstall, openDialog } from "./store";
import {
  accentFor,
  cardShadow,
  enterFade,
  enterModal,
  glass,
  modalShadow,
  motion,
  reduceMotion,
  shimmerStyle,
  supportsGlass,
  useTheme,
  withGlow,
  type Accent,
  type Theme,
} from "../theme";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

// Software updates are app-level (not a feature) — they always wear the brand
// (Chat blue) accent, never the active section's color. The card lives in
// Settings, so its neutral chrome uses graphite.
function makeStyles(theme: Theme, chat: Accent, neutral: Accent) {
  const { t } = theme;
  const overlayFill = theme.useSolid ? t.overlaySolid : t.overlaySurface;

  return StyleSheet.create({
    section: {
      maxWidth: 680,
      width: "100%",
    },
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      padding: 18,
    },
    cardHeader: {
      alignItems: "center",
      flexDirection: "row",
    },
    iconWrap: {
      alignItems: "center",
      backgroundColor: neutral.iconBadge,
      borderRadius: 10,
      height: 38,
      justifyContent: "center",
      marginRight: 12,
      width: 38,
    },
    cardHeading: {
      flex: 1,
    },
    cardTitle: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "600",
      letterSpacing: -0.1,
    },
    cardDescription: {
      color: t.textSecondary,
      fontSize: 12,
      marginTop: 4,
    },
    flashBadge: {
      alignItems: "center",
      backgroundColor: t.statusGreenFill,
      borderColor: t.statusGreenBorder,
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    flashText: {
      color: t.statusGreenText,
      fontSize: 11,
      fontWeight: "500",
    },
    secondaryButton: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      height: 32,
      marginTop: 12,
      paddingHorizontal: 10,
    },
    secondaryButtonHover: {
      backgroundColor: t.controlHover,
    },
    secondaryButtonText: {
      color: neutral.accentText,
      fontSize: 12,
      fontWeight: "600",
    },
    updateRow: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: chat.selectedFill,
      borderColor: "rgba(47,123,230,0.20)",
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 32,
      marginTop: 12,
      paddingHorizontal: 10,
    },
    updateRowText: {
      color: chat.accentText,
      fontSize: 12,
      fontWeight: "600",
    },
    inlineError: {
      color: t.errorText,
      flex: 1,
      fontSize: 11.5,
      lineHeight: 17,
      marginTop: 11,
    },
    softPressed: {
      opacity: 0.72,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    overlay: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 24,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 40,
    },
    modal: {
      backgroundColor: overlayFill,
      borderColor: t.edgeHighlight,
      borderRadius: 18,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      maxWidth: 440,
      padding: 22,
      width: "100%",
    },
    modalTop: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    modalIcon: {
      alignItems: "center",
      backgroundColor: chat.accent,
      borderRadius: 12,
      height: 40,
      justifyContent: "center",
      width: 40,
      boxShadow: withGlow("inset 0 1px 0 rgba(255,255,255,0.22)", chat),
    },
    closeButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    closeButtonHover: {
      backgroundColor: t.controlHover,
    },
    modalEyebrow: {
      color: t.textTertiary,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1.4,
      marginTop: 16,
    },
    modalTitle: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.3,
      marginTop: 7,
    },
    modalSubtitle: {
      color: t.textSecondary,
      fontSize: 12,
      marginTop: 6,
    },
    notesBox: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      marginTop: 16,
      maxHeight: 190,
    },
    notesContent: {
      padding: 14,
    },
    notesText: {
      color: t.textSecondary,
      fontSize: 12.5,
      lineHeight: 20,
    },
    progressWrap: {
      marginTop: 18,
    },
    progressTrack: {
      backgroundColor: t.progressTrack,
      borderRadius: 999,
      height: 7,
      overflow: "hidden",
      width: "100%",
    },
    progressBar: {
      backgroundColor: chat.accent,
      borderRadius: 999,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35)",
      height: 7,
    },
    progressShimmer: {
      backgroundColor: "rgba(255,255,255,0.45)",
      bottom: 0,
      opacity: 0.5,
      position: "absolute",
      top: 0,
      width: 48,
    },
    progressText: {
      color: t.textTertiary,
      fontSize: 11,
      marginTop: 8,
    },
    errorRow: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 7,
    },
    actions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 9,
      justifyContent: "flex-end",
      marginTop: 20,
    },
    ghostButton: {
      alignItems: "center",
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 13,
    },
    ghostButtonHover: {
      backgroundColor: t.controlHover,
    },
    ghostButtonText: {
      color: t.textSecondary,
      fontSize: 13,
      fontWeight: "600",
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: chat.accent,
      borderRadius: 10,
      boxShadow: withGlow("inset 0 1px 0 rgba(255,255,255,0.22)", chat),
      flexDirection: "row",
      gap: 7,
      justifyContent: "center",
      height: 34,
      paddingHorizontal: 13,
    },
    primaryButtonPressed: {
      opacity: 0.9,
      transform: [{ scale: 0.98 }],
    },
    primaryButtonText: {
      color: t.onAccent,
      fontSize: 13,
      fontWeight: "600",
    },
  });
}

function useUpdaterStyles() {
  const theme = useTheme();
  const chat = accentFor("chat");
  const neutral = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, chat, neutral), [theme, chat, neutral]);
  return { styles, theme, chat, neutral };
}

export function CheckForUpdatesCard() {
  const u = useUpdater();
  const { styles, theme, chat, neutral } = useUpdaterStyles();
  const checking = u.state === "checking";
  const hasUpdate = u.state === "available";

  return (
    <View style={styles.section}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconWrap}>
            <RiRefreshLine color={neutral.accentText} size={20} />
          </View>
          <View style={styles.cardHeading}>
            <Text style={styles.cardTitle}>软件更新</Text>
            <Text style={styles.cardDescription}>当前版本 v{u.currentVersion || "—"}</Text>
          </View>
          {u.upToDateFlash && (
            <View style={styles.flashBadge}>
              <RiCheckboxCircleFill color={theme.t.statusGreenText} size={14} />
              <Text style={styles.flashText}>已是最新</Text>
            </View>
          )}
        </View>

        {hasUpdate ? (
          <Pressable
            accessibilityRole="button"
            onPress={openDialog}
            style={({ pressed, hovered }: PressState) => [
              styles.updateRow,
              motion,
              hovered && ({ filter: "brightness(1.04)" } as ViewStyle),
              pressed && styles.softPressed,
            ]}
          >
            <RiDownload2Line color={chat.accentText} size={16} />
            <Text style={styles.updateRowText}>发现新版本 v{u.newVersion}，点击查看</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={checking}
            onPress={() => void checkForUpdates(true)}
            style={({ pressed, hovered }: PressState) => [
              styles.secondaryButton,
              motion,
              hovered && styles.secondaryButtonHover,
              pressed && styles.primaryButtonPressed,
              checking && styles.buttonDisabled,
            ]}
          >
            {checking ? (
              <ActivityIndicator color={neutral.accentText} size="small" />
            ) : (
              <RiRefreshLine color={neutral.accentText} size={16} />
            )}
            <Text style={styles.secondaryButtonText}>{checking ? "检查中…" : "检查更新"}</Text>
          </Pressable>
        )}

        {u.error ? <Text style={styles.inlineError}>{u.error}</Text> : null}
      </View>
    </View>
  );
}

export function UpdateDialog() {
  const u = useUpdater();
  const { styles, theme } = useUpdaterStyles();

  if (!u.dialogOpen) {
    return null;
  }

  const downloading = u.state === "downloading";
  const errored = u.state === "error";
  const primaryLabel = downloading ? "更新中…" : errored ? "重试" : "立即更新并重启";
  const widthTransition = reduceMotion
    ? undefined
    : ({
        transitionProperty: "width",
        transitionDuration: "220ms",
        transitionTimingFunction: "ease-out",
      } as unknown as ViewStyle);
  const showShimmer = downloading && supportsGlass && !reduceMotion;

  return (
    <View style={[styles.overlay, glass(8, 115), enterFade()]}>
      <View style={[styles.modal, glass(40, 180), enterModal()]}>
        <View style={styles.modalTop}>
          <View style={styles.modalIcon}>
            <RiSparkling2Fill color={theme.t.onAccent} size={20} />
          </View>
          {!downloading && (
            <Pressable
              accessibilityLabel="关闭"
              accessibilityRole="button"
              onPress={closeDialog}
              style={({ pressed, hovered }: PressState) => [
                styles.closeButton,
                motion,
                hovered && styles.closeButtonHover,
                pressed && styles.softPressed,
              ]}
            >
              <RiCloseLine color={theme.t.textTertiary} size={17} />
            </Pressable>
          )}
        </View>

        <Text style={styles.modalEyebrow}>软件更新</Text>
        <Text style={styles.modalTitle}>发现新版本 v{u.newVersion}</Text>
        <Text style={styles.modalSubtitle}>
          当前 v{u.currentVersion || "—"} → 新版本 v{u.newVersion}
        </Text>

        {u.releaseNotes ? (
          <ScrollView style={styles.notesBox} contentContainerStyle={styles.notesContent}>
            <Text style={styles.notesText}>{u.releaseNotes}</Text>
          </ScrollView>
        ) : null}

        {downloading && (
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressBar,
                  { width: `${u.progress}%` as `${number}%` },
                  widthTransition,
                ]}
              >
                {showShimmer && <View style={[styles.progressShimmer, shimmerStyle]} />}
              </View>
            </View>
            <Text style={styles.progressText}>正在下载并安装 {u.progress}%</Text>
          </View>
        )}

        {errored && (
          <View style={styles.errorRow}>
            <RiErrorWarningLine color={theme.t.errorText} size={15} />
            <Text style={styles.inlineError}>{u.error}</Text>
          </View>
        )}

        <View style={styles.actions}>
          {!downloading && (
            <Pressable
              accessibilityRole="button"
              onPress={closeDialog}
              style={({ pressed, hovered }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && styles.ghostButtonHover,
                pressed && styles.softPressed,
              ]}
            >
              <Text style={styles.ghostButtonText}>稍后</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={downloading}
            onPress={() => void downloadAndInstall()}
            style={({ pressed, hovered }: PressState) => [
              styles.primaryButton,
              motion,
              hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
              pressed && styles.primaryButtonPressed,
              downloading && styles.buttonDisabled,
            ]}
          >
            {downloading ? (
              <ActivityIndicator color={theme.t.onAccent} size="small" />
            ) : (
              <RiDownload2Line color={theme.t.onAccent} size={17} />
            )}
            <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
