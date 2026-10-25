"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { UIMessage } from "ai";
import { useT } from "@/components/i18n-context";
import { Btn } from "@/components/ornaments";
import { ChatBox } from "./chat-box";
import { McpConfigPanel, type ApplyResult, type McpSelectionItem } from "./mcp-config-panel";
import { SkillConfigPanel, type SkillApplyResult } from "./skill-config-panel";
import { McpPicker } from "./mcp-picker";
import { readTranscript, writeTranscript } from "./transcript-store";

type Phase = "loading" | "wizard" | "starting" | "chat" | "error";

type StartResponse = {
  sessionId: string;
  acpSessionId: string;
  resumed: boolean;
  mcps: McpSelectionItem[];
  // Selected MCPs the registry no longer publishes. On success they were pruned and the
  // session started without them; on a 422 nothing was left to start.
  dropped?: string[];
  error?: string;
  code?: string;
};

// Same mapping in both start paths, so an unreachable registry or a keyless agent reads the
// same whether it surfaced from the wizard or from an automatic resume.
const messageForStatus = (
  status: number,
  fallback: string | undefined,
  t: (k: string) => string,
): string => {
  if (status === 503) return t("session.errorRuntime");
  if (status === 409) return t("session.errorNoKey");
  if (status === 502) return t("session.errorRegistry");
  return fallback ?? t("session.errorStart");
};

// Says which MCPs vanished from the registry. `allGone` is the wizard's variant, where the
// selection pruned to nothing and there is no session to speak of yet; otherwise the session
// is running and this is dismissable.
function DroppedNotice({
  names,
  allGone,
  onDismiss,
}: {
  names: string[];
  allGone?: boolean;
  onDismiss?: () => void;
}) {
  const t = useT();
  if (names.length === 0) return null;
  return (
    <div
      style={{
        border: "1px solid rgba(138,53,38,0.28)",
        background: "rgba(138,53,38,0.07)",
        padding: 12,
        fontSize: 12.5,
        color: "var(--ink)",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        marginBottom: allGone ? 16 : 0,
      }}
    >
      <div style={{ flex: 1 }}>
        <div>
          {allGone
            ? t("session.mcpsAllGone")
            : t("session.mcpsDropped", { n: names.length })}
        </div>
        <div
          style={{
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: 11.5,
            color: "var(--ink-soft)",
            marginTop: 6,
            wordBreak: "break-all",
          }}
        >
          {names.join(", ")}
        </div>
      </div>
      {onDismiss ? (
        <Btn size="sm" kind="ghost" onClick={onDismiss}>
          {t("session.mcpsDroppedDismiss")}
        </Btn>
      ) : null}
    </div>
  );
}

export function SessionView({
  agentId,
  agentName,
  userId,
  lang,
}: {
  agentId: string;
  agentName: string;
  userId: string;
  lang: string;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mcps, setMcps] = useState<McpSelectionItem[]>([]);
  // Skills are not part of a session start payload — they are whatever is on disk — so this
  // is hydrated from its own endpoint rather than from StartResponse.
  const [skills, setSkills] = useState<string[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [restored, setRestored] = useState<UIMessage[]>([]);
  const [divider, setDivider] = useState(false);
  const [turnBusy, setTurnBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [dropped, setDropped] = useState<string[]>([]);
  // The stored selection resolved to nothing, so the wizard is standing in for a broken
  // configured agent rather than a first run. POST /api/session would keep reading that same
  // dead selection, so the re-pick has to go through PUT /api/agents/[id]/mcps.
  const [repick, setRepick] = useState(false);
  const [ending, setEnding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // Filled by ChatBox while it is mounted; the seam Reset uses to empty the thread without
  // remounting it.
  const clearChat = useRef<(() => void) | null>(null);

  // Shared by both start paths so a session begun by the wizard, by an automatic resume or by
  // a post-failure re-pick lands in exactly the same state.
  const enterChat = useCallback(
    (payload: StartResponse, storedMessages: UIMessage[]) => {
      setSessionId(payload.sessionId);
      setMcps(payload.mcps);
      setSelection(payload.mcps.map((m) => m.mcpName));
      setDropped(payload.dropped ?? []);
      setRepick(false);
      setRestored(storedMessages);
      // Honest about a session that aged out or a wiped dir: without the divider the UI
      // shows history the agent cannot see, and the user finds out by being contradicted.
      setDivider(!payload.resumed && storedMessages.length > 0);
      writeTranscript(userId, agentId, {
        acpSessionId: payload.acpSessionId,
        messages: storedMessages,
      });
      setPhase("chat");
      // Fire-and-forget: the panel is useful the moment the chat renders, and a failure here
      // must not block entering it. Skills are read from disk, not from the start payload.
      void fetch(`/api/agents/${agentId}/skills`)
        .then((r) => (r.ok ? (r.json() as Promise<{ skills?: string[] }>) : null))
        .then((d) => {
          if (d) setSkills(d.skills ?? []);
        })
        .catch(() => {});
    },
    [agentId, userId],
  );

  // Every selected MCP is gone from the registry. Not an error the user can retry out of —
  // strip the dead names and put them back in the picker, which is the only thing that can
  // move them forward.
  const toRepick = useCallback((gone: string[]) => {
    setSelection((prev) => prev.filter((n) => !gone.includes(n)));
    setDropped(gone);
    setRepick(true);
    setError(null);
    setPhase("wizard");
  }, []);

  const start = useCallback(
    async (mcpNames: string[] | undefined, freshContext = false) => {
      // localStorage is read here, in a callback — never during render, which would be a
      // hydration mismatch under Next 16's server render of this component.
      const stored = readTranscript(userId, agentId);
      setPendingCount(mcpNames ? mcpNames.length : mcps.length);
      setPhase("starting");
      setError(null);
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            ...(mcpNames ? { mcpNames } : {}),
            ...(!freshContext && stored.acpSessionId ? { acpSessionId: stored.acpSessionId } : {}),
          }),
        });
        const payload = (await res.json()) as StartResponse;
        if (!res.ok) {
          if (payload.code === "selection_unresolvable") {
            toRepick(payload.dropped ?? []);
            return;
          }
          setError(messageForStatus(res.status, payload.error, t));
          setPhase("error");
          return;
        }
        enterChat(payload, stored.messages);
      } catch {
        setError(t("session.errorStart"));
        setPhase("error");
      }
    },
    [agentId, userId, mcps.length, t, enterChat, toRepick],
  );

  // The re-pick path. PUT is the endpoint that accepts a new selection for an agent that is
  // already configured — POST /api/session deliberately lets the stored selection win, which
  // is exactly what cannot be honoured here.
  const applyRepick = useCallback(
    async (mcpNames: string[]) => {
      const stored = readTranscript(userId, agentId);
      setPendingCount(mcpNames.length);
      setPhase("starting");
      setError(null);
      try {
        const res = await fetch(`/api/agents/${agentId}/mcps`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mcpNames }),
        });
        const payload = (await res.json()) as StartResponse;
        if (!res.ok) {
          if (payload.code === "selection_unresolvable") {
            toRepick(payload.dropped ?? []);
            return;
          }
          setError(messageForStatus(res.status, payload.error, t));
          setPhase("error");
          return;
        }
        enterChat(payload, stored.messages);
      } catch {
        setError(t("session.errorStart"));
        setPhase("error");
      }
    },
    [agentId, userId, t, enterChat, toRepick],
  );

  // Mount: is this agent configured yet? No sync setState in the effect body.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    let live = true;
    fetch(`/api/agents/${agentId}/mcps`)
      .then(
        (r) =>
          r.json() as Promise<{
            configured?: boolean;
            mcps?: McpSelectionItem[];
          }>,
      )
      .then((d) => {
        if (!live) return;
        if (d.configured) {
          setMcps(d.mcps ?? []);
          setSelection((d.mcps ?? []).map((m) => m.mcpName));
          void start(undefined);
        } else {
          // First run opens the wizard with nothing checked — the picker lists the full
          // registry, and every agent may use all of it.
          setPhase("wizard");
        }
      })
      .catch(() => {
        if (live) {
          setError(t("session.errorStart"));
          setPhase("error");
        }
      });
    return () => {
      live = false;
    };
  }, [agentId, start, t]);

  const persist = useCallback(
    (messages: UIMessage[]) => {
      const stored = readTranscript(userId, agentId);
      writeTranscript(userId, agentId, { acpSessionId: stored.acpSessionId, messages });
    },
    [userId, agentId],
  );

  const onApplied = useCallback(
    (result: ApplyResult) => {
      setSessionId(result.sessionId);
      setMcps(result.mcps);
      setSelection(result.mcps.map((m) => m.mcpName));
      setDropped(result.dropped ?? []);
      setDivider(!result.resumed);
      const stored = readTranscript(userId, agentId);
      writeTranscript(userId, agentId, {
        acpSessionId: result.acpSessionId,
        messages: stored.messages,
      });
    },
    [userId, agentId],
  );

  // The respawn issues a fresh sessionId, so dropping the rest of the payload would leave the
  // client posting to a session that no longer exists. `mcps` rides along because the route
  // re-applies the stored MCP selection on the way through.
  const onSkillsApplied = useCallback((result: SkillApplyResult) => {
    setSessionId(result.sessionId);
    setSkills(result.skills);
    setMcps(result.mcps);
    setDivider(!result.resumed);
  }, []);

  // Reset keeps the agent connected and forgets the conversation. It is the one control here
  // that destroys something the user cannot get back, so it confirms.
  const doReset = async () => {
    if (!sessionId) return;
    if (!window.confirm(t("session.resetConfirm"))) return;
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch(`/api/session/${sessionId}/reset`, { method: "POST" });
      if (!res.ok) {
        // A reset that fails silently is indistinguishable from a button that does nothing.
        setResetError(
          res.status === 410
            ? t("session.expired")
            : res.status === 409
              ? t("session.resetBusy")
              : t("session.resetFailed"),
        );
        return;
      }
      const { acpSessionId, sessionId: nextSessionId } = (await res.json()) as { acpSessionId: string; sessionId: string };
      writeTranscript(userId, agentId, { acpSessionId, messages: [] });
      setRestored([]);
      setDivider(false);
      // Clear in place for a healthy child; switch transport if recovery respawned it.
      clearChat.current?.();
      if (nextSessionId !== sessionId) setSessionId(nextSessionId);
    } catch {
      setResetError(t("session.resetFailed"));
    } finally {
      setResetting(false);
    }
  };

  // End session disconnects and keeps nothing running.
  const doEnd = async () => {
    if (!sessionId) return;
    setEnding(true);
    try {
      await fetch(`/api/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // best effort; the sweeper is the backstop
    } finally {
      setEnding(false);
      setSessionId(null);
      setPhase("wizard");
    }
  };

  const backLink = (
    <Link
      href={`/${lang}/profile?tab=agents`}
      style={{ fontSize: 12.5, color: "var(--ink-soft)", textDecoration: "none" }}
    >
      {t("session.back")}
    </Link>
  );

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 20px 56px" }}>
      <div style={{ marginBottom: 8 }}>{backLink}</div>
      <h1
        className="smallcaps"
        style={{ fontSize: 22, color: "var(--ink)", margin: "0 0 20px" }}
      >
        {t("session.title", { name: agentName })}
      </h1>

      {phase === "loading" ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{t("session.loading")}</div>
      ) : null}

      {phase === "wizard" ? (
        <div style={{ border: "1px solid var(--line)", padding: 20 }}>
          {repick ? <DroppedNotice names={dropped} allGone /> : null}
          <McpPicker
            selected={selection}
            onChange={setSelection}
            title={t("session.wizardTitle")}
            subtitle={t("session.wizardSubtitle")}
            action={{
              label: t("session.wizardStart"),
              onClick: () => void (repick ? applyRepick(selection) : start(selection)),
            }}
          />
        </div>
      ) : null}

      {phase === "starting" ? (
        <div style={{ border: "1px solid var(--line)", padding: 20, fontSize: 13 }}>
          {/* Not fast: with acp_enable_mcp on, session/new pays the MCP connection cost for
              every server in the bundle before it returns. */}
          {pendingCount > 0
            ? t("session.connecting", { n: pendingCount })
            : t("session.connectingNone")}
        </div>
      ) : null}

      {phase === "error" ? (
        <div
          style={{
            border: "1px solid rgba(138,53,38,0.35)",
            background: "rgba(138,53,38,0.10)",
            padding: 16,
            fontSize: 13,
            color: "var(--wine)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{error ?? t("session.errorStart")}</span>
          <Btn size="sm" kind="ghost" onClick={() => setPhase("wizard")}>
            {t("session.restart")}
          </Btn>
        </div>
      ) : null}

      {phase === "chat" && sessionId ? (
        <ChatBox
          key={sessionId}
          sessionId={sessionId}
          initialMessages={restored}
          divider={divider}
          onMessages={persist}
          onExpired={() => void start(undefined, true)}
          onBusyChange={setTurnBusy}
          clearRef={clearChat}
          header={
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* The session started without these, and the stored selection was rewritten
                  without them, so this is the only moment the user can be told. */}
              <DroppedNotice names={dropped} onDismiss={() => setDropped([])} />
              <McpConfigPanel
                agentId={agentId}
                mcps={mcps}
                busy={turnBusy}
                onApplied={onApplied}
              />
              {/* Keyed on the installed set: the panel seeds its checkbox selection from
                  `skills` once, at mount, but `skills` arrives from its own fetch after the
                  chat renders. Without the key the picker would open pre-ticked with the
                  empty initial value. */}
              <SkillConfigPanel
                key={skills.join(",")}
                agentId={agentId}
                skills={skills}
                busy={turnBusy}
                onApplied={onSkillsApplied}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Btn
                  size="sm"
                  kind="ghost"
                  disabled={turnBusy || resetting}
                  onClick={() => void doReset()}
                >
                  {resetting ? t("session.resetting") : t("session.reset")}
                </Btn>
                <Btn
                  size="sm"
                  kind="ghost"
                  disabled={ending}
                  onClick={() => void doEnd()}
                  style={{ color: "var(--wine)" }}
                >
                  {ending ? t("session.ending") : t("session.end")}
                </Btn>
              </div>
              {resetError ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--wine)",
                    textAlign: "right",
                  }}
                >
                  {resetError}
                </div>
              ) : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
}
