import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { auth } from "@/lib/auth";
import { getSession, touch, currentSessionOwner } from "@/lib/session/registry";

// Parity with hosts that honour it; inert on a self-hosted Node server.
export const maxDuration = 300;

const MAX_CHARS = 8000;

const textOf = (message: UIMessage): string =>
  (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // The AI SDK's documented send-only-the-last-message shape. The ACP session is the
  // history, so posting the whole array every turn would ship data nobody reads.
  const message = (body as { message?: UIMessage })?.message;
  if (!message || typeof message !== "object") {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }
  const text = textOf(message);
  if (text.length < 1 || text.length > MAX_CHARS) {
    return Response.json(
      { error: "Message must be 1–8000 characters" },
      { status: 400 },
    );
  }

  // Absent or foreign reads the same: the UI renders it as "Restart session".
  const entry = getSession(id, session.user.id);
  if (!entry || !(await currentSessionOwner(entry)))
    return Response.json({ error: "Session expired" }, { status: 410 });
  if (entry.busy)
    return Response.json({ error: "Session busy" }, { status: 409 });

  entry.busy = true;
  touch(entry);

  // A stop button or a closed tab must free the session: without the cancel it stays busy
  // until the model finishes a turn nobody is reading, and every further prompt 409s.
  const onAbort = () => {
    void entry.session.cancel();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  const stream = createUIMessageStream({
    onError: (err) => (err instanceof Error ? err.message : "Agent error"),
    execute: async ({ writer }) => {
      const textId = randomUUID();
      writer.write({ type: "text-start", id: textId });
      try {
        await entry.session.prompt(text, (delta) => {
          writer.write({ type: "text-delta", id: textId, delta });
        });
        writer.write({ type: "text-end", id: textId });
      } catch (err) {
        writer.write({ type: "text-end", id: textId });
        writer.write({
          type: "error",
          errorText: err instanceof Error ? err.message : "Agent error",
        });
        // A dead child cannot serve another turn; drop it so the next POST 410s and the UI
        // offers a restart instead of hanging.
        entry.session.destroy();
      } finally {
        entry.busy = false;
        touch(entry);
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
