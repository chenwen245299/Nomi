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
import { createPortal } from "react-dom";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiFolderOpenLine,
  RiNodeTree,
  RiSearch2Line,
  RiFileList3Line,
} from "@remixicon/react";
import {
  SHELL_HEADER_HEIGHT,
  enterModal,
  glass,
  modalShadow,
  motion,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { revealPaper, type Paper } from "./api";
import { RATED_STATUSES, STATUS_META, STATUS_ORDER, type PaperStatus } from "./constants";
import { GraphCanvas } from "./GraphCanvas";
import { PaperEditor } from "./PaperEditor";
import type { PapersData } from "./usePapers";

export type PapersView = "graph" | "detail";

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

const NEW_PAPER = (x: number, y: number) => ({
  title: "未命名论文",
  status: "idea" as PaperStatus,
  venue: "",
  tags: [] as string[],
  rating: 0,
  x,
  y,
});

import { StarsInline } from "../ratings";

// ── Collection: papers grouped by status ────────────────────────────────────
export function PapersCollection({
  accent,
  papers,
  selectedId,
  onOpenPaper,
}: {
  accent: Accent;
  papers: PapersData;
  selectedId: string | null;
  onOpenPaper: (id: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Status filter: empty set = show everything. Otherwise only the chosen statuses.
  const [filters, setFilters] = useState<Set<PaperStatus>>(new Set());

  const deletePaper = useCallback(
    async (id: string) => {
      const paper = papers.papers.find((p) => p.id === id);
      const ok = await confirmDelete(
        `确定删除论文「${paper?.title || "未命名论文"}」吗？此操作无法撤销。`,
      );
      if (ok) void papers.deletePaper(id);
    },
    [papers],
  );

  const toggleFilter = useCallback((status: PaperStatus) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalized) return papers.papers;
    return papers.papers.filter((p) => {
      const hay = `${p.title} ${p.venue} ${p.tags.join(" ")}`.toLowerCase();
      return hay.includes(normalized);
    });
  }, [papers.papers, normalized]);

  const grouped = useMemo(() => {
    const by: Record<PaperStatus, Paper[]> = {
      writing: [],
      planned: [],
      idea: [],
      done: [],
      published: [],
    };
    for (const paper of filtered) by[paper.status]?.push(paper);
    for (const status of STATUS_ORDER) {
      // 打算写 / 有潜力 rank by importance first — that is what the stars are for.
      // Unrated (0) therefore sinks below every rated one, and recency breaks ties
      // exactly as it does everywhere else.
      by[status].sort((a, b) =>
        RATED_STATUSES.has(status) && b.rating !== a.rating
          ? b.rating - a.rating
          : b.updatedAt - a.updatedAt,
      );
    }
    return by;
  }, [filtered]);

  const visibleStatuses = STATUS_ORDER.filter((s) => filters.size === 0 || filters.has(s));
  const visibleCount = visibleStatuses.reduce((n, s) => n + grouped[s].length, 0);

  const createPaper = useCallback(async () => {
    // Spread list-created papers on a loose grid so they don't stack at the origin.
    const n = papers.papers.length;
    const x = (n % 5) * 70 - 140;
    const y = Math.floor(n / 5) * 70 - 60;
    const created = await papers.createPaper(NEW_PAPER(x, y));
    if (created) onOpenPaper(created.id);
  }, [papers, onOpenPaper]);

  return (
    <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
      <View style={styles.searchArea}>
        <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
          <RiSearch2Line
            color={searchFocused ? accent.accentText : theme.t.textTertiary}
            size={15}
          />
          <TextInput
            accessibilityLabel="搜索论文"
            onBlur={() => setSearchFocused(false)}
            onChangeText={setQuery}
            onFocus={() => setSearchFocused(true)}
            placeholder="搜索标题、期刊、标签…"
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
        <Pressable
          accessibilityLabel="新建论文"
          onPress={createPaper}
          style={({ hovered, pressed }: PressState) => [
            styles.newButton,
            motion,
            hovered && styles.newButtonHover,
            pressed && ({ opacity: 0.9 } as ViewStyle),
          ]}
        >
          <RiAddLine color={accent.accentText} size={16} />
          <Text style={styles.newButtonText}>新建</Text>
        </Pressable>
      </View>

      <View style={styles.filterRow}>
        {STATUS_ORDER.map((status) => {
          const active = filters.has(status);
          const meta = STATUS_META[status];
          return (
            <Pressable
              key={status}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => toggleFilter(status)}
              style={({ hovered }: PressState) => [
                styles.filterChip,
                motion,
                hovered && !active && styles.filterChipHover,
                active && { backgroundColor: meta.soft, borderColor: meta.color },
              ]}
            >
              <View style={[styles.filterDot, { backgroundColor: meta.color }]} />
              <Text
                style={[styles.filterChipText, active && { color: meta.text, fontWeight: "600" }]}
              >
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {papers.loading && papers.papers.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator color={theme.t.textTertiary} size="small" />
        </View>
      ) : visibleCount === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {normalized
              ? `没有找到包含“${query.trim()}”的论文`
              : filters.size > 0
                ? "没有符合筛选条件的论文"
                : "还没有论文\n点上方「新建」开始规划"}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          style={{ flex: 1, minHeight: 0 } as ViewStyle}
        >
          {visibleStatuses.map((status) => {
            const items = grouped[status];
            if (items.length === 0) return null;
            const meta = STATUS_META[status];
            return (
              <View key={status} style={styles.group}>
                <View style={styles.groupHeader}>
                  <View style={[styles.groupDot, { backgroundColor: meta.color }]} />
                  <Text style={styles.groupTitle}>{meta.label}</Text>
                  <Text style={styles.groupCount}>{items.length}</Text>
                </View>
                {items.map((paper) => (
                  <PaperListCard
                    key={paper.id}
                    active={paper.id === selectedId}
                    paper={paper}
                    styles={styles}
                    onContextMenu={(x, y) => setMenu({ id: paper.id, x, y })}
                    onPress={() => onOpenPaper(paper.id)}
                  />
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}

      {menu ? (
        <ListContextMenu
          accent={accent}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onOpen={() => {
            onOpenPaper(menu.id);
            setMenu(null);
          }}
          onReveal={() => {
            const id = menu.id;
            setMenu(null);
            void revealPaper(id);
          }}
          onDelete={() => {
            const id = menu.id;
            setMenu(null);
            void deletePaper(id);
          }}
        />
      ) : null}
    </View>
  );
}

function ListContextMenu({
  accent,
  x,
  y,
  onOpen,
  onReveal,
  onDelete,
  onClose,
}: {
  accent: Accent;
  x: number;
  y: number;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = theme;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 8 - rect.width))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 8 - rect.height))}px`;
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: { label: string; icon: React.ReactNode; onPress: () => void; danger?: boolean }[] = [
    {
      label: "打开",
      icon: <RiExternalLinkLine color={t.textSecondary} size={15} />,
      onPress: onOpen,
    },
    // Reveal only works on the desktop build (Finder / file manager).
    ...(isTauriRuntime()
      ? [
          {
            label: "在访达中显示",
            icon: <RiFolderOpenLine color={t.textSecondary} size={15} />,
            onPress: onReveal,
          },
        ]
      : []),
    {
      label: "删除",
      icon: <RiDeleteBinLine color={t.errorText} size={15} />,
      onPress: onDelete,
      danger: true,
    },
  ];

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
        ref={ref}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: x,
          top: y,
          minWidth: 160,
          padding: 6,
          background: t.cardSurface,
          border: `1px solid ${t.separator}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
          fontFamily: "inherit",
        }}
      >
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            onClick={row.onPress}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = row.danger
                ? "rgba(178,77,77,0.10)"
                : `rgba(${accent.rgb},0.12)`;
            }}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
            style={{
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
              color: row.danger ? t.errorText : t.textPrimary,
              transition: "background-color 120ms ease",
            }}
          >
            <span style={{ display: "inline-flex", width: 18, justifyContent: "center" }}>
              {row.icon}
            </span>
            {row.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function PaperListCard({
  active,
  paper,
  styles,
  onContextMenu,
  onPress,
}: {
  active: boolean;
  paper: Paper;
  styles: Styles;
  onContextMenu: (x: number, y: number) => void;
  onPress: () => void;
}) {
  const theme = useTheme();
  const showStars = RATED_STATUSES.has(paper.status) && paper.rating > 0;
  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ width: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ hovered }: PressState) => [
          styles.card,
          motion,
          hovered && !active && styles.cardHover,
          active && styles.cardActive,
        ]}
      >
        <Text ellipsizeMode="tail" numberOfLines={1} style={styles.cardTitle}>
          {paper.title}
        </Text>
        {showStars || paper.venue || paper.tags.length > 0 ? (
          <View style={styles.cardBadgeRow}>
            {/* Stars lead the row so they line up down the column and the group
                can be read as a ranking at a glance. */}
            {showStars ? <StarsInline rating={paper.rating} size={10} /> : null}
            {paper.venue ? (
              <View style={styles.venueBadge}>
                <Text numberOfLines={1} style={styles.venueBadgeText}>
                  {paper.venue}
                </Text>
              </View>
            ) : null}
            {paper.tags.length > 0 ? (
              <Text numberOfLines={1} style={[styles.cardTags, { color: theme.t.textTertiary }]}>
                #{paper.tags.slice(0, 4).join("  #")}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </div>
  );
}

// ── Main column: graph ↔ detail ─────────────────────────────────────────────
export function PapersMainColumn({
  accent,
  papers,
  selectedId,
  view,
  onSelectPaper,
  onOpenPaper,
  onSetView,
}: {
  accent: Accent;
  papers: PapersData;
  selectedId: string | null;
  view: PapersView;
  onSelectPaper: (id: string | null) => void;
  onOpenPaper: (id: string) => void;
  onSetView: (view: PapersView) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [edgeModal, setEdgeModal] = useState<{ id: string; label: string } | null>(null);

  const selected = papers.findPaper(selectedId);

  const handleCreateAt = useCallback(
    async (x: number, y: number) => {
      const created = await papers.createPaper(NEW_PAPER(x, y));
      if (created) onOpenPaper(created.id);
    },
    [papers, onOpenPaper],
  );

  const handleSetStatus = useCallback(
    (id: string, status: PaperStatus) => {
      const paper = papers.findPaper(id);
      if (!paper) return;
      void papers.updatePaper(id, {
        title: paper.title,
        status,
        venue: paper.venue,
        tags: paper.tags,
        rating: paper.rating,
        x: paper.x,
        y: paper.y,
      });
    },
    [papers],
  );

  const handleDeletePaper = useCallback(
    (id: string) => {
      void papers.deletePaper(id);
      if (id === selectedId) {
        onSelectPaper(null);
        onSetView("graph");
      }
    },
    [papers, selectedId, onSelectPaper, onSetView],
  );

  const openEdgeRename = useCallback(
    (id: string) => {
      const edge = papers.edges.find((e) => e.id === id);
      setEdgeModal({ id, label: edge?.label ?? "" });
    },
    [papers.edges],
  );

  const viewSwitch = (
    <ViewSwitch
      accent={accent}
      canDetail={Boolean(selected)}
      onSetView={onSetView}
      styles={styles}
      view={view}
    />
  );

  return (
    <View style={styles.mainInner}>
      {view === "detail" && selected ? (
        // Detail owns the single header (editable title + actions + view switch).
        // Keyed by id so switching papers remounts the editor. Its title / venue
        // / tags / status live in useState seeded from the prop and nothing syncs
        // them on a prop change, so a reused instance kept the previous paper's
        // values and the next save wrote them onto the paper now on screen —
        // renaming it. PaperBody was already keyed for the same reason.
        <PaperEditor
          key={selected.id}
          accent={accent}
          headerAccessory={viewSwitch}
          onDelete={handleDeletePaper}
          onReveal={(id) => void revealPaper(id)}
          onSaveMeta={(id, input) => void papers.updatePaper(id, input)}
          paper={selected}
          saveBody={papers.saveBody}
        />
      ) : (
        <>
          <View style={styles.mainHeader}>
            <Text numberOfLines={1} style={styles.mainTitle}>
              {view === "detail" ? "论文详情" : "论文关系图"}
            </Text>
            {viewSwitch}
          </View>
          {view === "detail" ? (
            <View style={styles.detailEmpty}>
              <Text style={styles.detailEmptyText}>从关系图中选择一篇论文，或新建一篇。</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSetView("graph")}
                style={({ hovered }: PressState) => [
                  styles.ghostButton,
                  hovered && styles.ghostButtonHover,
                ]}
              >
                <RiNodeTree size={15} color={accent.accentText} />
                <Text style={styles.ghostButtonText}>回到关系图</Text>
              </Pressable>
            </View>
          ) : (
            <GraphCanvas
              accent={accent}
              papers={papers.papers}
              edges={papers.edges}
              selectedId={selectedId}
              onSelect={onSelectPaper}
              onOpen={onOpenPaper}
              onCreateAt={handleCreateAt}
              onMoveLocal={papers.moveLocal}
              onCommitMove={(id, x, y) => void papers.commitMove(id, x, y)}
              onAddEdge={(from, to, fromSide, toSide) =>
                void papers.addEdge(from, to, "", fromSide, toSide)
              }
              onRenameEdge={openEdgeRename}
              onDeleteEdge={(id) => void papers.deleteEdge(id)}
              onDeletePaper={handleDeletePaper}
              onSetStatus={handleSetStatus}
              onReveal={(id) => void revealPaper(id)}
            />
          )}
        </>
      )}

      {edgeModal ? (
        <EdgeLabelModal
          accent={accent}
          initial={edgeModal.label}
          onCancel={() => setEdgeModal(null)}
          onSave={(label) => {
            void papers.updateEdge(edgeModal.id, label);
            setEdgeModal(null);
          }}
        />
      ) : null}
    </View>
  );
}

function ViewSwitch({
  accent,
  canDetail,
  onSetView,
  styles,
  view,
}: {
  accent: Accent;
  canDetail: boolean;
  onSetView: (view: PapersView) => void;
  styles: Styles;
  view: PapersView;
}) {
  const theme = useTheme();
  return (
    <View style={styles.segmented}>
      <SegButton
        accent={accent}
        active={view === "graph"}
        icon={
          <RiNodeTree
            size={15}
            color={view === "graph" ? accent.accentText : theme.t.textSecondary}
          />
        }
        label="关系图"
        onPress={() => onSetView("graph")}
        styles={styles}
      />
      <SegButton
        accent={accent}
        active={view === "detail"}
        disabled={!canDetail}
        icon={
          <RiFileList3Line
            size={15}
            color={view === "detail" ? accent.accentText : theme.t.textSecondary}
          />
        }
        label="论文详情"
        onPress={() => canDetail && onSetView("detail")}
        styles={styles}
      />
    </View>
  );
}

function SegButton({
  accent,
  active,
  disabled,
  icon,
  label,
  onPress,
  styles,
}: {
  accent: Accent;
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.segButton,
        motion,
        hovered && !active && styles.segButtonHover,
        active && styles.segButtonActive,
        disabled && ({ opacity: 0.4 } as ViewStyle),
      ]}
    >
      {icon}
      <Text
        style={[styles.segButtonText, active && { color: accent.accentText, fontWeight: "600" }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function EdgeLabelModal({
  accent,
  initial,
  onCancel,
  onSave,
}: {
  accent: Accent;
  initial: string;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [value, setValue] = useState(initial);

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: theme.t.scrim,
      }}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <View style={[styles.modalCard, glass(30, 180), enterModal() as ViewStyle]}>
          <Text style={styles.modalTitle}>关系标签</Text>
          <Text style={styles.modalHint}>给这条连接起个名字，例如「延伸自」「引用」「对比」。</Text>
          <TextInput
            autoFocus
            onChangeText={setValue}
            onSubmitEditing={() => onSave(value.trim())}
            placeholder="关系标签（可留空）"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.modalInput}
            value={value}
          />
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ hovered }: PressState) => [
                styles.modalGhost,
                hovered && styles.ghostButtonHover,
              ]}
            >
              <Text style={styles.modalGhostText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onSave(value.trim())}
              style={({ hovered }: PressState) => [
                styles.modalPrimary,
                hovered && ({ opacity: 0.92 } as ViewStyle),
              ]}
            >
              <Text style={styles.modalPrimaryText}>保存</Text>
            </Pressable>
          </View>
        </View>
      </div>
    </div>,
    document.body,
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Collection
    searchArea: { flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flex: 1,
      flexDirection: "row",
      gap: 8,
      height: 36,
      minWidth: 0,
      paddingHorizontal: 10,
    },
    searchBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    searchInput: { color: t.textPrimary, flex: 1, fontSize: 12.5, minWidth: 0, paddingVertical: 7 },
    searchClear: {
      alignItems: "center",
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    searchClearHover: { backgroundColor: t.controlHover },
    newButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      height: 36,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    newButtonHover: { backgroundColor: t.controlHover },
    newButtonText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      paddingBottom: 10,
      paddingHorizontal: 10,
    },
    filterChip: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      height: 26,
      paddingHorizontal: 9,
    },
    filterChipHover: { backgroundColor: t.controlHover },
    filterDot: { borderRadius: 3, height: 7, width: 7 },
    filterChipText: { color: t.textSecondary, fontSize: 11.5, fontWeight: "500" },
    empty: {
      alignItems: "center",
      gap: 6,
      justifyContent: "center",
      paddingHorizontal: 20,
      paddingVertical: 40,
    },
    emptyText: { color: t.textTertiary, fontSize: 12.5, lineHeight: 19, textAlign: "center" },
    listContent: { paddingBottom: 20, paddingHorizontal: 8 },
    group: { marginTop: 6 },
    groupHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
      paddingBottom: 4,
      paddingHorizontal: 6,
      paddingTop: 8,
    },
    groupDot: { borderRadius: 4, height: 8, width: 8 },
    groupTitle: { color: t.textSecondary, flex: 1, fontSize: 12, fontWeight: "700" },
    groupCount: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
    card: {
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderRadius: 10,
      borderWidth: 1,
      gap: 4,
      marginBottom: 2,
      paddingHorizontal: 11,
      paddingVertical: 9,
      // Explicit, because `accessibilityRole="button"` makes react-native-web
      // render this as a real <button>, and a button sizes itself shrink-to-fit
      // instead of stretching like a <div>. Without it every card was as wide as
      // its own title — short ones ended up half-width, long ones overflowed the
      // column — so the selected/hover highlight never lined up between rows.
      width: "100%",
    },
    cardHover: { backgroundColor: t.controlHover },
    cardActive: {
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.28)`,
    },
    cardTitle: {
      color: t.textPrimary,
      fontSize: 13,
      fontWeight: "600",
      lineHeight: 18,
      minWidth: 0,
      width: "100%",
    },
    // Single line (no wrap): a long venue + tags used to wrap to a second row for
    // some cards, so their highlight boxes came out taller than others. The venue
    // badge keeps its size; the tags truncate.
    cardBadgeRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "nowrap",
      gap: 6,
      marginTop: 3,
      overflow: "hidden",
    },
    venueBadge: {
      backgroundColor: `rgba(${accent.rgb},0.10)`,
      borderRadius: 6,
      flexShrink: 0,
      maxWidth: "60%",
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    venueBadgeText: { color: accent.accentText, fontSize: 11, fontWeight: "600" },
    cardTags: { flexShrink: 1, fontSize: 11, minWidth: 0 },
    // Main column
    mainInner: { flex: 1, minHeight: 0 },
    mainHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 14,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "space-between",
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 24,
      zIndex: 30,
    },
    mainTitle: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 16,
      fontWeight: "600",
      letterSpacing: -0.25,
      minWidth: 0,
    },
    segmented: {
      backgroundColor: t.controlIdle,
      borderRadius: 10,
      flexDirection: "row",
      gap: 2,
      padding: 3,
    },
    segButton: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      height: 30,
      paddingHorizontal: 12,
    },
    segButtonHover: { backgroundColor: t.controlHover },
    segButtonActive: { backgroundColor: t.cardSurface, boxShadow: "0 1px 3px rgba(16,24,36,0.10)" },
    segButtonText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "500" },
    detailEmpty: {
      alignItems: "center",
      flex: 1,
      gap: 14,
      justifyContent: "center",
      padding: 24,
    },
    detailEmptyText: { color: t.textSecondary, fontSize: 13, textAlign: "center" },
    ghostButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 34,
      paddingHorizontal: 14,
    },
    ghostButtonHover: { backgroundColor: t.controlHover },
    ghostButtonText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    // Edge label modal
    modalCard: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 16,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      gap: 10,
      padding: 20,
      width: 340,
    },
    modalTitle: { color: t.textPrimary, fontSize: 15, fontWeight: "700" },
    modalHint: { color: t.textSecondary, fontSize: 12, lineHeight: 17 },
    modalInput: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      borderRadius: 10,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      height: 38,
      marginTop: 2,
      paddingHorizontal: 12,
    },
    modalActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: 4 },
    modalGhost: {
      alignItems: "center",
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    modalGhostText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    modalPrimary: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    modalPrimaryText: { color: "#fff", fontSize: 12.5, fontWeight: "600" },
  });
}
