import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiCalendarLine,
  RiCalendarScheduleLine,
  RiCalendarTodoLine,
  RiCheckLine,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiInboxLine,
  RiLayoutGrid2Line,
  RiListCheck2,
  RiPencilLine,
  RiSearch2Line,
  RiStickyNoteLine,
  RiTimeLine,
} from "@remixicon/react";
import {
  enterFade,
  enterModal,
  glass,
  modalShadow,
  motion,
  SHELL_HEADER_HEIGHT,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { revealTodoData, type Quadrant, type Todo, type TodoPatch } from "./api";
import {
  daysBetween,
  dueLabel,
  shiftKey,
  spanLabel,
  spanProgress,
  todayKey,
  weekendKey,
} from "./dates";
import {
  OVERDUE_COLOR,
  OVERDUE_FILL,
  QUADRANTS,
  quadrantStyle,
  type QuadrantStyle,
} from "./palette";
import type { TodosData } from "./useTodos";
import {
  groupForList,
  scopeCounts,
  scopeLabel,
  scopeQuadrant,
  scopeSubtitle,
  scopeSupportsBoard,
  isOverdue,
  sortForBoard,
  todayProgress,
  todosInScope,
  type TodoLayout,
  type TodoScope,
} from "./views";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
type RemixIcon = typeof RiAddLine;

const QUADRANT_IDS: Quadrant[] = [1, 2, 3, 4];
const TODO_SHOW_DONE_KEY = "nomi.todo.showDone";

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function readShowDone(): boolean {
  try {
    return window.localStorage.getItem(TODO_SHOW_DONE_KEY) === "true";
  } catch {
    return false;
  }
}

async function confirmAction(message: string, title: string): Promise<boolean> {
  try {
    if (isTauriRuntime()) {
      return await tauriConfirm(message, { title, kind: "warning" });
    }
  } catch {
    /* fall through to the browser dialog */
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

/**
 * Today's date key, refreshed when the clock rolls past midnight — an app left
 * open overnight must not keep showing yesterday as 今天.
 */
function useToday(): string {
  const [today, setToday] = useState(todayKey);
  useEffect(() => {
    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const timer = window.setTimeout(
      () => setToday(todayKey()),
      Math.max(1000, nextDay.getTime() - now.getTime()),
    );
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

const SCOPE_VIEWS: { id: TodoScope; icon: RemixIcon }[] = [
  { id: "today", icon: RiCalendarTodoLine },
  { id: "week", icon: RiCalendarScheduleLine },
  { id: "all", icon: RiInboxLine },
  { id: "done", icon: RiCheckboxCircleLine },
];

/** The due date a todo created from this scope should start with. */
function scopeDueDate(scope: TodoScope, today: string): string | null {
  return scope === "today" ? today : null;
}

// ── Styles ───────────────────────────────────────────────────────────────────
function makeTodoStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Collection column
    collectionBody: { flex: 1, minHeight: 0 },
    captureArea: { gap: 8, paddingBottom: 8, paddingHorizontal: 10, paddingTop: 10 },
    captureBox: {
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
    captureBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    captureInput: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 12.5,
      minWidth: 0,
      paddingVertical: 7,
    },
    captureTargets: { alignItems: "center", flexDirection: "row", gap: 5 },
    captureSpacer: { flex: 1 },
    quadrantPick: {
      alignItems: "center",
      borderRadius: 7,
      borderWidth: 1,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    quadrantPickText: { fontSize: 10.5, fontWeight: "700" },
    dueToggle: {
      alignItems: "center",
      borderRadius: 7,
      borderWidth: 1,
      height: 22,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    dueToggleText: { fontSize: 10.5, fontWeight: "600" },
    scopeList: { paddingBottom: 14, paddingHorizontal: 6 },
    groupLabel: {
      color: t.textTertiary,
      fontSize: 10.5,
      fontWeight: "700",
      letterSpacing: 0.3,
      paddingBottom: 4,
      paddingHorizontal: 8,
      paddingTop: 12,
    },
    scopeRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 8,
      minHeight: 32,
      paddingHorizontal: 8,
      width: "100%",
    },
    scopeRowHover: { backgroundColor: t.controlHover },
    scopeRowActive: { backgroundColor: accent.selectedFill },
    scopeIconSlot: { alignItems: "center", justifyContent: "center", width: 18 },
    scopeLabel: { color: t.textPrimary, flex: 1, fontSize: 13, minWidth: 0 },
    scopeLabelActive: { fontWeight: "600" },
    scopeCount: { color: t.textTertiary, fontSize: 11 },
    dot: { borderRadius: 999, height: 9, width: 9 },
    collectionFooter: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      gap: 7,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    footerRow: { alignItems: "center", flexDirection: "row", gap: 8 },
    footerText: { color: t.textSecondary, flex: 1, fontSize: 11 },
    progressTrack: {
      backgroundColor: t.progressTrack,
      borderRadius: 999,
      height: 4,
      overflow: "hidden",
      width: "100%",
    },
    progressFill: { backgroundColor: accent.accent, borderRadius: 999, height: 4 },
    iconButton: {
      alignItems: "center",
      borderRadius: 7,
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    iconButtonHover: { backgroundColor: t.controlHover },

    // Main column
    mainInner: { flex: 1, minHeight: 0 },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 14,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "space-between",
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 20,
    },
    headerTitleBlock: { flexShrink: 1, minWidth: 80 },
    title: { color: t.textPrimary, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
    subtitle: { color: t.textTertiary, fontSize: 11.5, marginTop: 1 },
    headerControls: { alignItems: "center", flexDirection: "row", gap: 8 },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 30,
      maxWidth: 190,
      paddingHorizontal: 9,
      width: 160,
    },
    searchBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    searchInput: { color: t.textPrimary, flex: 1, fontSize: 12, minWidth: 0, paddingVertical: 5 },
    segment: {
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 2,
      padding: 2,
    },
    segmentButton: {
      alignItems: "center",
      borderRadius: 6,
      height: 24,
      justifyContent: "center",
      width: 30,
    },
    segmentButtonActive: {
      backgroundColor: t.cardSurface,
      boxShadow: "0 1px 2px rgba(20,28,40,0.10)",
    },
    ghostButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      height: 28,
      justifyContent: "center",
      paddingHorizontal: 9,
    },
    ghostButtonHover: { backgroundColor: t.controlHover },
    ghostButtonText: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    errorBanner: {
      alignItems: "center",
      backgroundColor: "rgba(178,77,77,0.10)",
      borderColor: "rgba(178,77,77,0.24)",
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      marginHorizontal: 16,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    errorText: { color: t.errorText, flex: 1, fontSize: 12, lineHeight: 17 },

    // Board
    board: { flex: 1, gap: 12, minHeight: 0, padding: 14 },
    boardRow: { flex: 1, flexDirection: "row", gap: 12, minHeight: 0 },
    panel: {
      backgroundColor: t.cardSurface,
      borderRadius: 14,
      borderWidth: 1,
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      overflow: "hidden",
    },
    panelHeader: {
      alignItems: "center",
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 8,
      height: 40,
      minHeight: 40,
      paddingHorizontal: 12,
    },
    panelTitle: { fontSize: 12.5, fontWeight: "700", letterSpacing: -0.1 },
    panelHint: { color: t.textTertiary, flex: 1, fontSize: 10.5, minWidth: 0 },
    panelCount: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
    panelBody: { flex: 1, minHeight: 0 },
    panelContent: { padding: 6 },
    panelFooter: {
      borderTopColor: t.rowDivider,
      borderTopWidth: 1,
      paddingHorizontal: 6,
      paddingVertical: 5,
    },
    panelEmpty: {
      color: t.textTertiary,
      fontSize: 11.5,
      paddingHorizontal: 8,
      paddingVertical: 14,
    },

    // Rows
    row: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 8,
      minHeight: 32,
      paddingHorizontal: 6,
      width: "100%",
    },
    rowHover: { backgroundColor: t.controlHover },
    checkbox: {
      alignItems: "center",
      borderRadius: 999,
      borderWidth: 1.5,
      height: 17,
      justifyContent: "center",
      width: 17,
    },
    rowTitle: { color: t.textPrimary, flex: 1, fontSize: 13, minWidth: 0 },
    rowTitleDone: { color: t.textTertiary, textDecorationLine: "line-through" },
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
      paddingVertical: 2,
    },
    chip: {
      alignItems: "center",
      borderRadius: 6,
      flexDirection: "row",
      gap: 3,
      height: 19,
      paddingHorizontal: 6,
    },
    chipText: { fontSize: 10.5, fontWeight: "600" },
    rowAction: {
      alignItems: "center",
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    noteBadge: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    dropLine: { backgroundColor: accent.accent, borderRadius: 999, height: 2, marginVertical: 1 },
    addRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 7,
      height: 30,
      paddingHorizontal: 6,
    },
    addInput: { color: t.textPrimary, flex: 1, fontSize: 12.5, minWidth: 0, paddingVertical: 5 },

    // List
    listScroll: { flex: 1, minHeight: 0 },
    listContent: { paddingBottom: 48, paddingHorizontal: 20, paddingTop: 12 },
    listInner: { alignSelf: "center", maxWidth: 720, width: "100%" },
    sectionHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingBottom: 3,
      paddingHorizontal: 6,
      paddingTop: 14,
    },
    sectionTitle: { color: t.textSecondary, fontSize: 12, fontWeight: "700" },
    sectionCount: { color: t.textTertiary, fontSize: 11 },
    listEmpty: { alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 44 },
    listEmptyTitle: { color: t.textSecondary, fontSize: 13.5, fontWeight: "600" },
    listEmptyText: {
      color: t.textTertiary,
      fontSize: 12,
      lineHeight: 18,
      maxWidth: 340,
      textAlign: "center",
    },

    // Lightweight todo details
    detailScrim: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 20,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 2400,
    },
    detailScrimHit: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    detailCard: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 16,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      maxWidth: 520,
      overflow: "hidden",
      width: "100%",
    },
    detailHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    detailHeaderText: { flex: 1, minWidth: 0 },
    detailEyebrow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginBottom: 5,
    },
    detailEyebrowText: { color: t.textTertiary, fontSize: 10.5, fontWeight: "600" },
    detailTitleInput: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.2,
      minWidth: 0,
      padding: 0,
    },
    detailClose: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    detailBody: { gap: 8, padding: 16 },
    detailLabel: { color: t.textSecondary, fontSize: 12, fontWeight: "700" },
    detailNotes: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13.5,
      lineHeight: 21,
      minHeight: 190,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlignVertical: "top",
    },
    detailHintRow: { alignItems: "center", flexDirection: "row", gap: 8 },
    detailHint: { color: t.textTertiary, flex: 1, fontSize: 11, lineHeight: 16 },
    detailCount: { color: t.textTertiary, fontSize: 10.5 },
    detailError: { color: t.errorText, fontSize: 11.5, lineHeight: 16 },
    detailFooter: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 10,
      justifyContent: "flex-end",
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    detailStatusButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      height: 32,
      marginRight: "auto",
      paddingHorizontal: 10,
    },
    detailStatusText: { fontSize: 12, fontWeight: "600" },
    detailDoneButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      minWidth: 76,
      paddingHorizontal: 16,
    },
    detailDoneText: { color: "#FFFFFF", fontSize: 12.5, fontWeight: "700" },
  });
}

type TodoStyles = ReturnType<typeof makeTodoStyles>;

// ── Collection column: view picker + quick capture ───────────────────────────
export function TodoCollection({
  accent,
  todos,
  scope,
  onSelectScope,
}: {
  accent: Accent;
  todos: TodosData;
  scope: TodoScope;
  onSelectScope: (scope: TodoScope) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeTodoStyles(theme, accent), [theme, accent]);
  const today = useToday();
  const counts = useMemo(() => scopeCounts(todos.todos, today), [todos.todos, today]);
  const progress = useMemo(() => todayProgress(todos.todos, today), [todos.todos, today]);

  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  // Capture defaults follow the view you are in — adding from 今天 dates the todo
  // today, adding from a quadrant view files it there. The override is tagged
  // with the scope it was made in, so switching views restores that view's
  // defaults without an effect.
  const [override, setOverride] = useState<{
    span: DateSpan;
    quadrant: Quadrant;
    scope: TodoScope;
  } | null>(null);
  const target =
    override?.scope === scope
      ? override
      : {
          span: { start: scope === "today" ? today : null, end: null },
          quadrant: scopeQuadrant(scope) ?? 2,
          scope,
        };

  const submit = async () => {
    const title = draft.trim();
    if (!title) {
      return;
    }
    setDraft("");
    // The date chosen here is kept for the next item: entering a week of work
    // for the same day should not mean re-picking the date every line.
    await todos.addTodo(title, target.quadrant, target.span.start, target.span.end);
  };

  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  return (
    <View style={styles.collectionBody}>
      <View style={styles.captureArea}>
        <View style={[styles.captureBox, motion, focused && styles.captureBoxFocused]}>
          <RiAddLine color={focused ? accent.accentText : theme.t.textTertiary} size={15} />
          <TextInput
            accessibilityLabel="快速添加待办"
            onBlur={() => setFocused(false)}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onSubmitEditing={() => void submit()}
            placeholder="快速添加待办..."
            placeholderTextColor={theme.t.textTertiary}
            style={styles.captureInput}
            value={draft}
          />
        </View>
        <View style={styles.captureTargets}>
          {QUADRANTS.map((meta) => {
            const active = meta.id === target.quadrant;
            return (
              <Pressable
                accessibilityLabel={`加入${meta.label}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={meta.id}
                onPress={() => setOverride({ ...target, quadrant: meta.id, scope })}
                style={({ hovered }: PressState) => [
                  styles.quadrantPick,
                  motion,
                  {
                    backgroundColor: active ? meta.color : hovered ? meta.tint : "transparent",
                    borderColor: active ? meta.color : meta.border,
                  } as ViewStyle,
                ]}
              >
                <Text
                  style={[
                    styles.quadrantPickText,
                    { color: active ? "#FFFFFF" : meta.text } as ViewStyle,
                  ]}
                >
                  {meta.id}
                </Text>
              </Pressable>
            );
          })}
          <View style={styles.captureSpacer} />
          <DateSpanPicker
            accent={accent}
            onChange={(span) => setOverride({ ...target, span, scope })}
            span={target.span}
            styles={styles}
            today={today}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scopeList} style={{ flex: 1 } as ViewStyle}>
        <Text style={styles.groupLabel}>视图</Text>
        {SCOPE_VIEWS.map((view) => (
          <ScopeRow
            accent={accent}
            active={scope === view.id}
            count={counts[view.id]}
            icon={view.icon}
            key={view.id}
            label={scopeLabel(view.id)}
            onPress={() => onSelectScope(view.id)}
            styles={styles}
          />
        ))}

        <Text style={styles.groupLabel}>四象限</Text>
        {QUADRANTS.map((meta) => {
          const id = `q${meta.id}` as TodoScope;
          return (
            <ScopeRow
              accent={accent}
              active={scope === id}
              color={meta.color}
              count={counts[id]}
              key={id}
              label={meta.label}
              onPress={() => onSelectScope(id)}
              styles={styles}
            />
          );
        })}
      </ScrollView>

      <View style={styles.collectionFooter}>
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>
            {progress.total === 0 ? "今天没有安排" : `今天完成 ${progress.done}/${progress.total}`}
          </Text>
          {isTauriRuntime() ? (
            <Pressable
              accessibilityLabel="在访达中显示待办数据"
              accessibilityRole="button"
              onPress={() => void revealTodoData()}
              style={({ hovered }: PressState) => [
                styles.iconButton,
                motion,
                hovered && styles.iconButtonHover,
              ]}
            >
              <RiExternalLinkLine color={theme.t.textTertiary} size={14} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${percent}%` } as ViewStyle, motion]} />
        </View>
      </View>
    </View>
  );
}

function ScopeRow({
  accent,
  active,
  color,
  count,
  icon: Icon,
  label,
  onPress,
  styles,
}: {
  accent: Accent;
  active: boolean;
  color?: string;
  count: number;
  icon?: RemixIcon;
  label: string;
  onPress: () => void;
  styles: TodoStyles;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.scopeRow,
        motion,
        hovered && !active && styles.scopeRowHover,
        active && styles.scopeRowActive,
      ]}
    >
      <View style={styles.scopeIconSlot}>
        {Icon ? (
          <Icon color={active ? accent.accentText : theme.t.textTertiary} size={16} />
        ) : (
          <View style={[styles.dot, { backgroundColor: color } as ViewStyle]} />
        )}
      </View>
      <Text numberOfLines={1} style={[styles.scopeLabel, active && styles.scopeLabelActive]}>
        {label}
      </Text>
      {count > 0 ? <Text style={styles.scopeCount}>{count}</Text> : null}
    </Pressable>
  );
}

// ── Main column ──────────────────────────────────────────────────────────────
export function TodoMainColumn({
  accent,
  todos,
  scope,
  layout,
  onSelectLayout,
}: {
  accent: Accent;
  todos: TodosData;
  scope: TodoScope;
  layout: TodoLayout;
  onSelectLayout: (layout: TodoLayout) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeTodoStyles(theme, accent), [theme, accent]);
  const today = useToday();
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [showDone, setShowDone] = useState(readShowDone);
  const [menu, setMenu] = useState<{ todo: Todo; x: number; y: number } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Which row is in inline-rename mode. Held here (not in the row) so the context
  // menu can start an edit on a row it does not own.
  const [editingId, setEditingId] = useState<string | null>(null);

  const boardable = scopeSupportsBoard(scope);
  const effectiveLayout: TodoLayout = boardable ? layout : "list";
  const dueDefault = scopeDueDate(scope, today);
  const quadrantDefault = scopeQuadrant(scope) ?? 2;

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return todosInScope(todos.todos, scope, today).filter((todo) => {
      if (!showDone && todo.done && scope !== "done") {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return (
        todo.title.toLocaleLowerCase().includes(normalized) ||
        todo.notes.toLocaleLowerCase().includes(normalized)
      );
    });
  }, [query, scope, showDone, today, todos.todos]);

  const openMenu = useCallback((todo: Todo, x: number, y: number) => setMenu({ todo, x, y }), []);
  const openDetail = useCallback((id: string) => {
    setEditingId(null);
    setMenu(null);
    setDetailId(id);
  }, []);
  const detailTodo = detailId ? (todos.todos.find((todo) => todo.id === detailId) ?? null) : null;

  const clearDone = async () => {
    const finished = todos.todos.filter((todo) => todo.done).length;
    if (finished === 0) {
      return;
    }
    if (await confirmAction(`确定要删除 ${finished} 条已完成的待办吗？`, "清空已完成")) {
      await todos.clearDone();
    }
  };

  const toggleShowDone = () => {
    setShowDone((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(TODO_SHOW_DONE_KEY, String(next));
      } catch {
        // A restricted preview can reject storage; the session state still works.
      }
      return next;
    });
  };

  return (
    <View style={styles.mainInner}>
      <View style={styles.header}>
        <View style={styles.headerTitleBlock}>
          <Text numberOfLines={1} style={styles.title}>
            {scopeLabel(scope)}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {scopeSubtitle(scope, today)}
          </Text>
        </View>

        <View style={styles.headerControls}>
          {scope === "done" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void clearDone()}
              style={({ hovered }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && styles.ghostButtonHover,
              ]}
            >
              <RiDeleteBinLine color={theme.t.textTertiary} size={14} />
              <Text style={styles.ghostButtonText}>清空已完成</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={showDone ? "隐藏已完成" : "显示已完成"}
              accessibilityRole="button"
              onPress={toggleShowDone}
              style={({ hovered }: PressState) => [
                styles.ghostButton,
                motion,
                hovered && styles.ghostButtonHover,
                !showDone && ({ backgroundColor: accent.selectedFill } as ViewStyle),
              ]}
            >
              {showDone ? (
                <RiEyeOffLine color={theme.t.textTertiary} size={15} />
              ) : (
                <RiEyeLine color={accent.accentText} size={15} />
              )}
              <Text style={[styles.ghostButtonText, !showDone && { color: accent.accentText }]}>
                {showDone ? "隐藏已完成" : "显示已完成"}
              </Text>
            </Pressable>
          )}

          <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
            <RiSearch2Line
              color={searchFocused ? accent.accentText : theme.t.textTertiary}
              size={14}
            />
            <TextInput
              accessibilityLabel="搜索待办"
              onBlur={() => setSearchFocused(false)}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              placeholder="搜索待办..."
              placeholderTextColor={theme.t.textTertiary}
              style={styles.searchInput}
              value={query}
            />
            {query ? (
              <Pressable
                accessibilityLabel="清除搜索"
                accessibilityRole="button"
                onPress={() => setQuery("")}
              >
                <RiCloseLine color={theme.t.textTertiary} size={14} />
              </Pressable>
            ) : null}
          </View>

          {boardable ? (
            <View style={styles.segment}>
              <SegmentButton
                accent={accent}
                active={effectiveLayout === "board"}
                icon={RiLayoutGrid2Line}
                label="四象限视图"
                onPress={() => onSelectLayout("board")}
                styles={styles}
              />
              <SegmentButton
                accent={accent}
                active={effectiveLayout === "list"}
                icon={RiListCheck2}
                label="清单视图"
                onPress={() => onSelectLayout("list")}
                styles={styles}
              />
            </View>
          ) : null}
        </View>
      </View>

      {todos.error ? (
        <View style={styles.errorBanner}>
          <RiErrorWarningLine color={theme.t.errorText} size={15} />
          <Text style={styles.errorText}>{todos.error}</Text>
          <Pressable
            accessibilityLabel="忽略错误"
            accessibilityRole="button"
            onPress={todos.dismissError}
          >
            <RiCloseLine color={theme.t.errorText} size={14} />
          </Pressable>
        </View>
      ) : null}

      {effectiveLayout === "board" ? (
        <TodoBoard
          accent={accent}
          dueDefault={dueDefault}
          editingId={editingId}
          onEndEdit={() => setEditingId(null)}
          onOpenDetail={openDetail}
          onMenu={openMenu}
          styles={styles}
          today={today}
          todos={todos}
          visible={visible}
        />
      ) : (
        <TodoListView
          accent={accent}
          dueDefault={dueDefault}
          editingId={editingId}
          onEndEdit={() => setEditingId(null)}
          onOpenDetail={openDetail}
          onMenu={openMenu}
          quadrantDefault={quadrantDefault}
          scope={scope}
          styles={styles}
          today={today}
          todos={todos}
          visible={visible}
        />
      )}

      {menu ? (
        <TodoContextMenu
          accent={accent}
          onClose={() => setMenu(null)}
          onEdit={setEditingId}
          onOpenDetail={openDetail}
          theme={theme}
          today={today}
          todo={menu.todo}
          todos={todos}
          x={menu.x}
          y={menu.y}
        />
      ) : null}

      {detailTodo ? (
        <TodoDetailDialog
          key={detailTodo.id}
          onClose={() => setDetailId(null)}
          styles={styles}
          todo={detailTodo}
          todos={todos}
        />
      ) : null}
    </View>
  );
}

function SegmentButton({
  accent,
  active,
  icon: Icon,
  label,
  onPress,
  styles,
}: {
  accent: Accent;
  active: boolean;
  icon: RemixIcon;
  label: string;
  onPress: () => void;
  styles: TodoStyles;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.segmentButton,
        motion,
        active && styles.segmentButtonActive,
        !active && hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
      ]}
    >
      <Icon color={active ? accent.accentText : theme.t.textTertiary} size={15} />
    </Pressable>
  );
}

// ── Board: the four-quadrant matrix ──────────────────────────────────────────
// Cards are dragged with pointer events rather than HTML5 drag-and-drop: the app
// shell deliberately cancels native drags (see App's `preventBrowserDrag` and the
// global `-webkit-user-drag: none`), and this mirrors how the titlebar reorders
// tabs. A press only becomes a drag after 5px of movement, so clicking a title
// can still open its detail note without making card dragging feel sticky.
const DROP_MARKER = " drop";

type DropTarget = { quadrant: Quadrant; index: number };

interface RowDrag {
  onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDown: (todo: Todo, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  register: (id: string, node: HTMLDivElement | null) => void;
}

function TodoBoard({
  accent,
  dueDefault,
  editingId,
  onEndEdit,
  onOpenDetail,
  onMenu,
  styles,
  today,
  todos,
  visible,
}: {
  accent: Accent;
  dueDefault: string | null;
  editingId: string | null;
  onEndEdit: () => void;
  onOpenDetail: (id: string) => void;
  onMenu: (todo: Todo, x: number, y: number) => void;
  styles: TodoStyles;
  today: string;
  todos: TodosData;
  visible: Todo[];
}) {
  const byQuadrant = useMemo(() => {
    const map = new Map<Quadrant, Todo[]>();
    for (const id of QUADRANT_IDS) {
      map.set(id, sortForBoard(visible.filter((todo) => todo.quadrant === id)));
    }
    return map;
  }, [visible]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const panelNodes = useRef(new Map<Quadrant, HTMLDivElement>());
  const session = useRef<{
    drop: DropTarget | null;
    id: string;
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (dragId === null) {
      return;
    }
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragId]);

  /** The panel under the pointer, and the slot the card would land in. */
  const targetAt = (x: number, y: number): DropTarget | null => {
    for (const quadrant of QUADRANT_IDS) {
      const node = panelNodes.current.get(quadrant);
      if (!node) {
        continue;
      }
      const bounds = node.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
        continue;
      }
      const list = byQuadrant.get(quadrant) ?? [];
      for (let index = 0; index < list.length; index += 1) {
        const rowNode = rowNodes.current.get(list[index].id);
        if (!rowNode) {
          continue;
        }
        const rect = rowNode.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          return { quadrant, index };
        }
      }
      return { quadrant, index: list.length };
    }
    return null;
  };

  const applyDrop = async (id: string, target: DropTarget) => {
    const dragged = todos.todos.find((todo) => todo.id === id);
    if (!dragged) {
      return;
    }
    // The drop line sits above one visible card; find it, then place the todo
    // there inside the FULL quadrant list so items hidden by the current scope
    // or search keep their relative order.
    const sequence = (byQuadrant.get(target.quadrant) ?? []).map((todo) => todo.id);
    sequence.splice(target.index, 0, DROP_MARKER);
    const withoutDragged = sequence.filter((entry) => entry !== id);
    const anchor = withoutDragged[withoutDragged.indexOf(DROP_MARKER) + 1] ?? null;

    const ids = sortForBoard(
      todos.todos.filter((todo) => todo.quadrant === target.quadrant && todo.id !== id),
    ).map((todo) => todo.id);
    const at = anchor === null ? -1 : ids.indexOf(anchor);
    ids.splice(at < 0 ? ids.length : at, 0, id);

    if (dragged.quadrant !== target.quadrant) {
      await todos.patchTodo(id, { quadrant: target.quadrant });
    }
    await todos.reorder(target.quadrant, ids);
  };

  const drag: RowDrag = {
    register: (id, node) => {
      if (node) {
        rowNodes.current.set(id, node);
      } else {
        rowNodes.current.delete(id);
      }
    },
    onClickCapture: (event) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onPointerDown: (todo, event) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest('[data-todo-nodrag="true"]')) {
        return;
      }
      session.current = {
        drop: null,
        id: todo.id,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    onPointerMove: (event) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) {
        return;
      }
      if (!current.moved) {
        const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
        if (distance < 5) {
          return;
        }
        current.moved = true;
        setDragId(current.id);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is unavailable in a few older embedded webviews.
        }
      }
      event.preventDefault();
      const next = targetAt(event.clientX, event.clientY);
      current.drop = next;
      setDrop((existing) =>
        existing?.quadrant === next?.quadrant && existing?.index === next?.index ? existing : next,
      );
    },
    onPointerUp: (event) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) {
        return;
      }
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // See the pointer-capture fallback above.
      }
      if (current.moved) {
        // A finished drag must not also read as a click on the card.
        suppressClick.current = true;
        if (current.drop) {
          void applyDrop(current.id, current.drop);
        }
      }
      session.current = null;
      setDragId(null);
      setDrop(null);
    },
    onPointerCancel: () => {
      session.current = null;
      setDragId(null);
      setDrop(null);
    },
  };

  const registerPanel = (quadrant: Quadrant, node: HTMLDivElement | null) => {
    if (node) {
      panelNodes.current.set(quadrant, node);
    } else {
      panelNodes.current.delete(quadrant);
    }
  };

  const panel = (quadrant: Quadrant) => (
    <QuadrantPanel
      accent={accent}
      drag={drag}
      dragId={dragId}
      dropIndex={drop?.quadrant === quadrant ? drop.index : null}
      dueDefault={dueDefault}
      editingId={editingId}
      key={quadrant}
      meta={quadrantStyle(quadrant)}
      onEndEdit={onEndEdit}
      onOpenDetail={onOpenDetail}
      onMenu={onMenu}
      registerPanel={registerPanel}
      styles={styles}
      today={today}
      todoList={byQuadrant.get(quadrant) ?? []}
      todos={todos}
    />
  );

  return (
    <View style={styles.board}>
      <View style={styles.boardRow}>
        {panel(2)}
        {panel(1)}
      </View>
      <View style={styles.boardRow}>
        {panel(4)}
        {panel(3)}
      </View>
    </View>
  );
}

function QuadrantPanel({
  accent,
  drag,
  dragId,
  dropIndex,
  dueDefault,
  editingId,
  meta,
  onEndEdit,
  onOpenDetail,
  onMenu,
  registerPanel,
  styles,
  today,
  todoList,
  todos,
}: {
  accent: Accent;
  drag: RowDrag;
  dragId: string | null;
  dropIndex: number | null;
  dueDefault: string | null;
  editingId: string | null;
  meta: QuadrantStyle;
  onEndEdit: () => void;
  onOpenDetail: (id: string) => void;
  onMenu: (todo: Todo, x: number, y: number) => void;
  registerPanel: (quadrant: Quadrant, node: HTMLDivElement | null) => void;
  styles: TodoStyles;
  today: string;
  todoList: Todo[];
  todos: TodosData;
}) {
  const theme = useTheme();
  const open = todoList.filter((todo) => !todo.done).length;
  const active = dropIndex !== null;

  return (
    <div
      ref={(node) => registerPanel(meta.id, node)}
      style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <View
        style={[
          styles.panel,
          motion,
          {
            borderColor: active ? meta.color : theme.t.separator,
            boxShadow: active ? `0 0 0 3px ${meta.tint}` : undefined,
          } as ViewStyle,
        ]}
      >
        <View
          style={[
            styles.panelHeader,
            { backgroundColor: meta.tint, borderBottomColor: meta.border } as ViewStyle,
          ]}
        >
          <View style={[styles.dot, { backgroundColor: meta.color } as ViewStyle]} />
          <Text style={[styles.panelTitle, { color: meta.text } as ViewStyle]}>{meta.label}</Text>
          <Text numberOfLines={1} style={styles.panelHint}>
            {meta.hint}
          </Text>
          {open > 0 ? <Text style={styles.panelCount}>{open}</Text> : null}
        </View>

        <ScrollView contentContainerStyle={styles.panelContent} style={styles.panelBody}>
          {todoList.length === 0 && !active ? (
            <Text style={styles.panelEmpty}>还没有待办，在下面添加或把卡片拖进来。</Text>
          ) : null}
          {todoList.map((todo, index) => (
            <View key={todo.id}>
              {dropIndex === index ? <View style={styles.dropLine} /> : null}
              <TodoRow
                accent={accent}
                drag={drag}
                dragging={dragId === todo.id}
                editing={editingId === todo.id}
                onEndEdit={onEndEdit}
                onOpenDetail={() => onOpenDetail(todo.id)}
                onMenu={onMenu}
                styles={styles}
                today={today}
                todo={todo}
                todos={todos}
              />
            </View>
          ))}
          {dropIndex === todoList.length ? <View style={styles.dropLine} /> : null}
        </ScrollView>

        <View style={styles.panelFooter}>
          <InlineAdd
            accent={accent}
            dueDate={dueDefault}
            placeholder="添加待办..."
            quadrant={meta.id}
            styles={styles}
            todos={todos}
          />
        </View>
      </View>
    </div>
  );
}

// ── List: one column, grouped by urgency or by day ───────────────────────────
function TodoListView({
  accent,
  dueDefault,
  editingId,
  onEndEdit,
  onOpenDetail,
  onMenu,
  quadrantDefault,
  scope,
  styles,
  today,
  todos,
  visible,
}: {
  accent: Accent;
  dueDefault: string | null;
  editingId: string | null;
  onEndEdit: () => void;
  onOpenDetail: (id: string) => void;
  onMenu: (todo: Todo, x: number, y: number) => void;
  quadrantDefault: Quadrant;
  scope: TodoScope;
  styles: TodoStyles;
  today: string;
  todos: TodosData;
  visible: Todo[];
}) {
  const groups = useMemo(() => groupForList(visible, scope, today), [scope, today, visible]);

  return (
    <ScrollView contentContainerStyle={styles.listContent} style={styles.listScroll}>
      <View style={styles.listInner}>
        {scope === "done" ? null : (
          <InlineAdd
            accent={accent}
            dueDate={dueDefault}
            placeholder={`添加到「${scopeLabel(scope)}」...`}
            quadrant={quadrantDefault}
            styles={styles}
            todos={todos}
          />
        )}

        {groups.length === 0 ? (
          <View style={styles.listEmpty}>
            <Text style={styles.listEmptyTitle}>这里还没有待办</Text>
            <Text style={styles.listEmptyText}>
              {scope === "done"
                ? "完成的待办会收在这里，方便回顾做过的事。"
                : "在上面的输入框添加一条，或切到四象限视图按重要和紧急程度整理。"}
            </Text>
          </View>
        ) : (
          groups.map((group) => (
            <View key={group.key}>
              {group.title ? (
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{group.title}</Text>
                  <Text style={styles.sectionCount}>{group.todos.length}</Text>
                </View>
              ) : null}
              {group.todos.map((todo) => (
                <TodoRow
                  accent={accent}
                  editing={editingId === todo.id}
                  key={todo.id}
                  onEndEdit={onEndEdit}
                  onOpenDetail={() => onOpenDetail(todo.id)}
                  onMenu={onMenu}
                  // The week view keys its sections by date, so that key is the
                  // day this row stands for. Other sections ("已逾期", "未安排
                  // 日期") are not days and fall back to today.
                  refDay={/^\d{4}-\d{2}-\d{2}$/.test(group.key) ? group.key : undefined}
                  // A quadrant scope is already all one colour — the dot would
                  // repeat what the checkbox ring says.
                  showQuadrant={scopeQuadrant(scope) === null}
                  styles={styles}
                  today={today}
                  todo={todo}
                  todos={todos}
                />
              ))}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

// ── One todo ─────────────────────────────────────────────────────────────────
function TodoRow({
  accent,
  drag,
  dragging,
  editing,
  onEndEdit,
  onOpenDetail,
  onMenu,
  refDay,
  showQuadrant,
  styles,
  today,
  todo,
  todos,
}: {
  accent: Accent;
  /** Present only on the board, where cards can be dragged between quadrants. */
  drag?: RowDrag;
  dragging?: boolean;
  editing: boolean;
  onEndEdit: () => void;
  onOpenDetail: () => void;
  onMenu: (todo: Todo, x: number, y: number) => void;
  /** Which day this row stands for. A multi-day task is listed under each day it
   *  runs, so its progress must count from that day rather than from today —
   *  otherwise every copy reads "第 1/3 天". Defaults to today elsewhere. */
  refDay?: string;
  showQuadrant?: boolean;
  styles: TodoStyles;
  today: string;
  todo: Todo;
  todos: TodosData;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const meta = quadrantStyle(todo.quadrant);

  const commit = (value: string) => {
    onEndEdit();
    const next = value.trim();
    if (next && next !== todo.title) {
      void todos.patchTodo(todo.id, { title: next });
    }
  };

  return (
    // Plain DOM wrapper: it carries the real right-click, the hover state and —
    // on the board — the pointer-drag handlers.
    <div
      onClickCapture={drag?.onClickCapture}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(todo, event.clientX, event.clientY);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerCancel={drag?.onPointerCancel}
      onPointerDown={drag ? (event) => drag.onPointerDown(todo, event) : undefined}
      onPointerMove={drag?.onPointerMove}
      onPointerUp={drag?.onPointerUp}
      ref={drag ? (node) => drag.register(todo.id, node) : undefined}
      style={{
        cursor: drag ? (dragging ? "grabbing" : "grab") : "default",
        opacity: dragging ? 0.45 : 1,
        touchAction: drag ? "none" : undefined,
        transition: "opacity 140ms ease",
        // A draggable card must not start a text selection under the pointer.
        userSelect: drag ? "none" : undefined,
        width: "100%",
      }}
    >
      <View style={[styles.row, motion, hovered && styles.rowHover]}>
        <div data-todo-nodrag="true" style={{ display: "flex" }}>
          <Pressable
            accessibilityLabel={todo.done ? "标记为未完成" : "标记为已完成"}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: todo.done }}
            onPress={() => void todos.patchTodo(todo.id, { done: !todo.done })}
            style={({ hovered: over }: PressState) => [
              styles.checkbox,
              motion,
              {
                backgroundColor: todo.done ? meta.color : over ? meta.tint : "transparent",
                borderColor: meta.color,
              } as ViewStyle,
            ]}
          >
            {todo.done ? <RiCheckLine color="#FFFFFF" size={11} /> : null}
          </Pressable>
        </div>

        {editing ? (
          <RowTitleInput
            onCancel={onEndEdit}
            onCommit={commit}
            styles={styles}
            title={todo.title}
          />
        ) : (
          <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
            <Pressable
              accessibilityLabel={`打开待办详情：${todo.title}`}
              accessibilityRole="button"
              onPress={onOpenDetail}
              style={{ flex: 1, minWidth: 0 } as ViewStyle}
            >
              <Text numberOfLines={1} style={[styles.rowTitle, todo.done && styles.rowTitleDone]}>
                {todo.title}
              </Text>
            </Pressable>
          </div>
        )}

        {todo.dueDate ? <DueChip styles={styles} today={today} todo={todo} /> : null}
        {todo.endDate && !todo.done ? (
          <SpanProgressChip day={refDay ?? today} styles={styles} todo={todo} />
        ) : null}
        <TimeChip styles={styles} todo={todo} />

        {todo.notes.trim() ? (
          <div data-todo-nodrag="true" style={{ display: "flex" }}>
            <Pressable
              accessibilityLabel="打开待办备注"
              accessibilityRole="button"
              onPress={onOpenDetail}
              style={({ hovered: over }: PressState) => [
                styles.noteBadge,
                motion,
                over && ({ backgroundColor: meta.tint } as ViewStyle),
              ]}
            >
              <RiStickyNoteLine color={accent.accentText} size={13} />
            </Pressable>
          </div>
        ) : null}

        {showQuadrant ? (
          <View
            accessibilityLabel={meta.label}
            style={[styles.dot, { backgroundColor: meta.color } as ViewStyle]}
          />
        ) : null}

        <div
          data-todo-nodrag="true"
          style={{
            display: "flex",
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 120ms ease",
          }}
        >
          <Pressable
            accessibilityLabel="删除待办"
            accessibilityRole="button"
            onPress={() => void todos.removeTodo(todo.id)}
            style={({ hovered: over }: PressState) => [
              styles.rowAction,
              motion,
              over && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
            ]}
          >
            <RiDeleteBinLine color={hovered ? accent.accentText : theme.t.textTertiary} size={14} />
          </Pressable>
        </div>
      </View>
    </div>
  );
}

function RowTitleInput({
  onCancel,
  onCommit,
  styles,
  title,
}: {
  onCancel: () => void;
  onCommit: (value: string) => void;
  styles: TodoStyles;
  title: string;
}) {
  const [value, setValue] = useState(title);
  // Enter/blur commit and Escape cancel can both fire (Escape unmounts → blur);
  // this ref makes sure exactly one wins.
  const settledRef = useRef(false);
  const settle = (run: () => void) => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    run();
  };
  return (
    <TextInput
      autoFocus
      onBlur={() => settle(() => onCommit(value))}
      onChangeText={setValue}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") {
          settle(onCancel);
        }
      }}
      onSubmitEditing={() => settle(() => onCommit(value))}
      selectTextOnFocus
      style={styles.rowInput}
      value={value}
    />
  );
}

function TodoDetailDialog({
  onClose,
  styles,
  todo,
  todos,
}: {
  onClose: () => void;
  styles: TodoStyles;
  todo: Todo;
  todos: TodosData;
}) {
  const theme = useTheme();
  const meta = quadrantStyle(todo.quadrant);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const saveAndClose = useCallback(async () => {
    if (savingRef.current) {
      return;
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("待办标题不能为空。");
      return;
    }

    const patch: TodoPatch = {};
    if (nextTitle !== todo.title) {
      patch.title = nextTitle;
    }
    // Do not trim notes: blank lines and indentation are meaningful in a small
    // notebook, and the storage layer already enforces the 4,000-character cap.
    if (notes !== todo.notes) {
      patch.notes = notes;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError(null);
    const updated = await todos.patchTodo(todo.id, patch);
    savingRef.current = false;
    setSaving(false);
    if (updated) {
      onClose();
    } else {
      setError("暂时无法保存，请稍后再试。");
    }
  }, [notes, onClose, title, todo.id, todo.notes, todo.title, todos]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void saveAndClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAndClose]);

  return createPortal(
    <View style={[styles.detailScrim, glass(8, 115), enterFade()]}>
      <Pressable
        accessibilityLabel="保存并关闭待办详情"
        onPress={() => void saveAndClose()}
        style={styles.detailScrimHit}
      />
      <View accessibilityViewIsModal style={[styles.detailCard, glass(36, 175), enterModal()]}>
        <View style={styles.detailHeader}>
          <View style={styles.detailHeaderText}>
            <View style={styles.detailEyebrow}>
              <View style={[styles.dot, { backgroundColor: meta.color } as ViewStyle]} />
              <Text style={styles.detailEyebrowText}>{meta.label}</Text>
            </View>
            <TextInput
              accessibilityLabel="待办标题"
              maxLength={200}
              onChangeText={(value) => {
                setTitle(value);
                setError(null);
              }}
              onSubmitEditing={() => void saveAndClose()}
              selectTextOnFocus
              style={styles.detailTitleInput}
              value={title}
            />
          </View>
          <Pressable
            accessibilityLabel="保存并关闭"
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void saveAndClose()}
            style={({ hovered }: PressState) => [
              styles.detailClose,
              motion,
              hovered && styles.iconButtonHover,
            ]}
          >
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>

        <View style={styles.detailBody}>
          <Text style={styles.detailLabel}>详情备注</Text>
          <TextInput
            accessibilityLabel="待办详情备注"
            autoFocus
            maxLength={4000}
            multiline
            onChangeText={(value) => {
              setNotes(value);
              setError(null);
            }}
            placeholder="记录会议号、密码、链接，或其他需要随手查看的信息…"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.detailNotes}
            value={notes}
          />
          <View style={styles.detailHintRow}>
            <Text style={styles.detailHint}>这里的换行会原样保留。</Text>
            <Text style={styles.detailCount}>{notes.length}/4000</Text>
          </View>
          {error ? <Text style={styles.detailError}>{error}</Text> : null}
        </View>

        <View style={styles.detailFooter}>
          <Pressable
            accessibilityLabel={todo.done ? "标记为未完成" : "标记为已完成"}
            accessibilityRole="button"
            onPress={() => void todos.patchTodo(todo.id, { done: !todo.done })}
            style={({ hovered }: PressState) => [
              styles.detailStatusButton,
              motion,
              {
                backgroundColor: hovered ? meta.tint : theme.t.controlIdle,
              } as ViewStyle,
            ]}
          >
            {todo.done ? (
              <RiCheckboxCircleLine color={meta.color} size={15} />
            ) : (
              <View style={[styles.checkbox, { borderColor: meta.color } as ViewStyle]} />
            )}
            <Text style={[styles.detailStatusText, { color: meta.text } as ViewStyle]}>
              {todo.done ? "已完成" : "标记完成"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void saveAndClose()}
            style={({ pressed }: PressState) => [
              styles.detailDoneButton,
              motion,
              pressed && ({ transform: [{ scale: 0.98 }] } as ViewStyle),
              saving && ({ opacity: 0.65 } as ViewStyle),
            ]}
          >
            <Text style={styles.detailDoneText}>{saving ? "保存中…" : "完成"}</Text>
          </Pressable>
        </View>
      </View>
    </View>,
    document.body,
  );
}

function DueChip({ styles, today, todo }: { styles: TodoStyles; today: string; todo: Todo }) {
  const theme = useTheme();
  // Overdue tracks the END of the span: a task running until Friday is not late
  // on Wednesday just because it started Monday.
  const overdue = isOverdue(todo, today);
  const color = overdue ? OVERDUE_COLOR : theme.t.textSecondary;
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: overdue ? OVERDUE_FILL : theme.t.controlIdle } as ViewStyle,
      ]}
    >
      <RiCalendarLine color={color} size={10} />
      <Text numberOfLines={1} style={[styles.chipText, { color } as ViewStyle]}>
        {todo.dueDate === null
          ? dueLabel(today, today)
          : spanLabel(todo.dueDate, todo.endDate, today)}
      </Text>
    </View>
  );
}

/** "第 2/4 天" for a multi-day task that is running right now. The date range
 *  alone says when it ends, not how far into it you are. */
function SpanProgressChip({ day, styles, todo }: { day: string; styles: TodoStyles; todo: Todo }) {
  const theme = useTheme();
  const label = todo.dueDate === null ? null : spanProgress(todo.dueDate, todo.endDate, day);
  if (label === null) {
    return null;
  }
  return (
    <View style={[styles.chip, { backgroundColor: theme.t.controlIdle } as ViewStyle]}>
      <Text style={[styles.chipText, { color: theme.t.textSecondary } as ViewStyle]}>{label}</Text>
    </View>
  );
}

/** A small clock chip showing the task's 24-hour time block. Keep the unset
 * state explicit so it is never ambiguous whether a card has a hidden time. */
function TimeChip({ styles, todo }: { styles: TodoStyles; todo: Todo }) {
  const theme = useTheme();
  const label = todo.startTime
    ? todo.endTime
      ? `${todo.startTime}–${todo.endTime}`
      : todo.startTime
    : todo.endTime
      ? `截至 ${todo.endTime}`
      : "未设时间";
  const color = todo.startTime || todo.endTime ? theme.t.textSecondary : theme.t.textTertiary;
  return (
    <View style={[styles.chip, { backgroundColor: theme.t.controlIdle } as ViewStyle]}>
      <RiTimeLine color={color} size={10} />
      <Text style={[styles.chipText, { color } as ViewStyle]}>{label}</Text>
    </View>
  );
}

function InlineAdd({
  accent,
  dueDate,
  placeholder,
  quadrant,
  styles,
  todos,
}: {
  accent: Accent;
  dueDate: string | null;
  placeholder: string;
  quadrant: Quadrant;
  styles: TodoStyles;
  todos: TodosData;
}) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const submit = async () => {
    const title = value.trim();
    if (!title) {
      return;
    }
    // Clear first so the next item can be typed straight away.
    setValue("");
    await todos.addTodo(title, quadrant, dueDate);
  };

  return (
    <View
      style={[
        styles.addRow,
        motion,
        focused && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
      ]}
    >
      <RiAddLine color={focused ? accent.accentText : theme.t.textTertiary} size={14} />
      <TextInput
        accessibilityLabel={placeholder}
        blurOnSubmit={false}
        onBlur={() => setFocused(false)}
        onChangeText={setValue}
        onFocus={() => setFocused(true)}
        onSubmitEditing={() => void submit()}
        placeholder={placeholder}
        placeholderTextColor={theme.t.textTertiary}
        style={styles.addInput}
        value={value}
      />
    </View>
  );
}

// ── Date span picking ───────────────────────────────────────────────────────
// One shared surface for "when does this happen", used by the capture bar (so a
// todo can be dated as it is created, rather than filed under today and fixed
// afterwards) and by the right-click menu. Native <input type="date"> for the
// same reason TimeRangeEditor uses type="time": the OS calendar is better than
// anything hand-rolled here, and it matches the rest of the module.

export interface DateSpan {
  start: string | null;
  end: string | null;
}

/** Button text for a span: 不设日期 / 今天 / 今天 → 周四. */
function spanButtonLabel(span: DateSpan, today: string): string {
  if (span.start === null) {
    return "不设日期";
  }
  return spanLabel(span.start, span.end, today);
}

/** Start → end inputs plus a day count. Emits a whole span, already ordered, so
 *  neither caller has to think about which end moved. */
function DateSpanFields({
  accent,
  onChange,
  span,
  theme,
}: {
  accent: Accent;
  onChange: (span: DateSpan) => void;
  span: DateSpan;
  theme: Theme;
}) {
  const { t } = theme;
  // flex + minWidth:0 because a native date input sizes to its content, so an
  // empty end field rendered visibly narrower than a filled start field.
  const inputStyle: React.CSSProperties = {
    background: t.cardSurfaceAlt,
    border: `1px solid ${t.separator}`,
    borderRadius: 7,
    color: t.textPrimary,
    flex: 1,
    fontFamily: "inherit",
    fontSize: 12.5,
    minWidth: 0,
    outline: "none",
    padding: "5px 7px",
  };
  const days = span.start && span.end ? daysBetween(span.start, span.end) + 1 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 10px 6px" }}>
      <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
        <input
          aria-label="开始日期"
          onChange={(event) => onChange({ start: event.target.value || null, end: span.end })}
          style={inputStyle}
          type="date"
          value={span.start ?? ""}
        />
        <span style={{ color: t.textTertiary, fontSize: 12 }}>→</span>
        <input
          aria-label="结束日期"
          // An end with no start has nothing to span from, so picking one first
          // starts the task that day instead of being silently dropped.
          disabled={span.start === null}
          onChange={(event) => onChange({ start: span.start, end: event.target.value || null })}
          style={{ ...inputStyle, opacity: span.start === null ? 0.5 : 1 }}
          type="date"
          value={span.end ?? ""}
        />
      </div>
      {days > 1 ? (
        <span style={{ color: accent.accentText, fontSize: 11.5, fontWeight: 600 }}>
          共 {days} 天
        </span>
      ) : null}
    </div>
  );
}

/** A button showing the current span, opening a popover to change it. */
function DateSpanPicker({
  accent,
  onChange,
  span,
  styles,
  today,
}: {
  accent: Accent;
  onChange: (span: DateSpan) => void;
  span: DateSpan;
  styles: TodoStyles;
  today: string;
}) {
  const theme = useTheme();
  const { t } = theme;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const openMenu = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ left: rect.left, top: rect.bottom + 6 });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const dated = span.start !== null;
  const quick: { key: string; label: string; span: DateSpan }[] = [
    { key: "today", label: "今天", span: { start: today, end: null } },
    { key: "tomorrow", label: "明天", span: { start: shiftKey(today, 1), end: null } },
    { key: "weekend", label: "本周末", span: { start: weekendKey(today), end: null } },
    {
      key: "3d",
      label: "未来三天",
      span: { start: today, end: shiftKey(today, 2) },
    },
    { key: "week", label: "本周七天", span: { start: today, end: shiftKey(today, 6) } },
    { key: "none", label: "不设日期", span: { start: null, end: null } },
  ];

  return (
    <div ref={anchorRef} style={{ display: "flex" }}>
      <Pressable
        accessibilityLabel="设置日期"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={openMenu}
        style={({ hovered }: PressState) => [
          styles.dueToggle,
          motion,
          {
            backgroundColor: dated ? accent.selectedFill : hovered ? t.controlHover : "transparent",
            borderColor: dated ? accent.accent : t.controlBorder,
            flexDirection: "row",
            gap: 4,
          } as ViewStyle,
        ]}
      >
        <View pointerEvents="none" style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <RiCalendarLine color={dated ? accent.accentText : t.textTertiary} size={11} />
          <Text
            style={[
              styles.dueToggleText,
              { color: dated ? accent.accentText : t.textTertiary } as ViewStyle,
            ]}
          >
            {spanButtonLabel(span, today)}
          </Text>
        </View>
      </Pressable>

      {open && anchor
        ? createPortal(
            <div
              onClick={() => setOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 2000 }}
            >
              <div
                onClick={(event) => event.stopPropagation()}
                style={{
                  background: t.cardSurface,
                  border: `1px solid ${t.separator}`,
                  borderRadius: 12,
                  boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
                  left: Math.max(8, Math.min(anchor.left, window.innerWidth - 308)),
                  padding: 6,
                  position: "fixed",
                  top: anchor.top,
                  // Wide enough for two native date inputs side by side; below
                  // this the browser clips the date text behind the picker icon.
                  width: 300,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gap: 4,
                    gridTemplateColumns: "repeat(3, 1fr)",
                    padding: "2px 4px 6px",
                  }}
                >
                  {quick.map((option) => {
                    const selected =
                      option.span.start === span.start && option.span.end === span.end;
                    return (
                      <button
                        key={option.key}
                        onClick={() => {
                          onChange(option.span);
                          setOpen(false);
                        }}
                        onMouseEnter={(event) => {
                          if (!selected) event.currentTarget.style.background = t.controlHover;
                        }}
                        onMouseLeave={(event) => {
                          if (!selected) event.currentTarget.style.background = "transparent";
                        }}
                        style={{
                          background: selected ? accent.selectedFill : "transparent",
                          border: `1px solid ${selected ? accent.accent : t.controlBorder}`,
                          borderRadius: 7,
                          color: selected ? accent.accentText : t.textSecondary,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: 12,
                          fontWeight: selected ? 600 : 500,
                          padding: "5px 4px",
                          textAlign: "center",
                          transition: "background-color 120ms ease",
                          whiteSpace: "nowrap",
                        }}
                        type="button"
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ background: t.separator, height: 1, margin: "2px 4px 6px" }} />
                <DateSpanFields accent={accent} onChange={onChange} span={span} theme={theme} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ── Right-click menu (rendered to <body> so it is never clipped) ─────────────
type MenuRow =
  | { kind: "divider"; key: string }
  | { kind: "heading"; key: string; label: string }
  | { kind: "custom"; key: string; render: () => React.ReactNode }
  | {
      kind: "item";
      key: string;
      label: string;
      danger?: boolean;
      dot?: string;
      icon?: React.ReactNode;
      selected?: boolean;
      run: () => void;
    };

/** Two `HH:MM` inputs (start → end) for a task's time block. Keeps local state
 *  (the menu holds a snapshot todo) and patches on every change. */
function TimeRangeEditor({
  accent,
  onPatch,
  theme,
  todo,
}: {
  accent: Accent;
  onPatch: (patch: TodoPatch) => void;
  theme: Theme;
  todo: Todo;
}) {
  const { t } = theme;
  const [start, setStart] = useState(todo.startTime ?? "");
  const [end, setEnd] = useState(todo.endTime ?? "");
  const skipBlur = useRef<"start" | "end" | null>(null);
  const normalize = (value: string): string | null => {
    const cleaned = value.trim().replace(/：/g, ":");
    const match = /^(\d{1,2}):(\d{2})$/.exec(cleaned) ?? /^(\d{1,2})(\d{2})$/.exec(cleaned);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };
  const commit = (kind: "start" | "end", value: string) => {
    const current = kind === "start" ? todo.startTime : todo.endTime;
    if (!value.trim()) {
      if (kind === "start") setStart("");
      else setEnd("");
      onPatch(kind === "start" ? { startTime: null } : { endTime: null });
      return;
    }
    const normalized = normalize(value);
    if (kind === "start") setStart(normalized ?? current ?? "");
    else setEnd(normalized ?? current ?? "");
    if (normalized && normalized !== current) {
      onPatch(kind === "start" ? { startTime: normalized } : { endTime: normalized });
    }
  };
  const inputStyle: React.CSSProperties = {
    background: t.cardSurfaceAlt,
    border: `1px solid ${t.separator}`,
    borderRadius: 7,
    color: t.textPrimary,
    fontFamily: "inherit",
    fontSize: 12.5,
    outline: "none",
    padding: "5px 7px",
    width: 72,
  };
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 6, padding: "2px 10px 6px" }}>
      <input
        aria-label="开始时间，24 小时制"
        autoComplete="off"
        inputMode="numeric"
        maxLength={5}
        onBlur={() => {
          if (skipBlur.current === "start") {
            skipBlur.current = null;
          } else {
            commit("start", start);
          }
        }}
        onChange={(event) => setStart(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            skipBlur.current = "start";
            setStart(todo.startTime ?? "");
            event.currentTarget.blur();
          }
        }}
        placeholder="HH:MM"
        spellCheck={false}
        style={inputStyle}
        title="24 小时制，例如 09:30 或 18:45"
        type="text"
        value={start}
      />
      <span style={{ color: t.textTertiary, fontSize: 12 }}>→</span>
      <input
        aria-label="结束时间，24 小时制"
        autoComplete="off"
        inputMode="numeric"
        maxLength={5}
        onBlur={() => {
          if (skipBlur.current === "end") {
            skipBlur.current = null;
          } else {
            commit("end", end);
          }
        }}
        onChange={(event) => setEnd(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            skipBlur.current = "end";
            setEnd(todo.endTime ?? "");
            event.currentTarget.blur();
          }
        }}
        placeholder="HH:MM"
        spellCheck={false}
        style={inputStyle}
        title="24 小时制，例如 09:30 或 18:45"
        type="text"
        value={end}
      />
      {start || end ? (
        <button
          aria-label="清除时间"
          onClick={() => {
            setStart("");
            setEnd("");
            onPatch({ startTime: null, endTime: null });
          }}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = `rgba(${accent.rgb},0.12)`;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "transparent";
          }}
          style={{
            alignItems: "center",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            display: "flex",
            height: 24,
            justifyContent: "center",
            width: 24,
          }}
          type="button"
        >
          <RiCloseLine color={t.textTertiary} size={14} />
        </button>
      ) : null}
    </div>
  );
}

function TodoContextMenu({
  accent,
  onClose,
  onEdit,
  onOpenDetail,
  theme,
  today,
  todo,
  todos,
  x,
  y,
}: {
  accent: Accent;
  onClose: () => void;
  onEdit: (id: string) => void;
  onOpenDetail: (id: string) => void;
  theme: Theme;
  today: string;
  todo: Todo;
  todos: TodosData;
  x: number;
  y: number;
}) {
  const { t } = theme;
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Keep the menu on-screen (mutate style directly — no state, no re-render flicker).
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 8 - rect.width))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 8 - rect.height))}px`;
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

  const iconColor = t.textSecondary;
  // Quick picks set a single day, so they clear any existing span rather than
  // leaving an end date stranded behind a new start.
  const setDue = (date: string | null) => () =>
    void todos.patchTodo(todo.id, { dueDate: date, endDate: null });
  const span: DateSpan = { start: todo.dueDate, end: todo.endDate };

  const rows: MenuRow[] = [
    {
      kind: "item",
      key: "toggle",
      label: todo.done ? "标记为未完成" : "标记为已完成",
      icon: <RiCheckLine color={iconColor} size={15} />,
      run: () => void todos.patchTodo(todo.id, { done: !todo.done }),
    },
    {
      kind: "item",
      key: "detail",
      label: "打开详情",
      icon: <RiStickyNoteLine color={iconColor} size={15} />,
      run: () => onOpenDetail(todo.id),
    },
    {
      kind: "item",
      key: "rename",
      label: "重命名",
      icon: <RiPencilLine color={iconColor} size={15} />,
      run: () => onEdit(todo.id),
    },
    { kind: "divider", key: "d1" },
    { kind: "heading", key: "h-quadrant", label: "移动到象限" },
    ...QUADRANTS.map<MenuRow>((meta) => ({
      kind: "item",
      key: `q${meta.id}`,
      label: meta.label,
      dot: meta.color,
      selected: meta.id === todo.quadrant,
      run: () => void todos.patchTodo(todo.id, { quadrant: meta.id }),
    })),
    { kind: "divider", key: "d2" },
    { kind: "heading", key: "h-due", label: "日期" },
    {
      kind: "item",
      key: "due-today",
      label: "今天",
      icon: <RiCalendarTodoLine color={iconColor} size={15} />,
      selected: todo.endDate === null && todo.dueDate === today,
      run: setDue(today),
    },
    {
      kind: "item",
      key: "due-tomorrow",
      label: "明天",
      icon: <RiCalendarLine color={iconColor} size={15} />,
      selected: todo.endDate === null && todo.dueDate === shiftKey(today, 1),
      run: setDue(shiftKey(today, 1)),
    },
    {
      kind: "item",
      key: "due-weekend",
      label: "本周末",
      icon: <RiCalendarScheduleLine color={iconColor} size={15} />,
      selected: todo.endDate === null && todo.dueDate === weekendKey(today),
      run: setDue(weekendKey(today)),
    },
    {
      kind: "item",
      key: "due-clear",
      label: "清除日期",
      icon: <RiCloseLine color={iconColor} size={15} />,
      selected: todo.dueDate === null,
      run: setDue(null),
    },
    {
      kind: "custom",
      key: "date-span",
      render: () => (
        <DateSpanFields
          accent={accent}
          onChange={(next) =>
            void todos.patchTodo(todo.id, { dueDate: next.start, endDate: next.end })
          }
          span={span}
          theme={theme}
        />
      ),
    },
    { kind: "divider", key: "d-time" },
    { kind: "heading", key: "h-time", label: "时间段（当天）" },
    {
      kind: "custom",
      key: "time-range",
      render: () => (
        <TimeRangeEditor
          accent={accent}
          onPatch={(patch) => void todos.patchTodo(todo.id, patch)}
          theme={theme}
          todo={todo}
        />
      ),
    },
    { kind: "divider", key: "d3" },
    {
      kind: "item",
      key: "delete",
      label: "删除待办",
      danger: true,
      icon: <RiDeleteBinLine color={t.errorText} size={15} />,
      run: () => void todos.removeTodo(todo.id),
    },
  ];

  const itemStyle: React.CSSProperties = {
    alignItems: "center",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 500,
    gap: 10,
    lineHeight: 1.2,
    padding: "7px 10px",
    textAlign: "left",
    transition: "background-color 120ms ease",
    width: "100%",
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
        onClick={(event) => event.stopPropagation()}
        ref={menuRef}
        style={{
          background: t.cardSurface,
          border: `1px solid ${t.separator}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
          fontFamily: "inherit",
          left: x,
          minWidth: 196,
          padding: 6,
          position: "fixed",
          top: y,
        }}
      >
        {rows.map((row) => {
          if (row.kind === "divider") {
            return (
              <div
                key={row.key}
                style={{ background: t.separator, height: 1, margin: "5px 8px" }}
              />
            );
          }
          if (row.kind === "heading") {
            return (
              <div
                key={row.key}
                style={{
                  color: t.textTertiary,
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  padding: "6px 10px 3px",
                }}
              >
                {row.label}
              </div>
            );
          }
          if (row.kind === "custom") {
            return <div key={row.key}>{row.render()}</div>;
          }
          return (
            <button
              key={row.key}
              onClick={() => {
                onClose();
                row.run();
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
              type="button"
            >
              <span style={{ display: "inline-flex", justifyContent: "center", width: 18 }}>
                {row.dot ? (
                  <span
                    style={{
                      background: row.dot,
                      borderRadius: 999,
                      height: 9,
                      marginTop: 4,
                      width: 9,
                    }}
                  />
                ) : (
                  row.icon
                )}
              </span>
              <span style={{ flex: 1 }}>{row.label}</span>
              {row.selected ? <RiCheckLine color={accent.accentText} size={14} /> : null}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
