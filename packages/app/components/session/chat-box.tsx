"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "@/components/i18n-context";
import { Btn } from "@/components/ornaments";

// react-markdown does not render raw HTML unless rehype-raw is added, and it strips
// javascript: URLs by default — so agent output cannot inject markup here. The one thing
// left to harden is the link target: these URLs come from a model, so they leave the tab
// without handing it a window.opener.
// Props are picked rather than spread: react-markdown also passes the mdast `node`, which
// React would forward to the DOM as node="[object Object]".
const mdComponents: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

const textOf = (m: UIMessage): string =>
  (m.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

const endSessionOnServer = (sessionId: string): void => {
  void fetch(`/api/session/${sessionId}`, { method: "DELETE", keepalive: true }).catch(
    () => undefined,
  );
};

// Module-scoped so it survives a remount: React only preserves component state across Strict
// Mode's simulated unmount, not across a real one, and the whole point here is to recognise a
// mount that follows a teardown for the same session.
const pendingTeardown = new Map<string, ReturnType<typeof setTimeout>>();
const TEARDOWN_GRACE_MS = 1000;

export function ChatBox({
  sessionId,
  initialMessages,
  divider,
  onMessages,
  onExpired,
  header,
  onBusyChange,
  clearRef,
}: {
  sessionId: string;
  initialMessages: UIMessage[];
  divider: boolean;
  onMessages: (messages: UIMessage[]) => void;
  onExpired: () => void;
  header: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
  clearRef?: React.RefObject<(() => void) | null>;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const [expired, setExpired] = useState(false);

  // Keyed on sessionId: a re-POST after Apply targets a new session id, and the transport
  // holds the URL. `prepareSendMessagesRequest` trims the body to the last user message —
  // the ACP session is the history, so the default (whole array) would be dead weight.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `/api/session/${sessionId}/chat`,
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: { id, message: messages[messages.length - 1] },
        }),
      }),
    [sessionId],
  );

  const { messages, sendMessage, status, stop, error, setMessages, clearError } = useChat<UIMessage>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onError: (err) => {
      if (/410|expired/i.test(err.message)) setExpired(true);
    },
  });

  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // One write per settled turn, not per delta.
  const lastPersisted = useRef<number>(-1);
  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    if (messages.length === lastPersisted.current) return;
    lastPersisted.current = messages.length;
    onMessages(messages);
  }, [status, messages, onMessages]);

  // Reset empties the thread in place rather than by remounting this component: a remount
  // runs the teardown below, and killing the session is the one thing Reset must not do —
  // it exists to keep the process and its warm MCP connections.
  useEffect(() => {
    if (!clearRef) return;
    clearRef.current = () => {
      setMessages([]);
      setExpired(false);
      clearError();
      // The caller has already written the empty transcript, so the persist effect has
      // nothing left to do; without this it would fire once more on the way down to zero.
      lastPersisted.current = 0;
    };
    return () => {
      clearRef.current = null;
    };
  }, [clearRef, setMessages, clearError]);

  // Best-effort teardown so a closed tab does not leave a zeroclaw process alive until the
  // sweeper notices. Two paths, because neither covers the other:
  //   - `pagehide` for a closed or navigated-away tab, which never unmounts. `keepalive`,
  //     not navigator.sendBeacon — sendBeacon can only POST, so it cannot reach a DELETE
  //     route at all.
  //   - a deferred unmount teardown for an in-app teardown, cancelled by any mount that
  //     follows for the same session. Deleting straight from the cleanup would destroy a
  //     live session on every remount — and Strict Mode remounts this component on mount in
  //     dev, so the session died before the first message was ever sent.
  useEffect(() => {
    const scheduled = pendingTeardown.get(sessionId);
    if (scheduled) {
      clearTimeout(scheduled);
      pendingTeardown.delete(sessionId);
    }
    const onPageHide = () => endSessionOnServer(sessionId);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      pendingTeardown.set(
        sessionId,
        setTimeout(() => {
          pendingTeardown.delete(sessionId);
          endSessionOnServer(sessionId);
        }, TEARDOWN_GRACE_MS),
      );
    };
  }, [sessionId]);

  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const contextDivider = (
    <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 11.5,
              color: "var(--ink-soft)",
            }}
          >
            <span style={{ flex: 1, borderTop: "1px dashed var(--line)" }} />
            <span className="smallcaps">{t("session.dividerContextReset")}</span>
            <span style={{ flex: 1, borderTop: "1px dashed var(--line)" }} />
          </div>
  );

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {header}

      <div
        ref={scroller}
        style={{
          border: "1px solid var(--line)",
          padding: 16,
          minHeight: 320,
          maxHeight: "58vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >

        {messages.map((m, index) => {
          const mine = m.role === "user";
          const body = textOf(m);
          if (!body) return null;
          return (
            <Fragment key={m.id}>
            {divider && index === initialMessages.length ? contextDivider : null}
            <div
              className={mine ? undefined : "chat-md"}
              style={{
                alignSelf: mine ? "flex-end" : "flex-start",
                maxWidth: "82%",
                minWidth: 0,
                padding: "9px 13px",
                fontSize: 13.5,
                lineHeight: 1.55,
                // Only the user's own text is verbatim. Agent replies are markdown, and
                // pre-wrap on the bubble would put a blank line between every block.
                whiteSpace: mine ? "pre-wrap" : undefined,
                // Chat content is addresses, tx hashes and bare URLs — single "words" far wider
                // than the bubble. `anywhere` rather than `break-word` so the break also counts
                // towards min-content width, which is what keeps the flex item itself in bounds.
                overflowWrap: "anywhere",
                color: "var(--ink)",
                background: mine ? "rgba(184,137,58,0.12)" : "transparent",
                border: `1px solid ${mine ? "rgba(184,137,58,0.45)" : "var(--line)"}`,
              }}
            >
              {mine ? (
                body
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {body}
                </ReactMarkdown>
              )}
            </div>
            </Fragment>
          );
        })}
        {divider && messages.length === initialMessages.length ? contextDivider : null}

        {busy ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
            {t("session.thinking")}
          </div>
        ) : null}

        {expired ? (
          <div
            style={{
              border: "1px solid rgba(138,53,38,0.35)",
              background: "rgba(138,53,38,0.10)",
              padding: 12,
              fontSize: 13,
              color: "var(--wine)",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>{t("session.expired")}</span>
            <Btn size="sm" kind="ghost" onClick={onExpired}>
              {t("session.restart")}
            </Btn>
          </div>
        ) : error && !expired ? (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--wine)" }}>
            <p>{error.message}</p>
            <Btn size="sm" kind="ghost" onClick={onExpired}>Restart chat context</Btn>
            <p>Your visible transcript and MCP selection are retained. This does not repeat the failed request.</p>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy || expired}
          rows={2}
          placeholder={t("session.composerPlaceholder")}
          style={{
            flex: 1,
            resize: "vertical",
            padding: "10px 12px",
            fontSize: 13.5,
            fontFamily: "var(--font-ui)",
            background: "transparent",
            color: "var(--ink)",
            border: "1px solid var(--line)",
          }}
        />
        {busy ? (
          <Btn size="sm" kind="ghost" onClick={() => void stop()}>
            {t("session.stop")}
          </Btn>
        ) : (
          <Btn size="sm" kind="brass" disabled={expired || !input.trim()} onClick={submit}>
            {t("session.send")}
          </Btn>
        )}
      </div>
    </div>
  );
}
