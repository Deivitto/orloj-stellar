import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PermissionOption,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  runtimeEnvironment,
  sessionTimeoutSecs,
  zeroclawBin,
  ZeroclawBinaryMissingError,
} from "./zeroclaw-config";

export type ChunkSink = (text: string) => void;

const STDERR_TAIL_BYTES = 8 * 1024;

export class ZeroClawAcpSession {
  private readonly configDir: string;
  private readonly workspaceDir: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private chunkSink: ChunkSink | null = null;
  private stderrBuf = "";
  private exited = false;
  acpSessionId: string | null = null;

  constructor(opts: { configDir: string; workspaceDir: string }) {
    this.configDir = opts.configDir;
    this.workspaceDir = opts.workspaceDir;
  }

  providerConfigDir(): string {
    return this.configDir;
  }

  stderrTail(): string {
    return this.stderrBuf;
  }

  async spawn(): Promise<void> {
    const args = [
      "acp",
      "--config-dir",
      this.configDir,
      "--max-sessions",
      "1",
      "--session-timeout",
      String(sessionTimeoutSecs()),
    ];
    if (
      process.env.ORLOJ_PRODUCT === "stellar" &&
      !process.env.RUNTIME_BROKER_URL
    )
      throw new ZeroclawBinaryMissingError("isolated runtime broker");
    const child = spawn(zeroclawBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnvironment(),
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.exited = true;
        reject(
          err.code === "ENOENT"
            ? new ZeroclawBinaryMissingError(zeroclawBin())
            : err,
        );
      };
      child.once("error", onError);
      // No ready signal on stdout before initialize, so a spawn is "up" once the process
      // exists and has not immediately died. A bad config surfaces at initialize instead.
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });

    child.stderr.setEncoding("utf8");
    // Ring buffer, not per-line logging: zeroclaw is chatty and the tail is what an error
    // report needs.
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on("exit", () => {
      this.exited = true;
    });
    child.on("error", () => {
      this.exited = true;
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection(() => this.handler(), stream);
  }

  private handler(): Client {
    return {
      // Stellar requests fail closed; contract approvals use the owner signing channel.
      // Legacy behavior remains available for EVM sessions. Never a
      // reject outcome — this is the seam an approval UI would replace.
      requestPermission: (params: RequestPermissionRequest) => {
        const opts = params.options ?? [];
        if (process.env.ORLOJ_PRODUCT === "stellar")
          return { outcome: { outcome: "cancelled" as const } };
        const pick =
          opts.find((o: PermissionOption) => o.kind === "allow_always") ??
          opts.find((o: PermissionOption) => o.kind === "allow_once") ??
          opts[0];
        return pick
          ? {
              outcome: {
                outcome: "selected" as const,
                optionId: pick.optionId,
              },
            }
          : { outcome: { outcome: "cancelled" as const } };
      },
      sessionUpdate: (params: SessionNotification) => {
        const update = params.update;
        if (update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content;
        if (content.type === "text") this.chunkSink?.(content.text);
      },
    };
  }

  private conn(): ClientSideConnection {
    if (!this.connection) throw new Error("ACP connection not started");
    return this.connection;
  }

  initialize(): Promise<InitializeResponse> {
    return this.conn().initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  }

  // `agentAlias` is not in the ACP schema — zeroclaw reads it as an extension. Passed
  // explicitly: omitting it is what produces `session/new requires agentAlias` the moment a
  // second [agents.*] entry appears in the template.
  private newSessionParams(): NewSessionRequest {
    return {
      cwd: this.workspaceDir,
      // Empty by design: initialize reports mcpCapabilities { http: false, sse: false }, so
      // zeroclaw accepts no HTTP MCP servers over the handshake at all. config.toml is the
      // only path.
      mcpServers: [],
      agentAlias: "default",
    } as NewSessionRequest & { agentAlias: string };
  }

  async newSession(): Promise<string> {
    const res = await this.conn().newSession(this.newSessionParams());
    this.acpSessionId = res.sessionId;
    return res.sessionId;
  }

  // Resolves false on a not-found-class error so the caller falls back to newSession rather
  // than surfacing an error for the ordinary case of an aged-out session.
  async loadSession(
    acpSessionId: string,
    onChunk?: ChunkSink,
  ): Promise<boolean> {
    this.chunkSink = onChunk ?? null;
    try {
      await this.conn().loadSession({
        ...this.newSessionParams(),
        sessionId: acpSessionId,
      } as LoadSessionRequest);
      this.acpSessionId = acpSessionId;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|unknown session|no such session|expired/i.test(msg))
        return false;
      throw err;
    } finally {
      this.chunkSink = null;
    }
  }

  // The close is mandatory, not hygiene: skipping it fails with
  // `-32001 Maximum session limit reached (1)` under --max-sessions 1. Keeping the process
  // is the whole point — Reset does not pay the MCP reconnection cost.
  async resetSession(): Promise<string> {
    if (this.acpSessionId) {
      await this.conn().closeSession({ sessionId: this.acpSessionId });
      this.acpSessionId = null;
    }
    return this.newSession();
  }

  async prompt(text: string, onChunk: ChunkSink): Promise<string> {
    if (!this.acpSessionId) throw new Error("No ACP session");
    if (this.exited) throw new Error("Agent process is not running");
    this.chunkSink = onChunk;
    try {
      const res = await this.conn().prompt({
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      return res.stopReason;
    } finally {
      this.chunkSink = null;
    }
  }

  async cancel(): Promise<void> {
    if (!this.acpSessionId || !this.connection || this.exited) return;
    try {
      await this.connection.cancel({ sessionId: this.acpSessionId });
    } catch {
      // A cancel that cannot be delivered is not worth failing the request over.
    }
  }

  destroy(): void {
    this.chunkSink = null;
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.exited = true;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    child.kill("SIGTERM");
    // Escalate if it ignores SIGTERM; unref so a pending timer cannot hold the event loop.
    const t = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
    t.unref();
  }
}
