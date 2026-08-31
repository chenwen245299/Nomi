import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Attachment, ChatMessage } from "./api";
import * as runtime from "./chatRuntime";
import type { StreamingMessage } from "./chatRuntime";

export type { DraftToolCall, StreamingMessage } from "./chatRuntime";

export interface ConversationController {
  messages: ChatMessage[];
  streaming: StreamingMessage | null;
  sending: boolean;
  error: string | null;
  loaded: boolean;
  send: (text: string, attachments: Attachment[], reasoningEffort?: string | null) => Promise<void>;
  clearContext: () => Promise<void>;
  edit: (messageId: string, content: string) => Promise<void>;
  feedback: (messageId: string, value: "good" | "bad" | null) => Promise<void>;
  selectResponse: (groupId: string, messageId: string, layout: "tabs" | "split") => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  generateVariant: (
    sourceMessageId: string,
    groupId: string,
    providerId: string,
    modelId: string,
    replace: boolean,
    reasoningEffort?: string | null,
  ) => Promise<void>;
  stop: () => void;
}

/**
 * A thin view over the module-level {@link runtime} store. All generation state
 * lives in the store, so a reply keeps streaming even after this component (and
 * the whole chat tab) unmounts — remounting simply re-attaches to the same slice.
 */
export function useConversation(assistantId: string, chatId: string): ConversationController {
  const slice = useSyncExternalStore(runtime.subscribe, () =>
    runtime.getSlice(assistantId, chatId),
  );

  // Load the persisted transcript on mount (no-op while a generation is live).
  useEffect(() => {
    void runtime.ensureLoaded(assistantId, chatId);
  }, [assistantId, chatId]);

  const send = useCallback(
    (text: string, attachments: Attachment[], reasoningEffort?: string | null) =>
      runtime.send(assistantId, chatId, text, attachments, reasoningEffort),
    [assistantId, chatId],
  );
  const clearContext = useCallback(
    () => runtime.clearContext(assistantId, chatId),
    [assistantId, chatId],
  );
  const edit = useCallback(
    (messageId: string, content: string) => runtime.edit(assistantId, chatId, messageId, content),
    [assistantId, chatId],
  );
  const feedback = useCallback(
    (messageId: string, value: "good" | "bad" | null) =>
      runtime.feedback(assistantId, chatId, messageId, value),
    [assistantId, chatId],
  );
  const selectResponse = useCallback(
    (groupId: string, messageId: string, layout: "tabs" | "split") =>
      runtime.selectResponse(assistantId, chatId, groupId, messageId, layout),
    [assistantId, chatId],
  );
  const remove = useCallback(
    (messageId: string) => runtime.remove(assistantId, chatId, messageId),
    [assistantId, chatId],
  );
  const generateVariant = useCallback(
    (
      sourceMessageId: string,
      groupId: string,
      providerId: string,
      modelId: string,
      replace: boolean,
      reasoningEffort?: string | null,
    ) =>
      runtime.generateVariant(
        assistantId,
        chatId,
        sourceMessageId,
        groupId,
        providerId,
        modelId,
        replace,
        reasoningEffort,
      ),
    [assistantId, chatId],
  );
  const stop = useCallback(() => runtime.stop(assistantId, chatId), [assistantId, chatId]);

  return {
    messages: slice.messages,
    streaming: slice.streaming,
    sending: slice.sending,
    error: slice.error,
    loaded: slice.loaded,
    send,
    clearContext,
    edit,
    feedback,
    selectResponse,
    remove,
    generateVariant,
    stop,
  };
}

/** Subscribe to just whether a conversation is generating (for list indicators). */
export function useConversationSending(assistantId: string, chatId: string): boolean {
  return useSyncExternalStore(runtime.subscribe, () => runtime.isSending(assistantId, chatId));
}
