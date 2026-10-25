const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-orloj-local-test": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_code ?? "REQUEST_FAILED");
  return data;
}
let signing = false;
$("connect").onclick = async () => {
  try {
    $("status").textContent = "Connect this wallet in Freighter.";
    const installed = await freighterApi.isConnected();
    if (!installed.isConnected) throw new Error("FREIGHTER_NOT_FOUND");
    const access = await freighterApi.requestAccess();
    if (access.error || !access.address)
      throw new Error("WALLET_ACCESS_DENIED");
    const network = await freighterApi.getNetwork();
    await api("connect", {
      address: access.address,
      networkPassphrase: network.networkPassphrase,
    });
    $("connect").disabled = true;
    $("run").disabled = false;
    $("status").textContent =
      "Wallet connected on Testnet. Ready for the test.";
  } catch (e) {
    $("status").textContent = e.message;
  }
};
$("run").onclick = async () => {
  try {
    $("run").disabled = true;
    await api("run", {});
    $("status").textContent =
      "Testing through MCP; a Freighter signing request will appear shortly.";
  } catch (e) {
    $("status").textContent = e.message;
  }
};
async function poll() {
  try {
    const state = await api("state");
    $("wallet").textContent = "Expected wallet: " + state.wallet;
    if (state.assetRecipient) {
      $("intro").textContent = "Stellar Testnet · One XLM transfer through MCP";
      $("description").textContent =
        "Send 0.0000001 testnet XLM to " +
        state.assetRecipient +
        ". Freighter keeps your private key. The test confirms the transfer and verifies duplicate requests do not submit again. A small testnet fee also applies.";
      $("run").textContent = "Run testnet XLM transfer";
    }
    if (state.started) {
      $("results").textContent = JSON.stringify(state.results, null, 2);
      if (state.done)
        $("status").textContent = state.ok
          ? "Test passed: confirmed once, duplicate reconciled."
          : "Test stopped. See the sanitized result below.";
    }
    if (!signing && state.started && !state.done) {
      const job = await api("signing");
      if (job.request) {
        signing = true;
        try {
          $("status").textContent =
            "Review the Testnet request in Freighter. Approve within 45 seconds.";
          const r = job.request;
          const result =
            r.kind === "transaction"
              ? await freighterApi.signTransaction(r.payload, {
                  networkPassphrase: r.networkPassphrase,
                  address: r.address,
                })
              : await freighterApi.signAuthEntry(r.payload, {
                  address: r.address,
                });
          await api("signed", { id: r.id, result });
        } catch {
          await api("signed", {
            id: job.request.id,
            result: { error: true },
          }).catch(() => {});
        } finally {
          signing = false;
        }
      }
    }
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    setTimeout(poll, 500);
  }
}
poll();
