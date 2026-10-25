import {RuntimeUnavailableError} from "./runtime-readiness";
import { headers } from "next/headers";
import { GatewayError } from "@orloj/skills-marketplace/gateway";
import { SkillPlanError } from "@orloj/skills-marketplace/install-plan";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { NoActiveTokenError } from "@/lib/session/registry";
import { RegistryUnreachableError, SelectionUnresolvableError } from "@/lib/session/mcp-servers";
import {
  agentDir,
  InvalidAgentIdError,
  TemplateUnavailableError,
  ZeroclawBinaryMissingError,
} from "@/lib/session/zeroclaw-config";

// These live outside the route files because Next.js route modules may only export route
// handlers and a fixed set of config values, and several routes need both.
const RUNTIME_UNAVAILABLE = { error: "Agent runtime unavailable on this host" };
const NOT_FOUND = { error: "Agent not found" };

export const authorizeAgent = async (
  id: string,
): Promise<{ userId: string } | Response> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) return ownership;
  // A malformed id cannot own anything, so it reads as a 404 like a non-owner.
  try {
    agentDir(id);
  } catch (err) {
    if (err instanceof InvalidAgentIdError) return Response.json(NOT_FOUND, { status: 404 });
    throw err;
  }
  return { userId: session.user.id };
};

export const errorResponse = (err: unknown): Response => {
  // 422 rather than the 409s below: the client has to act on this one specifically — send
  // the user back to the picker — so it branches on `code`, and no other session response
  // uses this status.
  if (err instanceof SelectionUnresolvableError) {
    return Response.json(
      {
        error: "None of the selected MCPs are in the registry",
        code: "selection_unresolvable",
        dropped: err.dropped,
      },
      { status: 422 },
    );
  }
  // The index named something we refuse to write. 422 rather than 502: the fetch succeeded,
  // so retrying is pointless — the published skill itself is the problem.
  if (err instanceof SkillPlanError) {
    return Response.json(
      {
        error: "Skill rejected by validation",
        code: "verification_failed",
        problems: err.problems,
      },
      { status: 422 },
    );
  }
  if (err instanceof GatewayError) {
    console.error("[session] 0G gateway", err);
    return err.kind === "verification"
      ? Response.json(
          { error: "Skill failed verification", code: "verification_failed" },
          { status: 422 },
        )
      : Response.json(
          { error: "0G Storage unreachable", code: "zg_unreachable" },
          { status: 502 },
        );
  }
  if (err instanceof NoActiveTokenError) {
    return Response.json({ error: "Agent has no active API key" }, { status: 409 });
  }
  if (err instanceof RegistryUnreachableError) {
    console.error("[session] registry manifest unreachable", err);
    return Response.json({ error: "Registry unreachable" }, { status: 502 });
  }
  if (err instanceof RuntimeUnavailableError || err instanceof ZeroclawBinaryMissingError || err instanceof TemplateUnavailableError) {
    console.error("[session] runtime unavailable", err);
    return Response.json(RUNTIME_UNAVAILABLE, { status: 503 });
  }
  console.error("[session] start failed", err);
  return Response.json({ error: "Failed to start session" }, { status: 500 });
};
