import { test } from "node:test";
import assert from "node:assert/strict";
import { composeCommand } from "./local-stack.mjs";
test("uses the official Compose plugin when available", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  };
  assert.deepEqual(composeCommand(run), {
    command: "docker",
    prefix: ["compose"],
  });
  assert.deepEqual(calls, [["docker", ["compose", "version"]]]);
});
test("falls back to the installed standalone Compose without changing Docker configuration", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: command === "docker-compose" ? 0 : 1 };
  };
  assert.deepEqual(composeCommand(run), {
    command: "docker-compose",
    prefix: [],
  });
  assert.equal(calls.length, 2);
});
test("reports missing Compose rather than attempting an installation or stack mutation", () => {
  assert.throws(
    () => composeCommand(() => ({ status: 1 })),
    /Compose is unavailable/,
  );
});
