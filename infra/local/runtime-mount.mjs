import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
const uuid = (s) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
// Optional native-app mode: expose exactly one agent directory at the identical
// absolute path. Never mount the agents root, app checkout or a secret directory.
export function runtimeMount(id, instance, env = process.env) {
  if (!uuid(id) || !uuid(instance)) throw Error("Invalid runtime identity");
  if (!env.AGENT_BIND_ROOT)
    return {
      directory: `/agents/${id}`,
      user: "1000:1000",
      mount: `type=volume,src=${env.AGENT_VOLUME ?? "orloj-agent-state"},dst=/agents/${id},volume-subpath=${id}`,
    };
  const root = path.resolve(env.AGENT_BIND_ROOT),
    directory = path.join(root, id);
  if (
    root === "/" ||
    root.includes(",") ||
    realpathSync(root) !== root ||
    realpathSync(directory) !== directory
  )
    throw Error("Invalid agent mount");
  if(Buffer.byteLength(directory)>70)throw Error("Agent directory is too long for runtime IPC; configure a shorter root");
  const info = statSync(directory),
    stamp = JSON.parse(
      readFileSync(path.join(directory, ".orloj-owner.json"), "utf8"),
    );
  if (!info.isDirectory() || info.uid === 0 || stamp.instanceId !== instance)
    throw Error("Agent mount identity mismatch");
  return {
    directory,
    user: `${info.uid}:${info.gid}`,
    mount: `type=bind,src=${directory},dst=${directory}`,
  };
}
