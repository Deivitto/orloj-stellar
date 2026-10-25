import { StellarProduct } from "@/components/stellar-product";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getAgentBranding } from "@/lib/agent-branding";
import { getAgentClient } from "@/lib/agent-client";
import { AgentAppBar, AgentAppSignIn } from "@/components/agent-app";
import { SessionView } from "@/components/session/session-view";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ lang: string; agentId: string }>;
}) {
  const { lang, agentId } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  // Signs in here rather than redirecting to /profile: this URL is the installed app's
  // start_url, and sending a standalone window to an out-of-scope page kicks it out of the app.
  if (!session) return <AgentAppSignIn />;

  const ownership = await assertAgentOwner(agentId, session.user.id);
  if (ownership !== true) notFound();

  // The name is cosmetic; a failing upstream must not block the chat.
  let agentName = agentId;
  try {
    const client = await getAgentClient();
    const { data } = await client.agents.get(agentId);
    if (data?.name) agentName = data.name;
  } catch {
    // fall back to the id
  }

  const branding = await getAgentBranding(agentId);

  // This URL is the agent app: it is the manifest's start_url and scope, so it is the only page
  // that can offer the install. AgentAppBar links the manifest itself — it has to be able to
  // bust it after the owner renames the app or changes its icon.
  // userId comes from the server session rather than useAuth(): the client auth context
  // exposes no user id, and the localStorage transcript key is scoped per user.
  return (
    <>
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <AgentAppBar
        agentId={agentId}
        agentName={agentName}
        appName={branding.appName}
        hasCustomIcon={Boolean(branding.iconPng)}
        lang={lang}
      />
      {process.env.ORLOJ_PRODUCT === "stellar" && (
        <StellarProduct agentId={agentId} />
      )}
      <SessionView
        agentId={agentId}
        agentName={agentName}
        userId={session.user.id}
        lang={lang}
      />
    </>
  );
}
