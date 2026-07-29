export interface PanelMessageRef {
  chatId: number;
  messageId: number;
}

// Shared Map<userId, ref> store behind menuMessages.ts and commands/panel.ts's createPanel (used by
// /schedule's and /admin's panels) — each private-chat panel (personal menu, /schedule, /admin)
// tracks its own one-message-per-user slot, and the underlying storage shape and operations were
// identical across all three.
export function createPanelMessageStore<Ref extends PanelMessageRef>() {
  const messages = new Map<number, Ref>();

  return {
    set(userId: number, ref: Ref): void {
      messages.set(userId, ref);
    },
    get(userId: number): Ref | undefined {
      return messages.get(userId);
    },
    clear(userId: number): void {
      messages.delete(userId);
    },
  };
}
