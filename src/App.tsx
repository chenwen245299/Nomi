import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  RiAddLine,
  RiArrowRightLine,
  RiBookletFill,
  RiBookletLine,
  RiChat3Fill,
  RiChat3Line,
  RiChatSettingsLine,
  RiCheckboxCircleFill,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiCompass3Fill,
  RiCompass3Line,
  RiExternalLinkLine,
  RiFolderOpenLine,
  RiGraduationCapFill,
  RiGraduationCapLine,
  RiHardDrive2Line,
  RiLayoutRightLine,
  RiNodeTree,
  RiRobot2Line,
  RiSearch2Line,
  RiSettings4Fill,
  RiSettings4Line,
  RiTerminalBoxLine,
  RiWallet3Fill,
  RiWallet3Line,
} from "@remixicon/react";
import { CheckForUpdatesCard, UpdateDialog } from "./updater/UpdaterUI";
import { EmptyIllustration } from "./illustrations";
import {
  AssistantEditorModal,
  AssistantSwitcher,
  ChatCollection,
  ChatMainBody,
} from "./chat/ChatSection";
import { ConversationAssistantPicker } from "./chat/AssistantPicker";
import { ConversationModelPicker } from "./chat/ModelPicker";
import { AiChatPanel } from "./chat/AiChatPanel";
import { ChatSettings } from "./chat/ChatSettings";
import { useChat, type ChatData } from "./chat/useChat";
import { ProvidersSettings } from "./providers/ProvidersSettings";
import { useProviders, type ProvidersController } from "./providers/useProviders";
import { McpSettings } from "./mcp/McpSettings";
import { EditableUserAvatar } from "./profile/UserAvatar";
import { useMcp, type McpController } from "./mcp/useMcp";
import { ExaSettings } from "./exa/ExaSettings";
import { NotesCollection, NotesMainColumn } from "./notes/NotesSection";
import { useNotes, type NotesData } from "./notes/useNotes";
import {
  PapersCollection,
  PapersMainColumn,
  usePapers,
  type PapersData,
  type PapersView,
} from "./papers";
import { FinanceCollection, FinanceMainColumn } from "./finance/FinanceSection";
import { useFinance, type FinanceData } from "./finance/useFinance";
import { TodoCollection, TodoMainColumn } from "./todo/TodoSection";
import { useTodos, type TodosData } from "./todo/useTodos";
import { TravelCollection, TravelMainColumn, useTravel, type TravelData } from "./travel";
import { scopeLabel, type TodoLayout, type TodoScope } from "./todo/views";
import { initVersion, startAutoUpdate, stopAutoUpdate } from "./updater/store";
import { detachTabToWindow, isMainWindow } from "./tabWindows";
import {
  accentFor,
  badgeGlow,
  cardShadow,
  COLLECTION_GUTTER,
  enterFade,
  enterModal,
  enterUp,
  focusRing,
  glass,
  modalShadow,
  motion,
  motionSlow,
  resolveTheme,
  SHELL_HEADER_HEIGHT,
  ThemeContext,
  useTheme,
  withGlow,
  type Accent,
  type SectionId,
  type Theme,
} from "./theme";

type RemixIcon = typeof RiAddLine;

type FeatureDirectory = {
  id: string;
  name: string;
  path: string;
};

type StorageStatus = {
  rootPath: string;
  configPath: string;
  reusedExistingData: boolean;
  features: FeatureDirectory[];
};

type StorageUsage = {
  totalBytes: number;
};

type SectionMeta = {
  id: SectionId;
  label: string;
  collectionTitle: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  actionLabel: string;
  icon: RemixIcon;
  iconFill: RemixIcon;
};

const sections: SectionMeta[] = [
  {
    id: "chat",
    label: "对话",
    collectionTitle: "全部对话",
    description: "整理想法、问题和持续进行的讨论。",
    emptyTitle: "开始一段对话",
    emptyDescription: "新的对话会保存在数据目录的 chat 文件夹中。",
    actionLabel: "新建对话",
    icon: RiChat3Line,
    iconFill: RiChat3Fill,
  },
  {
    id: "papers",
    label: "论文",
    collectionTitle: "论文",
    description: "规划正在写、打算写和有潜力的论文，并把它们联系起来。",
    emptyTitle: "规划你的论文",
    emptyDescription: "论文数据会独立保存在 papers 文件夹中。",
    actionLabel: "新建论文",
    icon: RiGraduationCapLine,
    iconFill: RiGraduationCapFill,
  },
  {
    id: "notes",
    label: "笔记",
    collectionTitle: "全部笔记",
    description: "记录灵感、资料和需要长期保存的内容。",
    emptyTitle: "写一篇笔记",
    emptyDescription: "笔记数据会独立保存在 notes 文件夹中。",
    actionLabel: "新建笔记",
    icon: RiBookletLine,
    iconFill: RiBookletFill,
  },
  {
    id: "todo",
    label: "待办",
    collectionTitle: "待办",
    description: "按重要和紧急程度安排要做的事。",
    emptyTitle: "添加一条待办",
    emptyDescription: "待办数据会独立保存在 todo 文件夹中。",
    actionLabel: "新建待办",
    icon: RiCheckboxCircleLine,
    iconFill: RiCheckboxCircleFill,
  },
  {
    id: "travel",
    label: "旅行",
    collectionTitle: "旅行笔记",
    description: "记录旅行足迹、地点、评分和行程规划。",
    emptyTitle: "创建一篇旅行笔记",
    emptyDescription: "所有旅行资料都会收纳在 travel 文件夹中。",
    actionLabel: "新建旅行",
    icon: RiCompass3Line,
    iconFill: RiCompass3Fill,
  },
  {
    id: "finance",
    label: "记账",
    collectionTitle: "我的账本",
    description: "记录日常收支，了解钱花在了哪里。",
    emptyTitle: "记下一笔账",
    emptyDescription: "账目数据会独立保存在 finance 文件夹中。",
    actionLabel: "新增记录",
    icon: RiWallet3Line,
    iconFill: RiWallet3Fill,
  },
  {
    id: "settings",
    label: "设置",
    collectionTitle: "设置",
    description: "",
    emptyTitle: "设置",
    emptyDescription: "",
    actionLabel: "",
    icon: RiSettings4Line,
    iconFill: RiSettings4Fill,
  },
];

const featureSections = sections.filter((section) => section.id !== "settings");
const metaFor = (id: SectionId): SectionMeta =>
  sections.find((section) => section.id === id) ?? sections[0];

/** Tabs that carry a right-hand AI-chat sidebar. Finance already embeds its own
 *  AI capture chat, and settings has no conversation surface, so both opt out. */
const SIDEBAR_SECTIONS = new Set<SectionId>(["chat", "notes", "papers", "todo", "travel"]);

const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_DEFAULT_WIDTH = 384;
const SIDEBAR_WIDTH_KEY = "nomi.sidebarWidth";

const clampSidebarWidth = (value: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));

function readStoredSidebarWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampSidebarWidth(stored);
  } catch {
    // localStorage may be unavailable (e.g. private mode) — fall back to default.
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

// Make the whole titlebar draggable. Tauri v2's "deep" mode drags on clicks
// anywhere in the subtree EXCEPT clickable elements (role=button/tab, tabindex),
// so Pressable tabs/buttons stay clickable while every empty area drags. The bare
// "" attribute on the spacers is a belt-and-suspenders fallback (drag-on-self)
// that works even on older Tauri builds that don't understand "deep".
const TITLEBAR_DRAG = { dataSet: { tauriDragRegion: "deep" } } as unknown as ViewProps;
const SPACER_DRAG = { dataSet: { tauriDragRegion: "" } } as unknown as ViewProps;

// Titlebar geometry. The styles below and the tab tear-off maths both need it:
// the titlebar sits at the window's top-left corner, so a pointer position in
// viewport coordinates is also its position inside the window.
const TITLEBAR_HEIGHT = 40;
// Room kept clear on the left for the macOS traffic lights — also where the
// first tab starts, which is what a torn-off tab becomes in its new window.
const TITLEBAR_TRAFFIC_WIDTH = 96;
// How far a dragged tab has to leave the titlebar before the drag stops being
// a reorder and becomes "open this in its own window".
const TAB_TEAR_OFF_MARGIN = 44;

// react-native's Pressable types only model `{ pressed }`; react-native-web also
// passes `hovered` / `focused`. Optional keeps the callback assignable.
type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

type SettingsTab = "storage" | "chat" | "providers" | "mcp";
type TabDropPosition = "after" | "before";

// A tab is one open view. Multiple tabs may share a section (several chats,
// several settings pages, …); each carries its own navigation state so switching
// tabs restores exactly what that tab was showing.
type Tab = {
  id: number;
  section: SectionId;
  // chat: switcher filter (null = 全部对话) and the currently open conversation.
  assistantId: string | null;
  conversationId: string | null;
  conversationAssistantId: string | null;
  // notes: the open note's path relative to the notes root (null = none open).
  noteId: string | null;
  // papers: the selected paper (null = none) and which view is showing.
  paperId: string | null;
  papersView: PapersView;
  // travel: the open travel note's id (null = none open).
  travelNoteId: string | null;
  // todo: which todos this tab is showing, and how they are laid out.
  todoScope: TodoScope;
  todoLayout: TodoLayout;
  // settings: which settings page this tab shows.
  settingsTab: SettingsTab;
};

function makeTab(id: number, section: SectionId): Tab {
  return {
    id,
    section,
    assistantId: null,
    conversationId: null,
    conversationAssistantId: null,
    noteId: null,
    paperId: null,
    papersView: "graph",
    travelNoteId: null,
    todoScope: "today",
    todoLayout: "board",
    settingsTab: "storage",
  };
}

/** The tab a window was born with, when it was torn off from another window.
 *  The payload crossed a process boundary, so keep only what still parses as a
 *  tab; anything else falls back to a fresh 对话 tab. */
function adoptTab(raw: unknown): Tab {
  const fresh = makeTab(1, "chat");
  if (!raw || typeof raw !== "object") return fresh;
  const candidate = raw as Partial<Tab>;
  if (!sections.some((section) => section.id === candidate.section)) return fresh;
  return { ...fresh, ...candidate, id: fresh.id };
}

const SETTINGS_LABEL: Record<SettingsTab, string> = {
  storage: "通用",
  chat: "对话",
  providers: "AI 服务商",
  mcp: "MCP 服务器",
};

const isTauriRuntime = () => "__TAURI_INTERNALS__" in window;

function previewStorage(): StorageStatus {
  const rootPath = "/Users/you/Documents/Nomi Data";
  return {
    rootPath,
    configPath: `${rootPath}/.nomi/config.json`,
    reusedExistingData: false,
    features: ["chat", "notes", "papers", "todo", "travel", "finance"].map((name) => ({
      id: name,
      name,
      path: `${rootPath}/${name}`,
    })),
  };
}

function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const fractionDigits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(fractionDigits)} ${units[unit]}`;
}

// ── Style factory ───────────────────────────────────────────────────────────
function makeStyles(theme: Theme, accent: Accent) {
  const { t, useSolid: solid } = theme;
  const railFill = solid ? t.railSolid : t.railMaterial;
  const collectionFill = solid ? t.collectionSolid : t.collectionMaterial;
  const mainFill = solid ? t.mainSolid : t.mainSurface;
  const overlayFill = solid ? t.overlaySolid : t.overlaySurface;
  const titlebarFill = solid ? t.collectionSolid : t.collectionMaterial;
  const railActiveBorder = t.edgeHighlight;

  return StyleSheet.create({
    appFrame: {
      backgroundColor: t.windowBase,
      flex: 1,
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
    },
    body: {
      flex: 1,
      flexDirection: "row",
      minHeight: 0,
    },
    backgroundWashOne: {
      backgroundColor: t.washA,
      borderRadius: 300,
      height: 380,
      left: -160,
      position: "absolute",
      top: -120,
      width: 380,
    },
    backgroundWashTwo: {
      backgroundColor: t.washB,
      borderRadius: 260,
      bottom: -40,
      height: 240,
      left: -110,
      position: "absolute",
      width: 440,
    },
    loadingScreen: {
      alignItems: "center",
      backgroundColor: t.windowBase,
      flex: 1,
      gap: 16,
      justifyContent: "center",
    },
    loadingMark: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 14,
      height: 48,
      justifyContent: "center",
      width: 48,
      boxShadow: withGlow(t.e2, accent),
    },
    loadingMarkText: {
      color: t.onAccent,
      fontSize: 22,
      fontWeight: "700",
    },
    // ── Titlebar + tabs ──
    titlebar: {
      alignItems: "center",
      backgroundColor: titlebarFill,
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      height: TITLEBAR_HEIGHT,
      paddingRight: 10,
      zIndex: 5,
    },
    tbTrafficSpace: {
      alignSelf: "stretch",
      width: TITLEBAR_TRAFFIC_WIDTH,
    },
    tbTabs: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      paddingRight: 4,
    },
    tbFlex: {
      alignSelf: "stretch",
      flex: 1,
    },
    tab: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      height: 28,
      maxWidth: 176,
      paddingHorizontal: 10,
    },
    tabClosable: {
      paddingRight: 5,
    },
    tabActive: {
      backgroundColor: mainFill,
      borderColor: t.separator,
      boxShadow: solid ? t.e1Solid : t.e1,
    },
    tabHover: {
      backgroundColor: t.controlHover,
    },
    tabMain: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: 7,
      minWidth: 0,
    },
    tabIcon: {
      alignItems: "center",
      flexShrink: 0,
      height: 16,
      justifyContent: "center",
      width: 16,
    },
    tabLabel: {
      flexShrink: 1,
      fontSize: 12.5,
      fontWeight: "500",
      letterSpacing: -0.1,
      minWidth: 0,
    },
    tabClose: {
      alignItems: "center",
      borderRadius: 5,
      height: 18,
      justifyContent: "center",
      marginLeft: 4,
      width: 18,
    },
    tabCloseHover: {
      backgroundColor: t.controlPressed,
    },
    tabAdd: {
      alignItems: "center",
      borderRadius: 7,
      height: 26,
      justifyContent: "center",
      marginLeft: 2,
      width: 26,
    },
    tabAddHover: {
      backgroundColor: t.controlHover,
    },
    // ── Navigation rail ──
    rail: {
      alignItems: "center",
      backgroundColor: railFill,
      borderRightColor: t.separator,
      borderRightWidth: 1,
      height: "100%",
      paddingBottom: 14,
      paddingTop: 0,
      width: 60,
      zIndex: 3,
    },
    railCompact: {
      width: 54,
    },
    brandMark: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderColor: t.edgeHighlight,
      borderRadius: 11,
      borderWidth: 1,
      height: 34,
      justifyContent: "center",
      marginBottom: 18,
      width: 34,
      boxShadow: withGlow(t.e2, accent),
    },
    railHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "center",
      width: "100%",
    },
    railNavigation: {
      alignItems: "center",
      gap: 6,
      marginTop: 12,
    },
    railSpacer: {
      flex: 1,
    },
    railButton: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 12,
      borderWidth: 1,
      height: 42,
      justifyContent: "center",
      width: 42,
    },
    railButtonHover: {
      backgroundColor: t.controlHover,
    },
    railButtonActive: {
      backgroundColor: accent.selectedFill,
      borderColor: railActiveBorder,
    },
    railButtonPressed: {
      opacity: 0.9,
      transform: [{ scale: 0.95 }],
    },
    // ── Collection column ──
    collectionColumn: {
      backgroundColor: collectionFill,
      borderRightColor: t.separator,
      borderRightWidth: 1,
      height: "100%",
      overflow: "hidden",
      width: 240,
      zIndex: 2,
    },
    collectionColumnCompact: {
      width: 212,
    },
    collectionWash: {
      backgroundColor: accent.wash,
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    collectionHeader: {
      alignItems: "stretch",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "center",
      minHeight: SHELL_HEADER_HEIGHT,
      overflow: "visible",
      paddingHorizontal: COLLECTION_GUTTER,
      paddingVertical: 6,
      zIndex: 100,
    },
    collectionSearchArea: {
      paddingBottom: 6,
      paddingHorizontal: COLLECTION_GUTTER,
      paddingTop: 6,
    },
    collectionHeaderUnderline: {
      backgroundColor: accent.accent,
      borderRadius: 999,
      bottom: -1,
      height: 2,
      left: COLLECTION_GUTTER,
      position: "absolute",
      width: 26,
    },
    collectionHeadingRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    collectionTitle: {
      color: t.textPrimary,
      fontSize: 15,
      fontWeight: "700",
      letterSpacing: -0.2,
    },
    addButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 7,
      height: 34,
      paddingHorizontal: 10,
    },
    searchBoxFocused: {
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.28)`,
    },
    searchInput: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      height: 32,
      paddingVertical: 0,
    },
    collectionEmpty: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingVertical: 40,
    },
    collectionEmptyText: {
      color: t.textTertiary,
      fontSize: 12.5,
    },
    settingsMenu: {
      gap: 2,
      padding: 10,
    },
    settingsMenuItem: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 8,
      height: 34,
      paddingHorizontal: 10,
    },
    settingsMenuItemHover: {
      backgroundColor: t.controlHover,
    },
    settingsMenuItemActive: {
      backgroundColor: accent.selectedFill,
    },
    settingsMenuText: {
      color: t.textSecondary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    settingsMenuTextActive: {
      color: accent.accentText,
    },
    // ── Main column ──
    mainColumn: {
      backgroundColor: mainFill,
      flex: 1,
      height: "100%",
      minWidth: 0,
      overflow: "hidden",
    },
    mainHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      height: SHELL_HEADER_HEIGHT,
      justifyContent: "space-between",
      minHeight: SHELL_HEADER_HEIGHT,
      paddingHorizontal: 24,
      paddingVertical: 6,
    },
    mainHeaderTitleBlock: { flex: 1, minWidth: 0 },
    mainHeaderControls: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 0,
      gap: 8,
    },
    mainTitle: {
      color: t.textPrimary,
      fontSize: 15,
      fontWeight: "600",
      letterSpacing: -0.2,
    },
    mainSubtitle: {
      color: t.textSecondary,
      fontSize: 12,
      marginTop: 3,
    },
    mainContent: {
      flexGrow: 1,
      padding: 24,
    },
    chatMainContent: {
      flex: 1,
      minHeight: 0,
      paddingBottom: 12,
      paddingHorizontal: 10,
      paddingTop: 12,
    },
    chatMainInner: { flex: 1, minHeight: 0 },
    mainScroll: {
      flex: 1,
      minHeight: 0,
    },
    featureEmptyCard: {
      alignItems: "center",
      alignSelf: "center",
      justifyContent: "center",
      marginVertical: "auto",
      maxWidth: 380,
      padding: 24,
    },
    featureIllustration: {
      alignItems: "center",
      marginBottom: 20,
    },
    featureEmptyTitle: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.3,
      textAlign: "center",
    },
    featureEmptyDescription: {
      color: t.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      marginTop: 7,
      maxWidth: 320,
      textAlign: "center",
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      height: 34,
      marginTop: 16,
      paddingHorizontal: 13,
      boxShadow: withGlow(`inset 0 1px 0 rgba(255,255,255,0.22)`, accent),
    },
    primaryButtonPressed: {
      opacity: 0.9,
      transform: [{ scale: 0.98 }],
    },
    primaryButtonText: {
      color: t.onAccent,
      fontSize: 12.5,
      fontWeight: "600",
    },
    // ── Settings ──
    settingsStack: {
      gap: 16,
    },
    settingsContent: {
      gap: 16,
      maxWidth: 680,
      width: "100%",
    },
    settingsCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      padding: 18,
      boxShadow: cardShadow(t),
    },
    settingsCardHeader: {
      alignItems: "center",
      flexDirection: "row",
    },
    settingsIconWrap: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 10,
      height: 38,
      justifyContent: "center",
      marginRight: 12,
      width: 38,
    },
    settingsCardHeading: {
      flex: 1,
    },
    settingsCardTitle: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "600",
      letterSpacing: -0.1,
    },
    settingsCardDescription: {
      color: t.textSecondary,
      fontSize: 12,
      marginTop: 4,
    },
    pathBox: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 9,
      marginTop: 16,
      paddingHorizontal: 11,
      paddingVertical: 10,
    },
    pathText: {
      color: t.textSecondary,
      flex: 1,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      lineHeight: 17,
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
      paddingHorizontal: 10,
    },
    secondaryButtonHover: {
      backgroundColor: t.controlHover,
    },
    secondaryButtonText: {
      color: accent.accentText,
      fontSize: 12,
      fontWeight: "600",
    },
    settingsCardActions: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
    },
    storageUsage: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginLeft: "auto",
      minHeight: 32,
      paddingHorizontal: 2,
    },
    storageUsageLabel: {
      color: t.textTertiary,
      fontSize: 11.5,
    },
    storageUsageValue: {
      color: t.textPrimary,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      fontWeight: "600",
    },
    directoryCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      padding: 18,
      boxShadow: cardShadow(t),
    },
    directoryHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginBottom: 12,
    },
    directoryTitle: {
      color: t.textPrimary,
      fontSize: 13,
      fontWeight: "600",
    },
    directoryRow: {
      alignItems: "center",
      borderTopColor: t.rowDivider,
      borderTopWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 36,
    },
    directoryNameRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 9,
    },
    directoryDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    directoryName: {
      color: t.textSecondary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
    },
    directoryNote: {
      color: t.textTertiary,
      fontSize: 11.5,
      fontWeight: "500",
    },
    configPathText: {
      color: t.textTertiary,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 12,
    },
    inlineError: {
      color: t.errorText,
      fontSize: 11.5,
      lineHeight: 17,
    },
    softPressed: {
      opacity: 0.72,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    // ── Setup overlay ──
    setupOverlay: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 24,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 20,
    },
    setupCard: {
      alignItems: "center",
      backgroundColor: overlayFill,
      borderColor: t.edgeHighlight,
      borderRadius: 22,
      borderWidth: 1,
      maxWidth: 460,
      padding: 30,
      width: "100%",
      boxShadow: modalShadow(t),
    },
    setupCardCompact: {
      padding: 20,
    },
    setupIcon: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 16,
      height: 60,
      justifyContent: "center",
      marginBottom: 18,
      width: 60,
      boxShadow: badgeGlow(accent),
    },
    setupIconCompact: {
      borderRadius: 14,
      height: 48,
      marginBottom: 12,
      width: 48,
    },
    setupEyebrow: {
      color: t.textTertiary,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1.4,
    },
    setupTitle: {
      color: t.textPrimary,
      fontSize: 22,
      fontWeight: "700",
      letterSpacing: -0.5,
      marginTop: 7,
    },
    setupTitleCompact: {
      fontSize: 19,
      marginTop: 5,
    },
    setupDescription: {
      color: t.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      marginTop: 10,
      maxWidth: 380,
      textAlign: "center",
    },
    setupDescriptionCompact: {
      lineHeight: 18,
      marginTop: 8,
    },
    setupTree: {
      alignSelf: "stretch",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      marginTop: 18,
      paddingHorizontal: 15,
      paddingVertical: 12,
    },
    setupTreeCompact: {
      marginTop: 12,
      paddingVertical: 9,
    },
    setupTreeRoot: {
      color: t.textPrimary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      fontWeight: "700",
      marginBottom: 4,
    },
    setupTreeItem: {
      color: t.textSecondary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      lineHeight: 18,
    },
    setupError: {
      color: t.errorText,
      fontSize: 11.5,
      lineHeight: 17,
      marginTop: 12,
      textAlign: "center",
    },
    setupButton: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: accent.accent,
      borderRadius: 11,
      flexDirection: "row",
      gap: 8,
      justifyContent: "center",
      marginTop: 18,
      minHeight: 44,
      paddingHorizontal: 16,
      boxShadow: withGlow(`inset 0 1px 0 rgba(255,255,255,0.22)`, accent),
    },
    setupButtonCompact: {
      marginTop: 12,
      minHeight: 40,
    },
    setupButtonText: {
      color: t.onAccent,
      fontSize: 13,
      fontWeight: "600",
    },
    setupFootnote: {
      color: t.textTertiary,
      fontSize: 11,
      marginTop: 12,
    },
    setupFootnoteCompact: {
      marginTop: 8,
    },
  });
}

type Styles = ReturnType<typeof makeStyles>;

function useStyles(accent: Accent): { styles: Styles; theme: Theme; accent: Accent } {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  return { styles, theme, accent };
}

// ── App root ────────────────────────────────────────────────────────────────
function App({ detachedTab }: { detachedTab?: unknown }) {
  const theme = useMemo(() => resolveTheme(), []);
  const { width } = useWindowDimensions();
  const compact = width < 900;
  const compactHeight = useWindowDimensions().height < 650;

  // Torn-off windows open on the tab that was dragged out; every other window
  // starts on a fresh 对话 tab. Read once — main.tsx resolves it before mounting.
  const [tabs, setTabs] = useState<Tab[]>(() => [adoptTab(detachedTab)]);
  const [activeId, setActiveId] = useState(1);
  const nextTabId = useRef(2);

  const [storage, setStorage] = useState<StorageStatus | null | undefined>(undefined);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [assistantEditor, setAssistantEditor] = useState<
    | { kind: "new" }
    | { kind: "assistant"; assistantId: string }
    | { kind: "defaultConversation" }
    | null
  >(null);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const activeSection = activeTab?.section ?? "chat";
  // Which tabs carry an AI-chat sidebar (finance has its own chat; settings none).
  const sidebarScope = SIDEBAR_SECTIONS.has(activeSection) ? activeSection : null;
  const sidebarContext = useMemo(
    () =>
      sidebarScope === "chat" && activeTab?.conversationAssistantId && activeTab.conversationId
        ? {
            assistantId: activeTab.conversationAssistantId,
            chatId: activeTab.conversationId,
          }
        : null,
    [sidebarScope, activeTab],
  );
  // Cap the sidebar so the rail + collection + a usable main column always fit.
  const sidebarMaxWidth = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, width - (compact ? 380 : 540)),
  );
  const effectiveSidebarWidth = Math.min(sidebarWidth, sidebarMaxWidth);
  const accent = useMemo(() => accentFor(activeSection), [activeSection]);
  const activeMeta = useMemo(() => metaFor(activeSection), [activeSection]);
  const chat = useChat(activeSection === "chat");
  const providers = useProviders(
    Boolean(storage) &&
      (activeSection === "chat" ||
        activeSection === "finance" ||
        (activeSection === "settings" &&
          (activeTab?.settingsTab === "providers" || activeTab?.settingsTab === "chat"))),
  );
  const mcp = useMcp(activeSection === "settings" && activeTab?.settingsTab === "mcp");
  const notes = useNotes(Boolean(storage) && activeSection === "notes");
  const papers = usePapers(Boolean(storage) && activeSection === "papers");
  const todos = useTodos(Boolean(storage) && activeSection === "todo");
  const finance = useFinance(Boolean(storage) && activeSection === "finance");
  const travel = useTravel(Boolean(storage) && activeSection === "travel");

  // Patch the currently-active tab's view state.
  const patchActiveTab = (patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === activeId ? { ...tab, ...patch } : tab)));
  };

  // ── Notes navigation ──
  const selectNote = (path: string | null) => patchActiveTab({ noteId: path });

  async function newRootNote() {
    const created = await notes.createNote("");
    if (created) {
      patchActiveTab({ noteId: created.path });
    }
  }

  // ── Papers navigation ──
  // Prime the selected paper (single-click in the graph) without leaving the view.
  const selectPaper = (id: string | null) => patchActiveTab({ paperId: id });
  // Open a paper's detail (list click / graph double-click / just created).
  const openPaper = (id: string) => patchActiveTab({ paperId: id, papersView: "detail" });
  const setPapersView = (papersView: PapersView) => patchActiveTab({ papersView });

  // ── Travel navigation ──
  const selectTravelNote = (id: string | null) => patchActiveTab({ travelNoteId: id });

  // ── Todo navigation ──
  const selectTodoScope = (todoScope: TodoScope) => patchActiveTab({ todoScope });
  const selectTodoLayout = (todoLayout: TodoLayout) => patchActiveTab({ todoLayout });

  // Keep every tab's open note in step when a note/folder is renamed, moved or
  // deleted (newPath = null on delete). Handles notes nested under a changed folder.
  const reconcileNotePath = (oldPath: string, newPath: string | null) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.section !== "notes" || !tab.noteId) {
          return tab;
        }
        if (tab.noteId === oldPath) {
          return { ...tab, noteId: newPath };
        }
        if (tab.noteId.startsWith(`${oldPath}/`)) {
          return {
            ...tab,
            noteId: newPath === null ? null : `${newPath}${tab.noteId.slice(oldPath.length)}`,
          };
        }
        return tab;
      }),
    );
  };

  // Nav rail: focus an existing tab for the section, or open a fresh one.
  function openSection(section: SectionId) {
    if (activeTab?.section === section) {
      return;
    }
    const existing = tabs.find((tab) => tab.section === section);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = nextTabId.current++;
    setTabs((prev) => [...prev, makeTab(id, section)]);
    setActiveId(id);
  }

  // "+" duplicates the current section into a new, fresh tab.
  function addTab() {
    const id = nextTabId.current++;
    setTabs((prev) => [...prev, makeTab(id, activeSection)]);
    setActiveId(id);
  }

  function closeTab(id: number) {
    if (tabs.length <= 1) {
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (id === activeId) {
      const fallback = next[Math.min(index, next.length - 1)];
      setActiveId(fallback.id);
    }
  }

  function reorderTabs(sourceId: number, targetId: number, position: TabDropPosition) {
    if (sourceId === targetId) return;
    setTabs((previous) => {
      const moving = previous.find((tab) => tab.id === sourceId);
      if (!moving) return previous;
      const remaining = previous.filter((tab) => tab.id !== sourceId);
      const targetIndex = remaining.findIndex((tab) => tab.id === targetId);
      if (targetIndex < 0) return previous;
      const insertIndex = targetIndex + (position === "after" ? 1 : 0);
      const next = [...remaining];
      next.splice(insertIndex, 0, moving);
      return next;
    });
  }

  // Dropping a tab outside the titlebar moves it into a window of its own, at
  // the drop point and at this window's size. The tab only leaves once that
  // window is up, so a failure to open it never loses the tab.
  async function detachTab(id: number, at: { x: number; y: number }) {
    if (tabs.length <= 1) return;
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    const opened = await detachTabToWindow(tab, {
      height: window.innerHeight,
      width: window.innerWidth,
      x: at.x,
      y: at.y,
    });
    if (opened) {
      closeTab(id);
    }
  }

  const setSettingsTab = (settingsTab: SettingsTab) => patchActiveTab({ settingsTab });

  // ── Chat navigation (drives the active tab) ──
  const selectAssistant = (id: string | null) =>
    patchActiveTab({ assistantId: id, conversationId: null, conversationAssistantId: null });

  const selectConversation = (conversationAssistantId: string, conversationId: string) =>
    patchActiveTab({ conversationId, conversationAssistantId });

  const newAssistant = () => setAssistantEditor({ kind: "new" });
  const editAssistant = (assistantId: string) =>
    setAssistantEditor({ kind: "assistant", assistantId });
  const editDefaultConversation = () => setAssistantEditor({ kind: "defaultConversation" });

  async function newConversation() {
    const created = await chat.createConversation(activeTab?.assistantId ?? null);
    if (created) {
      patchActiveTab({
        conversationId: created.id,
        conversationAssistantId: created.assistantId,
      });
    }
  }

  async function deleteConversation(conversationAssistantId: string, conversationId: string) {
    await chat.removeConversation(conversationAssistantId, conversationId);
    // Drop the deleted conversation from every tab that had it open.
    setTabs((prev) =>
      prev.map((tab) =>
        tab.conversationAssistantId === conversationAssistantId &&
        tab.conversationId === conversationId
          ? { ...tab, conversationId: null, conversationAssistantId: null }
          : tab,
      ),
    );
  }

  async function changeConversationAssistant(
    conversationAssistantId: string,
    conversationId: string,
    targetAssistantId: string,
  ) {
    const moved = await chat.setConversationAssistant(
      conversationAssistantId,
      conversationId,
      targetAssistantId,
    );
    // The backend moves the complete conversation folder. Reconcile every tab
    // that points at the old folder, including duplicate tabs for one chat.
    setTabs((prev) =>
      prev.map((item) =>
        item.conversationAssistantId === conversationAssistantId &&
        item.conversationId === conversationId
          ? {
              ...item,
              conversationAssistantId: moved.assistantId,
              conversationId: moved.id,
            }
          : item,
      ),
    );
  }

  const assistantDeleted = (assistantId: string) =>
    setTabs((prev) =>
      prev.map((tab) =>
        tab.section === "chat" &&
        (tab.assistantId === assistantId || tab.conversationAssistantId === assistantId)
          ? { ...tab, assistantId: null, conversationId: null, conversationAssistantId: null }
          : tab,
      ),
    );

  // A human-readable label per tab (conversation title / assistant / page name).
  function tabLabel(tab: Tab): string {
    if (tab.section === "chat") {
      if (tab.conversationId && tab.conversationAssistantId) {
        const conversation = chat.conversationById(tab.conversationAssistantId, tab.conversationId);
        if (conversation) {
          return conversation.title || "新对话";
        }
      }
      if (tab.assistantId) {
        return chat.assistantById(tab.assistantId)?.name ?? "助手";
      }
      return "新对话";
    }
    if (tab.section === "notes") {
      const note = notes.findNode(tab.noteId);
      return note ? note.name : metaFor("notes").label;
    }
    if (tab.section === "papers") {
      const paper = papers.findPaper(tab.paperId);
      return paper ? paper.title : metaFor("papers").label;
    }
    if (tab.section === "todo") {
      return scopeLabel(tab.todoScope);
    }
    if (tab.section === "settings") {
      return SETTINGS_LABEL[tab.settingsTab];
    }
    return metaFor(tab.section).label;
  }

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.style.colorScheme = "light";
    document.body.style.background = theme.t.windowBase;
    if (isTauriRuntime()) {
      void getCurrentWindow()
        .setBackgroundColor(theme.t.windowBase)
        .catch(() => {
          // Older API or permission not granted — the body bg already covers it.
        });
    }
  }, [theme.t.windowBase]);

  useEffect(() => {
    document.documentElement.style.setProperty("--focus", focusRing(accent));
  }, [accent]);

  useEffect(() => {
    const preventBrowserDrag = (event: DragEvent) => event.preventDefault();
    document.addEventListener("dragstart", preventBrowserDrag);
    document.addEventListener("drop", preventBrowserDrag);
    // Suppress the native WebView context menu (Reload / Share / Services) — this is
    // a desktop app. Text fields and the Markdown editor keep theirs (for paste),
    // and our own right-click menus set their own state before this fires.
    const suppressNativeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true'], [contenteditable=''], .vditor")
      ) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("contextmenu", suppressNativeMenu);
    return () => {
      document.removeEventListener("dragstart", preventBrowserDrag);
      document.removeEventListener("drop", preventBrowserDrag);
      document.removeEventListener("contextmenu", suppressNativeMenu);
    };
  }, []);

  useEffect(() => {
    async function loadStorage() {
      if (!isTauriRuntime()) {
        const showSetup = new URLSearchParams(window.location.search).has("setup");
        setStorage(showSetup ? null : previewStorage());
        return;
      }

      try {
        setStorage(await invoke<StorageStatus | null>("get_storage_status"));
      } catch (error) {
        setStorageError(String(error));
        setStorage(null);
      }
    }

    void loadStorage();
  }, []);

  useEffect(() => {
    void initVersion();
    // One updater per app: torn-off windows would otherwise each download the
    // same release. They can still check by hand from 设置.
    if (!isMainWindow()) return;
    startAutoUpdate();
    return () => stopAutoUpdate();
  }, []);

  async function chooseStorageFolder() {
    setIsChoosingFolder(true);
    setStorageError(null);

    try {
      if (!isTauriRuntime()) {
        setStorage(previewStorage());
        return;
      }

      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: storage?.rootPath,
        title: storage ? "切换 Nomi 数据文件夹" : "选择 Nomi 数据文件夹",
      });

      if (typeof selected !== "string") {
        return;
      }

      const nextStorage = await invoke<StorageStatus>("set_storage_root", {
        rootPath: selected,
      });
      setStorage(nextStorage);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setIsChoosingFolder(false);
    }
  }

  async function revealStorageFolder() {
    if (!storage?.rootPath || !isTauriRuntime()) return;
    setStorageError(null);
    try {
      await revealItemInDir(storage.rootPath);
    } catch (error) {
      setStorageError(String(error));
    }
  }

  if (storage === undefined) {
    return (
      <ThemeContext.Provider value={theme}>
        <LoadingScreen />
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={theme}>
      <View style={makeStyles(theme, accent).appFrame}>
        <TitleBar
          accent={accent}
          activeId={activeId}
          labelFor={tabLabel}
          onAdd={addTab}
          onClose={closeTab}
          onDetach={detachTab}
          onReorder={reorderTabs}
          onSelect={setActiveId}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          sidebarAvailable={sidebarScope !== null}
          sidebarOpen={sidebarOpen}
          tabs={tabs}
        />

        <View style={makeStyles(theme, accent).body}>
          <View style={makeStyles(theme, accent).backgroundWashOne} pointerEvents="none" />
          <View style={makeStyles(theme, accent).backgroundWashTwo} pointerEvents="none" />

          <NavigationRail
            accent={accent}
            activeSection={activeSection}
            compact={compact}
            onSelect={openSection}
          />

          <CollectionColumn
            accent={accent}
            activeSection={activeSection}
            chat={chat}
            compact={compact}
            finance={finance}
            meta={activeMeta}
            notes={notes}
            onDeleteConversation={deleteConversation}
            onEditAssistant={editAssistant}
            onEditDefaultConversation={editDefaultConversation}
            onNewAssistant={newAssistant}
            onNewConversation={newConversation}
            onNotePathChanged={reconcileNotePath}
            onOpenPaper={openPaper}
            onSelectAssistant={selectAssistant}
            onSelectConversation={selectConversation}
            onSelectNote={selectNote}
            onSelectSettingsTab={setSettingsTab}
            onSelectTodoScope={selectTodoScope}
            onSelectTravelNote={selectTravelNote}
            papers={papers}
            settingsTab={activeTab?.settingsTab ?? "storage"}
            tab={activeTab}
            todos={todos}
            travel={travel}
          />

          <MainColumn
            accent={accent}
            activeSection={activeSection}
            chat={chat}
            finance={finance}
            isChoosingFolder={isChoosingFolder}
            mcp={mcp}
            meta={activeMeta}
            notes={notes}
            onChooseStorageFolder={chooseStorageFolder}
            onChangeConversationAssistant={changeConversationAssistant}
            onRevealStorageFolder={revealStorageFolder}
            onNewConversation={newConversation}
            onNewRootNote={newRootNote}
            onNotePathChanged={reconcileNotePath}
            onOpenPaper={openPaper}
            onSelectPaper={selectPaper}
            onSelectTodoLayout={selectTodoLayout}
            onSelectTravelNote={selectTravelNote}
            onSetPapersView={setPapersView}
            papers={papers}
            providers={providers}
            settingsTab={activeTab?.settingsTab ?? "storage"}
            storage={storage}
            storageError={storageError}
            tab={activeTab}
            todos={todos}
            travel={travel}
          />

          {sidebarScope ? (
            // Clipping wrapper animates its width; the inner panel keeps a fixed
            // width (pinned to the right) so its content never reflows mid-slide.
            <View
              style={
                {
                  width: sidebarOpen ? effectiveSidebarWidth : 0,
                  overflow: "hidden",
                  position: "relative",
                  transitionProperty: "width",
                  transitionDuration: theme.reduceMotion ? "0ms" : "280ms",
                  transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
                } as ViewStyle
              }
            >
              <View
                style={
                  {
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    right: 0,
                    width: effectiveSidebarWidth,
                    borderLeftColor: theme.t.separator,
                    borderLeftWidth: StyleSheet.hairlineWidth,
                    opacity: sidebarOpen ? 1 : 0,
                    transitionProperty: "opacity",
                    transitionDuration: theme.reduceMotion ? "0ms" : "220ms",
                    transitionTimingFunction: "ease",
                  } as ViewStyle
                }
              >
                <SidebarResizeHandle
                  color={accent.accent}
                  max={sidebarMaxWidth}
                  onChange={(next) => {
                    setSidebarWidth(next);
                    try {
                      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
                    } catch {
                      // ignore persistence failures
                    }
                  }}
                  width={effectiveSidebarWidth}
                />
                <AiChatPanel
                  accent={accentFor(sidebarScope)}
                  contextSource={sidebarContext}
                  key={sidebarScope}
                  onBalance={providers.balance}
                  providers={providers.providers}
                  scope={sidebarScope}
                />
              </View>
            </View>
          ) : null}
        </View>

        {assistantEditor ? (
          <AssistantEditorModal
            accent={accentFor("chat")}
            assistant={
              assistantEditor.kind === "assistant"
                ? chat.assistantById(assistantEditor.assistantId)
                : null
            }
            chat={chat}
            defaultConversation={assistantEditor.kind === "defaultConversation"}
            key={
              assistantEditor.kind === "assistant"
                ? assistantEditor.assistantId
                : assistantEditor.kind
            }
            onClose={() => setAssistantEditor(null)}
            onCreated={(assistantId) =>
              patchActiveTab({
                assistantId,
                conversationId: null,
                conversationAssistantId: null,
              })
            }
            onDeleted={() => {
              if (assistantEditor.kind === "assistant") {
                assistantDeleted(assistantEditor.assistantId);
              }
            }}
            providers={providers.providers}
          />
        ) : null}

        {!storage && (
          <StorageSetup
            compact={compactHeight}
            error={storageError}
            isChoosingFolder={isChoosingFolder}
            onChooseStorageFolder={chooseStorageFolder}
          />
        )}

        <UpdateDialog />
      </View>
    </ThemeContext.Provider>
  );
}

function LoadingScreen() {
  const chat = accentFor("chat");
  const { styles, theme } = useStyles(chat);
  return (
    <View style={styles.loadingScreen}>
      <View style={styles.loadingMark}>
        <Text style={styles.loadingMarkText}>N</Text>
      </View>
      <ActivityIndicator color={theme.t.textTertiary} size="small" />
    </View>
  );
}

// ── Titlebar tabs ─────────────────────────────────────────────────────────────
/** A col-resize strip sitting on the sidebar's left border. Dragging it left
 *  widens the panel; the divider highlights while dragging. */
function SidebarResizeHandle({
  width,
  max,
  color,
  onChange,
}: {
  width: number;
  max: number;
  color: string;
  onChange: (next: number) => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        setActive(true);
        const move = (moveEvent: PointerEvent) => {
          const next = Math.round(startWidth + (startX - moveEvent.clientX));
          onChange(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, next)));
        };
        const up = () => {
          setActive(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      style={{
        bottom: 0,
        cursor: "col-resize",
        left: -3,
        position: "absolute",
        top: 0,
        touchAction: "none",
        width: 7,
        zIndex: 20,
      }}
      title="拖动调整宽度"
    >
      {active ? (
        <div
          style={{ background: color, bottom: 0, left: 3, position: "absolute", top: 0, width: 2 }}
        />
      ) : null}
    </div>
  );
}

function TitleBar({
  accent,
  activeId,
  labelFor,
  onAdd,
  onClose,
  onDetach,
  onReorder,
  onSelect,
  sidebarAvailable,
  sidebarOpen,
  onToggleSidebar,
  tabs,
}: {
  accent: Accent;
  activeId: number;
  labelFor: (tab: Tab) => string;
  onAdd: () => void;
  onClose: (id: number) => void;
  onDetach: (id: number, at: { x: number; y: number }) => void;
  onReorder: (sourceId: number, targetId: number, position: TabDropPosition) => void;
  onSelect: (id: number) => void;
  sidebarAvailable: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  tabs: Tab[];
}) {
  const { styles, theme } = useStyles(accent);
  const [draggedTabId, setDraggedTabId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: number;
    position: TabDropPosition;
  } | null>(null);
  // Set while the dragged tab is far enough outside the titlebar to become its
  // own window; holds the pointer position so the hint can follow the cursor.
  const [tearOff, setTearOff] = useState<{ x: number; y: number } | null>(null);
  const tabNodes = useRef(new Map<number, HTMLDivElement>());
  const pointerSession = useRef<{
    dropTarget: { id: number; position: TabDropPosition } | null;
    // Where the cursor sits relative to the window a drop would create.
    grabX: number;
    grabY: number;
    id: number;
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    tearOff: boolean;
  } | null>(null);
  // The last tab can be dragged around, but tearing it off would only swap one
  // window for another — leave it where it is.
  const canDetach = tabs.length > 1;

  useEffect(() => {
    if (draggedTabId == null) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [draggedTabId]);

  const clearDrag = () => {
    pointerSession.current = null;
    setDraggedTabId(null);
    setDropTarget(null);
    setTearOff(null);
  };

  /** Has the cursor left the titlebar strip by enough to mean "new window"? */
  const outsideTitlebar = (clientX: number, clientY: number) =>
    clientY > TITLEBAR_HEIGHT + TAB_TEAR_OFF_MARGIN ||
    clientY < -TAB_TEAR_OFF_MARGIN ||
    clientX < -TAB_TEAR_OFF_MARGIN ||
    clientX > window.innerWidth + TAB_TEAR_OFF_MARGIN;

  const targetAt = (sourceId: number, clientX: number) => {
    const candidates = tabs
      .filter((tab) => tab.id !== sourceId)
      .map((tab) => ({ id: tab.id, node: tabNodes.current.get(tab.id) }))
      .filter((item): item is { id: number; node: HTMLDivElement } => Boolean(item.node));
    if (candidates.length === 0) return null;
    for (const candidate of candidates) {
      const bounds = candidate.node.getBoundingClientRect();
      if (clientX < bounds.left + bounds.width / 2) {
        return { id: candidate.id, position: "before" as const };
      }
    }
    return { id: candidates[candidates.length - 1].id, position: "after" as const };
  };

  const startPointerDrag = (tabId: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-tab-close="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in a few older embedded webviews.
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerSession.current = {
      dropTarget: null,
      // In a new window this tab becomes the first one, so it would sit right
      // after the traffic-light space: offset the window by that much and the
      // tab reappears under the cursor, where the user left it.
      grabX: TITLEBAR_TRAFFIC_WIDTH + (event.clientX - bounds.left),
      grabY: Math.min(TITLEBAR_HEIGHT, Math.max(0, event.clientY)),
      id: tabId,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tearOff: false,
    };
  };

  const movePointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = pointerSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    // Straight-down drags tear a tab off, so the threshold has to see both axes.
    if (
      !session.moved &&
      Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 5
    ) {
      return;
    }
    if (!session.moved) {
      session.moved = true;
      setDraggedTabId(session.id);
    }
    session.tearOff = canDetach && outsideTitlebar(event.clientX, event.clientY);
    if (session.tearOff) {
      // Out of the strip: no insertion point any more, just the new-window hint.
      setDropTarget(null);
      setTearOff({ x: event.clientX, y: event.clientY });
      return;
    }
    setTearOff(null);
    const nextTarget = targetAt(session.id, event.clientX);
    session.dropTarget = nextTarget;
    setDropTarget((current) =>
      current?.id === nextTarget?.id && current?.position === nextTarget?.position
        ? current
        : nextTarget,
    );
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const session = pointerSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // See the pointer-capture fallback above.
    }
    if (!cancelled) {
      if (session.moved && session.tearOff) {
        // screenX/Y is the cursor on screen; back out the grab offset to get the
        // new window's top-left, so the tab lands exactly under the pointer.
        onDetach(session.id, {
          x: event.screenX - session.grabX,
          y: event.screenY - session.grabY,
        });
      } else if (session.moved && session.dropTarget) {
        onReorder(session.id, session.dropTarget.id, session.dropTarget.position);
      } else if (!session.moved) {
        onSelect(session.id);
      }
    }
    clearDrag();
  };

  return (
    <View style={[styles.titlebar, glass(30, 180)]} {...TITLEBAR_DRAG}>
      <View style={styles.tbTrafficSpace} {...SPACER_DRAG} />
      <View style={styles.tbTabs}>
        {tabs.map((tab) => {
          const dropPosition = dropTarget?.id === tab.id ? dropTarget.position : null;
          return (
            <div
              key={tab.id}
              onPointerCancel={(event) => finishPointerDrag(event, true)}
              onPointerDownCapture={(event) => startPointerDrag(tab.id, event)}
              onPointerMove={(event) => movePointerDrag(event)}
              onPointerUp={(event) => finishPointerDrag(event)}
              ref={(node) => {
                if (node) tabNodes.current.set(tab.id, node);
                else tabNodes.current.delete(tab.id);
              }}
              style={{
                borderRadius: 8,
                cursor: draggedTabId === tab.id ? "grabbing" : "grab",
                opacity: draggedTabId === tab.id ? 0.48 : 1,
                position: "relative",
                touchAction: "none",
                transition: "opacity 0.14s ease",
                userSelect: "none",
              }}
              title={canDetach ? "拖动调整顺序，拖出标题栏可在新窗口打开" : "拖动调整标签位置"}
            >
              {dropPosition ? (
                <div
                  style={{
                    background: accent.accent,
                    borderRadius: 999,
                    bottom: 2,
                    boxShadow: `0 0 0 2px rgba(${accent.rgb},0.16)`,
                    position: "absolute",
                    top: 2,
                    width: 2,
                    zIndex: 2,
                    ...(dropPosition === "before" ? { left: -3 } : { right: -3 }),
                  }}
                />
              ) : null}
              <TabButton
                accent={accent}
                active={tab.id === activeId}
                canClose={tabs.length > 1}
                label={labelFor(tab)}
                onClose={() => onClose(tab.id)}
                onSelect={() => onSelect(tab.id)}
                section={tab.section}
              />
            </div>
          );
        })}
        <Pressable
          accessibilityLabel="新建标签页"
          accessibilityRole="button"
          onPress={onAdd}
          style={({ hovered, pressed }: PressState) => [
            styles.tabAdd,
            motion,
            hovered && styles.tabAddHover,
            pressed && styles.primaryButtonPressed,
          ]}
        >
          <RiAddLine color={theme.t.textTertiary} size={17} />
        </Pressable>
      </View>
      <View style={styles.tbFlex} {...SPACER_DRAG} />
      {sidebarAvailable ? (
        <Pressable
          accessibilityLabel={sidebarOpen ? "隐藏 AI 侧边栏" : "显示 AI 侧边栏"}
          accessibilityRole="button"
          onPress={onToggleSidebar}
          style={({ hovered, pressed }: PressState) => [
            styles.tabAdd,
            motion,
            sidebarOpen && { backgroundColor: accent.selectedFill },
            hovered && !sidebarOpen && styles.tabAddHover,
            pressed && styles.primaryButtonPressed,
          ]}
        >
          <RiLayoutRightLine
            color={sidebarOpen ? accent.accentText : theme.t.textTertiary}
            size={17}
          />
        </Pressable>
      ) : null}
      {tearOff ? (
        // The titlebar starts at the window's top-left, so its own coordinate
        // space is the viewport's — an absolute box can just follow the cursor.
        <div
          style={{
            alignItems: "center",
            background: theme.t.overlaySolid,
            border: `1px solid ${theme.t.separatorStrong}`,
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(20,28,40,0.22)",
            color: theme.t.textSecondary,
            display: "flex",
            fontSize: 12,
            gap: 6,
            left: tearOff.x + 14,
            padding: "6px 10px",
            pointerEvents: "none",
            position: "absolute",
            top: tearOff.y + 16,
            whiteSpace: "nowrap",
            zIndex: 30,
          }}
        >
          <RiExternalLinkLine color={theme.t.textTertiary} size={14} />
          松开以在新窗口打开
        </div>
      ) : null}
    </View>
  );
}

function TabButton({
  accent,
  active,
  canClose,
  label,
  onClose,
  onSelect,
  section,
}: {
  accent: Accent;
  active: boolean;
  canClose: boolean;
  label: string;
  onClose: () => void;
  onSelect: () => void;
  section: SectionId;
}) {
  const { styles, theme } = useStyles(accent);
  const meta = metaFor(section);
  const sectionAccent = accentFor(section);
  const Icon = active ? meta.iconFill : meta.icon;
  const iconColor = active ? sectionAccent.accentText : theme.t.textTertiary;
  const labelColor = active ? theme.t.textPrimary : theme.t.textSecondary;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onSelect}
      style={({ hovered }: PressState) => [
        styles.tab,
        motion,
        canClose && styles.tabClosable,
        !active && hovered && styles.tabHover,
        active && styles.tabActive,
      ]}
    >
      <div style={{ display: "flex", flexShrink: 1, minWidth: 0 }}>
        <View style={styles.tabMain}>
          {/* Fixed-size icon: without flexShrink:0 the flex row squishes the icon
              (not just the label) once a long title pushes the tab to its max width. */}
          <View style={styles.tabIcon}>
            <Icon color={iconColor} size={16} />
          </View>
          <Text numberOfLines={1} style={[styles.tabLabel, { color: labelColor }]}>
            {label}
          </Text>
        </View>
      </div>
      {canClose && (
        <div data-tab-close="true" style={{ display: "flex" }}>
          <Pressable
            accessibilityLabel="关闭标签页"
            accessibilityRole="button"
            onPress={(event) => {
              event.stopPropagation();
              onClose();
            }}
            style={({ hovered: h, pressed }: PressState) => [
              styles.tabClose,
              motion,
              (h || pressed) && styles.tabCloseHover,
            ]}
          >
            <RiCloseLine color={theme.t.textTertiary} size={13} />
          </Pressable>
        </div>
      )}
    </Pressable>
  );
}

function NavigationRail({
  accent,
  activeSection,
  compact,
  onSelect,
}: {
  accent: Accent;
  activeSection: SectionId;
  compact: boolean;
  onSelect: (section: SectionId) => void;
}) {
  const { styles } = useStyles(accent);
  return (
    <View style={[styles.rail, glass(30, 180), compact && styles.railCompact]}>
      <View style={styles.railHeader}>
        <EditableUserAvatar size={38} />
      </View>

      <View style={styles.railNavigation}>
        {featureSections.map((section) => (
          <RailButton
            accent={accent}
            active={activeSection === section.id}
            iconFill={section.iconFill}
            iconLine={section.icon}
            key={section.id}
            label={section.label}
            onPress={() => onSelect(section.id)}
          />
        ))}
      </View>

      <View style={styles.railSpacer} />
      <RailButton
        accent={accent}
        active={activeSection === "settings"}
        iconFill={RiSettings4Fill}
        iconLine={RiSettings4Line}
        label="设置"
        onPress={() => onSelect("settings")}
      />
    </View>
  );
}

function RailButton({
  accent,
  active,
  iconFill: IconFill,
  iconLine: IconLine,
  label,
  onPress,
}: {
  accent: Accent;
  active: boolean;
  iconFill: RemixIcon;
  iconLine: RemixIcon;
  label: string;
  onPress: () => void;
}) {
  const { styles, theme } = useStyles(accent);
  const Icon = active ? IconFill : IconLine;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed, hovered }: PressState) => [
        styles.railButton,
        motion,
        hovered && !active && styles.railButtonHover,
        active && styles.railButtonActive,
        pressed && styles.railButtonPressed,
      ]}
    >
      {({ hovered }: PressState) => (
        <>
          <Icon
            color={
              active ? accent.accentText : hovered ? theme.t.textSecondary : theme.t.textTertiary
            }
            size={24}
          />
        </>
      )}
    </Pressable>
  );
}

function SettingsMenuItem({
  accent,
  active,
  icon: Icon,
  label,
  onPress,
}: {
  accent: Accent;
  active: boolean;
  icon: RemixIcon;
  label: string;
  onPress: () => void;
}) {
  const { styles, theme } = useStyles(accent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.settingsMenuItem,
        motion,
        hovered && !active && styles.settingsMenuItemHover,
        active && styles.settingsMenuItemActive,
        pressed && ({ opacity: 0.9 } as ViewStyle),
      ]}
    >
      <Icon color={active ? accent.accentText : theme.t.textTertiary} size={17} />
      <Text style={[styles.settingsMenuText, active && styles.settingsMenuTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function CollectionColumn({
  accent,
  activeSection,
  chat,
  compact,
  finance,
  meta,
  notes,
  onDeleteConversation,
  onEditAssistant,
  onEditDefaultConversation,
  onNewAssistant,
  onNewConversation,
  onNotePathChanged,
  onOpenPaper,
  onSelectAssistant,
  onSelectConversation,
  onSelectNote,
  onSelectSettingsTab,
  onSelectTodoScope,
  onSelectTravelNote,
  papers,
  settingsTab,
  tab,
  todos,
  travel,
}: {
  accent: Accent;
  activeSection: SectionId;
  chat: ChatData;
  compact: boolean;
  finance: FinanceData;
  meta: SectionMeta;
  notes: NotesData;
  onDeleteConversation: (assistantId: string, id: string) => void;
  onEditAssistant: (id: string) => void;
  onEditDefaultConversation: () => void;
  onNewAssistant: () => void;
  onNewConversation: () => void;
  onNotePathChanged: (oldPath: string, newPath: string | null) => void;
  onOpenPaper: (id: string) => void;
  onSelectAssistant: (id: string | null) => void;
  onSelectConversation: (assistantId: string, id: string) => void;
  onSelectNote: (path: string | null) => void;
  onSelectSettingsTab: (tab: SettingsTab) => void;
  onSelectTodoScope: (scope: TodoScope) => void;
  onSelectTravelNote: (id: string | null) => void;
  papers: PapersData;
  settingsTab: SettingsTab;
  tab: Tab | undefined;
  todos: TodosData;
  travel: TravelData;
}) {
  const { styles, theme } = useStyles(accent);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchText, setSearchText] = useState("");
  const isSettings = activeSection === "settings";
  const isChat = activeSection === "chat";
  const isNotes = activeSection === "notes";
  const isPapers = activeSection === "papers";
  const isTodo = activeSection === "todo";
  const isFinance = activeSection === "finance";
  const isTravel = activeSection === "travel";
  // Notes, papers, todo, finance and travel bring their own create + filter
  // controls, so the generic header button and search box stay out of their way.
  const ownsControls = isNotes || isPapers || isTodo || isFinance || isTravel;

  return (
    <View
      style={[styles.collectionColumn, glass(24, 150), compact && styles.collectionColumnCompact]}
    >
      <View style={[styles.collectionWash, motionSlow]} pointerEvents="none" />
      <View style={styles.collectionHeader}>
        {isChat ? (
          <AssistantSwitcher
            accent={accent}
            assistantId={tab?.assistantId ?? null}
            chat={chat}
            onEditAssistant={onEditAssistant}
            onEditDefaultConversation={onEditDefaultConversation}
            onNewAssistant={onNewAssistant}
            onNewConversation={onNewConversation}
            onSelectAssistant={onSelectAssistant}
          />
        ) : (
          <View style={styles.collectionHeadingRow}>
            <Text style={styles.collectionTitle}>{meta.collectionTitle}</Text>
            {/* Notes, todo and finance own their create controls; other sections
                keep the generic add affordance. Settings has none. */}
            {!isSettings && !ownsControls && (
              <Pressable
                accessibilityLabel={meta.actionLabel}
                accessibilityRole="button"
                style={({ pressed, hovered }: PressState) => [
                  styles.addButton,
                  motion,
                  hovered && styles.secondaryButtonHover,
                  pressed && styles.primaryButtonPressed,
                ]}
              >
                <RiAddLine color={accent.accentText} size={18} />
              </Pressable>
            )}
          </View>
        )}

        <View style={[styles.collectionHeaderUnderline, motionSlow]} pointerEvents="none" />
      </View>

      {!isSettings && !ownsControls && (
        <View style={styles.collectionSearchArea}>
          <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
            <RiSearch2Line
              color={searchFocused ? accent.accentText : theme.t.textTertiary}
              size={15}
            />
            <TextInput
              accessibilityLabel={isChat ? "搜索对话" : `搜索${meta.label}`}
              onBlur={() => setSearchFocused(false)}
              onChangeText={setSearchText}
              onFocus={() => setSearchFocused(true)}
              placeholder={isChat ? "搜索对话..." : `搜索${meta.label}...`}
              placeholderTextColor={theme.t.textTertiary}
              style={styles.searchInput}
              value={searchText}
            />
          </View>
        </View>
      )}

      {isSettings ? (
        <View style={styles.settingsMenu}>
          <SettingsMenuItem
            accent={accent}
            active={settingsTab === "storage"}
            icon={RiHardDrive2Line}
            label="通用"
            onPress={() => onSelectSettingsTab("storage")}
          />
          <SettingsMenuItem
            accent={accent}
            active={settingsTab === "chat"}
            icon={RiChatSettingsLine}
            label="对话"
            onPress={() => onSelectSettingsTab("chat")}
          />
          <SettingsMenuItem
            accent={accent}
            active={settingsTab === "providers"}
            icon={RiRobot2Line}
            label="AI 服务商"
            onPress={() => onSelectSettingsTab("providers")}
          />
          <SettingsMenuItem
            accent={accent}
            active={settingsTab === "mcp"}
            icon={RiTerminalBoxLine}
            label="MCP 服务器"
            onPress={() => onSelectSettingsTab("mcp")}
          />
        </View>
      ) : isChat ? (
        <ChatCollection
          accent={accent}
          assistantId={tab?.assistantId ?? null}
          chat={chat}
          conversationAssistantId={tab?.conversationAssistantId ?? null}
          conversationId={tab?.conversationId ?? null}
          onDeleteConversation={onDeleteConversation}
          onSelectConversation={onSelectConversation}
          query={searchText}
        />
      ) : isNotes ? (
        <NotesCollection
          accent={accent}
          notes={notes}
          onNotePathChanged={onNotePathChanged}
          onSelect={onSelectNote}
          selectedPath={tab?.noteId ?? null}
        />
      ) : isPapers ? (
        <PapersCollection
          accent={accent}
          onOpenPaper={onOpenPaper}
          papers={papers}
          selectedId={tab?.paperId ?? null}
        />
      ) : isTodo ? (
        <TodoCollection
          accent={accent}
          onSelectScope={onSelectTodoScope}
          scope={tab?.todoScope ?? "today"}
          todos={todos}
        />
      ) : isFinance ? (
        <FinanceCollection accent={accent} finance={finance} />
      ) : isTravel ? (
        <TravelCollection
          accent={accent}
          onSelect={onSelectTravelNote}
          selectedId={tab?.travelNoteId ?? null}
          travel={travel}
        />
      ) : (
        <View style={styles.collectionEmpty}>
          <Text style={styles.collectionEmptyText}>暂无{meta.label}</Text>
        </View>
      )}
    </View>
  );
}

function MainColumn({
  accent,
  activeSection,
  chat,
  finance,
  isChoosingFolder,
  mcp,
  meta,
  notes,
  onChangeConversationAssistant,
  onChooseStorageFolder,
  onRevealStorageFolder,
  onNewConversation,
  onNewRootNote,
  onNotePathChanged,
  onOpenPaper,
  onSelectPaper,
  onSelectTodoLayout,
  onSelectTravelNote,
  onSetPapersView,
  papers,
  providers,
  settingsTab,
  storage,
  storageError,
  tab,
  todos,
  travel,
}: {
  accent: Accent;
  activeSection: SectionId;
  chat: ChatData;
  finance: FinanceData;
  isChoosingFolder: boolean;
  mcp: McpController;
  meta: SectionMeta;
  notes: NotesData;
  onChangeConversationAssistant: (
    assistantId: string,
    conversationId: string,
    targetAssistantId: string,
  ) => Promise<void>;
  onChooseStorageFolder: () => void;
  onRevealStorageFolder: () => void;
  onNewConversation: () => void;
  onNewRootNote: () => void;
  onNotePathChanged: (oldPath: string, newPath: string | null) => void;
  onOpenPaper: (id: string) => void;
  onSelectPaper: (id: string | null) => void;
  onSelectTodoLayout: (layout: TodoLayout) => void;
  onSelectTravelNote: (id: string | null) => void;
  onSetPapersView: (view: PapersView) => void;
  papers: PapersData;
  providers: ProvidersController;
  settingsTab: SettingsTab;
  storage: StorageStatus | null;
  storageError: string | null;
  tab: Tab | undefined;
  todos: TodosData;
  travel: TravelData;
}) {
  const { styles, theme } = useStyles(accent);
  const isSettings = activeSection === "settings";
  const isChat = activeSection === "chat";
  const isNotes = activeSection === "notes";
  const scrollRef = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 0 });
  }, [activeSection]);

  // Finance: a full-height capture conversation with its own header + composer.
  if (activeSection === "finance") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <FinanceMainColumn accent={accent} finance={finance} providers={providers} />
      </View>
    );
  }

  // Travel: a full-height map with its own map / trajectory / planning tabs.
  if (activeSection === "travel") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <TravelMainColumn
          accent={accent}
          onSelect={onSelectTravelNote}
          selectedId={tab?.travelNoteId ?? null}
          travel={travel}
        />
      </View>
    );
  }

  // Papers: a full-height relationship graph with a graph / detail switch.
  if (activeSection === "papers") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <PapersMainColumn
          accent={accent}
          onOpenPaper={onOpenPaper}
          onSelectPaper={onSelectPaper}
          onSetView={onSetPapersView}
          papers={papers}
          selectedId={tab?.paperId ?? null}
          view={tab?.papersView ?? "graph"}
        />
      </View>
    );
  }

  // Todo: a full-height board / list host with its own header controls.
  if (activeSection === "todo") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <TodoMainColumn
          accent={accent}
          layout={tab?.todoLayout ?? "board"}
          onSelectLayout={onSelectTodoLayout}
          scope={tab?.todoScope ?? "today"}
          todos={todos}
        />
      </View>
    );
  }

  // Notes: a full-height editor host (its own header + save state), no outer scroll.
  if (isNotes) {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <NotesMainColumn
          accent={accent}
          notes={notes}
          notePath={tab?.noteId ?? null}
          onCreateFirstNote={onNewRootNote}
          onNotePathChanged={onNotePathChanged}
        />
      </View>
    );
  }

  // Chat preferences use a dedicated scrolling settings page.
  if (isSettings && settingsTab === "chat") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <View style={styles.mainHeader}>
          <View style={styles.mainHeaderTitleBlock}>
            <Text numberOfLines={1} style={styles.mainTitle}>
              对话
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
          <ChatSettings providers={providers.providers} />
        </View>
      </View>
    );
  }

  // AI providers gets the full main area (its own two-pane, no standard header).
  if (isSettings && settingsTab === "providers") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <View style={styles.mainHeader}>
          <View style={styles.mainHeaderTitleBlock}>
            <Text numberOfLines={1} style={styles.mainTitle}>
              AI 服务商
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
          <ProvidersSettings providers={providers} />
        </View>
      </View>
    );
  }

  // MCP server: a standard header plus its own scrolling settings body.
  if (isSettings && settingsTab === "mcp") {
    return (
      <View style={[styles.mainColumn, glass(12, 120)]}>
        <View style={styles.mainHeader}>
          <View style={styles.mainHeaderTitleBlock}>
            <Text numberOfLines={1} style={styles.mainTitle}>
              MCP 服务器
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
          <McpSettings mcp={mcp} />
        </View>
      </View>
    );
  }

  const openConversationId = isChat ? (tab?.conversationId ?? null) : null;
  const openConversationAssistantId = isChat ? (tab?.conversationAssistantId ?? null) : null;
  const openConversation =
    openConversationId && openConversationAssistantId
      ? chat.conversationById(openConversationAssistantId, openConversationId)
      : null;
  const chatTitle = openConversation
    ? openConversation.title || "新对话"
    : tab?.assistantId
      ? (chat.assistantById(tab.assistantId)?.name ?? "助手")
      : "新对话";

  const title = isSettings ? "通用" : isChat ? chatTitle : meta.label;
  const subtitle = isSettings ? "" : meta.description;

  return (
    <View style={[styles.mainColumn, glass(12, 120)]}>
      <View style={styles.mainHeader}>
        <View style={styles.mainHeaderTitleBlock}>
          <Text numberOfLines={1} style={styles.mainTitle}>
            {title}
          </Text>
          {!isChat && subtitle ? <Text style={styles.mainSubtitle}>{subtitle}</Text> : null}
        </View>
        {openConversation && openConversationAssistantId ? (
          <View style={styles.mainHeaderControls}>
            <ConversationAssistantPicker
              accent={accent}
              assistantId={openConversationAssistantId}
              assistants={chat.assistants}
              conversationId={openConversation.id}
              defaultAssistantEmoji={chat.defaultConversationEmoji}
              onSelect={(targetAssistantId) =>
                onChangeConversationAssistant(
                  openConversationAssistantId,
                  openConversation.id,
                  targetAssistantId,
                )
              }
            />
            <ConversationModelPicker
              accent={accent}
              modelId={openConversation.modelId ?? null}
              onBalance={providers.balance}
              onSelect={(providerId, modelId) =>
                chat.setConversationModel(
                  openConversationAssistantId,
                  openConversation.id,
                  providerId,
                  modelId,
                )
              }
              providerId={openConversation.providerId ?? null}
              providers={providers.providers}
            />
          </View>
        ) : null}
      </View>

      {isChat ? (
        <View style={styles.chatMainContent}>
          <View key={activeSection} style={[styles.chatMainInner, enterUp()]}>
            <ChatMainBody
              accent={accent}
              assistantId={tab?.assistantId ?? null}
              chat={chat}
              conversationAssistantId={tab?.conversationAssistantId ?? null}
              conversationId={tab?.conversationId ?? null}
              onNewConversation={onNewConversation}
              providers={providers.providers}
            />
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.mainContent}
          ref={scrollRef}
          style={styles.mainScroll}
        >
          <View key={activeSection} style={[{ flexGrow: 1 } as ViewStyle, enterUp()]}>
            {isSettings ? (
              <View style={styles.settingsStack}>
                <StorageSettings
                  accent={accent}
                  error={storageError}
                  isChoosingFolder={isChoosingFolder}
                  onChooseStorageFolder={onChooseStorageFolder}
                  onRevealStorageFolder={onRevealStorageFolder}
                  storage={storage}
                />
                <ExaSettings />
                <CheckForUpdatesCard />
              </View>
            ) : (
              <View style={styles.featureEmptyCard}>
                <View style={styles.featureIllustration}>
                  <EmptyIllustration
                    color={theme.t.textPrimary}
                    section={activeSection}
                    size={110}
                  />
                </View>
                <Text style={styles.featureEmptyTitle}>{meta.emptyTitle}</Text>
                <Text style={styles.featureEmptyDescription}>{meta.emptyDescription}</Text>
                <Pressable
                  accessibilityRole="button"
                  style={({ pressed, hovered }: PressState) => [
                    styles.primaryButton,
                    motion,
                    hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
                    pressed && styles.primaryButtonPressed,
                  ]}
                >
                  <RiAddLine color={theme.t.onAccent} size={17} />
                  <Text style={styles.primaryButtonText}>{meta.actionLabel}</Text>
                </Pressable>
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function StorageSettings({
  accent,
  error,
  isChoosingFolder,
  onChooseStorageFolder,
  onRevealStorageFolder,
  storage,
}: {
  accent: Accent;
  error: string | null;
  isChoosingFolder: boolean;
  onChooseStorageFolder: () => void;
  onRevealStorageFolder: () => void;
  storage: StorageStatus | null;
}) {
  const { styles, theme } = useStyles(accent);
  const [usage, setUsage] = useState<{
    rootPath: string;
    totalBytes: number | null;
    failed: boolean;
  } | null>(null);
  const rootPath = storage?.rootPath ?? null;

  useEffect(() => {
    let mounted = true;
    if (!rootPath) {
      return () => {
        mounted = false;
      };
    }

    const request = isTauriRuntime()
      ? invoke<StorageUsage>("get_storage_usage")
      : Promise.resolve<StorageUsage>({ totalBytes: 384 * 1024 * 1024 });
    void request
      .then((usage) => {
        if (!mounted) return;
        setUsage({ rootPath, totalBytes: usage.totalBytes, failed: false });
      })
      .catch(() => {
        if (!mounted) return;
        setUsage({ rootPath, totalBytes: null, failed: true });
      });

    return () => {
      mounted = false;
    };
  }, [rootPath, storage]);

  const currentUsage = usage?.rootPath === rootPath ? usage : null;
  const usageText = !rootPath
    ? "—"
    : !currentUsage
      ? "计算中…"
      : currentUsage.failed || currentUsage.totalBytes === null
        ? "暂时无法统计"
        : formatStorageBytes(currentUsage.totalBytes);

  return (
    <View style={styles.settingsContent}>
      <View style={styles.settingsCard}>
        <View style={styles.settingsCardHeader}>
          <View style={styles.settingsIconWrap}>
            <RiHardDrive2Line color={accent.accentText} size={20} />
          </View>
          <View style={styles.settingsCardHeading}>
            <Text style={styles.settingsCardTitle}>当前数据文件夹</Text>
            <Text style={styles.settingsCardDescription}>Nomi 的配置和各功能数据均由你管理。</Text>
          </View>
        </View>

        <View style={styles.pathBox}>
          <RiFolderOpenLine color={theme.t.textTertiary} size={16} />
          <Text numberOfLines={2} selectable style={styles.pathText}>
            {storage?.rootPath ?? "尚未选择"}
          </Text>
        </View>

        <View style={styles.settingsCardActions}>
          <Pressable
            accessibilityRole="button"
            disabled={!storage?.rootPath}
            onPress={onRevealStorageFolder}
            style={({ pressed, hovered }: PressState) => [
              styles.secondaryButton,
              motion,
              hovered && styles.secondaryButtonHover,
              pressed && styles.primaryButtonPressed,
              !storage?.rootPath && styles.buttonDisabled,
            ]}
          >
            <RiExternalLinkLine color={accent.accentText} size={15} />
            <Text style={styles.secondaryButtonText}>在访达中显示</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={isChoosingFolder}
            onPress={onChooseStorageFolder}
            style={({ pressed, hovered }: PressState) => [
              styles.secondaryButton,
              motion,
              hovered && styles.secondaryButtonHover,
              pressed && styles.primaryButtonPressed,
              isChoosingFolder && styles.buttonDisabled,
            ]}
          >
            {isChoosingFolder ? (
              <ActivityIndicator color={accent.accentText} size="small" />
            ) : (
              <RiFolderOpenLine color={accent.accentText} size={15} />
            )}
            <Text style={styles.secondaryButtonText}>切换文件夹</Text>
          </Pressable>
          <View style={styles.storageUsage}>
            <Text style={styles.storageUsageLabel}>已占用</Text>
            <Text selectable style={styles.storageUsageValue}>
              {usageText}
            </Text>
          </View>
        </View>
      </View>

      {storage && (
        <View style={styles.directoryCard}>
          <View style={styles.directoryHeader}>
            <RiNodeTree color={theme.t.textSecondary} size={18} />
            <Text style={styles.directoryTitle}>目录结构</Text>
          </View>
          <DirectoryRow accent={accent} name=".nomi" note="配置" />
          {storage.features.map((feature) => (
            <DirectoryRow
              accent={accent}
              feature={feature.name}
              key={feature.id}
              name={feature.name}
              note="数据"
            />
          ))}
          <Text selectable style={styles.configPathText}>
            配置文件：{storage.configPath}
          </Text>
        </View>
      )}

      {error && <Text style={styles.inlineError}>{error}</Text>}
    </View>
  );
}

const FEATURE_DOT: Record<string, Exclude<SectionId, "settings">> = {
  chat: "chat",
  notes: "notes",
  todo: "todo",
  travel: "travel",
  finance: "finance",
};

function DirectoryRow({
  accent,
  feature,
  name,
  note,
}: {
  accent: Accent;
  feature?: string;
  name: string;
  note: string;
}) {
  const { styles, theme } = useStyles(accent);
  const featureId = feature ? FEATURE_DOT[feature] : undefined;
  const dotColor = featureId ? accentFor(featureId).accentText : theme.t.textTertiary;
  return (
    <View style={styles.directoryRow}>
      <View style={styles.directoryNameRow}>
        <View style={[styles.directoryDot, { backgroundColor: dotColor }]} />
        <Text style={styles.directoryName}>{name}/</Text>
      </View>
      <Text style={styles.directoryNote}>{note}</Text>
    </View>
  );
}

function StorageSetup({
  compact,
  error,
  isChoosingFolder,
  onChooseStorageFolder,
}: {
  compact: boolean;
  error: string | null;
  isChoosingFolder: boolean;
  onChooseStorageFolder: () => void;
}) {
  const chat = accentFor("chat");
  const { styles, theme } = useStyles(chat);
  return (
    <View style={[styles.setupOverlay, glass(8, 115), enterFade()]}>
      <View
        style={[styles.setupCard, glass(40, 180), enterModal(), compact && styles.setupCardCompact]}
      >
        <View style={[styles.setupIcon, compact && styles.setupIconCompact]}>
          <RiFolderOpenLine color={chat.accentText} size={compact ? 24 : 28} />
        </View>
        <Text style={styles.setupEyebrow}>欢迎使用 NOMI</Text>
        <Text style={[styles.setupTitle, compact && styles.setupTitleCompact]}>选择数据文件夹</Text>
        <Text style={[styles.setupDescription, compact && styles.setupDescriptionCompact]}>
          首次启动需要选择一个文件夹。Nomi 会在其中创建配置和功能数据目录；如果已有 Nomi
          数据，将直接读取并继续使用。
        </Text>

        <View style={[styles.setupTree, compact && styles.setupTreeCompact]}>
          <Text style={styles.setupTreeRoot}>你选择的文件夹/</Text>
          <Text style={styles.setupTreeItem}>├─ .nomi/config.json</Text>
          <Text style={styles.setupTreeItem}>├─ chat/</Text>
          <Text style={styles.setupTreeItem}>├─ notes/</Text>
          <Text style={styles.setupTreeItem}>├─ todo/</Text>
          <Text style={styles.setupTreeItem}>├─ travel/</Text>
          <Text style={styles.setupTreeItem}>└─ finance/</Text>
        </View>

        {error && <Text style={styles.setupError}>{error}</Text>}

        <Pressable
          accessibilityRole="button"
          disabled={isChoosingFolder}
          onPress={onChooseStorageFolder}
          style={({ pressed, hovered }: PressState) => [
            styles.setupButton,
            motion,
            compact && styles.setupButtonCompact,
            hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
            pressed && styles.primaryButtonPressed,
            isChoosingFolder && styles.buttonDisabled,
          ]}
        >
          {isChoosingFolder ? (
            <ActivityIndicator color={theme.t.onAccent} size="small" />
          ) : (
            <RiFolderOpenLine color={theme.t.onAccent} size={18} />
          )}
          <Text style={styles.setupButtonText}>选择文件夹</Text>
          {!isChoosingFolder && <RiArrowRightLine color={theme.t.onAccent} size={17} />}
        </Pressable>
        <Text style={[styles.setupFootnote, compact && styles.setupFootnoteCompact]}>
          Nomi 不会把你的业务数据上传到云端。
        </Text>
      </View>
    </View>
  );
}

export default App;
