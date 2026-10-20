import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { makeTab, readTabSession, saveTabSession } from "../src/tabSession.ts";

const stored = new Map();

beforeEach(() => {
  stored.clear();
  globalThis.window = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
  };
});

test("first launch opens one default chat tab", () => {
  assert.deepEqual(readTabSession("main"), { tabs: [makeTab(1, "chat")], activeId: 1 });
});

test("restart restores order, duplicate sections, active selection and navigation", () => {
  const session = {
    tabs: [
      { ...makeTab(8, "notes"), noteId: "研究/想法.md" },
      {
        ...makeTab(3, "chat"),
        assistantId: "assistant-1",
        conversationAssistantId: "assistant-1",
        conversationId: "conversation-1",
      },
      { ...makeTab(12, "notes"), noteId: "工作/计划.md" },
      { ...makeTab(5, "papers"), paperId: "paper-1", papersView: "detail" },
      { ...makeTab(6, "todo"), todoScope: "q3", todoLayout: "list" },
      { ...makeTab(7, "travel"), travelNoteId: "travel-1" },
      { ...makeTab(9, "history"), historyEventId: "event-1", historyLayerId: "layer-1" },
      makeTab(10, "finance"),
      { ...makeTab(11, "settings"), settingsTab: "mcp" },
    ],
    activeId: 12,
  };
  saveTabSession("main", session);
  assert.deepEqual(readTabSession("main"), session);

  // Closing and switching must replace the snapshot instead of reviving old tabs.
  const updated = { tabs: session.tabs.filter((tab) => tab.id !== 12), activeId: 3 };
  saveTabSession("main", updated);
  assert.deepEqual(readTabSession("main"), updated);
});

test("detached windows have separate sessions and a new payload takes precedence", () => {
  const main = { tabs: [makeTab(4, "settings")], activeId: 4 };
  const detached = { tabs: [makeTab(2, "todo"), makeTab(7, "travel")], activeId: 7 };
  saveTabSession("main", main);
  saveTabSession("tab-test", detached);
  assert.deepEqual(readTabSession("main"), main);
  assert.deepEqual(readTabSession("tab-test", null), detached);
  const payload = { ...makeTab(99, "notes"), noteId: "拖出的笔记.md" };
  assert.deepEqual(readTabSession("tab-test", payload), {
    tabs: [{ ...payload, id: 1 }],
    activeId: 1,
  });
  assert.deepEqual(readTabSession("main"), main);
});

test("calendar layout survives restart and detaching a todo tab", () => {
  const tab = { ...makeTab(3, "todo"), todoScope: "q2", todoLayout: "calendar" };
  saveTabSession("main", { tabs: [tab], activeId: tab.id });
  assert.equal(readTabSession("main").tabs[0].todoLayout, "calendar");
  assert.equal(readTabSession("detached-calendar", tab).tabs[0].todoLayout, "calendar");
});

test("corrupt, empty and unsupported sessions fall back to a usable tab", () => {
  for (const raw of [
    "{broken",
    "null",
    "[]",
    '{"version":1,"tabs":[]}',
    '{"version":1,"tabs":{}}',
    '{"version":2,"tabs":[{"id":1,"section":"notes"}]}',
  ]) {
    stored.set("nomi.tabSession.main", raw);
    assert.deepEqual(readTabSession("main"), { tabs: [makeTab(1, "chat")], activeId: 1 });
  }
});

test("invalid tabs and duplicate ids do not break restored navigation", () => {
  stored.set(
    "nomi.tabSession.main",
    JSON.stringify({
      version: 1,
      tabs: [
        null,
        { id: 0, section: "notes" },
        { id: -1, section: "notes" },
        { id: 1.5, section: "notes" },
        { id: "2", section: "notes" },
        { id: Number.MAX_SAFE_INTEGER, section: "notes" },
        { id: 2, section: "removed-section" },
        { id: 4, section: "notes", noteId: "保留.md" },
        { id: 4, section: "chat" },
        { id: 8, section: "todo" },
      ],
      activeId: 2,
    }),
  );
  assert.deepEqual(readTabSession("main"), {
    tabs: [{ ...makeTab(4, "notes"), noteId: "保留.md" }, makeTab(8, "todo")],
    activeId: 4,
  });
});

test("partial tabs and invalid navigation fields receive safe defaults", () => {
  stored.set(
    "nomi.tabSession.main",
    JSON.stringify({
      version: 1,
      tabs: [
        {
          id: 6,
          section: "todo",
          noteId: 42,
          conversationId: {},
          todoScope: "invalid",
          todoLayout: "invalid",
          papersView: "invalid",
          settingsTab: "invalid",
        },
      ],
      activeId: 6,
    }),
  );
  assert.deepEqual(readTabSession("main"), { tabs: [makeTab(6, "todo")], activeId: 6 });
  assert.deepEqual(readTabSession("tab-test", { section: "missing" }), {
    tabs: [makeTab(1, "chat")],
    activeId: 1,
  });
});

test("unavailable storage does not prevent startup or navigation", () => {
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new Error("Storage unavailable");
    },
  });
  assert.deepEqual(readTabSession("main"), { tabs: [makeTab(1, "chat")], activeId: 1 });
  assert.doesNotThrow(() => saveTabSession("main", { tabs: [makeTab(1, "notes")], activeId: 1 }));
});
