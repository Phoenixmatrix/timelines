// A prompt waiting for its conversation: addressed to one chat, taken once.

export interface QueuedPrompt {
  chatId: string;
  prompt: string;
}

export interface PromptQueue {
  /** Replaces whatever was waiting; blank prompts are ignored. */
  put(next: QueuedPrompt): boolean;
  /** The prompt for this chat, removed as it's taken; null for any other chat. */
  take(chatId: string): string | null;
  peek(): QueuedPrompt | null;
}

export function promptQueue(): PromptQueue {
  let waiting: QueuedPrompt | null = null;
  return {
    put(next) {
      if (!next.prompt.trim()) return false;
      waiting = next;
      return true;
    },
    take(chatId) {
      if (!waiting || waiting.chatId !== chatId) return null;
      const { prompt } = waiting;
      waiting = null;
      return prompt;
    },
    peek: () => waiting,
  };
}
