import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiMap2Line,
  RiMapPin2Fill,
  RiMapPin2Line,
} from "@remixicon/react";
import { MarkdownEditor } from "../editor";
import { enterLeft, motion, useTheme, type Accent, type Theme } from "../theme";
import { readNote, saveNote, type NoteInput, type TravelNote } from "./api";
import {
  createImageMap,
  disposeImageMap,
  hydrateForDisplay,
  prepareForStorage,
  uploadNoteImages,
} from "./assetBridge";
import { LocationPicker } from "./LocationPicker";
import { StarRating } from "../ratings";
import { travelCategoryColor } from "./categoryColors";

type PressState = { pressed: boolean; hovered?: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function confirmDelete(message: string): Promise<boolean> {
  try {
    if (isTauriRuntime()) return await tauriConfirm(message, { title: "删除", kind: "warning" });
  } catch {
    /* fall through */
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

const AUTOSAVE_MS = 800;
const META_SAVE_MS = 500;

type SaveState = "idle" | "saving" | "saved" | "error";
const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

/**
 * The travel note detail: geotag metadata (category · rating · date · location)
 * above a reused Markdown editor. Metadata and body both autosave. cmd+V image
 * paste works through the same asset round-trip as the notes module.
 */
export function TravelNoteEditor({
  accent,
  note,
  categories,
  basemap,
  getMapCenter,
  expanded = false,
  onAddCategory,
  onOpenFull,
  onClose,
  onSaveMeta,
  onDelete,
}: {
  accent: Accent;
  note: TravelNote;
  categories: string[];
  basemap: string;
  getMapCenter: () => { lat: number; lng: number };
  expanded?: boolean;
  onAddCategory: (category: string) => Promise<boolean>;
  onOpenFull?: () => void;
  onClose: () => void;
  onSaveMeta: (id: string, input: NoteInput) => Promise<unknown>;
  onDelete: (id: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);

  const [title, setTitle] = useState(note.title);
  const [category, setCategory] = useState(note.category);
  const [rating, setRating] = useState(note.rating);
  const [date, setDate] = useState(note.date);
  const [lat, setLat] = useState<number | null>(note.lat);
  const [lng, setLng] = useState<number | null>(note.lng);
  const [address, setAddress] = useState(note.address);
  const [metaState, setMetaState] = useState<SaveState>("idle");
  const [bodyState, setBodyState] = useState<SaveState>("idle");
  const [picking, setPicking] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [customCategory, setCustomCategory] = useState("");

  // ── Metadata autosave ───────────────────────────────────────────────────────
  const metaTimer = useRef<number | undefined>(undefined);
  const latestMeta = useRef<NoteInput>({
    title: note.title,
    category: note.category,
    lat: note.lat,
    lng: note.lng,
    address: note.address,
    rating: note.rating,
    date: note.date,
  });
  const flushMeta = useCallback(async () => {
    window.clearTimeout(metaTimer.current);
    setMetaState("saving");
    try {
      await onSaveMeta(note.id, latestMeta.current);
      setMetaState("saved");
    } catch {
      setMetaState("error");
    }
  }, [note.id, onSaveMeta]);

  const patchMeta = useCallback(
    (change: Partial<NoteInput>) => {
      latestMeta.current = { ...latestMeta.current, ...change };
      setMetaState("saving");
      window.clearTimeout(metaTimer.current);
      metaTimer.current = window.setTimeout(() => void flushMeta(), META_SAVE_MS);
    },
    [flushMeta],
  );

  // ── Body load + autosave (mirrors notes NoteEditor) ─────────────────────────
  const mapImg = useRef(createImageMap());
  const valueRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const bodyTimer = useRef<number | undefined>(undefined);
  const [body, setBody] = useState<{
    kind: "loading" | "ready" | "error";
    content?: string;
    error?: string;
  }>({
    kind: "loading",
  });

  useEffect(() => {
    mountedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const raw = await readNote(note.id);
        const display = await hydrateForDisplay(note.id, raw, mapImg.current);
        if (!alive) return;
        valueRef.current = display;
        setBody({ kind: "ready", content: display });
      } catch (err) {
        if (alive) setBody({ kind: "error", error: String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [note.id]);

  const flushBody = useCallback(async () => {
    if (!dirtyRef.current) {
      await savingRef.current;
      return;
    }
    const prior = savingRef.current ?? Promise.resolve();
    const run: Promise<void> = prior
      .then(async () => {
        if (!dirtyRef.current) return;
        const snapshot = valueRef.current;
        if (mountedRef.current) setBodyState("saving");
        try {
          const stored = await prepareForStorage(note.id, snapshot, mapImg.current);
          await saveNote(note.id, stored);
          if (valueRef.current === snapshot) dirtyRef.current = false;
          if (mountedRef.current) setBodyState(valueRef.current === snapshot ? "saved" : "saving");
        } catch {
          if (mountedRef.current) setBodyState("error");
        }
      })
      .finally(() => {
        if (savingRef.current === run) savingRef.current = null;
      });
    savingRef.current = run;
    await run;
  }, [note.id]);

  const onBodyChange = useCallback(
    (markdown: string) => {
      valueRef.current = markdown;
      dirtyRef.current = true;
      setBodyState("saving");
      window.clearTimeout(bodyTimer.current);
      bodyTimer.current = window.setTimeout(() => void flushBody(), AUTOSAVE_MS);
    },
    [flushBody],
  );

  const onImageUpload = useCallback(
    (files: File[]) => uploadNoteImages(note.id, files, mapImg.current),
    [note.id],
  );

  // Flush everything on unmount / close.
  useEffect(
    () => () => {
      mountedRef.current = false;
      window.clearTimeout(bodyTimer.current);
      window.clearTimeout(metaTimer.current);
      const map = mapImg.current;
      void Promise.all([flushBody(), onSaveMeta(note.id, latestMeta.current)]).finally(() =>
        disposeImageMap(map),
      );
    },
    [flushBody, note.id, onSaveMeta],
  );

  const close = useCallback(async () => {
    window.clearTimeout(bodyTimer.current);
    await Promise.all([flushBody(), flushMeta()]);
    onClose();
  }, [flushBody, flushMeta, onClose]);

  const handleDelete = async () => {
    const ok = await confirmDelete(
      `确定删除旅行笔记「${title || "未命名旅行"}」吗？此操作无法撤销。`,
    );
    if (ok) onDelete(note.id);
  };

  const combinedState: SaveState =
    metaState === "error" || bodyState === "error"
      ? "error"
      : metaState === "saving" || bodyState === "saving"
        ? "saving"
        : metaState === "saved" || bodyState === "saved"
          ? "saved"
          : "idle";

  const locationLabel =
    address || (lat != null && lng != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : "");
  const categoryOptions =
    category && !categories.includes(category) ? [...categories, category] : categories;

  const commitCustomCategory = async () => {
    const normalized = customCategory.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    if (!(await onAddCategory(normalized))) return;
    setCategory(normalized);
    patchMeta({ category: normalized });
    setCustomCategory("");
    setAddingCategory(false);
  };

  return (
    <View style={[expanded ? styles.fullPanel : styles.panel, !expanded && enterLeft()]}>
      {/* Header: title + save state + actions */}
      <View style={styles.header}>
        {expanded ? (
          <Pressable
            accessibilityLabel="返回地图"
            accessibilityRole="button"
            onPress={() => void close()}
            style={({ hovered }: PressState) => [
              styles.backToMapButton,
              motion,
              hovered && styles.backToMapButtonHover,
            ]}
          >
            <RiArrowLeftLine color={theme.t.textSecondary} size={16} />
            <RiMap2Line color={theme.t.textSecondary} size={16} />
            <Text style={styles.backToMapText}>返回地图</Text>
          </Pressable>
        ) : null}
        <TextInput
          accessibilityLabel="旅行标题"
          onBlur={() => setTitleFocused(false)}
          onChangeText={(value) => {
            setTitle(value);
            patchMeta({ title: value });
          }}
          onFocus={() => setTitleFocused(true)}
          placeholder="给这段旅程起个名字…"
          placeholderTextColor={theme.t.textTertiary}
          style={[styles.titleInput, titleFocused && styles.titleInputFocused]}
          value={title}
        />
        <View style={styles.headerActions}>
          <Text style={styles.saveHint}>{SAVE_LABELS[combinedState]}</Text>
          {!expanded && onOpenFull ? (
            <Pressable
              accessibilityLabel="在右侧完整打开"
              accessibilityRole="button"
              onPress={onOpenFull}
              style={({ hovered }: PressState) => [
                styles.iconButton,
                motion,
                hovered && styles.iconButtonHover,
              ]}
            >
              <RiExternalLinkLine color={theme.t.textSecondary} size={16} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="删除旅行笔记"
            accessibilityRole="button"
            onPress={() => void handleDelete()}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              motion,
              hovered && styles.iconButtonDanger,
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={16} />
          </Pressable>
          <Pressable
            accessibilityLabel="完成"
            accessibilityRole="button"
            onPress={() => void close()}
            style={styles.doneButton}
          >
            <Text style={styles.doneButtonText}>完成</Text>
          </Pressable>
        </View>
      </View>

      {/* Metadata */}
      <View style={styles.metaBar}>
        <View style={styles.metaTopRow}>
          <View style={styles.metaField}>
            <Text style={styles.metaLabel}>日期</Text>
            <input
              aria-label="旅行日期"
              onChange={(event) => {
                setDate(event.target.value);
                patchMeta({ date: event.target.value });
              }}
              style={{
                background: theme.t.cardSurface,
                border: `1px solid ${theme.t.controlBorder}`,
                borderRadius: 8,
                color: theme.t.textPrimary,
                fontFamily: "inherit",
                fontSize: 13,
                outline: "none",
                padding: "7px 9px",
              }}
              type="date"
              value={date}
            />
          </View>
          <View style={styles.metaFieldGrow}>
            <Text style={styles.metaLabel}>评分</Text>
            <StarRating
              accent={accent}
              onChange={(value) => {
                setRating(value);
                patchMeta({ rating: value });
              }}
              rating={rating}
            />
          </View>
        </View>

        <Text style={styles.metaLabel}>分类</Text>
        <View style={styles.chipWrap}>
          {categoryOptions.map((cat) => {
            const active = category === cat;
            const categoryColor = travelCategoryColor(cat);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={cat}
                onPress={() => {
                  const next = active ? "" : cat;
                  setCategory(next);
                  patchMeta({ category: next });
                }}
                style={({ hovered }: PressState) => [
                  styles.chip,
                  motion,
                  {
                    backgroundColor: active
                      ? categoryColor
                      : hovered
                        ? theme.t.controlHover
                        : theme.t.controlIdle,
                    borderColor: active ? categoryColor : theme.t.controlBorder,
                  } as ViewStyle,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: active ? theme.t.onAccent : theme.t.textSecondary } as ViewStyle,
                  ]}
                >
                  {cat}
                </Text>
              </Pressable>
            );
          })}
          {addingCategory ? (
            <View style={styles.customCategoryEditor}>
              <TextInput
                accessibilityLabel="自定义旅行分类"
                autoFocus
                maxLength={20}
                onChangeText={setCustomCategory}
                onSubmitEditing={() => void commitCustomCategory()}
                placeholder="输入分类名称"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.customCategoryInput}
                value={customCategory}
              />
              <Pressable
                accessibilityLabel="保存自定义分类"
                accessibilityRole="button"
                disabled={!customCategory.trim()}
                onPress={() => void commitCustomCategory()}
                style={({ hovered }: PressState) => [
                  styles.customCategoryAction,
                  hovered && styles.iconButtonHover,
                  !customCategory.trim() && styles.customCategoryActionDisabled,
                ]}
              >
                <RiCheckLine color={accent.accentText} size={14} />
              </Pressable>
              <Pressable
                accessibilityLabel="取消自定义分类"
                accessibilityRole="button"
                onPress={() => {
                  setCustomCategory("");
                  setAddingCategory(false);
                }}
                style={({ hovered }: PressState) => [
                  styles.customCategoryAction,
                  hovered && styles.iconButtonHover,
                ]}
              >
                <RiCloseLine color={theme.t.textTertiary} size={14} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityLabel="添加自定义旅行分类"
              accessibilityRole="button"
              onPress={() => setAddingCategory(true)}
              style={({ hovered }: PressState) => [
                styles.addCategoryButton,
                motion,
                hovered && styles.addCategoryButtonHover,
              ]}
            >
              <RiAddLine color={accent.accentText} size={14} />
              <Text style={styles.addCategoryText}>自定义</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.metaLabel}>位置</Text>
        <View style={styles.locationRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPicking(true)}
            style={({ hovered }: PressState) => [
              styles.locationButton,
              motion,
              hovered && { backgroundColor: theme.t.controlHover },
            ]}
          >
            {lat != null && lng != null ? (
              <RiMapPin2Fill color={accent.accentText} size={15} />
            ) : (
              <RiMapPin2Line color={theme.t.textTertiary} size={15} />
            )}
            <Text numberOfLines={1} style={styles.locationText}>
              {locationLabel || "在地图上选择位置（或输入经纬度）"}
            </Text>
          </Pressable>
          {lat != null && lng != null ? (
            <Pressable
              accessibilityLabel="清除位置"
              accessibilityRole="button"
              onPress={() => {
                setLat(null);
                setLng(null);
                setAddress("");
                patchMeta({ lat: null, lng: null, address: "" });
              }}
              style={({ hovered }: PressState) => [
                styles.clearLocation,
                hovered && { backgroundColor: theme.t.controlHover },
              ]}
            >
              <Text style={styles.clearLocationText}>清除</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Body editor */}
      <View style={styles.editorHost}>
        {body.kind === "loading" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.t.textTertiary} size="small" />
          </View>
        ) : body.kind === "error" ? (
          <ScrollView contentContainerStyle={styles.centered}>
            <Text style={styles.errorText}>{body.error}</Text>
          </ScrollView>
        ) : (
          <MarkdownEditor
            accentRgb={accent.rgb}
            className="nomi-editor--compact"
            mode="wysiwyg"
            onBlur={() => void flushBody()}
            onChange={onBodyChange}
            onImageUpload={onImageUpload}
            onSave={() => void flushBody()}
            placeholder="记录这段旅程…（⌘V 可粘贴图片）"
            toolbar={[]}
            value={body.content}
          />
        )}
      </View>

      {picking ? (
        <LocationPicker
          accent={accent}
          basemap={basemap}
          initial={{ lat, lng, address }}
          initialCenter={getMapCenter()}
          onCancel={() => setPicking(false)}
          onConfirm={(location) => {
            setLat(location.lat);
            setLng(location.lng);
            setAddress(location.address);
            patchMeta({ lat: location.lat, lng: location.lng, address: location.address });
            setPicking(false);
          }}
        />
      ) : null}
    </View>
  );
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // A left-docked panel over the map (mirrors the planning panel's geometry),
    // replacing the former centered modal. The map stays visible to its right.
    // zIndex sits above the planning panel (9) so a note selected while planning
    // is open still shows on top.
    panel: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      bottom: 20,
      boxShadow: "0 10px 30px rgba(16,24,36,0.18)",
      display: "flex",
      flexDirection: "column",
      left: 16,
      overflow: "hidden",
      position: "absolute",
      top: 74,
      width: 420,
      zIndex: 11,
    },
    fullPanel: {
      backgroundColor: t.mainSolid,
      bottom: 0,
      display: "flex",
      flexDirection: "column",
      height: "100%",
      left: 0,
      overflow: "hidden",
      position: "absolute",
      right: 0,
      top: 0,
      width: "100%",
      zIndex: 30,
    },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    // 15 to match the papers detail title, note headers, and collection titles —
    // the docked note panel should read as part of the same compact UI.
    titleInput: {
      borderColor: "transparent",
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      flex: 1,
      fontSize: 15,
      fontWeight: "700",
      letterSpacing: -0.2,
      minWidth: 0,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    titleInputFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    headerActions: { alignItems: "center", flexDirection: "row", gap: 4 },
    backToMapButton: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      height: 32,
      paddingHorizontal: 9,
    },
    backToMapButtonHover: { backgroundColor: t.controlHover },
    backToMapText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    saveHint: { color: t.textTertiary, fontSize: 10.5, minWidth: 36, textAlign: "right" },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    iconButtonHover: { backgroundColor: t.controlHover },
    iconButtonDanger: { backgroundColor: "rgba(178,77,77,0.10)" },
    doneButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 32,
      justifyContent: "center",
      marginLeft: 4,
      paddingHorizontal: 14,
    },
    doneButtonText: { color: t.onAccent, fontSize: 13, fontWeight: "600" },
    metaBar: {
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    metaTopRow: { alignItems: "flex-end", flexDirection: "row", gap: 16 },
    metaField: { gap: 4 },
    metaFieldGrow: { flex: 1, gap: 6 },
    metaLabel: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
    chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      alignItems: "center",
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      height: 26,
      justifyContent: "center",
      paddingHorizontal: 11,
    },
    chipText: { fontSize: 11.5, fontWeight: "600" },
    addCategoryButton: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.24)`,
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      height: 26,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    addCategoryButtonHover: { backgroundColor: `rgba(${accent.rgb},0.18)` },
    addCategoryText: { color: accent.accentText, fontSize: 11.5, fontWeight: "600" },
    customCategoryEditor: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      height: 30,
      overflow: "hidden",
    },
    customCategoryInput: {
      color: t.textPrimary,
      fontSize: 11.5,
      minWidth: 100,
      paddingHorizontal: 9,
      paddingVertical: 5,
      width: 128,
    },
    customCategoryAction: {
      alignItems: "center",
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    customCategoryActionDisabled: { opacity: 0.35 },
    locationRow: { alignItems: "center", flexDirection: "row", gap: 8 },
    locationButton: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flex: 1,
      flexDirection: "row",
      gap: 8,
      minWidth: 0,
      paddingHorizontal: 11,
      paddingVertical: 9,
    },
    locationText: { color: t.textSecondary, flex: 1, fontSize: 12.5, minWidth: 0 },
    clearLocation: {
      alignItems: "center",
      borderRadius: 8,
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    clearLocationText: { color: t.textTertiary, fontSize: 12, fontWeight: "600" },
    editorHost: { flex: 1, minHeight: 0 },
    centered: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
    errorText: { color: t.errorText, fontSize: 12.5, lineHeight: 18, textAlign: "center" },
  });
}
