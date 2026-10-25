export async function resetConversation(
  sessionId: string,
  reset: () => Promise<string>,
  restart: () => Promise<{ sessionId: string; acpSessionId: string }>,
): Promise<{ sessionId: string; acpSessionId: string }> {
  try {
    return { sessionId, acpSessionId: await reset() };
  } catch {
    // Only start a fresh context. There is deliberately no prompt/replay callback.
    return restart();
  }
}
