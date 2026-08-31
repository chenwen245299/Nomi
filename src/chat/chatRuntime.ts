// A module-level store for chat generation, living OUTSIDE React so a running
// generation survives the conversation view unmounting — when the user switches
// to another conversation, opens a new one, or switches app tabs, the reply keeps
// streaming here and the transcript stays live when they come back.
//
// The backend `send_message` future already runs independently of the UI (and
// persists the reply when done); this store keeps the *frontend* attached to that
// stream regardless of which component, if any, is currently mounted.

import {
  addContextMarker,
  deleteChatMessage,
  editChatMessage,
  generateMessageVariant,
  listMessages,
  sendMessage,
  setChatMessageFeedback,
  setResponseGroupState,
  stopMessage,
  submitRenderResult,
  type Attachment,
  type ChatMessage,
  type MessageUsage,
  type StreamEvent,
} from "./api";

/** A tool call as it streams in, before the turn is persisted. */
export interface DraftToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
  result?: string;
  ok?: boolean;
  images?: string[];
}

/** The assistant reply currently being streamed. */
export interface StreamingMessage {
  id: string;
  content: string;
  reasoning: string;
  toolCalls: DraftToolCall[];
  usage?: MessageUsage;
  responseGroupId?: string;
  modelId?: string;
  replaceMessageId?: string;
}

/** Everything a conversation view needs, per conversation key. */
export interface ConversationSlice {
  messages: ChatMessage[];
  streaming: StreamingMessage | null;
  sending: boolean;
  error: string | null;
  loaded: boolean;
  requestId: string | null;
}

const EMPTY_SLICE: ConversationSlice = {
  messages: [],
  streaming: null,
  sending: false,
  error: null,
  loaded: false,
  requestId: null,
};

const slices = new Map<string, ConversationSlice>();
const listeners = new Set<() => void>();
export interface ConversationActivityEvent {
  /** Conversation store: "" = main chat; a tab id = that tab's AI sidebar. */
  scope: string;
  assistantId: string;
  chatId: string;
  /** Present for an optimistic newly-sent message; omitted when disk should be reloaded. */
  lastMessageAt?: number;
}
const conversationActivityListeners = new Set<(event: ConversationActivityEvent) => void>();

function key(scope: string, assistantId: string, chatId: string): string {
  // `/` can't appear in any of the three (scope is "" or a fixed tab id; folder
  // names sanitise `/` out), so this is an unambiguous composite key. The scope
  // prefix keeps each tab's AI sidebar slices separate from the main chat's.
  return `${scope}/${assistantId}/${chatId}`;
}

function emit() {
  for (const cb of listeners) cb();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Notify the conversation collection that persisted message activity changed its ordering. */
export function subscribeConversationActivity(
  cb: (event: ConversationActivityEvent) => void,
): () => void {
  conversationActivityListeners.add(cb);
  return () => {
    conversationActivityListeners.delete(cb);
  };
}

function emitConversationActivity(event: ConversationActivityEvent) {
  for (const cb of conversationActivityListeners) cb(event);
}

/** Stable snapshot for `useSyncExternalStore` — same ref until the slice changes. */
export function getSlice(scope: string, assistantId: string, chatId: string): ConversationSlice {
  return slices.get(key(scope, assistantId, chatId)) ?? EMPTY_SLICE;
}

function update(k: string, fn: (slice: ConversationSlice) => ConversationSlice) {
  const current = slices.get(k) ?? { ...EMPTY_SLICE };
  slices.set(k, fn(current));
  emit();
}

function foldStreaming(k: string, fn: (draft: StreamingMessage) => StreamingMessage) {
  update(k, (slice) => (slice.streaming ? { ...slice, streaming: fn(slice.streaming) } : slice));
}

function handleStreamEvent(k: string, event: StreamEvent) {
  switch (event.type) {
    case "text":
      foldStreaming(k, (draft) => ({ ...draft, content: draft.content + event.delta }));
      break;
    case "reasoning":
      foldStreaming(k, (draft) => ({ ...draft, reasoning: draft.reasoning + event.delta }));
      break;
    case "toolCallStart":
      foldStreaming(k, (draft) => {
        const toolCalls = [...draft.toolCalls];
        toolCalls[event.index] = {
          id: event.id,
          index: event.index,
          name: event.name,
          arguments: "",
        };
        return { ...draft, toolCalls };
      });
      break;
    case "toolCallArgs":
      foldStreaming(k, (draft) => {
        const toolCalls = [...draft.toolCalls];
        const slot = toolCalls[event.index];
        if (slot) toolCalls[event.index] = { ...slot, arguments: slot.arguments + event.delta };
        return { ...draft, toolCalls };
      });
      break;
    case "toolResult":
      foldStreaming(k, (draft) => ({
        ...draft,
        toolCalls: draft.toolCalls.map((tool) =>
          tool.id === event.id
            ? { ...tool, result: event.summary, ok: event.ok, images: event.images ?? [] }
            : tool,
        ),
      }));
      break;
    case "usage":
      foldStreaming(k, (draft) => ({
        ...draft,
        usage: {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          cacheHitTokens: event.cacheHitTokens ?? null,
          cacheMissTokens: event.cacheMissTokens ?? null,
          providerName: event.providerName,
          modelId: event.modelId,
          durationMs: event.durationMs,
          costCny: event.costCny ?? null,
          costUsd: event.costUsd ?? null,
          pricingPeriod: event.pricingPeriod ?? null,
        },
      }));
      break;
    case "renderRequest":
      // The backend's create_markdown_document tool is blocked awaiting these
      // bytes. Render off-screen (works even with no view mounted) and always
      // reply so the tool never hangs.
      void handleRenderRequest(event);
      break;
    case "error":
      update(k, (slice) => ({ ...slice, error: event.message }));
      break;
    case "done":
      break;
  }
}

async function handleRenderRequest(
  event: Extract<StreamEvent, { type: "renderRequest" }>,
): Promise<void> {
  // Track the current stage so a hang is reported as e.g. "卡在：html2canvas 截图"
  // right in the tool card — no devtools needed — and can never silently wait out
  // the backend timeout (even a stuck dynamic import is covered by the guard).
  let stage = "加载渲染模块";
  const render = (async (): Promise<{
    pdfBase64?: string;
    pngBase64?: string;
    error?: string;
  }> => {
    const { renderMarkdownToFiles } = await import("./markdownRender");
    return renderMarkdownToFiles(
      event.markdown,
      event.formats,
      event.pageSize,
      event.title,
      (s) => {
        stage = s;
      },
    );
  })();
  const guard = new Promise<{ error: string }>((resolve) =>
    setTimeout(() => resolve({ error: `文档渲染整体超时（卡在：${stage}）` }), 40_000),
  );
  try {
    const files = await Promise.race([render, guard]);
    await submitRenderResult({
      renderId: event.renderId,
      ok: !files.error,
      pdfBase64: "pdfBase64" in files ? files.pdfBase64 : undefined,
      pngBase64: "pngBase64" in files ? files.pngBase64 : undefined,
      error: files.error,
    });
  } catch (error) {
    console.error("[md-export] failed", error);
    await submitRenderResult({
      renderId: event.renderId,
      ok: false,
      error: `${stage}失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Load the persisted transcript for a conversation. A no-op while a generation
 * for that conversation is in flight — the live slice already holds the
 * optimistic user message plus the streaming draft, and must not be clobbered.
 */
export async function ensureLoaded(
  scope: string,
  assistantId: string,
  chatId: string,
): Promise<void> {
  const k = key(scope, assistantId, chatId);
  if (slices.get(k)?.sending) return;
  try {
    const messages = await listMessages(assistantId, chatId, scope);
    update(k, (s) => ({ ...s, messages, streaming: null, loaded: true }));
  } catch (err) {
    update(k, (s) => ({ ...s, loaded: true, error: String(err) }));
  }
}

/**
 * Start (or ignore, if already running) a generation for a conversation. Returns
 * once the backend turn finishes; callers usually fire-and-forget.
 */
export async function send(
  scope: string,
  assistantId: string,
  chatId: string,
  text: string,
  attachments: Attachment[],
  reasoningEffort?: string | null,
): Promise<void> {
  const k = key(scope, assistantId, chatId);
  if (slices.get(k)?.sending) return;
  if (!text.trim() && attachments.length === 0) return;

  const requestId = newRequestId();
  const userMsg: ChatMessage = {
    id: `local-${Date.now()}`,
    role: "user",
    content: text,
    attachments,
    toolCalls: [],
    createdAt: Math.floor(Date.now() / 1000),
  };
  const draft: StreamingMessage = {
    id: `draft-${requestId}`,
    content: "",
    reasoning: "",
    toolCalls: [],
  };

  update(k, (s) => ({
    ...s,
    messages: [...s.messages, userMsg],
    streaming: draft,
    sending: true,
    error: null,
    loaded: true,
    requestId,
  }));
  emitConversationActivity({ scope, assistantId, chatId, lastMessageAt: userMsg.createdAt });

  try {
    await sendMessage(
      { scope, assistantId, chatId, requestId, text, attachments, reasoningEffort },
      (event) => handleStreamEvent(k, event),
    );
  } catch (err) {
    update(k, (s) => ({ ...s, error: String(err) }));
  } finally {
    // Reload the canonical, persisted transcript (correct ids, tool records) and
    // drop the streaming draft — for whichever view is (or later becomes) mounted.
    let reloaded: ChatMessage[] | null = null;
    try {
      reloaded = await listMessages(assistantId, chatId, scope);
    } catch {
      reloaded = null;
    }
    update(k, (s) => ({
      ...s,
      messages: reloaded ?? s.messages,
      streaming: null,
      sending: false,
      requestId: null,
    }));
    emitConversationActivity({ scope, assistantId, chatId });
  }
}

export async function clearContext(
  scope: string,
  assistantId: string,
  chatId: string,
): Promise<void> {
  const messages = await addContextMarker(assistantId, chatId, scope);
  update(key(scope, assistantId, chatId), (slice) => ({ ...slice, messages }));
}

export async function edit(
  scope: string,
  assistantId: string,
  chatId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const messages = await editChatMessage(assistantId, chatId, messageId, content, scope);
  update(key(scope, assistantId, chatId), (slice) => ({ ...slice, messages }));
}

export async function feedback(
  scope: string,
  assistantId: string,
  chatId: string,
  messageId: string,
  value: "good" | "bad" | null,
): Promise<void> {
  const messages = await setChatMessageFeedback(assistantId, chatId, messageId, value, scope);
  update(key(scope, assistantId, chatId), (slice) => ({ ...slice, messages }));
}

export async function selectResponse(
  scope: string,
  assistantId: string,
  chatId: string,
  groupId: string,
  messageId: string,
  layout: "tabs" | "split",
): Promise<void> {
  const messages = await setResponseGroupState(
    assistantId,
    chatId,
    groupId,
    messageId,
    layout,
    scope,
  );
  update(key(scope, assistantId, chatId), (slice) => ({ ...slice, messages }));
}

export async function remove(
  scope: string,
  assistantId: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  const messages = await deleteChatMessage(assistantId, chatId, messageId, scope);
  update(key(scope, assistantId, chatId), (slice) => ({ ...slice, messages }));
  emitConversationActivity({ scope, assistantId, chatId });
}

export async function generateVariant(
  scope: string,
  assistantId: string,
  chatId: string,
  sourceMessageId: string,
  groupId: string,
  providerId: string,
  modelId: string,
  replace: boolean,
  reasoningEffort?: string | null,
): Promise<void> {
  const k = key(scope, assistantId, chatId);
  if (slices.get(k)?.sending) return;
  const requestId = newRequestId();
  update(k, (slice) => ({
    ...slice,
    streaming: {
      id: `draft-${requestId}`,
      content: "",
      reasoning: "",
      toolCalls: [],
      responseGroupId: groupId,
      modelId,
      replaceMessageId: replace ? sourceMessageId : undefined,
    },
    sending: true,
    error: null,
    requestId,
  }));
  try {
    await generateMessageVariant(
      {
        scope,
        assistantId,
        chatId,
        requestId,
        sourceMessageId,
        providerId,
        modelId,
        replace,
        reasoningEffort,
      },
      (event) => handleStreamEvent(k, event),
    );
  } catch (error) {
    update(k, (slice) => ({ ...slice, error: String(error) }));
  } finally {
    let messages: ChatMessage[] | null = null;
    try {
      messages = await listMessages(assistantId, chatId, scope);
    } catch {
      messages = null;
    }
    update(k, (slice) => ({
      ...slice,
      messages: messages ?? slice.messages,
      streaming: null,
      sending: false,
      requestId: null,
    }));
    emitConversationActivity({ scope, assistantId, chatId });
  }
}

/** Ask the backend to stop a conversation's in-flight generation. */
export function stop(scope: string, assistantId: string, chatId: string): void {
  const slice = slices.get(key(scope, assistantId, chatId));
  if (slice?.requestId) {
    void stopMessage(slice.requestId);
  }
}

/** Whether a conversation currently has a generation in flight. */
export function isSending(scope: string, assistantId: string, chatId: string): boolean {
  return slices.get(key(scope, assistantId, chatId))?.sending ?? false;
}
