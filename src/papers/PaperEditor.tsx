import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { RiDeleteBinLine, RiExternalLinkLine } from "@remixicon/react";
import { MarkdownEditor } from "../editor";
import { SHELL_HEADER_HEIGHT, motion, useTheme, type Accent, type Theme } from "../theme";
import { readBody, type Paper, type PaperInput } from "./api";
import {
  createImageMap,
  hydrateForDisplay,
  prepareForStorage,
  uploadNoteImages,
} from "./assetBridge";
import { StarRating } from "../ratings";
import { RATED_STATUSES, STATUS_META, STATUS_ORDER, type PaperStatus } from "./constants";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function confirmDelete(message: string): Promise<boolean> {
  try {
    if (isTauriRuntime()) return await tauriConfirm(message, { title: "删除", kind: "warning" });
  } catch {
    /* fall through */
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

// One overflow menu keeps Vditor's commands out of the way (mirrors notes).
const PAPERS_TOOLBAR = [
  {
    name: "more",
    tip: "格式与插入",
    toolbar: [
      { name: "undo", hotkey: "⌘Z" },
      { name: "redo", hotkey: "⇧⌘Z" },
      "headings",
      "bold",
      "italic",
      "strike",
      "list",
      "ordered-list",
      "check",
      "outdent",
      "indent",
      "quote",
      "line",
      "inline-code",
      "code",
      "link",
      "table",
      {
        name: "upload",
        tip: "插入图片",
        icon: '<svg aria-hidden="true"><use xlink:href="#vditor-icon-upload"></use></svg><span class="nomi-note-upload-label">插入图片</span>',
      },
      "emoji",
    ],
  },
];

export function PaperEditor({
  accent,
  paper,
  headerAccessory,
  onSaveMeta,
  onDelete,
  onReveal,
  saveBody,
}: {
  accent: Accent;
  paper: Paper;
  /** Rendered on the right of the single header (e.g. the graph / detail switch). */
  headerAccessory?: React.ReactNode;
  onSaveMeta: (id: string, input: PaperInput) => void;
  onDelete: (id: string) => void;
  onReveal: (id: string) => void;
  saveBody: (id: string, content: string) => Promise<void>;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);

  const [title, setTitle] = useState(paper.title);
  const [venue, setVenue] = useState(paper.venue);
  const [tagsText, setTagsText] = useState(paper.tags.join(" "));
  const [status, setStatus] = useState<PaperStatus>(paper.status);
  const [rating, setRating] = useState(paper.rating);
  const [titleFocused, setTitleFocused] = useState(false);

  const buildInput = useCallback(
    (overrides?: Partial<PaperInput>): PaperInput => ({
      title,
      status,
      venue,
      tags: tagsText.split(/[\s,，、]+/).filter(Boolean),
      rating,
      x: paper.x,
      y: paper.y,
      ...overrides,
    }),
    [title, status, venue, tagsText, rating, paper.x, paper.y],
  );

  const commit = useCallback(
    (overrides?: Partial<PaperInput>) => onSaveMeta(paper.id, buildInput(overrides)),
    [onSaveMeta, paper.id, buildInput],
  );

  const chooseStatus = useCallback(
    (next: PaperStatus) => {
      setStatus(next);
      commit({ status: next });
    },
    [commit],
  );

  const chooseRating = useCallback(
    (next: number) => {
      setRating(next);
      commit({ rating: next });
    },
    [commit],
  );

  const handleDelete = useCallback(async () => {
    const ok = await confirmDelete(`确定删除论文「${paper.title}」吗？此操作无法撤销。`);
    if (ok) onDelete(paper.id);
  }, [paper.id, paper.title, onDelete]);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <TextInput
            accessibilityLabel="论文标题"
            onBlur={() => {
              setTitleFocused(false);
              commit();
            }}
            onChangeText={setTitle}
            onFocus={() => setTitleFocused(true)}
            onSubmitEditing={() => commit()}
            placeholder="论文标题…"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.titleInput, titleFocused && styles.titleInputFocused]}
            value={title}
          />
        </View>
        <View style={styles.headerActions}>
          {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
          <Pressable
            accessibilityLabel="在文件夹中显示"
            onPress={() => onReveal(paper.id)}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              hovered && styles.iconButtonHover,
            ]}
          >
            <RiExternalLinkLine color={theme.t.textSecondary} size={17} />
          </Pressable>
          <Pressable
            accessibilityLabel="删除论文"
            onPress={handleDelete}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              hovered && styles.iconButtonDangerHover,
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={17} />
          </Pressable>
          <div
            className="nomi-note-toolbar-host"
            ref={setToolbarHost}
            style={{ "--nomi-editor-accent": accent.rgb } as React.CSSProperties}
          />
        </View>
      </View>

      <View style={styles.metaBar}>
        <View style={styles.statusRow}>
          {STATUS_ORDER.map((option) => {
            const active = option === status;
            const meta = STATUS_META[option];
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => chooseStatus(option)}
                style={({ hovered }: PressState) => [
                  styles.statusPill,
                  motion,
                  hovered && !active && styles.statusPillHover,
                  active && {
                    backgroundColor: meta.soft,
                    borderColor: meta.color,
                  },
                ]}
              >
                <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
                <Text
                  style={[styles.statusPillText, active && { color: meta.text, fontWeight: "600" }]}
                >
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
          {RATED_STATUSES.has(status) ? (
            <View style={styles.ratingInline}>
              <Text style={styles.ratingLabel}>重要性</Text>
              <StarRating accent={accent} onChange={chooseRating} rating={rating} size={17} />
            </View>
          ) : null}
        </View>
        <View style={styles.fieldsRow}>
          <TextInput
            accessibilityLabel="目标期刊 / 会议"
            onBlur={() => commit()}
            onChangeText={setVenue}
            placeholder="目标期刊 / 会议（可选）"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.field}
            value={venue}
          />
          <TextInput
            accessibilityLabel="标签"
            onBlur={() => commit()}
            onChangeText={setTagsText}
            placeholder="标签，用空格分隔（可选）"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.field}
            value={tagsText}
          />
        </View>
      </View>

      <PaperBody
        key={paper.id}
        accent={accent}
        paperId={paper.id}
        saveBody={saveBody}
        styles={styles}
        toolbarHost={toolbarHost}
      />
    </View>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";
const AUTOSAVE_MS = 800;

function PaperBody({
  accent,
  paperId,
  saveBody,
  styles,
  toolbarHost,
}: {
  accent: Accent;
  paperId: string;
  saveBody: (id: string, content: string) => Promise<void>;
  styles: ReturnType<typeof makeStyles>;
  toolbarHost: HTMLDivElement | null;
}) {
  const theme = useTheme();
  const [status, setStatus] = useState<{
    kind: "loading" | "ready" | "error";
    content?: string;
    error?: string;
  }>({ kind: "loading" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const mapRef = useRef(createImageMap());
  const valueRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const raw = await readBody(paperId);
        const display = await hydrateForDisplay(paperId, raw, mapRef.current);
        if (!alive) return;
        valueRef.current = display;
        setStatus({ kind: "ready", content: display });
      } catch (err) {
        if (alive) setStatus({ kind: "error", error: String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [paperId]);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) {
      await savingRef.current;
      return;
    }
    const prior = savingRef.current ?? Promise.resolve();
    const run: Promise<void> = prior
      .then(async () => {
        if (!dirtyRef.current) return;
        const snapshot = valueRef.current;
        if (mountedRef.current) setSaveState("saving");
        try {
          const stored = await prepareForStorage(paperId, snapshot, mapRef.current);
          await saveBody(paperId, stored);
          if (valueRef.current === snapshot) dirtyRef.current = false;
          if (mountedRef.current) setSaveState(valueRef.current === snapshot ? "saved" : "saving");
        } catch {
          if (mountedRef.current) setSaveState("error");
        }
      })
      .finally(() => {
        if (savingRef.current === run) savingRef.current = null;
      });
    savingRef.current = run;
    await run;
  }, [paperId, saveBody]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      void flush();
    },
    [flush],
  );

  const onChange = useCallback(
    (markdown: string) => {
      valueRef.current = markdown;
      dirtyRef.current = true;
      setSaveState("saving");
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  const onImageUpload = useCallback(
    (files: File[]) => uploadNoteImages(paperId, files, mapRef.current),
    [paperId],
  );

  if (status.kind === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.t.textTertiary} size="small" />
      </View>
    );
  }
  if (status.kind === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{status.error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.editorWrap}>
      <View style={styles.saveHintRow} pointerEvents="none">
        <Text style={styles.saveHint}>{SAVE_LABELS[saveState]}</Text>
      </View>
      <View style={styles.editorHost}>
        <MarkdownEditor
          accentRgb={accent.rgb}
          mode="wysiwyg"
          onBlur={() => void flush()}
          onChange={onChange}
          onImageUpload={onImageUpload}
          onSave={() => void flush()}
          placeholder="写下研究动机、大纲、待办、相关工作…"
          toolbar={PAPERS_TOOLBAR}
          toolbarHost={toolbarHost}
          value={status.content}
        />
      </View>
    </View>
  );
}

const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    wrap: { flex: 1, minHeight: 0 },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      height: SHELL_HEADER_HEIGHT,
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 24,
      justifyContent: "space-between",
      zIndex: 30,
    },
    titleBlock: { flex: 1, minWidth: 0 },
    // Matches the collection header ("论文") and the graph-view title (both 15),
    // so the title lines up across the two columns and doesn't resize when you
    // toggle between graph and detail.
    titleInput: {
      borderColor: "transparent",
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 15,
      fontWeight: "600",
      letterSpacing: -0.25,
      marginLeft: -8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    titleInputFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    headerActions: { alignItems: "center", flexDirection: "row", gap: 6 },
    headerAccessory: { marginRight: 2 },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    iconButtonHover: { backgroundColor: t.controlHover },
    iconButtonDangerHover: { backgroundColor: "rgba(178,77,77,0.12)" },
    metaBar: {
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      gap: 9,
      paddingHorizontal: 24,
      paddingVertical: 11,
    },
    statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    ratingInline: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: 28,
      paddingLeft: 6,
    },
    ratingLabel: { color: t.textTertiary, fontSize: 12.5 },
    statusPill: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 28,
      paddingHorizontal: 11,
    },
    statusPillHover: { backgroundColor: t.controlHover },
    statusDot: { borderRadius: 4, height: 8, width: 8 },
    statusPillText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "500" },
    fieldsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    // The real fix for the "too big" inputs: cap the width so they stay compact
    // and left-aligned instead of each stretching to half of a wide detail pane.
    field: {
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      flexBasis: 180,
      flexGrow: 1,
      flexShrink: 1,
      fontSize: 12.5,
      height: 32,
      maxWidth: 320,
      minWidth: 0,
      paddingHorizontal: 11,
    },
    editorWrap: { flex: 1, minHeight: 0 },
    saveHintRow: { alignItems: "flex-end", paddingHorizontal: 24, paddingTop: 4 },
    saveHint: { color: t.textTertiary, fontSize: 10.5, height: 14 },
    editorHost: { flex: 1, minHeight: 0 },
    centered: { alignItems: "center", flex: 1, gap: 14, justifyContent: "center", padding: 24 },
    errorText: { color: t.errorText, fontSize: 12.5, lineHeight: 18, textAlign: "center" },
    // `accent` participates so the memo re-runs when the section accent changes.
    _accent: { borderColor: accent.accent },
  });
}
