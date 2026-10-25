import { test } from "node:test";
import assert from "node:assert/strict";
import {
  statSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeMount } from "./runtime-mount.mjs";
test("volume mode keeps a single agent subpath", () => {
  const id = randomUUID(),
    instance = randomUUID();
  const m = runtimeMount(id, instance, {});
  assert.equal(m.directory, "/agents/" + id);
  assert.match(m.mount, new RegExp("volume-subpath=" + id + "$"));
  assert.throws(() => runtimeMount("../secret", instance, {}));
});
test("native mode rejects symlink escapes and stale instance stamps", () => {
  const root = realpathSync(
      mkdtempSync(
        path.join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          "orloj-mount-",
        ),
      ),
    ),
    id = randomUUID(),
    instance = randomUUID(),
    directory = path.join(root, id);
  try {
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, ".orloj-owner.json"),
      JSON.stringify({ instanceId: instance }),
    );
    if (process.getuid() !== 0) {
      const m = runtimeMount(id, instance, { AGENT_BIND_ROOT: root });
      assert.equal(m.directory, directory);
      assert.equal(
        m.user,
        `${statSync(directory).uid}:${statSync(directory).gid}`,
      );
      assert.equal(m.mount, `type=bind,src=${directory},dst=${directory}`);
    }
    assert.throws(() =>
      runtimeMount(id, randomUUID(), { AGENT_BIND_ROOT: root }),
    );
    const other = randomUUID();
    symlinkSync(directory, path.join(root, other));
    assert.throws(() =>
      runtimeMount(other, instance, { AGENT_BIND_ROOT: root }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects overlong native paths before spawning the IPC runtime", () => {
  const root = realpathSync(
      mkdtempSync(
        path.join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          "orloj-mount-",
        ),
      ),
    ),
    id = randomUUID(),
    instance = randomUUID(),
    deep = path.join(root, "long-directory-prefix-for-runtime-ipc"),
    directory = path.join(deep, id);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, ".orloj-owner.json"),
      JSON.stringify({ instanceId: instance }),
    );
    assert.throws(
      () => runtimeMount(id, instance, { AGENT_BIND_ROOT: deep }),
      /too long/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
