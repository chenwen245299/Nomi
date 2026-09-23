import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiArrowRightSLine,
  RiBookOpenLine,
  RiCheckLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiDeleteBinLine,
  RiEdit2Line,
  RiEyeLine,
  RiExternalLinkLine,
  RiFileAddLine,
  RiFileTextLine,
  RiFolderAddLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiLayoutColumnLine,
  RiPencilLine,
  RiSearch2Line,
} from "@remixicon/react";
import { MarkdownEditor, type MarkdownEditorHandle } from "../editor";
import { motion, SHELL_HEADER_HEIGHT, useTheme, type Accent, type Theme } from "../theme";
import { EmptyIllustration } from "../illustrations";
import { readNote, revealInFinder, saveNote, type NoteNode } from "./api";
import {
  createImageMap,
  disposeImageMap,
  hydrateForDisplay,
  prepareForStorage,
  uploadNoteImages,
} from "./assetBridge";
import { flushNotesUnder, registerNoteFlush } from "./flushRegistry";
import type { NotesData } from "./useNotes";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function confirmDelete(message: string): Promise<boolean> {
  try {
    if (isTauriRuntime()) {
      return await tauriConfirm(message, { title: "删除", kind: "warning" });
    }
  } catch {
    /* fall through to the browser dialog */
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// Which folders are open in the tree. Kept per machine rather than in the data
// folder: it is a view preference, not part of the notes themselves. Without it
// every visit to 笔记 — a tab switch is enough to unmount the tree — came back
// fully collapsed and lost where you were.
const EXPANDED_FOLDERS_KEY = "nomi.notes.expandedFolders";

function readExpandedFolders(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_FOLDERS_KEY) ?? "null");
    if (Array.isArray(stored)) {
      return new Set(stored.filter((path): path is string => typeof path === "string"));
    }
  } catch {
    // Unreadable or unavailable storage (private mode) — start collapsed.
  }
  return new Set();
}

function writeExpandedFolders(paths: Set<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...paths]));
  } catch {
    // Storage unavailable — the tree still works, it just won't remember.
  }
}

/** Drops `path` and everything nested under it — used when a folder is deleted,
 *  so removed folders don't pile up in storage forever. */
function forgetExpanded(paths: Set<string>, path: string): Set<string> {
  const next = new Set<string>();
  for (const kept of paths) {
    if (kept !== path && !kept.startsWith(`${path}/`)) next.add(kept);
  }
  return next.size === paths.size ? paths : next;
}

// Keep Vditor's native commands (selection handling, undo stack and uploads),
// but expose them through one Obsidian-style overflow menu. The three hidden
// view controls are driven by our clearer four-mode switcher in the note header.
const NOTES_TOOLBAR = [
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
  "edit-mode",
  "both",
  "preview",
];

type NoteViewMode = "source" | "preview" | "split" | "wysiwyg";

const NOTE_VIEW_LABELS: Record<NoteViewMode, string> = {
  source: "只编辑",
  preview: "只预览",
  split: "分屏",
  wysiwyg: "所见即所得",
};

function applyNoteViewMode(
  mode: NoteViewMode,
  editor: MarkdownEditorHandle | null,
  toolbarHost: HTMLElement | null,
): void {
  const instance = editor?.getInstance();
  if (!instance || !toolbarHost) return;
  const previewButton = toolbarHost.querySelector<HTMLButtonElement>('button[data-type="preview"]');
  const previewActive = previewButton?.classList.contains("vditor-menu--current") ?? false;

  if (mode === "preview") {
    if (!previewActive) previewButton?.click();
    return;
  }

  if (previewActive) previewButton?.click();
  if (mode === "wysiwyg") {
    instance.setPreviewMode("editor");
    // Vditor's same-mode early return does not reconcile the inactive surfaces
    // after async initialisation. A short round-trip guarantees one clean pane.
    if (instance.getCurrentMode() === "wysiwyg") {
      toolbarHost.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click();
    }
    toolbarHost.querySelector<HTMLButtonElement>('button[data-mode="wysiwyg"]')?.click();
    return;
  }

  toolbarHost.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click();
  instance.setPreviewMode(mode === "split" ? "both" : "editor");
}

type SearchResult = { node: NoteNode; snippet: string | null };

function noteNodes(nodes: NoteNode[]): NoteNode[] {
  return nodes.flatMap((node) => (node.kind === "note" ? [node] : noteNodes(node.children ?? [])));
}

function searchSnippet(markdown: string, query: string): string | null {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split("[")
    .join(" ")
    .split("]")
    .join(" ")
    .replace(/[`*_>#~|(){}-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const index = plain.toLocaleLowerCase().indexOf(query);
  if (index < 0) return null;
  const start = Math.max(0, index - 28);
  const end = Math.min(plain.length, index + query.length + 48);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

// ── Styles ────────────────────────────────────────────────────────────────────
function makeNotesStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Collection (tree)
    searchArea: {
      paddingBottom: 10,
      paddingHorizontal: 10,
      paddingTop: 10,
    },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      height: 36,
      paddingHorizontal: 10,
    },
    searchBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    searchInput: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 12.5,
      minWidth: 0,
      paddingVertical: 7,
    },
    searchClear: {
      alignItems: "center",
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    searchClearHover: { backgroundColor: t.controlHover },
    toolbarButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    toolbarButtonHover: { backgroundColor: t.controlHover },
    toolbarButtonText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    tree: { paddingBottom: 16, paddingHorizontal: 6 },
    row: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      minHeight: 30,
      paddingRight: 8,
      width: "100%",
    },
    rowHover: { backgroundColor: t.controlHover },
    rowActive: { backgroundColor: accent.selectedFill },
    twisty: { alignItems: "center", justifyContent: "center", width: 18 },
    rowLabel: { color: t.textPrimary, flex: 1, fontSize: 13, minWidth: 0 },
    rowLabelMuted: { color: t.textSecondary },
    rowInput: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      borderRadius: 6,
      borderWidth: 1,
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      minWidth: 0,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    empty: {
      alignItems: "center",
      gap: 6,
      justifyContent: "center",
      paddingHorizontal: 20,
      paddingVertical: 36,
    },
    emptyText: { color: t.textTertiary, fontSize: 12.5, textAlign: "center" },
    searchResult: {
      alignItems: "flex-start",
      borderRadius: 9,
      flexDirection: "row",
      gap: 8,
      minHeight: 48,
      paddingHorizontal: 10,
      paddingVertical: 8,
      width: "100%",
    },
    searchResultIcon: { alignItems: "center", height: 20, justifyContent: "center" },
    searchResultBody: { flex: 1, minWidth: 0 },
    searchResultTitle: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    searchResultPath: { color: t.textTertiary, fontSize: 10.5, marginTop: 2 },
    searchResultSnippet: { color: t.textSecondary, fontSize: 11, lineHeight: 15, marginTop: 3 },
    // Main column
    mainColumnInner: { flex: 1, minHeight: 0 },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 14,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "space-between",
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 24,
      paddingVertical: 7,
      zIndex: 30,
    },
    headerTitleBlock: { flex: 1, maxWidth: 280, minWidth: 120 },
    title: { color: t.textPrimary, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
    titleHover: { color: accent.accentText },
    titleInput: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      borderRadius: 7,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 15,
      fontWeight: "600",
      height: 32,
      paddingHorizontal: 8,
      width: "100%",
    },
    breadcrumb: { color: t.textTertiary, fontSize: 11.5 },
    // Aligned with the header's own gutter so the path lines up with the title
    // above it and with the editor's first line below it.
    breadcrumbBar: { paddingHorizontal: 24, paddingTop: 10 },
    headerActions: { alignItems: "center", flexDirection: "row", gap: 2 },
    headerIconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    headerIconButtonHover: { backgroundColor: t.controlHover },
    headerIconButtonOpen: {
      backgroundColor: accent.selectedFill,
    },
    viewMenu: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 14px 36px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.08)",
      padding: 5,
      position: "absolute",
      right: 0,
      top: 38,
      width: 188,
      zIndex: 60,
    },
    viewMenuItem: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 9,
      minHeight: 32,
      paddingHorizontal: 9,
    },
    viewMenuItemHover: { backgroundColor: t.controlHover },
    viewMenuItemActive: { backgroundColor: accent.selectedFill },
    viewMenuItemText: { color: t.textPrimary, flex: 1, fontSize: 12.5, fontWeight: "500" },
    saveHint: { color: t.textTertiary, fontSize: 10.5, minWidth: 36, textAlign: "right" },
    editorWrap: { flex: 1, minHeight: 0 },
    editorHost: { flex: 1, minHeight: 0 },
    centered: { alignItems: "center", flex: 1, gap: 14, justifyContent: "center", padding: 24 },
    emptyTitle: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.3,
      textAlign: "center",
    },
    emptyDescription: {
      color: t.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      maxWidth: 320,
      textAlign: "center",
    },
    errorText: { color: t.errorText, fontSize: 12.5, lineHeight: 18, textAlign: "center" },
  });
}

type NotesStyles = ReturnType<typeof makeNotesStyles>;

type MenuKey = "new-note" | "new-folder" | "rename" | "reveal" | "delete";
type MenuState = { node: NoteNode | null; x: number; y: number };

// ── Collection: the folder / note tree ─────────────────────────────────────────
export function NotesCollection({
  accent,
  notes,
  selectedPath,
  onSelect,
  onNotePathChanged,
}: {
  accent: Accent;
  notes: NotesData;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  /** Reconcile open tabs after a rename / move / delete (newPath = null on delete). */
  onNotePathChanged: (oldPath: string, newPath: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeNotesStyles(theme, accent), [theme, accent]);
  const [expanded, setExpanded] = useState<Set<string>>(readExpandedFolders);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchState, setSearchState] = useState<{ query: string; results: SearchResult[] }>({
    query: "",
    results: [],
  });
  const allNotes = useMemo(() => noteNodes(notes.tree), [notes.tree]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searching = Boolean(normalizedQuery) && searchState.query !== normalizedQuery;
  const searchResults = searchState.query === normalizedQuery ? searchState.results : [];

  useEffect(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(
        allNotes.map(async (node): Promise<SearchResult | null> => {
          const titleMatch = node.name.toLocaleLowerCase().includes(normalized);
          try {
            const content = await readNote(node.path);
            const snippet = searchSnippet(content, normalized);
            return titleMatch || snippet ? { node, snippet } : null;
          } catch {
            return titleMatch ? { node, snippet: null } : null;
          }
        }),
      ).then((results) => {
        if (cancelled) return;
        setSearchState({
          query: normalized,
          results: results.filter((result): result is SearchResult => result !== null),
        });
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allNotes, query]);

  useEffect(() => {
    writeExpandedFolders(expanded);
  }, [expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expand = useCallback((path: string) => {
    setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }, []);

  const handleCreateNote = useCallback(
    async (parent: string) => {
      const created = await notes.createNote(parent);
      if (created) {
        if (parent) {
          expand(parent);
        }
        onSelect(created.path);
        setEditing(created.path);
      }
    },
    [notes, onSelect, expand],
  );

  const handleCreateFolder = useCallback(
    async (parent: string) => {
      const created = await notes.createFolder(parent);
      if (created) {
        if (parent) {
          expand(parent);
        }
        setEditing(created.path);
      }
    },
    [notes, expand],
  );

  const commitRename = useCallback(
    async (node: NoteNode, name: string) => {
      setEditing(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === node.name) {
        return;
      }
      // Persist any open editor under this path first, so its edits land in the
      // file before it is renamed on disk.
      await flushNotesUnder(node.path);
      const updated = await notes.renameNode(node, trimmed);
      if (updated && updated.path !== node.path) {
        onNotePathChanged(node.path, updated.path);
        if (node.kind === "folder") {
          // Remap the renamed folder AND every expanded descendant folder, else
          // nested-open folders visually collapse after the rename.
          setExpanded((prev) => {
            const next = new Set<string>();
            for (const path of prev) {
              if (path === node.path) {
                next.add(updated.path);
              } else if (path.startsWith(`${node.path}/`)) {
                next.add(`${updated.path}${path.slice(node.path.length)}`);
              } else {
                next.add(path);
              }
            }
            return next;
          });
        }
      }
    },
    [notes, onNotePathChanged],
  );

  const handleDelete = useCallback(
    async (node: NoteNode) => {
      const what = node.kind === "note" ? "笔记" : "文件夹及其内容";
      const ok = await confirmDelete(`确定删除${what}「${node.name}」吗？此操作无法撤销。`);
      if (!ok) {
        return;
      }
      await notes.deleteNode(node);
      onNotePathChanged(node.path, null);
      if (node.kind === "folder") {
        setExpanded((prev) => forgetExpanded(prev, node.path));
      }
    },
    [notes, onNotePathChanged],
  );

  const runMenuAction = useCallback(
    (node: NoteNode | null, key: MenuKey) => {
      switch (key) {
        case "new-note":
          void handleCreateNote(node?.kind === "folder" ? node.path : "");
          break;
        case "new-folder":
          void handleCreateFolder(node?.kind === "folder" ? node.path : "");
          break;
        case "rename":
          if (node) setEditing(node.path);
          break;
        case "reveal":
          if (node) void revealInFinder(node.path);
          break;
        case "delete":
          if (node) void handleDelete(node);
          break;
      }
    },
    [handleCreateNote, handleCreateFolder, handleDelete],
  );

  return (
    <div
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-note-tree-row], [data-note-search], input, button")) return;
        event.preventDefault();
        setMenu({ node: null, x: event.clientX, y: event.clientY });
      }}
      style={{ display: "flex", flex: 1, minHeight: 0 }}
    >
      <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
        <div data-note-search>
          <View style={styles.searchArea}>
            <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
              <RiSearch2Line
                color={searchFocused ? accent.accentText : theme.t.textTertiary}
                size={15}
              />
              <TextInput
                accessibilityLabel="搜索笔记标题和内容"
                onBlur={() => setSearchFocused(false)}
                onChangeText={setQuery}
                onFocus={() => setSearchFocused(true)}
                placeholder="搜索标题与内容…"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.searchInput}
                value={query}
              />
              {query ? (
                <Pressable
                  accessibilityLabel="清空搜索"
                  onPress={() => setQuery("")}
                  style={({ hovered }: PressState) => [
                    styles.searchClear,
                    hovered && styles.searchClearHover,
                  ]}
                >
                  <RiCloseLine color={theme.t.textTertiary} size={15} />
                </Pressable>
              ) : null}
            </View>
          </View>
        </div>

        {notes.loading && notes.tree.length === 0 ? (
          <View style={styles.empty}>
            <ActivityIndicator color={theme.t.textTertiary} size="small" />
          </View>
        ) : query.trim() ? (
          searching ? (
            <View style={styles.empty}>
              <ActivityIndicator color={theme.t.textTertiary} size="small" />
            </View>
          ) : searchResults.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>没有找到包含“{query.trim()}”的笔记</Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1, minHeight: 0 } as ViewStyle}>
              {searchResults.map((result) => (
                <SearchResultRow
                  key={result.node.path}
                  accent={accent}
                  active={result.node.path === selectedPath}
                  result={result}
                  styles={styles}
                  onContextMenu={(x, y) => setMenu({ node: result.node, x, y })}
                  onSelect={() => onSelect(result.node.path)}
                />
              ))}
            </ScrollView>
          )
        ) : notes.tree.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>还没有笔记{"\n"}在空白处右键即可新建</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.tree}
            style={{ flex: 1, minHeight: 0 } as ViewStyle}
          >
            <TreeLevel
              accent={accent}
              styles={styles}
              nodes={notes.tree}
              depth={0}
              expanded={expanded}
              editing={editing}
              selectedPath={selectedPath}
              onToggle={toggle}
              onSelect={onSelect}
              onContextMenu={(node, x, y) => setMenu({ node, x, y })}
              onCommitRename={commitRename}
              onCancelRename={() => setEditing(null)}
            />
          </ScrollView>
        )}

        {menu && (
          <TreeContextMenu
            accent={accent}
            theme={theme}
            node={menu.node}
            x={menu.x}
            y={menu.y}
            onAction={(key) => runMenuAction(menu.node, key)}
            onClose={() => setMenu(null)}
          />
        )}
      </View>
    </div>
  );
}

function SearchResultRow({
  accent,
  active,
  result,
  styles,
  onContextMenu,
  onSelect,
}: {
  accent: Accent;
  active: boolean;
  result: SearchResult;
  styles: NotesStyles;
  onContextMenu: (x: number, y: number) => void;
  onSelect: () => void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const parent = parentOf(result.node.path).replace(/\//g, " / ");
  return (
    <div
      data-note-tree-row
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ padding: "0 6px", width: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={onSelect}
        style={[
          styles.searchResult,
          motion,
          hovered && !active && styles.rowHover,
          active && styles.rowActive,
        ]}
      >
        <View style={styles.searchResultIcon}>
          <RiFileTextLine color={active ? accent.accentText : theme.t.textTertiary} size={15} />
        </View>
        <View style={styles.searchResultBody}>
          <Text numberOfLines={1} style={styles.searchResultTitle}>
            {result.node.name}
          </Text>
          {parent ? (
            <Text numberOfLines={1} style={styles.searchResultPath}>
              {parent}
            </Text>
          ) : null}
          {result.snippet ? (
            <Text numberOfLines={2} style={styles.searchResultSnippet}>
              {result.snippet}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </div>
  );
}

type TreeCallbacks = {
  onToggle: (path: string) => void;
  onSelect: (path: string | null) => void;
  onContextMenu: (node: NoteNode, x: number, y: number) => void;
  onCommitRename: (node: NoteNode, name: string) => void;
  onCancelRename: () => void;
};

function TreeLevel({
  accent,
  styles,
  nodes,
  depth,
  expanded,
  editing,
  selectedPath,
  ...cb
}: {
  accent: Accent;
  styles: NotesStyles;
  nodes: NoteNode[];
  depth: number;
  expanded: Set<string>;
  editing: string | null;
  selectedPath: string | null;
} & TreeCallbacks) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          accent={accent}
          styles={styles}
          node={node}
          depth={depth}
          expanded={expanded}
          editing={editing}
          selectedPath={selectedPath}
          {...cb}
        />
      ))}
    </>
  );
}

function TreeRow({
  accent,
  styles,
  node,
  depth,
  expanded,
  editing,
  selectedPath,
  onToggle,
  onSelect,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  accent: Accent;
  styles: NotesStyles;
  node: NoteNode;
  depth: number;
  expanded: Set<string>;
  editing: string | null;
  selectedPath: string | null;
} & TreeCallbacks) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const isFolder = node.kind === "folder";
  const isOpen = expanded.has(node.path);
  const isActive = node.path === selectedPath;
  const isEditing = editing === node.path;
  const indent = 8 + depth * 14;

  return (
    <>
      {/* Plain DOM wrapper so we get a real right-click (contextmenu) event. */}
      <div
        data-note-tree-row
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(node, event.clientX, event.clientY);
        }}
        style={{ width: "100%" }}
      >
        <Pressable
          accessibilityRole="button"
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={() => (isFolder ? onToggle(node.path) : onSelect(node.path))}
          style={[
            styles.row,
            motion,
            { paddingLeft: indent } as ViewStyle,
            hovered && !isActive && styles.rowHover,
            isActive && styles.rowActive,
          ]}
        >
          <View style={styles.twisty}>
            {isFolder ? (
              <RiArrowRightSLine
                color={theme.t.textTertiary}
                size={16}
                style={{
                  transform: isOpen ? "rotate(90deg)" : "none",
                  transition: "transform 150ms ease",
                }}
              />
            ) : null}
          </View>
          {isFolder ? (
            isOpen ? (
              <RiFolderOpenLine color={accent.accentText} size={16} />
            ) : (
              <RiFolderLine color={accent.accentText} size={16} />
            )
          ) : (
            <RiFileTextLine color={isActive ? accent.accentText : theme.t.textTertiary} size={15} />
          )}

          {isEditing ? (
            <RowRenameInput
              styles={styles}
              node={node}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          ) : (
            <Text numberOfLines={1} style={[styles.rowLabel, isFolder && styles.rowLabelMuted]}>
              {node.name}
            </Text>
          )}
        </Pressable>
      </div>

      {isFolder && isOpen && node.children && node.children.length > 0 && (
        <TreeLevel
          accent={accent}
          styles={styles}
          nodes={node.children}
          depth={depth + 1}
          expanded={expanded}
          editing={editing}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
        />
      )}
    </>
  );
}

function RowRenameInput({
  styles,
  node,
  onCommit,
  onCancel,
}: {
  styles: NotesStyles;
  node: NoteNode;
  onCommit: (node: NoteNode, name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(node.name);
  // Enter/blur commit and Escape cancel can both fire (Escape unmounts → blur);
  // this ref makes sure exactly one wins.
  const settledRef = useRef(false);
  const commit = () => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    onCommit(node, value);
  };
  const cancel = () => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    onCancel();
  };
  return (
    <TextInput
      autoFocus
      onBlur={commit}
      onChangeText={setValue}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") {
          cancel();
        }
      }}
      onSubmitEditing={commit}
      selectTextOnFocus
      style={styles.rowInput}
      value={value}
    />
  );
}

// ── Right-click context menu (rendered to <body> so it's never clipped) ─────────
function TreeContextMenu({
  accent,
  theme,
  node,
  x,
  y,
  onAction,
  onClose,
}: {
  accent: Accent;
  theme: Theme;
  node: NoteNode | null;
  x: number;
  y: number;
  onAction: (key: MenuKey) => void;
  onClose: () => void;
}) {
  const { t } = theme;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isMac =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
  const revealLabel = isMac ? "在 Finder 中显示" : "在文件夹中显示";

  // Keep the menu on-screen (mutate style directly — no state, no re-render flicker).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - 8 - rect.width));
    const top = Math.max(8, Math.min(y, window.innerHeight - 8 - rect.height));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  type Row =
    { key: MenuKey; label: string; icon: React.ReactNode; danger?: boolean } | { divider: true };

  const iconColor = t.textSecondary;
  const rows: Row[] = !node
    ? [
        {
          key: "new-note",
          label: "新建笔记",
          icon: <RiFileAddLine color={iconColor} size={15} />,
        },
        {
          key: "new-folder",
          label: "新建文件夹",
          icon: <RiFolderAddLine color={iconColor} size={15} />,
        },
      ]
    : node.kind === "folder"
      ? [
          {
            key: "new-note",
            label: "新建笔记",
            icon: <RiFileAddLine color={iconColor} size={15} />,
          },
          {
            key: "new-folder",
            label: "新建子文件夹",
            icon: <RiFolderAddLine color={iconColor} size={15} />,
          },
          { divider: true },
          { key: "rename", label: "重命名", icon: <RiPencilLine color={iconColor} size={15} /> },
          {
            key: "reveal",
            label: revealLabel,
            icon: <RiExternalLinkLine color={iconColor} size={15} />,
          },
          { divider: true },
          {
            key: "delete",
            label: "删除",
            danger: true,
            icon: <RiDeleteBinLine color={t.errorText} size={15} />,
          },
        ]
      : [
          { key: "rename", label: "重命名", icon: <RiPencilLine color={iconColor} size={15} /> },
          {
            key: "reveal",
            label: revealLabel,
            icon: <RiExternalLinkLine color={iconColor} size={15} />,
          },
          { divider: true },
          {
            key: "delete",
            label: "删除",
            danger: true,
            icon: <RiDeleteBinLine color={t.errorText} size={15} />,
          },
        ];

  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    border: "none",
    background: "transparent",
    padding: "7px 10px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.2,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    transition: "background-color 120ms ease",
  };

  return createPortal(
    <div
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 2000 }}
    >
      <div
        ref={menuRef}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: x,
          top: y,
          minWidth: 188,
          padding: 6,
          background: t.cardSurface,
          border: `1px solid ${t.separator}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
          fontFamily: "inherit",
        }}
      >
        {rows.map((row, index) =>
          "divider" in row ? (
            <div
              key={`divider-${index}`}
              style={{ height: 1, background: t.separator, margin: "5px 8px" }}
            />
          ) : (
            <button
              key={row.key}
              type="button"
              onClick={() => {
                onClose();
                onAction(row.key);
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = row.danger
                  ? "rgba(178,77,77,0.10)"
                  : `rgba(${accent.rgb},0.12)`;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
              style={{ ...itemStyle, color: row.danger ? t.errorText : t.textPrimary }}
            >
              <span style={{ display: "inline-flex", width: 18, justifyContent: "center" }}>
                {row.icon}
              </span>
              {row.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Main column: the editor host ───────────────────────────────────────────────
export function NotesMainColumn({
  accent,
  notes,
  notePath,
  onCreateFirstNote,
  onNotePathChanged,
}: {
  accent: Accent;
  notes: NotesData;
  notePath: string | null;
  onCreateFirstNote: () => void;
  onNotePathChanged: (oldPath: string, newPath: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeNotesStyles(theme, accent), [theme, accent]);
  const node = notes.findNode(notePath);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [editorHandle, setEditorHandle] = useState<MarkdownEditorHandle | null>(null);
  const [viewMode, setViewMode] = useState<NoteViewMode>("wysiwyg");

  useEffect(
    () => applyNoteViewMode(viewMode, editorHandle, toolbarHost),
    [editorHandle, toolbarHost, viewMode],
  );

  const commitTitle = useCallback(
    async (titleValue: string) => {
      if (!node || !notePath) return;
      const nextName = titleValue.trim();
      if (!nextName || nextName === node.name) return;
      await flushNotesUnder(notePath);
      const updated = await notes.renameNode(node, nextName);
      if (updated && updated.path !== notePath) {
        onNotePathChanged(notePath, updated.path);
      }
    },
    [node, notePath, notes, onNotePathChanged],
  );

  const breadcrumb =
    notePath && notePath.includes("/") ? parentOf(notePath).replace(/\//g, " / ") : "";

  return (
    <View style={styles.mainColumnInner}>
      <View style={styles.header}>
        <View style={styles.headerTitleBlock}>
          <EditableNoteTitle
            key={notePath ?? "empty-note"}
            node={node}
            onCommit={commitTitle}
            styles={styles}
          />
        </View>
        {notePath ? (
          <View style={styles.headerActions}>
            <Text style={styles.saveHint}>{SAVE_LABELS[saveState]}</Text>
            <NoteViewModeMenu
              accent={accent}
              disabled={!editorHandle}
              mode={viewMode}
              onChange={setViewMode}
              styles={styles}
              toolbarHost={toolbarHost}
            />
            <div
              className="nomi-note-toolbar-host"
              ref={setToolbarHost}
              style={{ "--nomi-editor-accent": accent.rgb } as React.CSSProperties}
            />
          </View>
        ) : null}
      </View>

      {/* The folder path sits below the header rule, not inside it: stacked
          under the title it had to share a fixed 48px band with, which left both
          lines cramped. Down here it reads as the first line of the note's own
          column and the header carries the title alone. */}
      {breadcrumb ? (
        <View style={styles.breadcrumbBar}>
          <Text style={styles.breadcrumb}>{breadcrumb}</Text>
        </View>
      ) : null}

      {notePath ? (
        <NoteEditor
          key={notePath}
          accent={accent}
          styles={styles}
          notePath={notePath}
          onReady={setEditorHandle}
          onSaveState={setSaveState}
          toolbarHost={toolbarHost}
        />
      ) : (
        <View style={styles.centered}>
          <EmptyIllustration color={theme.t.textPrimary} section="notes" size={104} />
          <Text style={styles.emptyTitle}>写一篇笔记</Text>
          <Text style={styles.emptyDescription}>
            在左侧空白处右键新建笔记，或选择一篇已有笔记。内容会保存在数据目录的 notes 文件夹中。
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onCreateFirstNote}
            style={({ hovered, pressed }: PressState) => [
              styles.toolbarButton,
              motion,
              hovered && styles.toolbarButtonHover,
              pressed && ({ opacity: 0.9 } as ViewStyle),
            ]}
          >
            <RiFileAddLine color={accent.accentText} size={15} />
            <Text style={styles.toolbarButtonText}>新建笔记</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function NoteViewModeIcon({ mode, color }: { mode: NoteViewMode; color: string }) {
  if (mode === "source") return <RiCodeSSlashLine color={color} size={15} />;
  if (mode === "preview") return <RiEyeLine color={color} size={15} />;
  if (mode === "split") return <RiLayoutColumnLine color={color} size={15} />;
  return <RiEdit2Line color={color} size={15} />;
}

function NoteViewModeMenu({
  accent,
  disabled,
  mode,
  onChange,
  styles,
  toolbarHost,
}: {
  accent: Accent;
  disabled: boolean;
  mode: NoteViewMode;
  onChange: (mode: NoteViewMode) => void;
  styles: NotesStyles;
  toolbarHost: HTMLElement | null;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const options: NoteViewMode[] = ["source", "preview", "split", "wysiwyg"];
  return (
    <div ref={anchorRef} style={{ position: "relative", zIndex: 50 }}>
      <Pressable
        accessibilityLabel={`当前为${NOTE_VIEW_LABELS[mode]}，切换笔记视图`}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => {
          toolbarHost
            ?.querySelectorAll<HTMLElement>(".vditor-hint, .vditor-panel")
            .forEach((panel) => {
              panel.style.display = "none";
            });
          setOpen((current) => !current);
        }}
        style={({ hovered, pressed }: PressState) => [
          styles.headerIconButton,
          motion,
          (hovered || pressed) && styles.headerIconButtonHover,
          open && styles.headerIconButtonOpen,
          disabled && ({ opacity: 0.45 } as ViewStyle),
        ]}
      >
        <RiBookOpenLine color={open ? accent.accentText : theme.t.textSecondary} size={17} />
      </Pressable>
      {open ? (
        <View style={styles.viewMenu}>
          {options.map((option) => {
            const active = option === mode;
            return (
              <Pressable
                accessibilityRole="menuitem"
                key={option}
                onPress={() => {
                  onChange(option);
                  setOpen(false);
                }}
                style={({ hovered, pressed }: PressState) => [
                  styles.viewMenuItem,
                  (hovered || pressed) && styles.viewMenuItemHover,
                  active && styles.viewMenuItemActive,
                ]}
              >
                <NoteViewModeIcon
                  color={active ? accent.accentText : theme.t.textSecondary}
                  mode={option}
                />
                <Text style={styles.viewMenuItemText}>{NOTE_VIEW_LABELS[option]}</Text>
                {active ? <RiCheckLine color={accent.accentText} size={15} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </div>
  );
}

function EditableNoteTitle({
  node,
  onCommit,
  styles,
}: {
  node: NoteNode | null;
  onCommit: (value: string) => void;
  styles: NotesStyles;
}) {
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [value, setValue] = useState(node?.name ?? "");
  const settledRef = useRef(false);

  if (editing && node) {
    return (
      <TextInput
        accessibilityLabel="修改笔记标题"
        autoFocus
        onBlur={() => {
          if (settledRef.current) return;
          settledRef.current = true;
          setEditing(false);
          onCommit(value);
        }}
        onChangeText={setValue}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") {
            settledRef.current = true;
            setValue(node.name);
            setEditing(false);
          }
        }}
        onSubmitEditing={() => {
          if (settledRef.current) return;
          settledRef.current = true;
          setEditing(false);
          onCommit(value);
        }}
        selectTextOnFocus
        style={styles.titleInput}
        value={value}
      />
    );
  }

  return (
    <div
      onDoubleClick={() => {
        if (!node) return;
        settledRef.current = false;
        setValue(node.name);
        setEditing(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: node ? "text" : "default", transition: "color 120ms ease" }}
      title={node ? "双击修改标题" : undefined}
    >
      <Text numberOfLines={1} style={[styles.title, hovered && node && styles.titleHover]}>
        {node ? node.name : "笔记"}
      </Text>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";
const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

const AUTOSAVE_MS = 800;

function NoteEditor({
  accent,
  styles,
  notePath,
  onReady,
  onSaveState,
  toolbarHost,
}: {
  accent: Accent;
  styles: NotesStyles;
  notePath: string;
  onReady: (handle: MarkdownEditorHandle) => void;
  onSaveState: (state: SaveState) => void;
  toolbarHost: HTMLElement | null;
}) {
  const theme = useTheme();
  const [status, setStatus] = useState<{
    kind: "loading" | "ready" | "error";
    content?: string;
    error?: string;
  }>({
    kind: "loading",
  });
  const mapRef = useRef(createImageMap());
  const valueRef = useRef("");
  const dirtyRef = useRef(false);
  // Serialized save chain: each flush() waits for any in-flight save then persists
  // the latest value, so awaiting flush() guarantees the newest text is on disk
  // (used before rename) and a switch/unmount can never drop an edit.
  const savingRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);

  // Load this note (constant path — NoteEditor is keyed by notePath upstream, so
  // the initial `loading` state already applies on mount).
  useEffect(() => {
    mountedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const raw = await readNote(notePath);
        const display = await hydrateForDisplay(notePath, raw, mapRef.current);
        if (!alive) {
          return;
        }
        valueRef.current = display;
        setStatus({ kind: "ready", content: display });
      } catch (err) {
        if (alive) {
          setStatus({ kind: "error", error: String(err) });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [notePath]);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) {
      // Still await any in-flight save so callers (e.g. rename) see a settled disk.
      await savingRef.current;
      return;
    }
    // Chain onto any in-flight save, then persist the current snapshot.
    const prior = savingRef.current ?? Promise.resolve();
    const run: Promise<void> = prior
      .then(async () => {
        if (!dirtyRef.current) {
          return;
        }
        const snapshot = valueRef.current;
        if (mountedRef.current) {
          onSaveState("saving");
        }
        try {
          const stored = await prepareForStorage(notePath, snapshot, mapRef.current);
          await saveNote(notePath, stored);
          // Only clear dirty if nothing was typed while this save was running.
          if (valueRef.current === snapshot) {
            dirtyRef.current = false;
          }
          if (mountedRef.current) {
            onSaveState(valueRef.current === snapshot ? "saved" : "saving");
          }
        } catch {
          if (mountedRef.current) {
            onSaveState("error");
          }
        }
      })
      .finally(() => {
        if (savingRef.current === run) {
          savingRef.current = null;
        }
      });
    savingRef.current = run;
    await run;
  }, [notePath, onSaveState]);

  // Flush pending edits on unmount (note switch, tab close, section change).
  useEffect(
    () => () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      const map = mapRef.current;
      void flush().finally(() => disposeImageMap(map));
    },
    [flush],
  );

  // Expose this note's flush so tree actions can persist it before moving its file.
  useEffect(() => registerNoteFlush(notePath, flush), [notePath, flush]);

  const onChange = useCallback(
    (markdown: string) => {
      valueRef.current = markdown;
      dirtyRef.current = true;
      onSaveState("saving");
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush, onSaveState],
  );

  const onImageUpload = useCallback(
    (files: File[]) => uploadNoteImages(notePath, files, mapRef.current),
    [notePath],
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
      <View style={styles.editorHost}>
        <MarkdownEditor
          accentRgb={accent.rgb}
          className="nomi-editor--notes"
          mode="wysiwyg"
          onBlur={() => void flush()}
          onChange={onChange}
          onImageUpload={onImageUpload}
          onReady={onReady}
          onSave={() => void flush()}
          optimizeSelectAll
          placeholder="开始写点什么…"
          toolbar={NOTES_TOOLBAR}
          toolbarHost={toolbarHost}
          value={status.content}
        />
      </View>
    </View>
  );
}
