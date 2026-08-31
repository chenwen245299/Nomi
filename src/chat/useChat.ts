import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createAssistant,
  createConversation,
  createDefaultConversation,
  deleteAssistant,
  deleteConversation,
  listAllConversations,
  listAssistants,
  renameConversation,
  revealConversation,
  setConversationAssistant,
  setDefaultConversationSettings,
  setConversationModel,
  updateAssistant,
  DEFAULT_ASSISTANT_ID,
  type Assistant,
  type ConversationSummary,
} from "./api";
import { subscribeConversationActivity } from "./chatRuntime";
import { assistantEmoji } from "./emoji";

/**
 * A shared, tab-agnostic data store for the chat section. It holds the named
 * assistants and a flat list of every conversation (across all assistants);
 * per-tab *selection* lives in the tab state up in App, not here. All mutations
 * refresh from disk so every open tab sees the same, current data.
 */
export interface ChatData {
  assistants: Assistant[]; // named assistants (the implicit default is hidden)
  conversations: ConversationSummary[]; // every conversation, newest first
  defaultConversationProviderId: string | null;
  defaultConversationModelId: string | null;
  defaultConversationSystemPrompt: string;
  defaultConversationEmoji: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  assistantById: (id: string | null) => Assistant | null;
  assistantName: (id: string | null) => string;
  conversationsFor: (assistantId: string | null) => ConversationSummary[];
  conversationById: (assistantId: string, id: string) => ConversationSummary | null;
  createAssistant: (
    name: string,
    systemPrompt: string,
    emoji: string,
    defaultProviderId: string | null,
    defaultModelId: string | null,
  ) => Promise<string | null>;
  saveAssistant: (
    id: string,
    name: string,
    systemPrompt: string,
    emoji: string,
    defaultProviderId: string | null,
    defaultModelId: string | null,
  ) => Promise<void>;
  saveDefaultConversationSettings: (
    emoji: string,
    systemPrompt: string,
    providerId: string | null,
    modelId: string | null,
  ) => Promise<void>;
  removeAssistant: (id: string) => Promise<void>;
  createConversation: (
    assistantId: string | null,
  ) => Promise<{ assistantId: string; id: string } | null>;
  renameConversationTitle: (assistantId: string, id: string, title: string) => Promise<void>;
  setConversationModel: (
    assistantId: string,
    id: string,
    providerId: string | null,
    modelId: string | null,
  ) => Promise<void>;
  setConversationAssistant: (
    assistantId: string,
    id: string,
    targetAssistantId: string,
  ) => Promise<ConversationSummary>;
  removeConversation: (assistantId: string, id: string) => Promise<void>;
  revealConversation: (assistantId: string, id: string) => Promise<void>;
}

const DEFAULT_ASSISTANT_LABEL = "默认助手";
const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type ConversationTitleUpdated = {
  scope: string;
  assistantId: string;
  chatId: string;
  title: string;
};
const conversationActivityAt = (conversation: ConversationSummary) =>
  conversation.lastMessageAt ?? conversation.createdAt;
const sortByLastMessage = (conversations: ConversationSummary[]) =>
  conversations.sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));

export function useChat(active: boolean): ChatData {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [defaultConversationProviderId, setDefaultConversationProviderId] = useState<string | null>(
    null,
  );
  const [defaultConversationModelId, setDefaultConversationModelId] = useState<string | null>(null);
  const [defaultConversationSystemPrompt, setDefaultConversationSystemPrompt] = useState("");
  const [defaultConversationEmoji, setDefaultConversationEmoji] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rawAssistants, allConversations] = await Promise.all([
        listAssistants(),
        listAllConversations(),
      ]);
      const defaultAssistant = rawAssistants.find(
        (assistant) => assistant.id === DEFAULT_ASSISTANT_ID,
      );
      setDefaultConversationProviderId(defaultAssistant?.defaultProviderId ?? null);
      setDefaultConversationModelId(defaultAssistant?.defaultModelId ?? null);
      setDefaultConversationSystemPrompt(defaultAssistant?.systemPrompt ?? "");
      setDefaultConversationEmoji(assistantEmoji(defaultAssistant?.emoji, DEFAULT_ASSISTANT_ID));
      // The implicit default assistant is never shown in the switcher; its
      // conversations still surface in the flat list under "默认助手".
      setAssistants(rawAssistants.filter((a) => a.id !== DEFAULT_ASSISTANT_ID));
      setConversations(allConversations);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  useEffect(
    () =>
      subscribeConversationActivity(({ scope, assistantId, chatId, lastMessageAt }) => {
        // The main-chat collection ignores AI-sidebar activity (its own scope).
        if (scope !== "") return;
        if (lastMessageAt != null) {
          setConversations((current) =>
            sortByLastMessage(
              current.map((conversation) =>
                conversation.assistantId === assistantId && conversation.id === chatId
                  ? { ...conversation, lastMessageAt }
                  : conversation,
              ),
            ),
          );
          return;
        }
        void listAllConversations()
          .then(setConversations)
          .catch((err) => setError(String(err)));
      }),
    [],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<ConversationTitleUpdated>("conversation-title-updated", ({ payload }) => {
      // The main-chat collection only reflects main-chat titles (scope "").
      if (payload.scope) return;
      setConversations((current) =>
        current.map((conversation) =>
          conversation.assistantId === payload.assistantId && conversation.id === payload.chatId
            ? { ...conversation, title: payload.title }
            : conversation,
        ),
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const assistantById = useCallback(
    (id: string | null) => (id ? (assistants.find((a) => a.id === id) ?? null) : null),
    [assistants],
  );

  const assistantName = useCallback(
    (id: string | null) => {
      if (!id || id === DEFAULT_ASSISTANT_ID) {
        return DEFAULT_ASSISTANT_LABEL;
      }
      return assistants.find((a) => a.id === id)?.name ?? DEFAULT_ASSISTANT_LABEL;
    },
    [assistants],
  );

  const conversationsFor = useCallback(
    (assistantId: string | null) =>
      assistantId ? conversations.filter((c) => c.assistantId === assistantId) : conversations,
    [conversations],
  );

  const conversationById = useCallback(
    (assistantId: string, id: string) =>
      conversations.find((c) => c.assistantId === assistantId && c.id === id) ?? null,
    [conversations],
  );

  const doCreateAssistant = useCallback(
    async (
      name: string,
      systemPrompt: string,
      emoji: string,
      defaultProviderId: string | null,
      defaultModelId: string | null,
    ) => {
      try {
        const created = await createAssistant(
          name.trim() || "未命名助手",
          systemPrompt,
          emoji,
          defaultProviderId,
          defaultModelId,
        );
        await refresh();
        return created.id;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  const saveAssistant = useCallback(
    async (
      id: string,
      name: string,
      systemPrompt: string,
      emoji: string,
      defaultProviderId: string | null,
      defaultModelId: string | null,
    ) => {
      try {
        await updateAssistant(
          id,
          name.trim() || "未命名助手",
          systemPrompt,
          emoji,
          defaultProviderId,
          defaultModelId,
        );
        await refresh();
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [refresh],
  );

  const removeAssistant = useCallback(
    async (id: string) => {
      try {
        await deleteAssistant(id);
        await refresh();
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [refresh],
  );

  const saveOrdinaryConversationSettings = useCallback(
    async (
      emoji: string,
      systemPrompt: string,
      providerId: string | null,
      modelId: string | null,
    ) => {
      try {
        const saved = await setDefaultConversationSettings(
          emoji,
          systemPrompt,
          providerId,
          modelId,
        );
        setDefaultConversationEmoji(assistantEmoji(saved.emoji, DEFAULT_ASSISTANT_ID));
        setDefaultConversationProviderId(saved.defaultProviderId ?? null);
        setDefaultConversationModelId(saved.defaultModelId ?? null);
        setDefaultConversationSystemPrompt(saved.systemPrompt ?? "");
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [],
  );

  const doCreateConversation = useCallback(
    async (assistantId: string | null) => {
      try {
        if (assistantId) {
          const created = await createConversation(assistantId, "新对话");
          await refresh();
          return { assistantId, id: created.id };
        }
        const created = await createDefaultConversation("新对话");
        await refresh();
        return { assistantId: created.assistantId, id: created.id };
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [refresh],
  );

  const renameConversationTitle = useCallback(
    async (assistantId: string, id: string, title: string) => {
      try {
        await renameConversation(assistantId, id, title.trim() || "未命名对话");
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const setConversationModelChoice = useCallback(
    async (assistantId: string, id: string, providerId: string | null, modelId: string | null) => {
      try {
        const updated = await setConversationModel(assistantId, id, providerId, modelId);
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.assistantId === assistantId && conversation.id === id
              ? { ...conversation, ...updated }
              : conversation,
          ),
        );
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [],
  );

  const setConversationAssistantChoice = useCallback(
    async (assistantId: string, id: string, targetAssistantId: string) => {
      try {
        const moved = await setConversationAssistant(assistantId, id, targetAssistantId);
        await refresh();
        return moved;
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [refresh],
  );

  const removeConversation = useCallback(
    async (assistantId: string, id: string) => {
      try {
        await deleteConversation(assistantId, id);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const revealConversationFolder = useCallback(async (assistantId: string, id: string) => {
    try {
      setError(null);
      await revealConversation(assistantId, id);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, []);

  return useMemo(
    () => ({
      assistants,
      conversations,
      defaultConversationProviderId,
      defaultConversationModelId,
      defaultConversationSystemPrompt,
      defaultConversationEmoji,
      loading,
      error,
      refresh,
      assistantById,
      assistantName,
      conversationsFor,
      conversationById,
      createAssistant: doCreateAssistant,
      saveAssistant,
      saveDefaultConversationSettings: saveOrdinaryConversationSettings,
      removeAssistant,
      createConversation: doCreateConversation,
      renameConversationTitle,
      setConversationAssistant: setConversationAssistantChoice,
      setConversationModel: setConversationModelChoice,
      removeConversation,
      revealConversation: revealConversationFolder,
    }),
    [
      assistants,
      conversations,
      defaultConversationProviderId,
      defaultConversationModelId,
      defaultConversationSystemPrompt,
      defaultConversationEmoji,
      loading,
      error,
      refresh,
      assistantById,
      assistantName,
      conversationsFor,
      conversationById,
      doCreateAssistant,
      saveAssistant,
      saveOrdinaryConversationSettings,
      removeAssistant,
      doCreateConversation,
      renameConversationTitle,
      setConversationAssistantChoice,
      setConversationModelChoice,
      removeConversation,
      revealConversationFolder,
    ],
  );
}
