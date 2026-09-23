import { Channel, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { findDefaultModel, listProviders } from "../providers/api";
import { randomAssistantEmoji } from "./emoji";

export interface Assistant {
  id: string;
  name: string;
  systemPrompt: string;
  emoji: string;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  /** Whether this assistant offers tools to the model at all. */
  toolsEnabled?: boolean;
  /** Allow-list of tool ids; `null`/absent = all available tools. */
  toolIds?: string[] | null;
  createdAt: number;
  updatedAt: number;
}

/** The tools the chat model can be given. Kept in sync with `tool_schemas` in
 *  src-tauri/src/chat_agent.rs. `requires` notes what a tool needs to actually
 *  run (shown as a hint); the model still only sees enabled tools. */
export const CHAT_TOOLS: { id: string; name: string; description: string; requires?: string }[] = [
  {
    id: "web_search",
    name: "联网搜索",
    description: "用 Exa 搜索互联网获取最新信息",
    requires: "需在设置中配置 Exa Key",
  },
  {
    id: "web_fetch",
    name: "获取网页与文件",
    description: "读取已知网址并保存到当前对话的附件目录",
  },
  {
    id: "create_markdown_document",
    name: "生成文档",
    description: "把 Markdown 导出为 PDF / PNG 文件",
  },
  {
    id: "get_pdf_fulltext",
    name: "读取 PDF 文本",
    description: "提取对话中 PDF 附件的全文",
    requires: "对话中需有 PDF 附件",
  },
  {
    id: "render_pdf_pages",
    name: "渲染 PDF 页面",
    description: "把 PDF 页面渲染成图片以查看图表",
    requires: "对话中需有 PDF 附件",
  },
];

/** All tool ids, in catalog order — the default for a new assistant. */
export const ALL_TOOL_IDS = CHAT_TOOLS.map((tool) => tool.id);

export interface Conversation {
  id: string;
  title: string;
  providerId?: string | null;
  modelId?: string | null;
  groupId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the newest persisted user/assistant message. */
  lastMessageAt?: number | null;
}

/** A conversation plus the assistant it belongs to (for the "全部对话" list). */
export interface ConversationSummary extends Conversation {
  assistantId: string;
  assistantName: string;
  /** Model that produced the first persisted assistant reply, when known. */
  firstResponseModel?: string | null;
}

export interface ChatGroup {
  id: string;
  name: string;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRef {
  assistantId: string;
  id: string;
}

/** Reserved id of the implicit default assistant (empty system prompt). */
export const DEFAULT_ASSISTANT_ID = "__default__";

export const DEFAULT_TITLE_GENERATION_PROMPT = `你是 Nomi 的对话标题生成器。根据用户发出的第一条消息，为这段对话生成一个简洁、具体、便于扫描和检索的标题。

要求：
- 准确概括用户的核心意图、对象与任务；优先保留关键专有名词。
- 使用与用户消息相同的主要语言。
- 中文控制在 6–18 个汉字；英文控制在 3–10 个单词。
- 不要回答问题，不要补充消息中没有的信息。
- 不使用“关于……”“咨询……”“用户想要……”等空泛前缀。
- 不要输出引号、句号、冒号、Markdown、编号或解释。
- 只输出一行标题。`;

export interface ChatSettings {
  /** Null means “follow the global default model”. */
  titleProviderId?: string | null;
  titleModelId?: string | null;
  titlePrompt: string;
}

export interface Attachment {
  id: string;
  kind: string; // image | audio | video | file
  name: string;
  mimeType: string;
  path: string;
  size?: number | null;
  textStatus?: string | null; // PDF: "ready" | "none"
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result: string;
  ok: boolean;
  images?: string[];
}

/** Token usage for an assistant reply (cache fields only when the provider reports them). */
export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number | null;
  cacheMissTokens?: number | null;
  providerName?: string | null;
  modelId?: string | null;
  durationMs?: number | null;
  /** Locally estimated CNY charge from the saved provider configuration. */
  costCny?: number | null;
  /** Provider-reported USD charge (OpenRouter credits), the real charge. */
  costUsd?: number | null;
  pricingPeriod?: "peak" | "offPeak" | null;
}

export interface ChatMessage {
  id: string;
  role: string; // user | assistant | system | context_marker
  content: string;
  model?: string | null;
  reasoning?: string;
  attachments: Attachment[];
  toolCalls: ToolCallRecord[];
  /** Provider-native assistant/tool transcript retained for reliable follow-up tool calls. */
  providerHistory?: unknown[];
  usage?: MessageUsage | null;
  responseGroupId?: string | null;
  selectedForContext?: boolean | null;
  responseLayout?: "tabs" | "split" | null;
  feedback?: "good" | "bad" | null;
  createdAt: number;
}

// Mirrors the Rust `llm::StreamEvent` (serde tag = "type", camelCase).
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "toolCallStart"; index: number; id: string; name: string }
  | { type: "toolCallArgs"; index: number; delta: string }
  | { type: "toolResult"; id: string; ok: boolean; summary: string; images?: string[] }
  | {
      type: "renderRequest";
      renderId: string;
      markdown: string;
      formats: string[];
      pageSize: string;
      title: string;
    }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      providerName: string;
      modelId: string;
      durationMs: number;
      costCny?: number;
      costUsd?: number;
      pricingPeriod?: "peak" | "offPeak";
    }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Browser-preview in-memory store (so `pnpm dev` works without the Rust backend) ──
const preview: {
  assistants: Assistant[];
  conversations: Record<string, Conversation[]>;
  groups: ChatGroup[];
  messages: Record<string, ChatMessage[]>;
  seq: number;
} = { assistants: [], conversations: {}, groups: [], messages: {}, seq: 1 };
const previewAttachmentDataUrls = new Map<string, string>();
let previewChatSettings: ChatSettings = {
  titleProviderId: null,
  titleModelId: null,
  titlePrompt: DEFAULT_TITLE_GENERATION_PROMPT,
};

const previewAssistantName = (id: string) =>
  preview.assistants.find((a) => a.id === id)?.name ??
  (id === DEFAULT_ASSISTANT_ID ? "默认助手" : id);

const previewFirstResponseModel = (assistantId: string, conversationId: string) => {
  const firstReply = (preview.messages[previewChatKey(assistantId, conversationId)] ?? []).find(
    (message) => message.role === "assistant",
  );
  return firstReply?.model ?? firstReply?.usage?.modelId ?? null;
};

const previewId = (base: string) => `${base}-${preview.seq++}`;
const previewChatKey = (assistantId: string, chatId: string) => `${assistantId}/${chatId}`;
const conversationActivityAt = (conversation: Conversation) =>
  conversation.lastMessageAt ?? conversation.createdAt;

function touchPreviewConversation(
  assistantId: string,
  chatId: string,
  messages: ChatMessage[],
): void {
  const conversation = (preview.conversations[assistantId] ?? []).find(
    (item) => item.id === chatId,
  );
  if (!conversation) return;
  conversation.lastMessageAt =
    messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .reduce<number | null>(
        (latest, message) =>
          latest == null ? message.createdAt : Math.max(latest, message.createdAt),
        null,
      ) ?? null;
  conversation.updatedAt = nowSec();
}

function previewConversationTitle(text: string, attachments: Attachment[]): string {
  const source =
    text.trim() ||
    (attachments.length > 0
      ? `查看${attachments.map((attachment) => attachment.name).join("、")}`
      : "新对话");
  return source
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .replace(/[。！？.!?]+$/u, "")
    .trim()
    .slice(0, 18);
}

function ensurePreviewDefaultAssistant(): Assistant {
  const existing = preview.assistants.find((assistant) => assistant.id === DEFAULT_ASSISTANT_ID);
  if (existing) return existing;
  const ts = nowSec();
  const assistant: Assistant = {
    id: DEFAULT_ASSISTANT_ID,
    name: "默认助手",
    systemPrompt: "",
    emoji: randomAssistantEmoji(),
    createdAt: ts,
    updatedAt: ts,
  };
  preview.assistants.push(assistant);
  preview.conversations[DEFAULT_ASSISTANT_ID] = [];
  return assistant;
}

async function previewInheritedModel(
  assistantId: string,
): Promise<{ providerId: string; modelId: string } | null> {
  const assistant = preview.assistants.find((item) => item.id === assistantId);
  if (assistant?.defaultProviderId && assistant.defaultModelId) {
    return { providerId: assistant.defaultProviderId, modelId: assistant.defaultModelId };
  }
  const globalDefault = findDefaultModel(await listProviders());
  return globalDefault
    ? { providerId: globalDefault.provider.id, modelId: globalDefault.model.id }
    : null;
}

export async function listAssistants(): Promise<Assistant[]> {
  if (isTauri()) {
    return invoke<Assistant[]>("list_assistants");
  }
  return [...preview.assistants].sort((a, b) => a.createdAt - b.createdAt);
}

export async function createAssistant(
  name: string,
  systemPrompt: string,
  emoji?: string,
  defaultProviderId?: string | null,
  defaultModelId?: string | null,
  toolsEnabled: boolean = true,
  toolIds: string[] | null = null,
): Promise<Assistant> {
  if (isTauri()) {
    return invoke<Assistant>("create_assistant", {
      name,
      systemPrompt,
      emoji,
      defaultProviderId: defaultProviderId ?? null,
      defaultModelId: defaultModelId ?? null,
      toolsEnabled,
      toolIds,
    });
  }
  const ts = nowSec();
  const assistant: Assistant = {
    id: previewId("assistant"),
    name,
    systemPrompt,
    emoji: emoji?.trim() || randomAssistantEmoji(),
    defaultProviderId: defaultProviderId ?? null,
    defaultModelId: defaultModelId ?? null,
    toolsEnabled,
    toolIds,
    createdAt: ts,
    updatedAt: ts,
  };
  preview.assistants.push(assistant);
  preview.conversations[assistant.id] = [];
  return assistant;
}

export async function updateAssistant(
  id: string,
  name: string,
  systemPrompt: string,
  emoji?: string,
  defaultProviderId?: string | null,
  defaultModelId?: string | null,
  toolsEnabled: boolean = true,
  toolIds: string[] | null = null,
): Promise<Assistant> {
  if (isTauri()) {
    return invoke<Assistant>("update_assistant", {
      id,
      name,
      systemPrompt,
      emoji,
      defaultProviderId: defaultProviderId ?? null,
      defaultModelId: defaultModelId ?? null,
      toolsEnabled,
      toolIds,
    });
  }
  const assistant = preview.assistants.find((item) => item.id === id);
  if (!assistant) {
    throw new Error("助手不存在");
  }
  assistant.name = name;
  assistant.systemPrompt = systemPrompt;
  if (emoji !== undefined) {
    assistant.emoji = emoji.trim() || randomAssistantEmoji();
  }
  assistant.defaultProviderId = defaultProviderId ?? null;
  assistant.defaultModelId = defaultModelId ?? null;
  assistant.toolsEnabled = toolsEnabled;
  assistant.toolIds = toolIds;
  assistant.updatedAt = nowSec();
  return { ...assistant };
}

export async function deleteAssistant(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_assistant", { id });
    return;
  }
  preview.assistants = preview.assistants.filter((item) => item.id !== id);
  delete preview.conversations[id];
}

export async function listConversations(
  assistantId: string,
  scope?: string,
): Promise<Conversation[]> {
  if (isTauri()) {
    return invoke<Conversation[]>("list_conversations", { scope, assistantId });
  }
  return [...(preview.conversations[assistantId] ?? [])].sort(
    (a, b) => conversationActivityAt(b) - conversationActivityAt(a),
  );
}

export async function listAllConversations(): Promise<ConversationSummary[]> {
  if (isTauri()) {
    return invoke<ConversationSummary[]>("list_all_conversations");
  }
  const rows: ConversationSummary[] = [];
  for (const [assistantId, list] of Object.entries(preview.conversations)) {
    for (const conversation of list) {
      rows.push({
        ...conversation,
        assistantId,
        assistantName: previewAssistantName(assistantId),
        firstResponseModel: previewFirstResponseModel(assistantId, conversation.id),
      });
    }
  }
  return rows.sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));
}

export async function listChatGroups(): Promise<ChatGroup[]> {
  if (isTauri()) return invoke<ChatGroup[]>("list_chat_groups");
  return [...preview.groups].sort((a, b) => a.createdAt - b.createdAt);
}

export async function createChatGroup(
  name: string,
  conversations: ConversationRef[],
): Promise<ChatGroup> {
  if (isTauri()) return invoke<ChatGroup>("create_chat_group", { name, conversations });
  const timestamp = nowSec();
  const group: ChatGroup = {
    id: previewId("group"),
    name: name.trim() || "新分组",
    collapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  preview.groups.push(group);
  await setConversationsChatGroup(conversations, group.id);
  return { ...group };
}

export async function renameChatGroup(id: string, name: string): Promise<ChatGroup> {
  if (isTauri()) return invoke<ChatGroup>("rename_chat_group", { id, name });
  const group = preview.groups.find((item) => item.id === id);
  if (!group) throw new Error("对话分组不存在");
  group.name = name.trim() || "新分组";
  group.updatedAt = nowSec();
  return { ...group };
}

export async function setChatGroupCollapsed(id: string, collapsed: boolean): Promise<ChatGroup> {
  if (isTauri()) return invoke<ChatGroup>("set_chat_group_collapsed", { id, collapsed });
  const group = preview.groups.find((item) => item.id === id);
  if (!group) throw new Error("对话分组不存在");
  group.collapsed = collapsed;
  group.updatedAt = nowSec();
  return { ...group };
}

export async function setConversationsChatGroup(
  conversations: ConversationRef[],
  groupId: string | null,
): Promise<void> {
  if (isTauri()) {
    await invoke("set_conversations_chat_group", { conversations, groupId });
    return;
  }
  if (groupId && !preview.groups.some((group) => group.id === groupId)) {
    throw new Error("对话分组不存在");
  }
  for (const conversationRef of conversations) {
    const conversation = (preview.conversations[conversationRef.assistantId] ?? []).find(
      (item) => item.id === conversationRef.id,
    );
    if (conversation) conversation.groupId = groupId;
  }
}

/** Create a conversation under the implicit default assistant (empty prompt). */
export async function createDefaultConversation(
  title: string,
  scope?: string,
): Promise<ConversationSummary> {
  if (isTauri()) {
    return invoke<ConversationSummary>("create_default_conversation", { scope, title });
  }
  ensurePreviewDefaultAssistant();
  const conversation = await createConversation(DEFAULT_ASSISTANT_ID, title, scope);
  return { ...conversation, assistantId: DEFAULT_ASSISTANT_ID, assistantName: "默认助手" };
}

export async function createConversation(
  assistantId: string,
  title: string,
  scope?: string,
): Promise<Conversation> {
  if (isTauri()) {
    return invoke<Conversation>("create_conversation", { scope, assistantId, title });
  }
  const ts = nowSec();
  const inheritedModel = await previewInheritedModel(assistantId);
  const conversation: Conversation = {
    id: previewId("conversation"),
    title,
    createdAt: ts,
    updatedAt: ts,
    lastMessageAt: null,
    providerId: inheritedModel?.providerId ?? null,
    modelId: inheritedModel?.modelId ?? null,
  };
  (preview.conversations[assistantId] ??= []).push(conversation);
  return conversation;
}

export async function setConversationAssistant(
  assistantId: string,
  id: string,
  targetAssistantId: string,
): Promise<ConversationSummary> {
  if (isTauri()) {
    return invoke<ConversationSummary>("set_conversation_assistant", {
      assistantId,
      id,
      targetAssistantId,
    });
  }
  const source = (preview.conversations[assistantId] ?? []).find((item) => item.id === id);
  if (!source) throw new Error("对话不存在");
  const targetAssistant =
    targetAssistantId === DEFAULT_ASSISTANT_ID
      ? ensurePreviewDefaultAssistant()
      : preview.assistants.find((assistant) => assistant.id === targetAssistantId);
  if (!targetAssistant) throw new Error("助手不存在");
  if (assistantId === targetAssistantId) {
    return {
      ...source,
      assistantId,
      assistantName: targetAssistant.name,
      firstResponseModel: previewFirstResponseModel(assistantId, id),
    };
  }

  const oldKey = previewChatKey(assistantId, id);
  const messages = preview.messages[oldKey] ?? [];
  const targetList = (preview.conversations[targetAssistantId] ??= []);
  const nextId = targetList.some((conversation) => conversation.id === id)
    ? previewId("conversation")
    : id;
  const moved: Conversation = { ...source, id: nextId, updatedAt: nowSec() };
  if (messages.length === 0) {
    const inherited = await previewInheritedModel(targetAssistantId);
    moved.providerId = inherited?.providerId ?? null;
    moved.modelId = inherited?.modelId ?? null;
  }
  preview.conversations[assistantId] = (preview.conversations[assistantId] ?? []).filter(
    (conversation) => conversation.id !== id,
  );
  targetList.push(moved);
  if (oldKey in preview.messages) {
    preview.messages[previewChatKey(targetAssistantId, nextId)] = messages;
    delete preview.messages[oldKey];
  }
  return {
    ...moved,
    assistantId: targetAssistantId,
    assistantName: targetAssistant.name,
    firstResponseModel: previewFirstResponseModel(targetAssistantId, nextId),
  };
}

export async function setDefaultConversationSettings(
  emoji: string,
  systemPrompt: string,
  providerId: string | null,
  modelId: string | null,
  toolsEnabled: boolean = true,
  toolIds: string[] | null = null,
): Promise<Assistant> {
  if (isTauri()) {
    return invoke<Assistant>("set_default_conversation_settings", {
      emoji,
      systemPrompt,
      providerId,
      modelId,
      toolsEnabled,
      toolIds,
    });
  }
  const assistant = ensurePreviewDefaultAssistant();
  assistant.emoji = emoji.trim() || randomAssistantEmoji();
  assistant.systemPrompt = systemPrompt;
  assistant.defaultProviderId = providerId;
  assistant.defaultModelId = modelId;
  assistant.toolsEnabled = toolsEnabled;
  assistant.toolIds = toolIds;
  assistant.updatedAt = nowSec();
  return { ...assistant };
}

export async function getChatSettings(): Promise<ChatSettings> {
  if (isTauri()) {
    return invoke<ChatSettings>("get_chat_settings");
  }
  return { ...previewChatSettings };
}

export async function saveChatSettings(settings: ChatSettings): Promise<ChatSettings> {
  if (isTauri()) {
    return invoke<ChatSettings>("set_chat_settings", {
      titleProviderId: settings.titleProviderId ?? null,
      titleModelId: settings.titleModelId ?? null,
      titlePrompt: settings.titlePrompt,
    });
  }
  previewChatSettings = {
    titleProviderId: settings.titleProviderId ?? null,
    titleModelId: settings.titleModelId ?? null,
    titlePrompt: settings.titlePrompt,
  };
  return { ...previewChatSettings };
}

export async function renameConversation(
  assistantId: string,
  id: string,
  title: string,
  scope?: string,
): Promise<Conversation> {
  if (isTauri()) {
    return invoke<Conversation>("rename_conversation", { scope, assistantId, id, title });
  }
  const conversation = (preview.conversations[assistantId] ?? []).find((item) => item.id === id);
  if (!conversation) {
    throw new Error("对话不存在");
  }
  conversation.title = title;
  conversation.updatedAt = nowSec();
  return { ...conversation };
}

export async function deleteConversation(
  assistantId: string,
  id: string,
  scope?: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("delete_conversation", { scope, assistantId, id });
    return;
  }
  preview.conversations[assistantId] = (preview.conversations[assistantId] ?? []).filter(
    (item) => item.id !== id,
  );
  delete preview.messages[previewChatKey(assistantId, id)];
}

export async function revealConversation(
  assistantId: string,
  id: string,
  scope?: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("reveal_conversation", { scope, assistantId, id });
  }
}

export async function setConversationModel(
  assistantId: string,
  id: string,
  providerId: string | null,
  modelId: string | null,
  scope?: string,
): Promise<Conversation> {
  if (isTauri()) {
    return invoke<Conversation>("set_conversation_model", {
      scope,
      assistantId,
      id,
      providerId,
      modelId,
    });
  }
  const conversation = (preview.conversations[assistantId] ?? []).find((item) => item.id === id);
  if (!conversation) {
    throw new Error("对话不存在");
  }
  conversation.providerId = providerId;
  conversation.modelId = modelId;
  return { ...conversation };
}

// ── Messages / attachments / streaming ──────────────────────────────────────

export async function listMessages(
  assistantId: string,
  id: string,
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("list_messages", { scope, assistantId, id });
  }
  return [...(preview.messages[previewChatKey(assistantId, id)] ?? [])];
}

export async function addContextMarker(
  assistantId: string,
  chatId: string,
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("add_context_marker", { scope, assistantId, chatId });
  }
  const key = previewChatKey(assistantId, chatId);
  const messages = preview.messages[key] ?? [];
  const lastMarker = messages.reduce(
    (last, message, index) => (message.role === "context_marker" ? index : last),
    -1,
  );
  const hasActiveContext = messages
    .slice(lastMarker + 1)
    .some((message) => message.role === "user" || message.role === "assistant");
  if (hasActiveContext) {
    messages.push({
      id: previewId("context"),
      role: "context_marker",
      content: "",
      attachments: [],
      toolCalls: [],
      createdAt: nowSec(),
    });
  }
  preview.messages[key] = messages;
  return [...messages];
}

export async function editChatMessage(
  assistantId: string,
  chatId: string,
  messageId: string,
  content: string,
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("edit_chat_message", {
      scope,
      assistantId,
      chatId,
      messageId,
      content,
    });
  }
  const messages = preview.messages[previewChatKey(assistantId, chatId)] ?? [];
  const message = messages.find((item) => item.id === messageId);
  if (message) message.content = content;
  return [...messages];
}

export async function setChatMessageFeedback(
  assistantId: string,
  chatId: string,
  messageId: string,
  feedback: "good" | "bad" | null,
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("set_chat_message_feedback", {
      scope,
      assistantId,
      chatId,
      messageId,
      feedback,
    });
  }
  const messages = preview.messages[previewChatKey(assistantId, chatId)] ?? [];
  const message = messages.find((item) => item.id === messageId);
  if (message) message.feedback = feedback;
  return [...messages];
}

export async function setResponseGroupState(
  assistantId: string,
  chatId: string,
  groupId: string,
  selectedMessageId: string,
  layout: "tabs" | "split",
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("set_response_group_state", {
      scope,
      assistantId,
      chatId,
      groupId,
      selectedMessageId,
      layout,
    });
  }
  const messages = preview.messages[previewChatKey(assistantId, chatId)] ?? [];
  for (const message of messages) {
    const messageGroup = message.responseGroupId ?? message.id;
    if (message.role === "assistant" && messageGroup === groupId) {
      message.responseGroupId = groupId;
      message.selectedForContext = message.id === selectedMessageId;
      message.responseLayout = layout;
    }
  }
  return [...messages];
}

export async function deleteChatMessage(
  assistantId: string,
  chatId: string,
  messageId: string,
  scope?: string,
): Promise<ChatMessage[]> {
  if (isTauri()) {
    return invoke<ChatMessage[]>("delete_chat_message", { scope, assistantId, chatId, messageId });
  }
  const key = previewChatKey(assistantId, chatId);
  const messages = preview.messages[key] ?? [];
  const removed = messages.find((message) => message.id === messageId);
  preview.messages[key] = messages.filter((message) => message.id !== messageId);
  if (removed?.role === "assistant" && removed.selectedForContext !== false) {
    const groupId = removed.responseGroupId ?? removed.id;
    const fallback = preview.messages[key].find(
      (message) =>
        message.role === "assistant" && (message.responseGroupId ?? message.id) === groupId,
    );
    if (fallback) fallback.selectedForContext = true;
  }
  touchPreviewConversation(assistantId, chatId, preview.messages[key]);
  return [...preview.messages[key]];
}

export async function saveChatAttachment(
  assistantId: string,
  chatId: string,
  sourcePath: string,
  name?: string,
  scope?: string,
): Promise<Attachment> {
  if (isTauri()) {
    return invoke<Attachment>("save_chat_attachment", {
      scope,
      assistantId,
      chatId,
      sourcePath,
      name,
    });
  }
  throw new Error("预览模式不支持上传附件。");
}

/** Save an in-memory image or PDF pasted from the clipboard. */
export async function saveChatAttachmentData(
  assistantId: string,
  chatId: string,
  dataBase64: string,
  name: string,
  mimeType: string,
  scope?: string,
): Promise<Attachment> {
  if (isTauri()) {
    return invoke<Attachment>("save_chat_attachment_data", {
      scope,
      assistantId,
      chatId,
      dataBase64,
      name,
      mimeType,
    });
  }
  const attachment: Attachment = {
    id: previewId("att"),
    kind: mimeType.startsWith("image/") ? "image" : "file",
    name,
    mimeType,
    path: `assets/${name}`,
    size: Math.floor((dataBase64.length * 3) / 4),
  };
  previewAttachmentDataUrls.set(attachment.id, `data:${mimeType};base64,${dataBase64}`);
  return attachment;
}

export interface AttachmentPreviewSource {
  url: string;
  revokeOnClose: boolean;
}

/** Load a local image/PDF only when its badge is opened for preview. */
export async function loadChatAttachmentPreview(
  assistantId: string,
  chatId: string,
  attachment: Attachment,
  scope?: string,
): Promise<AttachmentPreviewSource> {
  if (isTauri()) {
    const payload = await invoke<ArrayBuffer | number[]>("read_chat_attachment_data", {
      scope,
      assistantId,
      chatId,
      relativePath: attachment.path,
    });
    const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload);
    const mimeType = attachment.mimeType || "application/octet-stream";
    return {
      url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
      revokeOnClose: true,
    };
  }

  const url = previewAttachmentDataUrls.get(attachment.id);
  if (!url) throw new Error("预览数据已失效，请重新上传附件。");
  return { url, revokeOnClose: false };
}

/** Render a PDF attachment's first page to a thumbnail on demand (no stored file)
 *  — used to show a preview image for PDF attachments in the chat. */
export async function loadPdfThumbnail(
  assistantId: string,
  chatId: string,
  attachment: Attachment,
  scope?: string,
): Promise<AttachmentPreviewSource> {
  if (!isTauri()) throw new Error("预览不可用。");
  const payload = await invoke<ArrayBuffer | number[]>("read_pdf_thumbnail", {
    scope,
    assistantId,
    chatId,
    relativePath: attachment.path,
  });
  const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload);
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
    revokeOnClose: true,
  };
}

/** Reply to a backend `renderRequest`: hand the rendered PDF/PNG bytes (base64)
 *  back to the waiting `create_markdown_document` tool call. No-op outside Tauri. */
export async function submitRenderResult(result: {
  renderId: string;
  ok: boolean;
  pdfBase64?: string | null;
  pngBase64?: string | null;
  error?: string | null;
}): Promise<void> {
  if (!isTauri()) return;
  await invoke("submit_render_result", {
    renderId: result.renderId,
    ok: result.ok,
    pdfBase64: result.pdfBase64 ?? null,
    pngBase64: result.pngBase64 ?? null,
    error: result.error ?? null,
  });
}

/** Download a saved attachment: pick a destination via the OS save dialog, then
 *  copy the file there in the backend. Returns false if the user cancelled. */
export async function downloadAttachment(
  assistantId: string,
  chatId: string,
  attachment: Attachment,
  scope?: string,
): Promise<boolean> {
  if (!isTauri()) {
    // Browser-preview fallback: open the data URL in a new tab if we have one.
    const url = previewAttachmentDataUrls.get(attachment.id);
    if (url) window.open(url, "_blank");
    return Boolean(url);
  }
  const extension = attachment.name.includes(".") ? attachment.name.split(".").pop()! : undefined;
  const destPath = await save({
    defaultPath: attachment.name,
    filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
  });
  if (!destPath) return false;
  await invoke("write_attachment_to", {
    scope,
    assistantId,
    chatId,
    relativePath: attachment.path,
    destPath,
  });
  return true;
}

export interface SendMessageParams {
  /** Conversation store: undefined = main chat; a tab id = that tab's AI sidebar. */
  scope?: string;
  assistantId: string;
  chatId: string;
  requestId: string;
  text: string;
  attachments: Attachment[];
  /** Optional main-chat transcript supplied as read-only context to an AI sidebar. */
  contextAssistantId?: string | null;
  contextChatId?: string | null;
  /** Optional read-only snapshot from a feature page shown beside the sidebar. */
  contextText?: string | null;
  reasoningEffort?: string | null;
}

/**
 * Stream a chat turn. `onEvent` fires for every token / tool event; the returned
 * promise resolves once the backend finishes (after a `done` or `error` event).
 */
export async function sendMessage(
  params: SendMessageParams,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (isTauri()) {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    await invoke("send_message", { ...params, channel });
    return;
  }
  const key = previewChatKey(params.assistantId, params.chatId);
  const existingMessages = preview.messages[key] ?? [];
  const conversation = (preview.conversations[params.assistantId] ?? []).find(
    (item) => item.id === params.chatId,
  );
  const shouldGenerateTitle =
    conversation?.title === "新对话" &&
    !existingMessages.some((message) => message.role === "user");
  const modelId = conversation?.modelId ?? "deepseek-v4-flash";
  const groupId = previewId("response");
  const reasoningEnabled = Boolean(params.reasoningEffort && params.reasoningEffort !== "off");
  const reasoning = reasoningEnabled
    ? Array.from(
        { length: 14 },
        (_, index) => `第 ${index + 1} 步：分析用户需求、已有上下文与回答约束。`,
      ).join("\n")
    : "";
  const user: ChatMessage = {
    id: previewId("msg"),
    role: "user",
    content: params.text,
    attachments: params.attachments,
    toolCalls: [],
    createdAt: nowSec(),
  };
  const content = `这是来自 ${modelId} 的预览回复，用于检查消息操作和多模型回答布局。`;
  if (reasoning) onEvent({ type: "reasoning", delta: reasoning });
  onEvent({ type: "text", delta: content });
  onEvent({
    type: "usage",
    promptTokens: 84,
    completionTokens: 32,
    totalTokens: 116,
    providerName: "DeepSeek",
    modelId,
    durationMs: 1_120,
    cacheHitTokens: 42,
    cacheMissTokens: 42,
    costCny: 0.0012,
  });
  const assistant: ChatMessage = {
    id: previewId("msg"),
    role: "assistant",
    content,
    reasoning,
    model: modelId,
    attachments: [],
    toolCalls: [],
    usage: {
      promptTokens: 84,
      completionTokens: 32,
      totalTokens: 116,
      cacheHitTokens: 42,
      cacheMissTokens: 42,
      providerName: "DeepSeek",
      modelId,
      durationMs: 1_120,
      costCny: 0.0012,
    },
    responseGroupId: groupId,
    selectedForContext: true,
    responseLayout: "tabs",
    createdAt: nowSec(),
  };
  (preview.messages[key] ??= []).push(user, assistant);
  if (conversation && shouldGenerateTitle) {
    conversation.title = previewConversationTitle(params.text, params.attachments);
    conversation.updatedAt = nowSec();
  }
  touchPreviewConversation(params.assistantId, params.chatId, preview.messages[key]);
  onEvent({ type: "done", messageId: assistant.id });
}

export interface GenerateMessageVariantParams {
  /** Conversation store: undefined = main chat; a tab id = that tab's AI sidebar. */
  scope?: string;
  assistantId: string;
  chatId: string;
  requestId: string;
  sourceMessageId: string;
  providerId: string;
  modelId: string;
  replace: boolean;
  /** Optional main-chat transcript supplied as read-only context to an AI sidebar. */
  contextAssistantId?: string | null;
  contextChatId?: string | null;
  contextText?: string | null;
  /** Effort already mapped to this variant model's scale (null = thinking off). */
  reasoningEffort?: string | null;
}

export async function generateMessageVariant(
  params: GenerateMessageVariantParams,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (isTauri()) {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    await invoke("generate_message_variant", { ...params, channel });
    return;
  }
  const key = previewChatKey(params.assistantId, params.chatId);
  const messages = preview.messages[key] ?? [];
  const sourceIndex = messages.findIndex((message) => message.id === params.sourceMessageId);
  if (sourceIndex < 0) throw new Error("回复不存在");
  const source = messages[sourceIndex];
  const groupId = source.responseGroupId ?? source.id;
  const content = `这是 ${params.modelId} 针对同一问题生成的另一份回答。你可以切换查看，或使用分栏模式并排比较。`;
  await new Promise((resolve) => window.setTimeout(resolve, 800));
  onEvent({ type: "text", delta: content });
  const assistant: ChatMessage = {
    ...source,
    id: previewId("msg"),
    content,
    model: params.modelId,
    feedback: null,
    responseGroupId: groupId,
    selectedForContext: true,
    usage: {
      promptTokens: 90,
      completionTokens: 36,
      totalTokens: 126,
      providerName: "DeepSeek",
      modelId: params.modelId,
      durationMs: 1_460,
      costCny: 0.0016,
    },
    createdAt: nowSec(),
  };
  for (const message of messages) {
    if (message.role === "assistant" && (message.responseGroupId ?? message.id) === groupId) {
      message.responseGroupId = groupId;
      message.selectedForContext = false;
    }
  }
  if (params.replace) {
    messages.splice(sourceIndex, 1, assistant);
  } else {
    let last = sourceIndex;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && (message.responseGroupId ?? message.id) === groupId) {
        last = index;
        break;
      }
    }
    messages.splice(last + 1, 0, assistant);
  }
  touchPreviewConversation(params.assistantId, params.chatId, messages);
  onEvent({ type: "done", messageId: assistant.id });
}

export async function stopMessage(requestId: string): Promise<void> {
  if (isTauri()) {
    await invoke("stop_message", { requestId });
  }
}
