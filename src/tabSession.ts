import type { PapersView } from "./papers";
import type { SectionId } from "./theme";
import type { TodoLayout, TodoScope } from "./todo/views";

export type SettingsTab = "storage" | "chat" | "providers" | "mcp";

// Each titlebar tab carries its own navigation state, even when several tabs
// show the same section. Keep this shape shared by persistence and tear-off.
export type Tab = {
  id: number;
  section: SectionId;
  assistantId: string | null;
  conversationId: string | null;
  conversationAssistantId: string | null;
  noteId: string | null;
  paperId: string | null;
  papersView: PapersView;
  travelNoteId: string | null;
  historyEventId: string | null;
  // Kept for compatibility with detached tabs created by an earlier build.
  historyLayerId: string | null;
  todoScope: TodoScope;
  todoLayout: TodoLayout;
  settingsTab: SettingsTab;
};

export type TabSession = { tabs: Tab[]; activeId: number };

const SESSION_VERSION = 1;
const sessionKey = (label: string) => `nomi.tabSession.${label}`;

export function makeTab(id: number, section: SectionId): Tab {
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
    historyEventId: null,
    historyLayerId: null,
    todoScope: "week",
    todoLayout: "board",
    settingsTab: "storage",
  };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], fallback: T): T {
  return values.find((value) => value === raw) ?? fallback;
}

const stringOrNull = (raw: unknown): string | null => (typeof raw === "string" ? raw : null);

/** Stored data and detached payloads may come from an older build or be corrupt.
 *  Accept known fields only, filling missing navigation state with defaults. */
function parseTab(raw: unknown, id: number): Tab | null {
  if (!isRecord(raw)) return null;
  const section = oneOf<SectionId | "">(
    raw.section,
    ["chat", "notes", "papers", "todo", "travel", "history", "finance", "settings"],
    "",
  );
  if (!section) return null;
  return {
    id,
    section,
    assistantId: stringOrNull(raw.assistantId),
    conversationId: stringOrNull(raw.conversationId),
    conversationAssistantId: stringOrNull(raw.conversationAssistantId),
    noteId: stringOrNull(raw.noteId),
    paperId: stringOrNull(raw.paperId),
    papersView: oneOf<PapersView>(raw.papersView, ["graph", "detail"], "graph"),
    travelNoteId: stringOrNull(raw.travelNoteId),
    historyEventId: stringOrNull(raw.historyEventId),
    historyLayerId: stringOrNull(raw.historyLayerId),
    todoScope: oneOf<TodoScope>(
      raw.todoScope,
      ["today", "week", "all", "done", "q1", "q2", "q3", "q4"],
      "week",
    ),
    todoLayout: oneOf<TodoLayout>(raw.todoLayout, ["board", "list", "calendar"], "board"),
    settingsTab: oneOf<SettingsTab>(
      raw.settingsTab,
      ["storage", "chat", "providers", "mcp"],
      "storage",
    ),
  };
}

/** Read once before mounting the views. A new tear-off payload takes precedence
 *  over this window's saved session; a reload restores its own tabs. */
export function readTabSession(label: string, detachedTab?: unknown): TabSession {
  const initial = parseTab(detachedTab, 1) ?? makeTab(1, "chat");
  const fallback = { tabs: [initial], activeId: initial.id };
  if (detachedTab != null) return fallback;

  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(sessionKey(label)) ?? "null");
    if (!isRecord(raw) || raw.version !== SESSION_VERSION || !Array.isArray(raw.tabs)) {
      return fallback;
    }
    const tabs: Tab[] = [];
    const ids = new Set<number>();
    for (const candidate of raw.tabs) {
      if (!isRecord(candidate)) continue;
      const id = candidate.id;
      if (
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        id >= Number.MAX_SAFE_INTEGER ||
        ids.has(id)
      ) {
        continue;
      }
      const tab = parseTab(candidate, id);
      if (!tab) continue;
      ids.add(id);
      tabs.push(tab);
    }
    if (tabs.length === 0) return fallback;
    const activeId = tabs.find((tab) => tab.id === raw.activeId)?.id ?? tabs[0].id;
    return { tabs, activeId };
  } catch {
    // A missing/corrupt session or unavailable storage must not block startup.
    return fallback;
  }
}

/** Persist on navigation changes, while the webview is still alive. Window
 *  labels keep detached windows from overwriting the main window's session. */
export function saveTabSession(label: string, session: TabSession): void {
  try {
    window.localStorage.setItem(
      sessionKey(label),
      JSON.stringify({ version: SESSION_VERSION, ...session }),
    );
  } catch {
    // Keep tab navigation usable if local storage is unavailable or full.
  }
}
