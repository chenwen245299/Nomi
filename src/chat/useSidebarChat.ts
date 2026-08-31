import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DEFAULT_ASSISTANT_ID,
  createDefaultConversation,
  deleteConversation as apiDeleteConversation,
  listConversations,
  setConversationModel,
  type Conversation,
} from "./api";
import { subscribeConversationActivity } from "./chatRuntime";

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type TitleEvent = { scope: string; assistantId: string; chatId: string; title: string };

/**
 * Per-tab AI-sidebar conversation store. Every sidebar conversation lives under
 * the scope's implicit `__default__` assistant (`<tab>/ai-sidebar/__default__/…`),
 * so this hook only ever deals with a single assistant and a flat conversation
 * list — the compact counterpart to the main chat's {@link useChat}.
 */
export interface SidebarChat {
  conversations: Conversation[];
  activeId: string | null;
  active: Conversation | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  newConversation: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  setModel: (providerId: string, modelId: string) => Promise<void>;
}

function byActivity(list: Conversation[]): Conversation[] {
  return [...list].sort(
    (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
  );
}

export function useSidebarChat(scope: string): SidebarChat {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load this scope's conversations; seed a blank one when the store is empty so
  // the panel always opens with a conversation ready to receive the first message.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      let list: Conversation[];
      try {
        list = await listConversations(DEFAULT_ASSISTANT_ID, scope);
      } catch {
        list = []; // the scope's default assistant hasn't been created yet
      }
      list = byActivity(list);
      if (list.length === 0) {
        try {
          list = [await createDefaultConversation("新对话", scope)];
        } catch (err) {
          if (!cancelled) setError(String(err));
        }
      }
      if (cancelled) return;
      setConversations(list);
      setActiveId(list[0]?.id ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const refresh = useCallback(async () => {
    try {
      setConversations(byActivity(await listConversations(DEFAULT_ASSISTANT_ID, scope)));
    } catch {
      /* assistant folder may not exist yet — leave the current list in place */
    }
  }, [scope]);

  // Keep ordering + lastMessageAt live as this scope's conversations get activity.
  useEffect(
    () =>
      subscribeConversationActivity((event) => {
        if (event.scope !== scope) return;
        if (event.lastMessageAt != null) {
          const at = event.lastMessageAt;
          setConversations((current) =>
            byActivity(
              current.map((c) => (c.id === event.chatId ? { ...c, lastMessageAt: at } : c)),
            ),
          );
          return;
        }
        void refresh();
      }),
    [scope, refresh],
  );

  // Reflect async-generated titles for this scope.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<TitleEvent>("conversation-title-updated", ({ payload }) => {
      if (payload.scope !== scope) return;
      setConversations((current) =>
        current.map((c) => (c.id === payload.chatId ? { ...c, title: payload.title } : c)),
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [scope]);

  const select = useCallback((id: string) => setActiveId(id), []);

  const newConversation = useCallback(async () => {
    // Reuse the current conversation if it's still blank rather than stacking
    // empty conversations — matches the reference sidebar's "＋ 新对话" behaviour.
    const active = conversations.find((c) => c.id === activeId);
    if (active && active.lastMessageAt == null) return;
    try {
      const created = await createDefaultConversation("新对话", scope);
      setConversations((current) => byActivity([created, ...current]));
      setActiveId(created.id);
    } catch (err) {
      setError(String(err));
    }
  }, [conversations, activeId, scope]);

  const removeConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(DEFAULT_ASSISTANT_ID, id, scope);
      let next = byActivity(await listConversations(DEFAULT_ASSISTANT_ID, scope).catch(() => []));
      if (next.length === 0) {
        try {
          next = [await createDefaultConversation("新对话", scope)];
        } catch (err) {
          setError(String(err));
        }
      }
      setConversations(next);
      setActiveId((active) => (active === id || !active ? (next[0]?.id ?? null) : active));
    },
    [scope],
  );

  const setModel = useCallback(
    async (providerId: string, modelId: string) => {
      if (!activeId) return;
      const updated = await setConversationModel(
        DEFAULT_ASSISTANT_ID,
        activeId,
        providerId,
        modelId,
        scope,
      );
      setConversations((current) => current.map((c) => (c.id === updated.id ? updated : c)));
    },
    [activeId, scope],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return {
    conversations,
    activeId,
    active,
    loading,
    error,
    select,
    newConversation,
    removeConversation,
    setModel,
  };
}
