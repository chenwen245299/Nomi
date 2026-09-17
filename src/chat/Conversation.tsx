import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
  type ViewStyle,
} from "react-native";
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiAttachment2,
  RiAtLine,
  RiBrainAi3Line,
  RiCheckLine,
  RiCloseLine,
  RiCollapseDiagonalLine,
  RiDatabase2Line,
  RiDeleteBinLine,
  RiDownload2Line,
  RiEditBoxLine,
  RiEditLine,
  RiEraserLine,
  RiExpandDiagonalLine,
  RiFileCopyLine,
  RiFilePdf2Line,
  RiFileTextLine,
  RiImage2Line,
  RiLayoutColumnLine,
  RiLayoutRowLine,
  RiLoader4Line,
  RiRestartLine,
  RiSendPlane2Fill,
  RiSendPlane2Line,
  RiStopFill,
  RiThumbDownFill,
  RiThumbDownLine,
  RiThumbUpFill,
  RiThumbUpLine,
  RiToolsFill,
  RiVideoLine,
} from "@remixicon/react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Vditor from "vditor";
import { AttachmentPreviewModal, type AttachmentPreviewKind } from "../AttachmentPreviewModal";
import { copyText } from "../clipboard";
import { VDITOR_CDN } from "../editor/vditorAssets";
import { accentFor, motion, useTheme, type Accent, type Theme } from "../theme";
import { BrandIcon } from "../providers/BrandIcon";
import { modelIconUrl, providerIconUrl } from "../providers/icons";
import { UserAvatar } from "../profile/UserAvatar";
import { isChatModel, type Provider } from "../providers/api";
import {
  downloadAttachment,
  loadChatAttachmentPreview,
  loadPdfThumbnail,
  saveChatAttachment,
  saveChatAttachmentData,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type MessageUsage,
} from "./api";
import { useConversation, type DraftToolCall, type StreamingMessage } from "./useConversation";
import type { ConversationContextSource } from "./chatRuntime";
import { renderMarkdown } from "./markdown";
import {
  effortScaleFor,
  mapEffort,
  thinkingCanBeDisabled,
  THINKING_LABEL,
  type ThinkingEffort,
} from "./reasoning";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const ATTACH_EXTS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "mp4",
  "avi",
  "mov",
  "mkv",
  "txt",
  "md",
];

interface PendingAttachment {
  key: string;
  name: string;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  previewUrl?: string;
}

interface ReasoningViewState {
  expanded: boolean;
  open: boolean;
}

const DEFAULT_REASONING_VIEW_STATE: ReasoningViewState = { expanded: false, open: true };
const USER_MESSAGE_COLLAPSED_LINES = 10;
// Keep in sync with .nomi-user-message-text's line-height in global.css so the
// collapse threshold and fade gradient line up with the rendered text.
const USER_MESSAGE_LINE_HEIGHT = 26;
const USER_MESSAGE_COLLAPSED_HEIGHT = USER_MESSAGE_COLLAPSED_LINES * USER_MESSAGE_LINE_HEIGHT;
const CHAT_SCROLL_STORAGE_KEY = "nomi.chat.scroll-positions.v1";
const MAX_SAVED_CHAT_SCROLL_POSITIONS = 200;

interface SavedChatScrollPosition {
  atBottom: boolean;
  top: number;
  updatedAt: number;
}

const savedChatScrollPositions = new Map<string, SavedChatScrollPosition>();
let chatScrollPositionsLoaded = false;
let chatScrollPersistTimer: number | undefined;

function chatScrollKey(scope: string, assistantId: string, conversationId: string): string {
  return [scope || "main", assistantId, conversationId].map(encodeURIComponent).join("/");
}

function loadChatScrollPositions(): void {
  if (chatScrollPositionsLoaded || typeof window === "undefined") return;
  chatScrollPositionsLoaded = true;
  try {
    const raw = window.localStorage.getItem(CHAT_SCROLL_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Partial<SavedChatScrollPosition>>;
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value.top === "number" &&
        Number.isFinite(value.top) &&
        typeof value.atBottom === "boolean"
      ) {
        savedChatScrollPositions.set(key, {
          atBottom: value.atBottom,
          top: Math.max(0, value.top),
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
        });
      }
    }
  } catch {
    // Corrupt or unavailable localStorage must never block opening a conversation.
  }
}

function readChatScrollPosition(key: string): SavedChatScrollPosition | null {
  loadChatScrollPositions();
  return savedChatScrollPositions.get(key) ?? null;
}

function persistChatScrollPositions(): void {
  if (typeof window === "undefined") return;
  const entries = [...savedChatScrollPositions.entries()]
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_SAVED_CHAT_SCROLL_POSITIONS);
  savedChatScrollPositions.clear();
  entries.forEach(([key, value]) => savedChatScrollPositions.set(key, value));
  try {
    window.localStorage.setItem(
      CHAT_SCROLL_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // The in-memory copy still keeps positions for the current app session.
  }
}

function rememberChatScrollPosition(
  key: string,
  position: Omit<SavedChatScrollPosition, "updatedAt">,
): void {
  savedChatScrollPositions.set(key, { ...position, updatedAt: Date.now() });
  if (typeof window === "undefined") return;
  window.clearTimeout(chatScrollPersistTimer);
  chatScrollPersistTimer = window.setTimeout(persistChatScrollPositions, 180);
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("读取剪贴板文件失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取剪贴板文件失败"));
    reader.readAsDataURL(file);
  });
}

function clipboardFileMimeType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "png") return "image/png";
  return "application/octet-stream";
}

function isSupportedClipboardFile(file: File): boolean {
  const mimeType = clipboardFileMimeType(file);
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

/** Pretty-print streamed JSON args; fall back to the raw text while partial. */
function prettyArgs(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function findScrollableParent(target: unknown): HTMLElement | null {
  let element = target instanceof HTMLElement ? target : null;
  while (element) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function selectionIsInside(root: HTMLElement | null): boolean {
  const selection = document.getSelection();
  if (!root || !selection || selection.isCollapsed) return false;
  return Boolean(
    (selection.anchorNode && root.contains(selection.anchorNode)) ||
    (selection.focusNode && root.contains(selection.focusNode)),
  );
}

function isNearScrollBottom(element: HTMLElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
}

function updatePreservingScrollPosition(target: unknown, update: () => void) {
  const scrollParent = findScrollableParent(target);
  const scrollTop = scrollParent?.scrollTop;
  update();
  if (scrollParent && scrollTop != null) {
    window.requestAnimationFrame(() => {
      scrollParent.scrollTop = scrollTop;
    });
  }
}

// ── Markdown (raw DOM, like the <select> used elsewhere in the app) ────────────
const CHAT_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function normaliseChatExternalHref(anchor: HTMLAnchorElement): string | null {
  const rawHref = anchor.getAttribute("href")?.trim();
  if (!rawHref || rawHref.startsWith("#")) return null;

  let candidate = rawHref;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  else if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;

  try {
    const url = new URL(candidate);
    return CHAT_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function openChatExternalHref(href: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function MarkdownView({ content, color }: { content: string; color: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element?.querySelector(".language-math")) return;
    Vditor.mathRender(element, {
      cdn: VDITOR_CDN,
      math: { engine: "KaTeX" },
    });
  }, [html]);

  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;

    // Never let an untrusted model-authored link navigate Nomi's own webview.
    event.preventDefault();
    event.stopPropagation();
    const href = normaliseChatExternalHref(anchor);
    if (href) void openChatExternalHref(href);
  };

  return (
    <div
      className="nomi-chat-selectable nomi-md"
      onClick={handleLinkClick}
      ref={elementRef}
      style={{ color, lineHeight: 1.65, wordBreak: "break-word" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    root: { flex: 1, minHeight: 0, width: "100%" },
    scroll: { flex: 1, minHeight: 0 },
    scrollContent: { gap: 16, paddingBottom: 16, paddingRight: 8, paddingTop: 8 },
    empty: { alignItems: "center", gap: 6, justifyContent: "center", paddingVertical: 48 },
    emptyText: { color: t.textTertiary, fontSize: 12.5 },
    // message rows
    row: { flexDirection: "row", gap: 8, maxWidth: "100%", width: "100%" },
    rowUser: { alignItems: "flex-start", justifyContent: "flex-end" },
    rowAssistant: { alignItems: "flex-start", justifyContent: "flex-start" },
    userBubble: {
      alignItems: "stretch",
      flexShrink: 1,
      maxWidth: "100%",
      minWidth: 0,
      paddingVertical: 4,
    },
    userEditor: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separatorStrong,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 15,
      lineHeight: 23,
      minHeight: 64,
      minWidth: 260,
      paddingHorizontal: 9,
      paddingVertical: 7,
      textAlign: "left",
    },
    userMetaRow: {
      marginTop: 2,
      minHeight: 23,
      position: "relative",
    },
    userMetaControls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 3,
      position: "absolute",
      right: 0,
      top: 0,
    },
    userExpandButton: {
      alignItems: "center",
      borderRadius: 6,
      flexDirection: "row",
      gap: 2,
      height: 24,
      paddingHorizontal: 7,
    },
    userExpandButtonHover: { backgroundColor: t.controlHover },
    userExpandText: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    assistantBubble: { flex: 1, minWidth: 0 },
    assistantIcon: { marginTop: 1 },
    answerSurface: { minWidth: 0, width: "100%" },
    answerMetaRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      justifyContent: "space-between",
      minHeight: 23,
      marginTop: 5,
    },
    answerActions: { alignItems: "center", flexDirection: "row", gap: 2 },
    answerAction: {
      alignItems: "center",
      borderRadius: 5,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    answerActionHover: { backgroundColor: t.controlHover },
    answerActionActive: { backgroundColor: accent.selectedFill },
    answerEditor: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separatorStrong,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 15,
      lineHeight: 23,
      minHeight: 88,
      padding: 10,
    },
    editorActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      justifyContent: "flex-end",
      marginTop: 5,
    },
    compareFrame: {
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      flex: 1,
      flexDirection: "row",
      minWidth: 0,
      overflow: "hidden",
    },
    comparePanel: { flex: 1, minWidth: 0 },
    comparePanelBorder: { borderLeftColor: t.separator, borderLeftWidth: 1 },
    compareHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 7,
      minHeight: 38,
      paddingHorizontal: 10,
    },
    compareModel: { color: t.textSecondary, flex: 1, fontSize: 11, fontWeight: "600" },
    compareBody: {
      flex: 1,
      minHeight: 110,
      paddingHorizontal: 11,
      paddingTop: 10,
    },
    compareFooter: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    compareFooterActions: { alignItems: "center", flexDirection: "row", gap: 2 },
    variantBar: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 6,
      marginTop: 8,
      paddingTop: 8,
    },
    variantButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: "transparent",
      borderRadius: 8,
      borderWidth: 1,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    variantButtonHover: { backgroundColor: t.controlHover },
    variantButtonActive: { backgroundColor: t.cardSurface, borderColor: accent.accent },
    modelMenu: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 10,
      borderWidth: 1,
      boxShadow: "0 12px 36px rgba(30,38,50,0.16)",
      left: 0,
      maxHeight: 260,
      overflow: "scroll",
      padding: 5,
      position: "absolute",
      width: 270,
      zIndex: 30,
    },
    modelMenuDown: { top: 27 },
    modelMenuUp: { bottom: 27 },
    modelMenuProvider: {
      color: t.textTertiary,
      fontSize: 9.5,
      fontWeight: "700",
      letterSpacing: 0.8,
      paddingHorizontal: 7,
      paddingVertical: 5,
      textTransform: "uppercase",
    },
    modelMenuRow: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 8,
      minHeight: 36,
      paddingHorizontal: 7,
    },
    modelMenuRowHover: { backgroundColor: t.controlHover },
    modelMenuName: { color: t.textSecondary, flex: 1, fontSize: 11 },
    // attachments
    attachRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      justifyContent: "flex-end",
      marginBottom: 8,
    },
    chip: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      maxWidth: 220,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    chipHover: { backgroundColor: t.controlHover, borderColor: t.separatorStrong },
    chipText: { color: t.textSecondary, flexShrink: 1, fontSize: 12 },
    chipStatus: { color: t.textTertiary, fontSize: 11 },
    // reasoning
    reasoning: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      marginBottom: 8,
      overflow: "hidden",
    },
    reasoningHeader: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 34,
      paddingHorizontal: 9,
    },
    reasoningToggle: {
      alignItems: "center",
      borderRadius: 6,
      flexDirection: "row",
      gap: 4,
      minHeight: 26,
      paddingHorizontal: 3,
    },
    reasoningToggleHover: { backgroundColor: t.controlHover },
    reasoningLabel: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    reasoningMeta: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      marginLeft: "auto",
    },
    reasoningMetaText: { color: t.textTertiary, fontSize: 10.5 },
    reasoningExpand: {
      alignItems: "center",
      borderRadius: 6,
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    reasoningBody: {
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    reasoningText: {
      color: t.textSecondary,
      fontSize: 11.5,
      lineHeight: 18,
      opacity: 0.68,
    },
    // tool calls
    toolGroup: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separatorStrong,
      borderRadius: 10,
      borderWidth: 1,
      marginBottom: 8,
      overflow: "hidden",
    },
    toolGroupHeader: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 38,
      paddingHorizontal: 10,
    },
    toolGroupToggle: {
      alignItems: "center",
      borderRadius: 6,
      flex: 1,
      flexDirection: "row",
      gap: 7,
      minHeight: 30,
      minWidth: 0,
      paddingHorizontal: 3,
    },
    toolGroupLabel: { color: t.textPrimary, fontSize: 12, fontWeight: "700" },
    toolGroupMeta: {
      color: t.textTertiary,
      flexShrink: 1,
      fontSize: 10.5,
      marginLeft: "auto",
    },
    tool: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      marginBottom: 8,
      overflow: "hidden",
    },
    toolGrouped: {
      backgroundColor: "transparent",
      borderRadius: 6,
      borderWidth: 0,
      marginBottom: 0,
    },
    toolGroupedDivider: { borderBottomColor: t.separator, borderBottomWidth: 1 },
    toolHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
      minHeight: 32,
      paddingHorizontal: 7,
      paddingVertical: 6,
    },
    toolHeaderHover: { backgroundColor: t.controlIdle },
    toolName: {
      color: t.textSecondary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      fontWeight: "600",
    },
    toolSummary: { color: t.textTertiary, flex: 1, fontSize: 11.5 },
    toolBody: { borderTopColor: t.separator, borderTopWidth: 1, gap: 8, padding: 11 },
    toolImageLoading: {
      color: t.textTertiary,
      fontSize: 10.5,
      paddingBottom: 9,
      paddingLeft: 29,
    },
    toolImageThumb: {
      backgroundColor: t.cardSurface,
      borderColor: t.separatorStrong,
      borderRadius: 8,
      borderWidth: 1,
      flexShrink: 0,
      overflow: "hidden",
      position: "relative",
    },
    toolImageThumbHover: {
      borderColor: accent.accent,
      boxShadow: `0 3px 12px rgba(${accent.rgb},0.16)`,
      transform: "translateY(-1px)",
    },
    toolImageCaption: {
      backgroundColor: "rgba(20,28,40,0.68)",
      bottom: 0,
      color: "#FFFFFF",
      fontSize: 9.5,
      left: 0,
      paddingHorizontal: 6,
      paddingVertical: 3,
      position: "absolute",
      right: 0,
      textAlign: "center",
    },
    // Attachments the model generated (create_markdown_document): thumbnail cards.
    // Card width is fixed; height is set inline from each file's true aspect ratio.
    assistantAttachRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 },
    assistantAttachCard: {},
    assistantAttachThumb: {
      backgroundColor: t.cardSurface,
      borderColor: t.separatorStrong,
      borderRadius: 10,
      borderWidth: 1,
      overflow: "hidden",
      position: "relative",
    },
    assistantAttachHit: {
      alignItems: "center",
      backgroundColor: "#FFFFFF",
      height: "100%",
      justifyContent: "center",
      width: "100%",
    },
    assistantAttachHitHover: {
      boxShadow: `inset 0 0 0 2px rgba(${accent.rgb},0.55)`,
    },
    assistantAttachFallback: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      height: "100%",
      justifyContent: "center",
      width: "100%",
    },
    assistantAttachDownload: {
      alignItems: "center",
      backgroundColor: "rgba(20,28,40,0.74)",
      borderRadius: 999,
      bottom: 7,
      height: 27,
      justifyContent: "center",
      position: "absolute",
      right: 7,
      width: 27,
      zIndex: 2,
    },
    assistantAttachDownloadHover: {
      backgroundColor: accent.accent,
    },
    assistantAttachName: {
      color: t.textSecondary,
      fontSize: 11,
      marginTop: 5,
    },
    toolSectionLabel: { color: t.textTertiary, fontSize: 11, fontWeight: "600", marginBottom: 4 },
    code: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 7,
      borderWidth: 1,
      color: t.textSecondary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      lineHeight: 17,
      padding: 9,
    },
    contextMarkerRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 36,
    },
    contextMarkerLine: { backgroundColor: t.separator, flex: 1, height: 1 },
    contextMarkerContent: { alignItems: "center", flexDirection: "row", gap: 3 },
    contextMarkerText: { color: t.textTertiary, fontSize: 10.5 },
    contextMarkerDelete: {
      alignItems: "center",
      borderRadius: 5,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    // composer
    composer: {
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexShrink: 0,
      gap: 8,
      paddingTop: 10,
    },
    pendingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    pendingChipPreview: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 6,
      minWidth: 0,
    },
    pendingImage: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      height: 68,
      overflow: "hidden",
      position: "relative",
      width: 84,
    },
    pendingImageRemove: {
      alignItems: "center",
      backgroundColor: "rgba(20,28,40,0.72)",
      borderRadius: 999,
      height: 20,
      justifyContent: "center",
      position: "absolute",
      right: 4,
      top: 4,
      width: 20,
      zIndex: 2,
    },
    pendingImageStatus: {
      backgroundColor: "rgba(20,28,40,0.66)",
      bottom: 0,
      color: "#FFFFFF",
      fontSize: 9.5,
      left: 0,
      paddingHorizontal: 5,
      paddingVertical: 3,
      position: "absolute",
      right: 0,
      textAlign: "center",
    },
    inputWrap: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      padding: 8,
    },
    inputWrapFocused: {
      borderColor: t.separatorStrong,
      boxShadow: "0 0 0 1px rgba(60,70,85,0.04)",
    },
    input: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 13,
      lineHeight: 20,
      maxHeight: 160,
      minHeight: 40,
      paddingHorizontal: 6,
      paddingVertical: 6,
    },
    controls: { alignItems: "center", flexDirection: "row", gap: 2, marginTop: 4 },
    controlAnchor: { position: "relative", zIndex: 20 },
    iconBtn: {
      alignItems: "center",
      borderRadius: 7,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    iconBtnHover: { backgroundColor: t.controlHover },
    iconBtnActive: { backgroundColor: accent.selectedFill },
    iconBtnDisabled: { opacity: 0.36 },
    thinkingMenu: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 10,
      borderWidth: 1,
      bottom: 36,
      boxShadow: "0 10px 30px rgba(30,38,50,0.14)",
      left: 0,
      padding: 5,
      position: "absolute",
      width: 156,
      zIndex: 40,
    },
    thinkingMenuTitle: {
      color: t.textTertiary,
      fontSize: 10,
      fontWeight: "600",
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    thinkingOption: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      minHeight: 31,
      paddingHorizontal: 8,
    },
    thinkingOptionHover: { backgroundColor: t.controlHover },
    thinkingOptionActive: { backgroundColor: accent.selectedFill },
    thinkingOptionText: { color: t.textSecondary, flex: 1, fontSize: 11.5 },
    thinkingOptionTextActive: { color: accent.accentText, fontWeight: "600" },
    controlsSpacer: { flex: 1 },
    sendBtn: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 7,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    sendBtnDisabled: { opacity: 0.45 },
    stopBtn: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 7,
      borderWidth: 1,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    error: { color: t.errorText, fontSize: 12, paddingTop: 2 },
    hint: { color: t.textTertiary, fontSize: 11.5, paddingTop: 2 },
    usageRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      justifyContent: "flex-end",
      marginLeft: "auto",
      marginTop: 0,
    },
    usageText: { color: t.textTertiary, fontSize: 10.5 },
    usageGroup: { alignItems: "center", flexDirection: "row", gap: 6 },
    usageModel: { color: t.textTertiary, fontSize: 10.5 },
    usagePeriod: {
      backgroundColor: t.statusGreenFill,
      borderRadius: 999,
      color: t.statusGreenText,
      fontSize: 9.5,
      fontWeight: "700",
      overflow: "hidden",
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    usagePeriodPeak: { backgroundColor: "rgba(196,106,26,0.09)", color: "#B65F16" },
    usageSeparator: { color: t.separatorStrong, fontSize: 10 },
  });
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function costLabel(cost: number): string {
  const digits = cost >= 1 ? 3 : cost >= 0.01 ? 4 : 6;
  return cost.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function tokenCountLabel(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 1_000) return String(rounded);
  return `${(rounded / 1_000)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")}k`;
}

/** Compact response metadata: model, usage, throughput, latency, cache and cost. */
function UsageFooter({
  fallbackModel,
  fallbackProviderKind,
  fallbackProvider,
  showModel = true,
  usage,
  styles,
}: {
  fallbackModel?: string | null;
  fallbackProviderKind?: string | null;
  fallbackProvider?: string | null;
  showModel?: boolean;
  usage: MessageUsage;
  styles: Styles;
}) {
  const theme = useTheme();
  const hit = usage.cacheHitTokens ?? 0;
  const miss = usage.cacheMissTokens ?? 0;
  const hasCache = usage.cacheHitTokens != null || usage.cacheMissTokens != null;
  const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0;
  const durationMs = usage.durationMs ?? 0;
  const speed = durationMs > 0 ? usage.completionTokens / (durationMs / 1_000) : null;
  const model = usage.modelId || fallbackModel;
  const provider = usage.providerName?.trim() || fallbackProvider?.trim();
  const modelLabel = [provider, model].filter(Boolean).join(" · ");
  const hasCost = usage.pricingPeriod != null || usage.costCny != null || usage.costUsd != null;
  const hasDetails = durationMs > 0 || hasCache || hasCost;
  return (
    <View style={styles.usageRow}>
      {showModel && modelLabel ? (
        <View style={styles.usageGroup}>
          {provider ? (
            <BrandIcon
              accent={accentFor("chat")}
              fallback={provider.slice(0, 1).toUpperCase()}
              size={14}
              url={providerIconUrl(provider, fallbackProviderKind ?? "")}
            />
          ) : null}
          <Text style={styles.usageModel}>{modelLabel}</Text>
        </View>
      ) : null}
      {showModel && modelLabel ? <Text style={styles.usageSeparator}>|</Text> : null}
      <View style={styles.usageGroup}>
        <Text style={styles.usageText}>↑{tokenCountLabel(usage.promptTokens)}</Text>
        <Text style={styles.usageText}>↓{tokenCountLabel(usage.completionTokens)}</Text>
        {speed != null ? <Text style={styles.usageText}>{speed.toFixed(1)} t/s</Text> : null}
      </View>
      {hasDetails ? <Text style={styles.usageSeparator}>|</Text> : null}
      {hasDetails ? (
        <View style={styles.usageGroup}>
          {durationMs > 0 ? (
            <Text style={styles.usageText}>◷ {durationLabel(durationMs)}</Text>
          ) : null}
          {hasCache ? (
            <div title="缓存命中率">
              <View style={styles.usageGroup}>
                <RiDatabase2Line color={theme.t.textTertiary} size={11} />
                <Text style={styles.usageText}>{rate}%</Text>
              </View>
            </div>
          ) : null}
          {usage.pricingPeriod ? (
            <Text
              style={[styles.usagePeriod, usage.pricingPeriod === "peak" && styles.usagePeriodPeak]}
            >
              {usage.pricingPeriod === "peak" ? "波峰" : "波谷"}
            </Text>
          ) : null}
          {usage.costCny != null ? (
            <Text style={styles.usageText}>≈¥{costLabel(usage.costCny)}</Text>
          ) : null}
          {usage.costUsd != null ? (
            <Text style={styles.usageText}>${costLabel(usage.costUsd)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Per-file-type palette so a badge reads its kind at a glance: PDF is red, images
 * green, video violet, everything else a steel blue. `fill`/`border` are low-alpha
 * washes for the chip; `icon` is the AA-deepened tone for the glyph + label.
 */
interface AttachmentTint {
  icon: string;
  fill: string;
  fillHover: string;
  border: string;
}

function attachmentTint(att: { mimeType?: string; kind?: string }): AttachmentTint {
  if (att.mimeType === "application/pdf") {
    return {
      icon: "#C24A38",
      fill: "rgba(194,74,56,0.10)",
      fillHover: "rgba(194,74,56,0.16)",
      border: "rgba(194,74,56,0.22)",
    };
  }
  if (att.kind === "image" || att.mimeType?.startsWith("image/")) {
    return {
      icon: "#2F8A5B",
      fill: "rgba(47,138,91,0.10)",
      fillHover: "rgba(47,138,91,0.16)",
      border: "rgba(47,138,91,0.22)",
    };
  }
  if (att.kind === "video" || att.mimeType?.startsWith("video/")) {
    return {
      icon: "#6A4FC0",
      fill: "rgba(106,79,192,0.10)",
      fillHover: "rgba(106,79,192,0.16)",
      border: "rgba(106,79,192,0.22)",
    };
  }
  return {
    icon: "#4C6A9E",
    fill: "rgba(76,106,158,0.10)",
    fillHover: "rgba(76,106,158,0.16)",
    border: "rgba(76,106,158,0.22)",
  };
}

function attachmentIcon(att: { mimeType?: string; kind?: string }, size = 14) {
  const color = attachmentTint(att).icon;
  if (att.mimeType === "application/pdf") return <RiFilePdf2Line color={color} size={size} />;
  if (att.kind === "image" || att.mimeType?.startsWith("image/"))
    return <RiImage2Line color={color} size={size} />;
  if (att.kind === "video" || att.mimeType?.startsWith("video/"))
    return <RiVideoLine color={color} size={size} />;
  return <RiFileTextLine color={color} size={size} />;
}

interface ToolImageContextValue {
  /** "" = main chat; a tab id = that tab's AI sidebar store. */
  scope: string;
  assistantId: string;
  chatId: string;
  openImage: (relativePath: string, name: string) => void;
  openAttachment: (attachment: Attachment) => void;
}

const ToolImageContext = createContext<ToolImageContextValue | null>(null);
const EMPTY_TOOL_IMAGE_PATHS: string[] = [];

function toolImageName(relativePath: string): string {
  const page = relativePath.match(/page-(\d+)\.png$/i)?.[1];
  return page ? `PDF 第 ${page} 页` : basename(relativePath);
}

function toolImageAttachment(relativePath: string, name = toolImageName(relativePath)): Attachment {
  return {
    id: `tool-image:${relativePath}`,
    kind: "image",
    mimeType: "image/png",
    name,
    path: relativePath,
  };
}

function loadImageSize(url: string): Promise<{ height: number; width: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({ height: image.naturalHeight || 1, width: image.naturalWidth || 1 });
    image.onerror = () => resolve({ height: 3, width: 4 });
    image.src = url;
  });
}

function toolImageThumbnailSize(width: number, height: number) {
  const ratio = width > 0 && height > 0 ? width / height : 4 / 3;
  const maxWidth = 180;
  const maxHeight = 96;
  if (ratio >= maxWidth / maxHeight) {
    return { height: maxWidth / ratio, width: maxWidth };
  }
  return { height: maxHeight, width: maxHeight * ratio };
}

function attachmentPreviewKind(att: Attachment): AttachmentPreviewKind | null {
  if (att.mimeType === "application/pdf") return "pdf";
  if (att.kind === "image" || att.mimeType.startsWith("image/")) return "image";
  if (att.kind === "video" || att.mimeType.startsWith("video/")) return "video";
  return null;
}

function AttachmentChip({
  att,
  onPreview,
  styles,
}: {
  att: Attachment;
  onPreview?: (attachment: Attachment) => void;
  styles: Styles;
}) {
  const tint = attachmentTint(att);
  const content = (
    <>
      {attachmentIcon(att)}
      <Text numberOfLines={1} style={styles.chipText}>
        {att.name}
      </Text>
    </>
  );
  if (!onPreview) {
    return (
      <View style={[styles.chip, { backgroundColor: tint.fill, borderColor: tint.border }]}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={`预览附件 ${att.name}`}
      accessibilityRole="button"
      onPress={() => onPreview(att)}
      style={({ hovered, pressed }: PressState) => [
        styles.chip,
        { backgroundColor: tint.fill, borderColor: tint.border },
        motion,
        (hovered || pressed) && { backgroundColor: tint.fillHover },
      ]}
    >
      {content}
    </Pressable>
  );
}

/** Attachments occupy the first visual row of a user message. */
function AttachmentBadges({
  attachments,
  onPreview,
  styles,
}: {
  attachments: Attachment[];
  onPreview: (attachment: Attachment) => void;
  styles: Styles;
}) {
  return (
    <View style={styles.attachRow}>
      {attachments.map((att) => (
        <AttachmentChip
          att={att}
          key={att.id}
          onPreview={attachmentPreviewKind(att) ? onPreview : undefined}
          styles={styles}
        />
      ))}
    </View>
  );
}

function ToolCallImages({ imagePaths, styles }: { imagePaths: string[]; styles: Styles }) {
  const context = useContext(ToolImageContext);
  const scope = context?.scope ?? "";
  const assistantId = context?.assistantId;
  const chatId = context?.chatId;
  const openImage = context?.openImage;
  const [previews, setPreviews] = useState<
    Array<{ height: number; name: string; path: string; url: string; width: number }>
  >([]);

  useEffect(() => {
    if (!assistantId || !chatId || imagePaths.length === 0) return;
    let cancelled = false;
    const loadedUrls: string[] = [];
    void Promise.all(
      imagePaths.map(async (path) => {
        const name = toolImageName(path);
        try {
          const source = await loadChatAttachmentPreview(
            assistantId,
            chatId,
            toolImageAttachment(path, name),
            scope,
          );
          if (cancelled) {
            if (source.revokeOnClose) URL.revokeObjectURL(source.url);
            return null;
          }
          const size = await loadImageSize(source.url);
          if (cancelled) {
            if (source.revokeOnClose) URL.revokeObjectURL(source.url);
            return null;
          }
          if (source.revokeOnClose) loadedUrls.push(source.url);
          return { ...size, name, path, url: source.url };
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (!cancelled) {
        setPreviews(
          loaded.filter(
            (
              preview,
            ): preview is {
              height: number;
              name: string;
              path: string;
              url: string;
              width: number;
            } => preview !== null,
          ),
        );
      }
    });
    return () => {
      cancelled = true;
      loadedUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [scope, assistantId, chatId, imagePaths]);

  if (!assistantId || !chatId || !openImage || imagePaths.length === 0) return null;
  if (previews.length === 0) {
    return <Text style={styles.toolImageLoading}>正在加载渲染预览…</Text>;
  }

  return (
    <div
      aria-label="模型查看的渲染图片"
      style={{
        display: "flex",
        gap: 8,
        overflowX: "auto",
        padding: "2px 8px 9px 29px",
        scrollbarWidth: "thin",
      }}
    >
      {previews.map((preview) => (
        <Pressable
          accessibilityLabel={`查看大图：${preview.name}`}
          accessibilityRole="button"
          key={preview.path}
          onPress={() => openImage(preview.path, preview.name)}
          style={({ hovered, pressed }: PressState) => [
            styles.toolImageThumb,
            toolImageThumbnailSize(preview.width, preview.height),
            motion,
            (hovered || pressed) && styles.toolImageThumbHover,
          ]}
        >
          <img
            alt={preview.name}
            draggable={false}
            src={preview.url}
            style={{ height: "100%", objectFit: "contain", width: "100%" }}
          />
          <Text numberOfLines={1} style={styles.toolImageCaption}>
            {preview.name}
          </Text>
        </Pressable>
      ))}
    </div>
  );
}

/** Load an attachment's thumbnail: the image itself for an image, a first-page
 *  render (on demand, no stored file) for a PDF, or null → a generic file icon. */
function loadAttachmentThumbnail(
  assistantId: string,
  chatId: string,
  att: Attachment,
  scope: string,
) {
  if (att.mimeType === "application/pdf") {
    return loadPdfThumbnail(assistantId, chatId, att, scope);
  }
  if (att.kind === "image" || att.mimeType.startsWith("image/")) {
    return loadChatAttachmentPreview(assistantId, chatId, att, scope);
  }
  return null;
}

/** Thumbnail card width; height follows the file's true aspect ratio, clamped so
 *  a normal page reads at its real proportions and a long image (PNG 长图) shows
 *  its top as a preview instead of a squished sliver. */
const ATTACH_THUMB_WIDTH = 150;
const ATTACH_THUMB_MAX_HEIGHT = 220;
const ATTACH_THUMB_MIN_HEIGHT = 76;

interface AttachmentPreview {
  url: string;
  width: number;
  height: number;
}

function AssistantAttachmentCard({
  att,
  preview,
  onOpen,
  onDownload,
  styles,
}: {
  att: Attachment;
  preview?: AttachmentPreview;
  onOpen: () => void;
  onDownload: () => void;
  styles: Styles;
}) {
  const canPreview = Boolean(attachmentPreviewKind(att));
  const ratio =
    preview && preview.width > 0 && preview.height > 0 ? preview.width / preview.height : 3 / 4;
  const thumbHeight = Math.round(
    Math.max(
      ATTACH_THUMB_MIN_HEIGHT,
      Math.min(ATTACH_THUMB_WIDTH / ratio, ATTACH_THUMB_MAX_HEIGHT),
    ),
  );
  return (
    <View style={[styles.assistantAttachCard, { width: ATTACH_THUMB_WIDTH }]}>
      <View
        style={[styles.assistantAttachThumb, { width: ATTACH_THUMB_WIDTH, height: thumbHeight }]}
      >
        <Pressable
          accessibilityLabel={canPreview ? `预览 ${att.name}` : att.name}
          accessibilityRole="button"
          disabled={!canPreview}
          onPress={onOpen}
          style={({ hovered, pressed }: PressState) => [
            styles.assistantAttachHit,
            motion,
            canPreview && (hovered || pressed) && styles.assistantAttachHitHover,
          ]}
        >
          {preview ? (
            <img
              alt={att.name}
              draggable={false}
              src={preview.url}
              // cover + top: exact-ratio cards fill perfectly; over-tall long
              // images crop to their top edge (a document-preview look).
              style={{ height: "100%", objectFit: "cover", objectPosition: "top", width: "100%" }}
            />
          ) : (
            <View style={styles.assistantAttachFallback}>{attachmentIcon(att, 30)}</View>
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={`下载 ${att.name}`}
          accessibilityRole="button"
          onPress={onDownload}
          style={({ hovered, pressed }: PressState) => [
            styles.assistantAttachDownload,
            motion,
            (hovered || pressed) && styles.assistantAttachDownloadHover,
          ]}
        >
          <RiDownload2Line color="#FFFFFF" size={14} />
        </Pressable>
      </View>
      <Text numberOfLines={1} style={styles.assistantAttachName}>
        {att.name}
      </Text>
    </View>
  );
}

/** The files an assistant reply produced (via `create_markdown_document`),
 *  rendered as thumbnails with a bottom-right download button and click-to-preview. */
function AssistantAttachments({
  attachments,
  styles,
}: {
  attachments: Attachment[];
  styles: Styles;
}) {
  const context = useContext(ToolImageContext);
  const scope = context?.scope ?? "";
  const assistantId = context?.assistantId;
  const chatId = context?.chatId;
  const openAttachment = context?.openAttachment;
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview>>({});

  useEffect(() => {
    if (!assistantId || !chatId || attachments.length === 0) return;
    let cancelled = false;
    const loadedUrls: string[] = [];
    void Promise.all(
      attachments.map(async (att) => {
        const loader = loadAttachmentThumbnail(assistantId, chatId, att, scope);
        if (!loader) return null;
        try {
          const loaded = await loader;
          if (cancelled) {
            if (loaded.revokeOnClose) URL.revokeObjectURL(loaded.url);
            return null;
          }
          // Measure natural size so the card follows the file's real aspect ratio.
          const size = await loadImageSize(loaded.url);
          if (cancelled) {
            if (loaded.revokeOnClose) URL.revokeObjectURL(loaded.url);
            return null;
          }
          if (loaded.revokeOnClose) loadedUrls.push(loaded.url);
          return [att.id, { url: loaded.url, width: size.width, height: size.height }] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, AttachmentPreview> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      setPreviews(next);
    });
    return () => {
      cancelled = true;
      loadedUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [scope, assistantId, chatId, attachments]);

  if (!assistantId || !chatId || attachments.length === 0) return null;

  return (
    <View style={styles.assistantAttachRow}>
      {attachments.map((att) => (
        <AssistantAttachmentCard
          att={att}
          key={att.id}
          onDownload={() => void downloadAttachment(assistantId, chatId, att, scope)}
          onOpen={() => openAttachment?.(att)}
          preview={previews[att.id]}
          styles={styles}
        />
      ))}
    </View>
  );
}

function ToolCallCard({
  name,
  args,
  result,
  ok,
  running,
  imagePaths,
  grouped = false,
  last = false,
  styles,
  accent,
  theme,
}: {
  name: string;
  args: string;
  result?: string;
  ok?: boolean;
  running: boolean;
  imagePaths?: string[];
  grouped?: boolean;
  last?: boolean;
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const summary = running ? "运行中…" : (result ?? "");
  return (
    <View
      style={[
        styles.tool,
        grouped && styles.toolGrouped,
        grouped && !last && styles.toolGroupedDivider,
      ]}
    >
      <Pressable
        accessibilityLabel={`${open ? "收起" : "展开"}${name || "工具"}调用详情`}
        accessibilityRole="button"
        onPress={(event) =>
          updatePreservingScrollPosition(event.currentTarget as unknown as EventTarget, () =>
            setOpen((value) => !value),
          )
        }
        style={({ hovered }: PressState) => [
          styles.toolHeader,
          motion,
          hovered && styles.toolHeaderHover,
        ]}
      >
        <RiArrowRightSLine
          color={theme.t.textTertiary}
          size={15}
          style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 0.15s" }}
        />
        <RiToolsFill color={grouped ? theme.t.textTertiary : accent.accentText} size={13} />
        <Text style={styles.toolName}>{name || "工具"}</Text>
        <Text numberOfLines={1} style={styles.toolSummary}>
          {summary}
        </Text>
        {running ? (
          <ToolRunningSpinner color={theme.t.textTertiary} />
        ) : ok === false ? (
          <RiCloseLine color={theme.t.errorText} size={14} />
        ) : result != null ? (
          <RiCheckLine color={theme.t.statusGreenText} size={14} />
        ) : null}
      </Pressable>
      <ToolCallImages imagePaths={imagePaths ?? EMPTY_TOOL_IMAGE_PATHS} styles={styles} />
      {open && (
        <View style={styles.toolBody}>
          <View>
            <Text style={styles.toolSectionLabel}>参数</Text>
            <Text selectable style={styles.code}>
              {prettyArgs(args) || "（无）"}
            </Text>
          </View>
          {result != null && (
            <View>
              <Text style={styles.toolSectionLabel}>结果</Text>
              <Text selectable style={styles.code}>
                {result || "（无）"}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ToolRunningSpinner({ color }: { color: string }) {
  return (
    <div aria-hidden className="nomi-tool-running-spinner">
      <RiLoader4Line color={color} size={14} />
    </div>
  );
}

type DisplayToolCall = Pick<
  DraftToolCall,
  "arguments" | "id" | "images" | "name" | "ok" | "result"
>;

function ToolCallsBlock({
  toolCalls,
  styles,
  accent,
  theme,
}: {
  toolCalls: DisplayToolCall[];
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const [open, setOpen] = useState(true);
  const runningCount = toolCalls.filter((toolCall) => toolCall.result == null).length;
  const failedCount = toolCalls.filter((toolCall) => toolCall.ok === false).length;
  const status = runningCount
    ? `${runningCount} 个运行中`
    : failedCount
      ? `${failedCount} 个失败`
      : "已完成";

  return (
    <View style={styles.toolGroup}>
      <View style={styles.toolGroupHeader}>
        <Pressable
          accessibilityLabel={open ? "收起工具调用" : "展开工具调用"}
          accessibilityRole="button"
          onPress={(event) =>
            updatePreservingScrollPosition(event.currentTarget as unknown as EventTarget, () =>
              setOpen((value) => !value),
            )
          }
          style={({ hovered, pressed }: PressState) => [
            styles.toolGroupToggle,
            motion,
            (hovered || pressed) && styles.reasoningToggleHover,
          ]}
        >
          {open ? (
            <RiArrowDownSLine color={theme.t.textTertiary} size={14} />
          ) : (
            <RiArrowRightSLine color={theme.t.textTertiary} size={14} />
          )}
          <RiToolsFill color={accent.accentText} size={14} />
          <Text style={styles.toolGroupLabel}>工具调用</Text>
          <Text numberOfLines={1} style={styles.toolGroupMeta}>
            {toolCalls.length} 次 · {status}
          </Text>
          {runningCount ? (
            <ToolRunningSpinner color={theme.t.textTertiary} />
          ) : failedCount ? (
            <RiCloseLine color={theme.t.errorText} size={14} />
          ) : (
            <RiCheckLine color={theme.t.statusGreenText} size={14} />
          )}
        </Pressable>
      </View>
      {open ? (
        <div
          aria-label="工具调用列表，可滚动"
          role="region"
          style={{
            backgroundColor: theme.t.cardSurface,
            borderTop: `1px solid ${theme.t.separator}`,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            maxHeight: 240,
            outline: "none",
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: "5px 7px",
            scrollbarGutter: "stable",
          }}
          tabIndex={0}
        >
          {toolCalls.map((toolCall, index) => (
            <ToolCallCard
              accent={accent}
              args={toolCall.arguments}
              grouped
              imagePaths={toolCall.images}
              key={toolCall.id || String(index)}
              last={index === toolCalls.length - 1}
              name={toolCall.name}
              ok={toolCall.ok}
              result={toolCall.result}
              running={toolCall.result == null}
              styles={styles}
              theme={theme}
            />
          ))}
        </div>
      ) : null}
    </View>
  );
}

function reasoningWordCount(text: string): number {
  try {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (
          locale: string,
          options: { granularity: "word" },
        ) => { segment(value: string): Iterable<{ isWordLike?: boolean }> };
      }
    ).Segmenter;
    if (!Segmenter) throw new Error("Intl.Segmenter unavailable");
    const segmenter = new Segmenter("zh-CN", { granularity: "word" });
    return Array.from(segmenter.segment(text)).filter((segment) => segment.isWordLike).length;
  } catch {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function ReasoningBlock({
  onViewStateChange,
  styles,
  text,
  theme,
  viewState,
}: {
  onViewStateChange?: (state: ReasoningViewState) => void;
  styles: Styles;
  text: string;
  theme: Theme;
  viewState?: ReasoningViewState;
}) {
  const [localViewState, setLocalViewState] = useState<ReasoningViewState>(
    DEFAULT_REASONING_VIEW_STATE,
  );
  const { expanded, open } = viewState ?? localViewState;
  const setViewState = onViewStateChange ?? setLocalViewState;
  const counts = useMemo(
    () => ({ characters: Array.from(text.trim()).length, words: reasoningWordCount(text) }),
    [text],
  );

  return (
    <View style={styles.reasoning}>
      <View style={styles.reasoningHeader}>
        <Pressable
          accessibilityLabel={open ? "收起思考过程" : "展开思考过程预览"}
          accessibilityRole="button"
          onPress={() => {
            setViewState({ expanded: open ? false : expanded, open: !open });
          }}
          style={({ hovered, pressed }: PressState) => [
            styles.reasoningToggle,
            motion,
            (hovered || pressed) && styles.reasoningToggleHover,
          ]}
        >
          {open ? (
            <RiArrowDownSLine color={theme.t.textTertiary} size={14} />
          ) : (
            <RiArrowRightSLine color={theme.t.textTertiary} size={14} />
          )}
          <Text style={styles.reasoningLabel}>思考过程</Text>
        </Pressable>
        <View style={styles.reasoningMeta}>
          <Text style={styles.reasoningMetaText}>{counts.words} 词</Text>
          <Text style={styles.reasoningMetaText}>·</Text>
          <Text style={styles.reasoningMetaText}>{counts.characters} 字符</Text>
          <div title={expanded ? "缩小思考框" : "放大思考框"}>
            <Pressable
              accessibilityLabel={expanded ? "缩小思考框" : "放大思考框"}
              accessibilityRole="button"
              onPress={(event) =>
                updatePreservingScrollPosition(event.currentTarget as unknown as EventTarget, () =>
                  setViewState({ expanded: !expanded, open: true }),
                )
              }
              style={({ hovered, pressed }: PressState) => [
                styles.reasoningExpand,
                motion,
                (hovered || pressed) && styles.reasoningToggleHover,
              ]}
            >
              {expanded ? (
                <RiCollapseDiagonalLine color={theme.t.textTertiary} size={13} />
              ) : (
                <RiExpandDiagonalLine color={theme.t.textTertiary} size={13} />
              )}
            </Pressable>
          </div>
        </View>
      </View>
      {open && (
        <div
          aria-label="思考过程内容，可滚动"
          role="region"
          style={{
            borderTop: `1px solid ${theme.t.separator}`,
            maxHeight: expanded ? "min(60vh, 560px)" : 180,
            outline: "none",
            overflowY: "auto",
            overscrollBehavior: "contain",
            scrollbarGutter: "stable",
          }}
          tabIndex={0}
        >
          <View style={styles.reasoningBody}>
            <Text selectable style={styles.reasoningText}>
              {text}
            </Text>
          </View>
        </div>
      )}
    </View>
  );
}

function AnswerAction({
  active,
  icon,
  successIcon,
  successLabel,
  label,
  onPress,
  styles,
  theme,
}: {
  active?: boolean;
  icon: ReactNode;
  /** Shown briefly after `onPress` resolves truthy — e.g. a check mark on copy. */
  successIcon?: ReactNode;
  successLabel?: string;
  label: string;
  onPress: () => void | Promise<boolean>;
  styles: Styles;
  theme: Theme;
}) {
  const [succeeded, setSucceeded] = useState(false);
  const handlePress = () => {
    const result = onPress();
    if (successIcon && result && typeof (result as Promise<boolean>).then === "function") {
      void (result as Promise<boolean>).then((ok) => {
        if (!ok) return;
        setSucceeded(true);
        setTimeout(() => setSucceeded(false), 1500);
      });
    }
  };
  const showSuccess = succeeded && !!successIcon;
  return (
    <div title={showSuccess ? (successLabel ?? label) : label}>
      <Pressable
        accessibilityLabel={showSuccess ? (successLabel ?? label) : label}
        accessibilityRole="button"
        onPress={handlePress}
        style={({ hovered, pressed }: PressState) => [
          styles.answerAction,
          motion,
          active && styles.answerActionActive,
          (hovered || pressed) && styles.answerActionHover,
          pressed && { backgroundColor: theme.t.controlPressed },
        ]}
      >
        {showSuccess ? successIcon : icon}
      </Pressable>
    </div>
  );
}

function providerForMessage(
  message: ChatMessage,
  providers: Provider[],
  fallbackId?: string | null,
) {
  const modelId = message.usage?.modelId ?? message.model ?? "";
  const providerName = message.usage?.providerName?.trim().toLowerCase();
  return (
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.models.some((model) => model.id === modelId) &&
        provider.name.trim().toLowerCase() === providerName,
    ) ??
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.id === fallbackId &&
        provider.models.some((model) => model.id === modelId),
    ) ??
    providers.find(
      (provider) => provider.enabled && provider.models.some((model) => model.id === modelId),
    )
  );
}

function AnswerSurface({
  accent,
  fallbackProviderId,
  hideFeedback = false,
  message,
  onDelete,
  onEdit,
  onFeedback,
  onGenerate,
  onReasoningViewStateChange,
  providerKind,
  providerName,
  providers,
  reasoningViewState,
  styles,
  theme,
}: {
  accent: Accent;
  fallbackProviderId?: string | null;
  hideFeedback?: boolean;
  message: ChatMessage;
  onDelete: (messageId: string) => Promise<void>;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onFeedback: (messageId: string, feedback: "good" | "bad" | null) => Promise<void>;
  onGenerate: (
    sourceMessageId: string,
    providerId: string,
    modelId: string,
    replace: boolean,
  ) => Promise<void>;
  onReasoningViewStateChange: (state: ReasoningViewState) => void;
  providerKind?: string | null;
  providerName?: string | null;
  providers: Provider[];
  reasoningViewState: ReasoningViewState;
  styles: Styles;
  theme: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPlacement, setModelMenuPlacement] = useState<"up" | "down">("down");
  const modelMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const iconColor = theme.t.textTertiary;
  const currentProvider = providerForMessage(message, providers, fallbackProviderId);
  const currentModelId = message.usage?.modelId ?? message.model ?? "";
  const showActions = hovered || editing || modelMenuOpen;
  const availableProviders = providers
    .filter((provider) => provider.enabled && provider.hasKey)
    .map((provider) => ({
      provider,
      models: provider.models.filter(isChatModel),
    }))
    .filter((group) => group.models.length > 0);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        if (!editing) setModelMenuOpen(false);
      }}
      style={{ minWidth: 0, position: "relative" }}
    >
      <View style={styles.answerSurface}>
        {message.reasoning ? (
          <ReasoningBlock
            onViewStateChange={onReasoningViewStateChange}
            styles={styles}
            text={message.reasoning}
            theme={theme}
            viewState={reasoningViewState}
          />
        ) : null}
        {message.toolCalls.length ? (
          <ToolCallsBlock
            accent={accent}
            styles={styles}
            theme={theme}
            toolCalls={message.toolCalls}
          />
        ) : null}
        {editing ? (
          <>
            <TextInput
              accessibilityLabel="编辑回答内容"
              multiline
              onChangeText={setDraft}
              style={styles.answerEditor}
              textAlignVertical="top"
              value={draft}
            />
            <View style={styles.editorActions}>
              <AnswerAction
                icon={<RiCloseLine color={iconColor} size={13} />}
                label="取消编辑"
                onPress={() => {
                  setDraft(message.content);
                  setEditing(false);
                }}
                styles={styles}
                theme={theme}
              />
              <AnswerAction
                icon={<RiCheckLine color={theme.t.statusGreenText} size={13} />}
                label="保存修改"
                onPress={() => {
                  void onEdit(message.id, draft).then(() => setEditing(false));
                }}
                styles={styles}
                theme={theme}
              />
            </View>
          </>
        ) : message.content ? (
          <MarkdownView color={theme.t.textPrimary} content={message.content} />
        ) : null}
        {message.attachments.length > 0 ? (
          <AssistantAttachments attachments={message.attachments} styles={styles} />
        ) : null}

        <View style={styles.answerMetaRow}>
          <View style={[styles.answerActions, { opacity: showActions ? 1 : 0 }]}>
            <AnswerAction
              icon={<RiFileCopyLine color={iconColor} size={13} />}
              successIcon={<RiCheckLine color={theme.t.statusGreenText} size={13} />}
              successLabel="已复制"
              label="复制回答"
              onPress={() => copyText(message.content)}
              styles={styles}
              theme={theme}
            />
            <AnswerAction
              active={editing}
              icon={<RiEditLine color={iconColor} size={13} />}
              label="编辑回答"
              onPress={() => setEditing(true)}
              styles={styles}
              theme={theme}
            />
            <AnswerAction
              icon={<RiRestartLine color={iconColor} size={13} />}
              label="重新生成"
              onPress={() => {
                if (currentProvider && currentModelId) {
                  void onGenerate(message.id, currentProvider.id, currentModelId, true);
                }
              }}
              styles={styles}
              theme={theme}
            />
            <div ref={modelMenuAnchorRef} style={{ position: "relative" }}>
              <AnswerAction
                active={modelMenuOpen}
                icon={<RiAtLine color={iconColor} size={13} />}
                label="切换模型回答"
                onPress={() => {
                  if (modelMenuOpen) {
                    setModelMenuOpen(false);
                    return;
                  }

                  const anchor = modelMenuAnchorRef.current;
                  if (anchor) {
                    const anchorRect = anchor.getBoundingClientRect();
                    const scrollRect = findScrollableParent(anchor)?.getBoundingClientRect();
                    const boundaryTop = Math.max(0, scrollRect?.top ?? 0);
                    const boundaryBottom = Math.min(
                      window.innerHeight,
                      scrollRect?.bottom ?? window.innerHeight,
                    );
                    const roomAbove = anchorRect.top - boundaryTop;
                    const roomBelow = boundaryBottom - anchorRect.bottom;
                    setModelMenuPlacement(roomBelow < 270 && roomAbove > roomBelow ? "up" : "down");
                  }
                  setModelMenuOpen(true);
                }}
                styles={styles}
                theme={theme}
              />
              {modelMenuOpen ? (
                <View
                  style={[
                    styles.modelMenu,
                    modelMenuPlacement === "up" ? styles.modelMenuUp : styles.modelMenuDown,
                  ]}
                >
                  {availableProviders.map(({ provider, models }) => (
                    <View key={provider.id}>
                      <Text style={styles.modelMenuProvider}>{provider.name}</Text>
                      {models.map((model) => (
                        <Pressable
                          accessibilityLabel={`使用 ${provider.name} ${model.name} 回答`}
                          accessibilityRole="button"
                          key={model.id}
                          onPress={() => {
                            setModelMenuOpen(false);
                            void onGenerate(message.id, provider.id, model.id, false);
                          }}
                          style={({ hovered: rowHovered, pressed }: PressState) => [
                            styles.modelMenuRow,
                            motion,
                            (rowHovered || pressed) && styles.modelMenuRowHover,
                          ]}
                        >
                          <BrandIcon
                            accent={accent}
                            fallback={provider.name.slice(0, 1).toUpperCase()}
                            size={24}
                            url={modelIconUrl(model.id, model.name)}
                          />
                          <Text numberOfLines={1} style={styles.modelMenuName}>
                            {model.name || model.id}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </View>
              ) : null}
            </div>
            {!hideFeedback && (
              <>
                <AnswerAction
                  active={message.feedback === "good"}
                  icon={
                    message.feedback === "good" ? (
                      <RiThumbUpFill color={accent.accentText} size={13} />
                    ) : (
                      <RiThumbUpLine color={iconColor} size={13} />
                    )
                  }
                  label="回答有帮助"
                  onPress={() =>
                    void onFeedback(message.id, message.feedback === "good" ? null : "good")
                  }
                  styles={styles}
                  theme={theme}
                />
                <AnswerAction
                  active={message.feedback === "bad"}
                  icon={
                    message.feedback === "bad" ? (
                      <RiThumbDownFill color={accent.accentText} size={13} />
                    ) : (
                      <RiThumbDownLine color={iconColor} size={13} />
                    )
                  }
                  label="回答没有帮助"
                  onPress={() =>
                    void onFeedback(message.id, message.feedback === "bad" ? null : "bad")
                  }
                  styles={styles}
                  theme={theme}
                />
              </>
            )}
            <AnswerAction
              icon={<RiDeleteBinLine color={iconColor} size={13} />}
              label="删除回答"
              onPress={() => void onDelete(message.id)}
              styles={styles}
              theme={theme}
            />
          </View>
          {message.usage ? (
            <UsageFooter
              fallbackModel={message.model}
              fallbackProviderKind={currentProvider?.kind ?? providerKind}
              fallbackProvider={currentProvider?.name ?? providerName}
              styles={styles}
              usage={message.usage}
            />
          ) : null}
        </View>
      </View>
    </div>
  );
}

function SplitAnswerPanel({
  accent,
  fallbackProviderId,
  hideFeedback = false,
  message,
  onFeedback,
  onReasoningViewStateChange,
  providerKind,
  providerName,
  providers,
  reasoningViewState,
  streaming,
  styles,
  theme,
}: {
  accent: Accent;
  fallbackProviderId?: string | null;
  hideFeedback?: boolean;
  message: ChatMessage;
  onFeedback: (messageId: string, feedback: "good" | "bad" | null) => Promise<void>;
  onReasoningViewStateChange: (state: ReasoningViewState) => void;
  providerKind?: string | null;
  providerName?: string | null;
  providers: Provider[];
  reasoningViewState: ReasoningViewState;
  streaming?: StreamingMessage | null;
  styles: Styles;
  theme: Theme;
}) {
  const currentProvider = providerForMessage(message, providers, fallbackProviderId);
  const modelId = streaming?.modelId ?? message.usage?.modelId ?? message.model ?? "";
  const iconColor = theme.t.textTertiary;

  return (
    <>
      <View style={styles.compareBody}>
        {streaming ? (
          <StreamingAnswerSurface
            accent={accent}
            draft={streaming}
            modelId={modelId}
            providerKind={currentProvider?.kind ?? providerKind}
            providerName={currentProvider?.name ?? providerName}
            onReasoningViewStateChange={onReasoningViewStateChange}
            reasoningViewState={reasoningViewState}
            showUsage={false}
            styles={styles}
            theme={theme}
          />
        ) : (
          <>
            {message.reasoning ? (
              <ReasoningBlock
                onViewStateChange={onReasoningViewStateChange}
                styles={styles}
                text={message.reasoning}
                theme={theme}
                viewState={reasoningViewState}
              />
            ) : null}
            {message.toolCalls.length ? (
              <ToolCallsBlock
                accent={accent}
                styles={styles}
                theme={theme}
                toolCalls={message.toolCalls}
              />
            ) : null}
            {message.content ? (
              <MarkdownView color={theme.t.textPrimary} content={message.content} />
            ) : null}
            {message.attachments.length > 0 ? (
              <AssistantAttachments attachments={message.attachments} styles={styles} />
            ) : null}
          </>
        )}
      </View>
      {!streaming ? (
        <View style={styles.compareFooter}>
          <View style={styles.compareFooterActions}>
            <AnswerAction
              icon={<RiFileCopyLine color={iconColor} size={13} />}
              successIcon={<RiCheckLine color={theme.t.statusGreenText} size={13} />}
              successLabel="已复制"
              label="复制回答"
              onPress={() => copyText(message.content)}
              styles={styles}
              theme={theme}
            />
            {!hideFeedback && (
              <>
                <AnswerAction
                  active={message.feedback === "good"}
                  icon={
                    message.feedback === "good" ? (
                      <RiThumbUpFill color={accent.accentText} size={13} />
                    ) : (
                      <RiThumbUpLine color={iconColor} size={13} />
                    )
                  }
                  label="回答有帮助"
                  onPress={() =>
                    void onFeedback(message.id, message.feedback === "good" ? null : "good")
                  }
                  styles={styles}
                  theme={theme}
                />
                <AnswerAction
                  active={message.feedback === "bad"}
                  icon={
                    message.feedback === "bad" ? (
                      <RiThumbDownFill color={accent.accentText} size={13} />
                    ) : (
                      <RiThumbDownLine color={iconColor} size={13} />
                    )
                  }
                  label="回答没有帮助"
                  onPress={() =>
                    void onFeedback(message.id, message.feedback === "bad" ? null : "bad")
                  }
                  styles={styles}
                  theme={theme}
                />
              </>
            )}
          </View>
          {message.usage ? (
            <UsageFooter
              fallbackModel={message.model}
              fallbackProviderKind={currentProvider?.kind ?? providerKind}
              fallbackProvider={currentProvider?.name ?? providerName}
              showModel={false}
              styles={styles}
              usage={message.usage}
            />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

function ResponseGroup({
  accent,
  fallbackProviderId,
  hideFeedback = false,
  messages,
  onDelete,
  onEdit,
  onFeedback,
  onGenerate,
  onSelect,
  providerKind,
  providerName,
  providers,
  streaming,
  styles,
  theme,
}: {
  accent: Accent;
  fallbackProviderId?: string | null;
  hideFeedback?: boolean;
  messages: ChatMessage[];
  onDelete: (messageId: string) => Promise<void>;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onFeedback: (messageId: string, feedback: "good" | "bad" | null) => Promise<void>;
  onGenerate: (
    sourceMessageId: string,
    groupId: string,
    providerId: string,
    modelId: string,
    replace: boolean,
  ) => Promise<void>;
  onSelect: (groupId: string, messageId: string, layout: "tabs" | "split") => Promise<void>;
  providerKind?: string | null;
  providerName?: string | null;
  providers: Provider[];
  streaming?: StreamingMessage | null;
  styles: Styles;
  theme: Theme;
}) {
  const [reasoningViewState, setReasoningViewState] = useState<ReasoningViewState>(
    DEFAULT_REASONING_VIEW_STATE,
  );
  const selected = messages.find((message) => message.selectedForContext !== false) ?? messages[0];
  const groupId = selected.responseGroupId ?? selected.id;
  const layout = selected.responseLayout ?? messages[0]?.responseLayout ?? "tabs";
  const replacingSelected = streaming?.replaceMessageId === selected.id;
  const selectedModel = replacingSelected
    ? (streaming.modelId ?? selected.usage?.modelId ?? selected.model ?? "")
    : (selected.usage?.modelId ?? selected.model ?? "");
  const ordered = [selected, ...messages.filter((message) => message.id !== selected.id)];
  const splitMessages = ordered.slice(0, 2);
  const multi = messages.length > 1;
  const generate = (
    sourceMessageId: string,
    providerId: string,
    modelId: string,
    replace: boolean,
  ) => onGenerate(sourceMessageId, groupId, providerId, modelId, replace);

  return (
    <View style={{ maxWidth: "100%", width: "100%" }}>
      <View style={[styles.row, styles.rowAssistant]}>
        <View style={styles.assistantIcon}>
          <BrandIcon
            accent={accent}
            fallback="A"
            size={28}
            url={modelIconUrl(selectedModel, selectedModel)}
          />
        </View>
        {multi && layout === "split" ? (
          <View style={styles.compareFrame}>
            {splitMessages.map((message, index) => {
              const replacing = streaming?.replaceMessageId === message.id;
              const modelId = replacing
                ? (streaming.modelId ?? message.usage?.modelId ?? message.model ?? "")
                : (message.usage?.modelId ?? message.model ?? "");
              const messageProvider = providerForMessage(message, providers, fallbackProviderId);
              const modelName =
                messageProvider?.models.find((model) => model.id === modelId)?.name || modelId;
              return (
                <View
                  key={message.id}
                  style={[styles.comparePanel, index > 0 && styles.comparePanelBorder]}
                >
                  <View style={styles.compareHeader}>
                    <BrandIcon
                      accent={accent}
                      fallback="M"
                      size={21}
                      url={modelIconUrl(modelId, modelName)}
                    />
                    <Text numberOfLines={1} style={styles.compareModel}>
                      {modelName}
                    </Text>
                  </View>
                  <SplitAnswerPanel
                    accent={accent}
                    fallbackProviderId={fallbackProviderId}
                    hideFeedback={hideFeedback}
                    message={message}
                    onFeedback={onFeedback}
                    onReasoningViewStateChange={setReasoningViewState}
                    providerKind={providerKind}
                    providerName={providerName}
                    providers={providers}
                    reasoningViewState={reasoningViewState}
                    streaming={replacing ? streaming : null}
                    styles={styles}
                    theme={theme}
                  />
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.assistantBubble}>
            {replacingSelected && streaming ? (
              <StreamingAnswerSurface
                accent={accent}
                draft={streaming}
                modelId={selectedModel}
                providerKind={providerKind}
                providerName={providerName}
                onReasoningViewStateChange={setReasoningViewState}
                reasoningViewState={reasoningViewState}
                styles={styles}
                theme={theme}
              />
            ) : (
              <AnswerSurface
                accent={accent}
                fallbackProviderId={fallbackProviderId}
                hideFeedback={hideFeedback}
                message={selected}
                onDelete={onDelete}
                onEdit={onEdit}
                onFeedback={onFeedback}
                onGenerate={generate}
                onReasoningViewStateChange={setReasoningViewState}
                providerKind={providerKind}
                providerName={providerName}
                providers={providers}
                reasoningViewState={reasoningViewState}
                styles={styles}
                theme={theme}
              />
            )}
          </View>
        )}
      </View>
      {multi ? (
        <View style={[styles.variantBar, { marginLeft: 36 }]}>
          <div title={layout === "tabs" ? "并排比较" : "单栏切换"}>
            <Pressable
              accessibilityLabel={layout === "tabs" ? "并排比较回答" : "单栏显示回答"}
              accessibilityRole="button"
              onPress={() =>
                void onSelect(groupId, selected.id, layout === "tabs" ? "split" : "tabs")
              }
              style={({ hovered, pressed }: PressState) => [
                styles.variantButton,
                motion,
                (hovered || pressed) && styles.variantButtonHover,
              ]}
            >
              {layout === "tabs" ? (
                <RiLayoutColumnLine color={theme.t.textTertiary} size={16} />
              ) : (
                <RiLayoutRowLine color={theme.t.textTertiary} size={16} />
              )}
            </Pressable>
          </div>
          {messages.map((message) => {
            const modelId = message.usage?.modelId ?? message.model ?? "";
            const active = message.id === selected.id;
            return (
              <div key={message.id} title={modelId}>
                <Pressable
                  accessibilityLabel={`切换到 ${modelId} 的回答`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => void onSelect(groupId, message.id, layout)}
                  style={({ hovered, pressed }: PressState) => [
                    styles.variantButton,
                    motion,
                    active && styles.variantButtonActive,
                    (hovered || pressed) && styles.variantButtonHover,
                  ]}
                >
                  <BrandIcon
                    accent={accent}
                    fallback="M"
                    size={22}
                    url={modelIconUrl(modelId, modelId)}
                  />
                </Pressable>
              </div>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ContextMarker({
  messageId,
  onDelete,
  styles,
  theme,
}: {
  messageId: string;
  onDelete: (messageId: string) => Promise<void>;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={styles.contextMarkerRow}>
      <View style={styles.contextMarkerLine} />
      <View style={styles.contextMarkerContent}>
        <Text style={styles.contextMarkerText}>已清除上方上下文</Text>
        <div title="删除标记并恢复上方上下文">
          <Pressable
            accessibilityLabel="删除清除上下文标记"
            accessibilityRole="button"
            onPress={() => void onDelete(messageId)}
            style={({ hovered, pressed }: PressState) => [
              styles.contextMarkerDelete,
              motion,
              (hovered || pressed) && { backgroundColor: theme.t.controlHover },
            ]}
          >
            <RiDeleteBinLine color={theme.t.textTertiary} size={12.5} />
          </Pressable>
        </div>
      </View>
      <View style={styles.contextMarkerLine} />
    </View>
  );
}

function MessageBubble({
  message,
  onDelete,
  onEdit,
  onResend,
  onPreviewAttachment,
  providerKind,
  providerName,
  styles,
  accent,
  theme,
}: {
  message: ChatMessage;
  onDelete: (messageId: string) => Promise<void>;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onResend: (message: ChatMessage) => void;
  onPreviewAttachment: (attachment: Attachment) => void;
  providerKind?: string | null;
  providerName?: string | null;
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [userExpanded, setUserExpanded] = useState(false);
  const [userOverflows, setUserOverflows] = useState(false);
  const userTextRef = useRef<HTMLDivElement | null>(null);
  const iconColor = theme.t.textTertiary;
  const showActions = hovered || editing;
  const persisted = !message.id.startsWith("local-");

  useEffect(() => {
    const element = userTextRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setUserOverflows(element.scrollHeight > USER_MESSAGE_COLLAPSED_HEIGHT + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [editing, message.content]);

  if (message.role === "user") {
    return (
      <View style={[styles.row, styles.rowUser]}>
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            alignItems: "stretch",
            display: "flex",
            flexDirection: "column",
            flexShrink: 1,
            maxWidth: "85%",
            minWidth: 0,
            width: "fit-content",
          }}
        >
          <View style={styles.userBubble}>
            {message.attachments.length > 0 && (
              <AttachmentBadges
                attachments={message.attachments}
                onPreview={onPreviewAttachment}
                styles={styles}
              />
            )}
            {editing ? (
              <>
                <TextInput
                  accessibilityLabel="编辑用户消息"
                  multiline
                  onChangeText={setDraft}
                  style={styles.userEditor}
                  textAlignVertical="top"
                  value={draft}
                />
                <View style={styles.editorActions}>
                  <AnswerAction
                    icon={<RiCloseLine color={iconColor} size={13} />}
                    label="取消编辑"
                    onPress={() => {
                      setDraft(message.content);
                      setEditing(false);
                    }}
                    styles={styles}
                    theme={theme}
                  />
                  <AnswerAction
                    icon={<RiCheckLine color={theme.t.statusGreenText} size={13} />}
                    label="保存修改"
                    onPress={() => {
                      void onEdit(message.id, draft).then(() => setEditing(false));
                    }}
                    styles={styles}
                    theme={theme}
                  />
                </View>
              </>
            ) : message.content ? (
              <div style={{ maxWidth: "100%", position: "relative" }}>
                <div
                  className={`nomi-user-message-text${
                    userOverflows && !userExpanded ? " is-collapsed" : ""
                  }`}
                  ref={userTextRef}
                  style={{
                    color: theme.t.textPrimary,
                    maxHeight:
                      userOverflows && !userExpanded ? USER_MESSAGE_COLLAPSED_HEIGHT : undefined,
                  }}
                >
                  {message.content}
                </div>
                {userOverflows && !userExpanded ? (
                  <div
                    aria-hidden
                    style={{
                      background: `linear-gradient(180deg, rgba(255,255,255,0), ${theme.t.mainSolid})`,
                      bottom: 0,
                      height: USER_MESSAGE_LINE_HEIGHT * 2,
                      left: 0,
                      pointerEvents: "none",
                      position: "absolute",
                      right: 0,
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </View>
          <View style={styles.userMetaRow}>
            <View style={styles.userMetaControls}>
              <View style={[styles.answerActions, { opacity: showActions ? 1 : 0 }]}>
                <AnswerAction
                  icon={<RiFileCopyLine color={iconColor} size={13} />}
                  successIcon={<RiCheckLine color={theme.t.statusGreenText} size={13} />}
                  successLabel="已复制"
                  label="复制消息"
                  onPress={() => copyText(message.content)}
                  styles={styles}
                  theme={theme}
                />
                <AnswerAction
                  icon={<RiSendPlane2Line color={iconColor} size={13} />}
                  label="重新发送"
                  onPress={() => onResend(message)}
                  styles={styles}
                  theme={theme}
                />
                {persisted ? (
                  <>
                    <AnswerAction
                      active={editing}
                      icon={<RiEditLine color={iconColor} size={13} />}
                      label="编辑消息"
                      onPress={() => setEditing(true)}
                      styles={styles}
                      theme={theme}
                    />
                    <AnswerAction
                      icon={<RiDeleteBinLine color={iconColor} size={13} />}
                      label="删除消息"
                      onPress={() => void onDelete(message.id)}
                      styles={styles}
                      theme={theme}
                    />
                  </>
                ) : null}
              </View>
              {userOverflows && !editing ? (
                <Pressable
                  accessibilityLabel={userExpanded ? "收起用户消息" : "展开用户消息"}
                  accessibilityRole="button"
                  onPress={(event) =>
                    updatePreservingScrollPosition(event.target, () =>
                      setUserExpanded((expanded) => !expanded),
                    )
                  }
                  style={({ hovered, pressed }: PressState) => [
                    styles.userExpandButton,
                    motion,
                    (hovered || pressed) && styles.userExpandButtonHover,
                  ]}
                >
                  <Text style={styles.userExpandText}>{userExpanded ? "收起" : "展开"}</Text>
                  <RiArrowDownSLine
                    color={theme.t.textSecondary}
                    size={14}
                    style={{ transform: userExpanded ? "rotate(180deg)" : "none" }}
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        </div>
        <UserAvatar size={30} />
      </View>
    );
  }
  const modelId = message.usage?.modelId ?? message.model;
  return (
    <View style={[styles.row, styles.rowAssistant]}>
      <View style={styles.assistantIcon}>
        <BrandIcon
          accent={accent}
          fallback="A"
          size={28}
          url={modelIconUrl(modelId ?? "", modelId ?? "")}
        />
      </View>
      <View style={styles.assistantBubble}>
        {message.reasoning ? (
          <ReasoningBlock text={message.reasoning} styles={styles} theme={theme} />
        ) : null}
        {message.toolCalls.length ? (
          <ToolCallsBlock
            accent={accent}
            styles={styles}
            theme={theme}
            toolCalls={message.toolCalls}
          />
        ) : null}
        {message.content ? (
          <MarkdownView color={theme.t.textPrimary} content={message.content} />
        ) : null}
        {message.attachments.length > 0 ? (
          <AssistantAttachments attachments={message.attachments} styles={styles} />
        ) : null}
        {message.usage ? (
          <UsageFooter
            fallbackModel={message.model}
            fallbackProviderKind={providerKind}
            fallbackProvider={providerName}
            styles={styles}
            usage={message.usage}
          />
        ) : null}
      </View>
    </View>
  );
}

function StreamingAnswerSurface({
  draft,
  modelId,
  onReasoningViewStateChange,
  providerKind,
  providerName,
  reasoningViewState,
  showUsage = true,
  styles,
  accent,
  theme,
}: {
  draft: StreamingMessage;
  modelId?: string | null;
  onReasoningViewStateChange?: (state: ReasoningViewState) => void;
  providerKind?: string | null;
  providerName?: string | null;
  reasoningViewState?: ReasoningViewState;
  showUsage?: boolean;
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const empty = !draft.content && !draft.reasoning && draft.toolCalls.length === 0;
  const visibleToolCalls = draft.toolCalls.filter(Boolean) as DraftToolCall[];
  return (
    <View style={styles.answerSurface}>
      {draft.reasoning ? (
        <ReasoningBlock
          onViewStateChange={onReasoningViewStateChange}
          styles={styles}
          text={draft.reasoning}
          theme={theme}
          viewState={reasoningViewState}
        />
      ) : null}
      {visibleToolCalls.length ? (
        <ToolCallsBlock
          accent={accent}
          styles={styles}
          theme={theme}
          toolCalls={visibleToolCalls}
        />
      ) : null}
      {draft.content ? <MarkdownView color={theme.t.textPrimary} content={draft.content} /> : null}
      {showUsage && draft.usage ? (
        <UsageFooter
          fallbackModel={draft.modelId ?? modelId}
          fallbackProviderKind={providerKind}
          fallbackProvider={providerName}
          styles={styles}
          usage={draft.usage}
        />
      ) : null}
      {empty ? <Text style={styles.emptyText}>正在思考…</Text> : null}
    </View>
  );
}

function StreamingBubble(props: {
  draft: StreamingMessage;
  modelId?: string | null;
  providerKind?: string | null;
  providerName?: string | null;
  styles: Styles;
  accent: Accent;
  theme: Theme;
}) {
  const modelId = props.draft.modelId ?? props.modelId;
  return (
    <View style={[props.styles.row, props.styles.rowAssistant]}>
      <View style={props.styles.assistantIcon}>
        <BrandIcon
          accent={props.accent}
          fallback="A"
          size={28}
          url={modelIconUrl(modelId ?? "", modelId ?? "")}
        />
      </View>
      <View style={props.styles.assistantBubble}>
        <StreamingAnswerSurface {...props} modelId={modelId} />
      </View>
    </View>
  );
}

export function ConversationView({
  accent,
  assistantId,
  assistantName,
  conversation,
  onNewConversation,
  providerKind,
  providerName,
  providers,
  scope = "",
  contextSource,
  hideFeedback = false,
}: {
  accent: Accent;
  assistantId: string;
  assistantName: string;
  conversation: Conversation;
  onNewConversation: () => void;
  providerKind?: string | null;
  providerName?: string | null;
  providers: Provider[];
  /** "" = main chat; a tab id routes this view to that tab's AI sidebar store. */
  scope?: string;
  /** Main conversation shown to the left of an AI sidebar, used as model context. */
  contextSource?: ConversationContextSource | null;
  /** Hide the 👍/👎 feedback buttons (used by the compact AI sidebar). */
  hideFeedback?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const convo = useConversation(assistantId, conversation.id, scope, contextSource);
  const thinkingModelKey = `${conversation.id}/${conversation.providerId ?? ""}/${conversation.modelId ?? ""}`;

  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    kind: AttachmentPreviewKind;
    name: string;
    revokeOnClose: boolean;
    url: string;
    /** The saved attachment behind this preview, so the modal can offer download
     *  (absent for an unsaved pending upload previewed from a data URL). */
    attachment?: Attachment;
  } | null>(null);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [thinkingSelection, setThinkingSelection] = useState<{
    modelKey: string;
    effort: ThinkingEffort;
  }>({ modelKey: "", effort: "off" });
  const [thinkingMenuFor, setThinkingMenuFor] = useState<string | null>(null);
  const composingRef = useRef(false);
  const submitRef = useRef<() => void>(() => undefined);
  const pasteFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollPositionKey = chatScrollKey(scope, assistantId, conversation.id);
  const initialScrollPosition = useMemo(
    () => readChatScrollPosition(scrollPositionKey),
    [scrollPositionKey],
  );
  const savedScrollPositionRef = useRef(initialScrollPosition);
  const scrollRestoredRef = useRef(false);
  const stickToBottomRef = useRef(initialScrollPosition?.atBottom ?? true);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptScrollRef = useRef<HTMLElement | null>(null);
  const selectingTextRef = useRef(false);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);

  const uploading = pending.some((p) => p.status === "uploading");
  const readyAttachments = pending
    .filter((p) => p.status === "ready" && p.attachment)
    .map((p) => p.attachment!);
  const hasModel = Boolean(conversation.providerId && conversation.modelId);
  const selectedProvider = providers.find((provider) => provider.id === conversation.providerId);
  const thinkingEfforts = effortScaleFor(selectedProvider, conversation.modelId);
  const canDisableThinking = thinkingCanBeDisabled(selectedProvider, conversation.modelId);
  const selectedThinkingEffort =
    thinkingSelection.modelKey === thinkingModelKey ? thinkingSelection.effort : "off";
  // GLM-5.3 models reject `thinking: disabled`; show their real default instead
  // of presenting an "off" state the API cannot honour.
  const thinkingEffort =
    !canDisableThinking && selectedThinkingEffort === "off" ? "max" : selectedThinkingEffort;
  const thinkingMenuOpen = thinkingMenuFor === thinkingModelKey;
  const lastContextMarker = convo.messages.reduce(
    (last, message, index) => (message.role === "context_marker" ? index : last),
    -1,
  );
  const canClearContext =
    !convo.sending &&
    convo.messages
      .slice(lastContextMarker + 1)
      .some((message) => message.role === "user" || message.role === "assistant");
  const canSend =
    hasModel &&
    !convo.sending &&
    !uploading &&
    (text.trim().length > 0 || readyAttachments.length > 0);
  const latestMessageId = convo.messages[convo.messages.length - 1]?.id ?? "";
  const streamingActivity = convo.streaming
    ? [
        convo.streaming.id,
        convo.streaming.content.length,
        convo.streaming.reasoning.length,
        convo.streaming.toolCalls.reduce(
          (total, toolCall) =>
            total +
            toolCall.arguments.length +
            (toolCall.result?.length ?? 0) +
            (toolCall.images?.length ?? 0),
          0,
        ),
      ].join(":")
    : "";

  useEffect(() => {
    if (!convo.loaded || scrollRestoredRef.current) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const scroller = transcriptScrollRef.current ?? findScrollableParent(transcriptRef.current);
        transcriptScrollRef.current = scroller;
        const saved = savedScrollPositionRef.current;
        if (scroller) {
          if (saved && !saved.atBottom) {
            scroller.scrollTop = Math.min(
              saved.top,
              Math.max(0, scroller.scrollHeight - scroller.clientHeight),
            );
          } else {
            scroller.scrollTop = scroller.scrollHeight;
          }
        } else if (!saved || saved.atBottom) {
          scrollRef.current?.scrollToEnd({ animated: false });
        }
        stickToBottomRef.current = saved?.atBottom ?? true;
        scrollRestoredRef.current = true;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [convo.loaded, scrollPositionKey]);

  useEffect(() => {
    if (
      !scrollRestoredRef.current ||
      !stickToBottomRef.current ||
      selectingTextRef.current ||
      selectionIsInside(transcriptRef.current)
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [convo.messages.length, latestMessageId, streamingActivity]);

  useEffect(
    () => () => {
      const scroller = transcriptScrollRef.current ?? findScrollableParent(transcriptRef.current);
      if (!scrollRestoredRef.current || !scroller) return;
      rememberChatScrollPosition(scrollPositionKey, {
        atBottom: isNearScrollBottom(scroller),
        top: scroller.scrollTop,
      });
    },
    [scrollPositionKey],
  );

  useEffect(() => {
    const syncStickiness = () => {
      if (selectingTextRef.current) return;
      if (selectionIsInside(transcriptRef.current)) {
        stickToBottomRef.current = false;
        return;
      }
      const scroller = transcriptScrollRef.current;
      if (scroller) stickToBottomRef.current = isNearScrollBottom(scroller);
    };
    const finishSelection = () => {
      if (!selectingTextRef.current) return;
      selectingTextRef.current = false;
      window.requestAnimationFrame(syncStickiness);
    };

    document.addEventListener("pointerup", finishSelection);
    document.addEventListener("pointercancel", finishSelection);
    document.addEventListener("selectionchange", syncStickiness);
    window.addEventListener("blur", finishSelection);
    return () => {
      document.removeEventListener("pointerup", finishSelection);
      document.removeEventListener("pointercancel", finishSelection);
      document.removeEventListener("selectionchange", syncStickiness);
      window.removeEventListener("blur", finishSelection);
    };
  }, []);

  useEffect(
    () => () => {
      if (attachmentPreview?.revokeOnClose) URL.revokeObjectURL(attachmentPreview.url);
    },
    [attachmentPreview],
  );

  async function openAttachmentPreview(attachment: Attachment) {
    const kind = attachmentPreviewKind(attachment);
    if (!kind) return;
    setAttachmentPreviewError(null);
    try {
      const source = await loadChatAttachmentPreview(
        assistantId,
        conversation.id,
        attachment,
        scope,
      );
      setAttachmentPreview({ kind, name: attachment.name, attachment, ...source });
    } catch (error) {
      setAttachmentPreviewError(
        error instanceof Error ? error.message : `无法预览附件：${attachment.name}`,
      );
    }
  }

  async function openToolImagePreview(relativePath: string, name: string) {
    setAttachmentPreviewError(null);
    try {
      const attachment = toolImageAttachment(relativePath, name);
      const source = await loadChatAttachmentPreview(
        assistantId,
        conversation.id,
        attachment,
        scope,
      );
      setAttachmentPreview({ kind: "image", name, attachment, ...source });
    } catch (error) {
      setAttachmentPreviewError(
        error instanceof Error ? error.message : `无法预览渲染图片：${name}`,
      );
    }
  }

  useEffect(() => {
    if (!thinkingMenuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      const menuRoot = thinkingMenuRef.current;
      if (menuRoot && !event.composedPath().includes(menuRoot)) {
        setThinkingMenuFor(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThinkingMenuFor(null);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [thinkingMenuOpen]);

  async function attach() {
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: true,
        filters: [{ name: "文件", extensions: ATTACH_EXTS }],
      });
    } catch {
      return; // dialog unavailable (e.g. browser preview)
    }
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((prev) => [...prev, { key, name: basename(path), status: "uploading" }]);
      try {
        const att = await saveChatAttachment(assistantId, conversation.id, path, undefined, scope);
        setPending((prev) =>
          prev.map((x) =>
            x.key === key ? { ...x, status: "ready", attachment: att, name: att.name } : x,
          ),
        );
      } catch {
        setPending((prev) => prev.map((x) => (x.key === key ? { ...x, status: "error" } : x)));
      }
    }
  }

  async function attachClipboardFiles(files: File[]) {
    for (const [index, file] of files.entries()) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const mimeType = clipboardFileMimeType(file);
      const extension =
        mimeType === "application/pdf"
          ? "pdf"
          : mimeType === "image/jpeg"
            ? "jpg"
            : (mimeType.split("/")[1] ?? "png");
      const name =
        file.name ||
        `clipboard-${mimeType === "application/pdf" ? "document" : "image"}-${index + 1}.${extension}`;
      setPending((prev) => [...prev, { key, name, status: "uploading" }]);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (mimeType.startsWith("image/")) {
          setPending((prev) =>
            prev.map((item) => (item.key === key ? { ...item, previewUrl: dataUrl } : item)),
          );
        }
        const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const attachment = await saveChatAttachmentData(
          assistantId,
          conversation.id,
          dataBase64,
          name,
          mimeType,
          scope,
        );
        setPending((prev) =>
          prev.map((item) =>
            item.key === key
              ? { ...item, attachment, name: attachment.name, status: "ready" }
              : item,
          ),
        );
      } catch {
        setPending((prev) =>
          prev.map((item) => (item.key === key ? { ...item, status: "error" } : item)),
        );
      }
    }
  }

  function submit() {
    if (!canSend) return;
    stickToBottomRef.current = true;
    void convo.send(text, readyAttachments, thinkingEffort === "off" ? null : thinkingEffort);
    setText("");
    setPending([]);
  }

  useEffect(() => {
    submitRef.current = submit;
    pasteFilesRef.current = (files) => void attachClipboardFiles(files);
  });

  useEffect(() => {
    const input = document.getElementById("nomi-chat-composer");
    if (!(input instanceof HTMLTextAreaElement)) return;

    const startComposing = () => {
      composingRef.current = true;
    };
    const stopComposing = () => {
      composingRef.current = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (composingRef.current || event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey || event.metaKey) return;

      event.preventDefault();
      submitRef.current();
    };
    const handlePaste = (event: ClipboardEvent) => {
      const itemFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const listedFiles = Array.from(event.clipboardData?.files ?? []);
      const files = [...itemFiles, ...listedFiles]
        .filter(isSupportedClipboardFile)
        .filter(
          (file, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.name === file.name &&
                candidate.size === file.size &&
                candidate.lastModified === file.lastModified,
            ) === index,
        );
      if (files.length === 0) return;
      event.preventDefault();
      pasteFilesRef.current(files);
    };

    input.addEventListener("compositionstart", startComposing);
    input.addEventListener("compositionend", stopComposing);
    input.addEventListener("keydown", handleKeyDown);
    input.addEventListener("paste", handlePaste);
    return () => {
      input.removeEventListener("compositionstart", startComposing);
      input.removeEventListener("compositionend", stopComposing);
      input.removeEventListener("keydown", handleKeyDown);
      input.removeEventListener("paste", handlePaste);
    };
  }, []);

  return (
    <>
      <ToolImageContext.Provider
        value={{
          scope,
          assistantId,
          chatId: conversation.id,
          openImage: (relativePath, name) => void openToolImagePreview(relativePath, name),
          openAttachment: (attachment) => void openAttachmentPreview(attachment),
        }}
      >
        <View style={styles.root}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              const scroller = findScrollableParent(transcriptRef.current);
              if (scroller) transcriptScrollRef.current = scroller;
              const atBottom =
                contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
              if (scrollRestoredRef.current) {
                rememberChatScrollPosition(scrollPositionKey, {
                  atBottom,
                  top: Math.max(0, contentOffset.y),
                });
              }
              if (selectingTextRef.current || selectionIsInside(transcriptRef.current)) {
                stickToBottomRef.current = false;
                return;
              }
              stickToBottomRef.current = atBottom;
            }}
            ref={scrollRef}
            scrollEventThrottle={32}
            style={[styles.scroll, { scrollbarGutter: "stable" } as unknown as ViewStyle]}
          >
            <div
              className="nomi-chat-transcript"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const target = event.target as HTMLElement;
                if (!target.closest(".nomi-chat-selectable")) return;
                selectingTextRef.current = true;
                stickToBottomRef.current = false;
                transcriptScrollRef.current = findScrollableParent(event.currentTarget);
              }}
              ref={transcriptRef}
              style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}
            >
              {convo.loaded && convo.messages.length === 0 && !convo.streaming ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>开始和「{assistantName}」对话吧。</Text>
                  <Text style={styles.emptyText}>可上传 PDF，模型会用工具读取全文或渲染页面。</Text>
                </View>
              ) : (
                (() => {
                  const seenGroups = new Set<string>();
                  return convo.messages.flatMap((message) => {
                    if (message.role === "context_marker") {
                      return [
                        <ContextMarker
                          key={message.id}
                          messageId={message.id}
                          onDelete={convo.remove}
                          styles={styles}
                          theme={theme}
                        />,
                      ];
                    }
                    if (message.role !== "assistant") {
                      return [
                        <MessageBubble
                          accent={accent}
                          key={message.id}
                          message={message}
                          onDelete={convo.remove}
                          onEdit={convo.edit}
                          onResend={(target) =>
                            void convo.send(
                              target.content,
                              target.attachments,
                              thinkingEffort === "off" ? null : thinkingEffort,
                            )
                          }
                          onPreviewAttachment={(attachment) =>
                            void openAttachmentPreview(attachment)
                          }
                          providerKind={providerKind}
                          providerName={providerName}
                          styles={styles}
                          theme={theme}
                        />,
                      ];
                    }
                    const groupId = message.responseGroupId ?? message.id;
                    if (seenGroups.has(groupId)) return [];
                    seenGroups.add(groupId);
                    const groupMessages = convo.messages.filter(
                      (candidate) =>
                        candidate.role === "assistant" &&
                        (candidate.responseGroupId ?? candidate.id) === groupId,
                    );
                    return [
                      <ResponseGroup
                        accent={accent}
                        fallbackProviderId={conversation.providerId}
                        key={groupId}
                        hideFeedback={hideFeedback}
                        messages={groupMessages}
                        onDelete={convo.remove}
                        onEdit={convo.edit}
                        onFeedback={convo.feedback}
                        onGenerate={(
                          sourceMessageId,
                          responseGroupId,
                          providerId,
                          modelId,
                          replace,
                        ) => {
                          // The composer's effort is on the selected model's scale;
                          // map it onto the model actually answering this variant.
                          const targetProvider = providers.find((p) => p.id === providerId);
                          const mapped = mapEffort(
                            thinkingEffort,
                            effortScaleFor(targetProvider, modelId),
                          );
                          const targetEffort =
                            mapped === "off" && !thinkingCanBeDisabled(targetProvider, modelId)
                              ? "max"
                              : mapped;
                          return convo.generateVariant(
                            sourceMessageId,
                            responseGroupId,
                            providerId,
                            modelId,
                            replace,
                            targetEffort === "off" ? null : targetEffort,
                          );
                        }}
                        onSelect={convo.selectResponse}
                        providerKind={providerKind}
                        providerName={providerName}
                        providers={providers}
                        streaming={
                          convo.streaming?.responseGroupId === groupId ? convo.streaming : null
                        }
                        styles={styles}
                        theme={theme}
                      />,
                    ];
                  });
                })()
              )}
              {convo.streaming && !convo.streaming.replaceMessageId && (
                <StreamingBubble
                  accent={accent}
                  draft={convo.streaming}
                  modelId={conversation.modelId}
                  providerKind={providerKind}
                  providerName={providerName}
                  styles={styles}
                  theme={theme}
                />
              )}
            </div>
          </ScrollView>

          <View style={styles.composer}>
            {pending.length > 0 && (
              <View style={styles.pendingRow}>
                {pending.map((p) =>
                  p.previewUrl ? (
                    <View key={p.key} style={styles.pendingImage}>
                      <Pressable
                        accessibilityLabel={`预览图片 ${p.name}`}
                        accessibilityRole="button"
                        onPress={() =>
                          setAttachmentPreview({
                            kind: "image",
                            name: p.name,
                            revokeOnClose: false,
                            url: p.previewUrl!,
                          })
                        }
                        style={{ flex: 1 }}
                      >
                        <img
                          alt={p.name}
                          src={p.previewUrl}
                          style={{ height: "100%", objectFit: "cover", width: "100%" }}
                        />
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`移除图片 ${p.name}`}
                        accessibilityRole="button"
                        onPress={() =>
                          setPending((prev) => prev.filter((item) => item.key !== p.key))
                        }
                        style={styles.pendingImageRemove}
                      >
                        <RiCloseLine color="#FFFFFF" size={13} />
                      </Pressable>
                      {p.status !== "ready" ? (
                        <Text style={styles.pendingImageStatus}>
                          {p.status === "uploading" ? "处理中…" : "上传失败"}
                        </Text>
                      ) : null}
                    </View>
                  ) : (
                    <View
                      key={p.key}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: attachmentTint(p.attachment ?? {}).fill,
                          borderColor: attachmentTint(p.attachment ?? {}).border,
                        },
                      ]}
                    >
                      <Pressable
                        accessibilityLabel={
                          p.attachment && attachmentPreviewKind(p.attachment)
                            ? `预览附件 ${p.name}`
                            : undefined
                        }
                        accessibilityRole={
                          p.attachment && attachmentPreviewKind(p.attachment) ? "button" : undefined
                        }
                        disabled={!p.attachment || !attachmentPreviewKind(p.attachment)}
                        onPress={() => {
                          if (p.attachment) void openAttachmentPreview(p.attachment);
                        }}
                        style={styles.pendingChipPreview}
                      >
                        {attachmentIcon(p.attachment ?? {})}
                        <Text numberOfLines={1} style={styles.chipText}>
                          {p.name}
                        </Text>
                      </Pressable>
                      <Text style={styles.chipStatus}>
                        {p.status === "uploading" ? "处理中…" : p.status === "error" ? "失败" : ""}
                      </Text>
                      <Pressable
                        onPress={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                      >
                        <RiCloseLine color={theme.t.textTertiary} size={13} />
                      </Pressable>
                    </View>
                  ),
                )}
              </View>
            )}

            <View style={[styles.inputWrap, inputFocused && styles.inputWrapFocused]}>
              <TextInput
                multiline
                nativeID="nomi-chat-composer"
                onBlur={() => setInputFocused(false)}
                onChangeText={setText}
                onFocus={() => setInputFocused(true)}
                placeholder={hasModel ? "输入消息…" : "先在右上角选择模型…"}
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                textAlignVertical="top"
                value={text}
              />
              <View style={styles.controls}>
                <div title="新建对话">
                  <Pressable
                    accessibilityLabel="新建对话"
                    accessibilityRole="button"
                    onPress={onNewConversation}
                    style={({ hovered, pressed }: PressState) => [
                      styles.iconBtn,
                      motion,
                      (hovered || pressed) && styles.iconBtnHover,
                    ]}
                  >
                    <RiEditBoxLine color={theme.t.textSecondary} size={17} />
                  </Pressable>
                </div>

                <div title="上传附件">
                  <Pressable
                    accessibilityLabel="上传附件"
                    accessibilityRole="button"
                    onPress={() => void attach()}
                    style={({ hovered, pressed }: PressState) => [
                      styles.iconBtn,
                      motion,
                      (hovered || pressed) && styles.iconBtnHover,
                    ]}
                  >
                    <RiAttachment2 color={theme.t.textSecondary} size={18} />
                  </Pressable>
                </div>

                <div ref={thinkingMenuRef} style={styles.controlAnchor as CSSProperties}>
                  <div
                    title={
                      thinkingEfforts.length > 0
                        ? `思考模式：${THINKING_LABEL[thinkingEffort]}`
                        : "当前模型不支持思考模式"
                    }
                  >
                    <Pressable
                      accessibilityLabel={`思考模式：${THINKING_LABEL[thinkingEffort]}`}
                      accessibilityRole="button"
                      disabled={thinkingEfforts.length === 0}
                      onPress={() =>
                        setThinkingMenuFor((current) =>
                          current === thinkingModelKey ? null : thinkingModelKey,
                        )
                      }
                      style={({ hovered, pressed }: PressState) => [
                        styles.iconBtn,
                        motion,
                        thinkingEffort !== "off" && styles.iconBtnActive,
                        thinkingEfforts.length === 0 && styles.iconBtnDisabled,
                        (hovered || pressed) && thinkingEfforts.length > 0 && styles.iconBtnHover,
                      ]}
                    >
                      <RiBrainAi3Line
                        color={thinkingEffort === "off" ? theme.t.textSecondary : accent.accentText}
                        size={18}
                      />
                    </Pressable>
                  </div>
                  {thinkingMenuOpen && thinkingEfforts.length > 0 ? (
                    <View style={styles.thinkingMenu}>
                      <Text style={styles.thinkingMenuTitle}>思考强度</Text>
                      {(
                        [
                          ...(canDisableThinking ? (["off"] as ThinkingEffort[]) : []),
                          ...thinkingEfforts,
                        ] as ThinkingEffort[]
                      ).map((effort) => {
                        const active = effort === thinkingEffort;
                        return (
                          <Pressable
                            accessibilityLabel={`思考强度：${THINKING_LABEL[effort]}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            key={effort}
                            onPress={() => {
                              setThinkingSelection({ modelKey: thinkingModelKey, effort });
                              setThinkingMenuFor(null);
                            }}
                            style={({ hovered, pressed }: PressState) => [
                              styles.thinkingOption,
                              motion,
                              active && styles.thinkingOptionActive,
                              (hovered || pressed) && styles.thinkingOptionHover,
                            ]}
                          >
                            <Text
                              style={[
                                styles.thinkingOptionText,
                                active && styles.thinkingOptionTextActive,
                              ]}
                            >
                              {THINKING_LABEL[effort]}
                            </Text>
                            {active ? <RiCheckLine color={accent.accentText} size={13} /> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </div>

                <div title="清除上方上下文">
                  <Pressable
                    accessibilityLabel="清除上方上下文"
                    accessibilityRole="button"
                    disabled={!canClearContext}
                    onPress={() => void convo.clearContext()}
                    style={({ hovered, pressed }: PressState) => [
                      styles.iconBtn,
                      motion,
                      !canClearContext && styles.iconBtnDisabled,
                      (hovered || pressed) && canClearContext && styles.iconBtnHover,
                    ]}
                  >
                    <RiEraserLine color={theme.t.textSecondary} size={18} />
                  </Pressable>
                </div>

                <View style={styles.controlsSpacer} />

                {convo.sending ? (
                  <Pressable
                    onPress={() => convo.stop()}
                    style={({ pressed }: PressState) => [
                      styles.stopBtn,
                      motion,
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    <RiStopFill color={theme.t.textSecondary} size={14} />
                  </Pressable>
                ) : (
                  <Pressable
                    disabled={!canSend}
                    onPress={submit}
                    style={({ pressed }: PressState) => [
                      styles.sendBtn,
                      motion,
                      !canSend && styles.sendBtnDisabled,
                      pressed && canSend && { opacity: 0.9 },
                    ]}
                  >
                    <RiSendPlane2Fill color={theme.t.onAccent} size={15} />
                  </Pressable>
                )}
              </View>
            </View>
            {convo.error ? <Text style={styles.error}>{convo.error}</Text> : null}
            {attachmentPreviewError ? (
              <Text style={styles.error}>{attachmentPreviewError}</Text>
            ) : null}
            {!hasModel ? (
              <Text style={styles.hint}>请选择一个已启用服务商的模型后再发送。</Text>
            ) : null}
          </View>
        </View>
      </ToolImageContext.Provider>
      {attachmentPreview ? (
        <AttachmentPreviewModal
          kind={attachmentPreview.kind}
          name={attachmentPreview.name}
          onClose={() => setAttachmentPreview(null)}
          onDownload={
            attachmentPreview.attachment
              ? () =>
                  void downloadAttachment(
                    assistantId,
                    conversation.id,
                    attachmentPreview.attachment!,
                    scope,
                  )
              : undefined
          }
          url={attachmentPreview.url}
        />
      ) : null}
    </>
  );
}

type Styles = ReturnType<typeof makeStyles>;
