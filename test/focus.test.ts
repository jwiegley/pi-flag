import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFocus,
  estimateTextTokens,
  serializeFocus,
  verifyFocusProjection,
  type SerializedFocus,
} from "../src/focus.ts";
import type { ActiveFlag } from "../src/state.ts";

function activeFlag(
  entryId: string,
  activationIndex: number,
  textBlocks: string[],
  role: "user" | "assistant" = "user",
): ActiveFlag {
  return {
    entryId,
    role,
    sourceTimestamp: `source-${entryId}`,
    flaggedAt: `flagged-${entryId}-${activationIndex}`,
    textBlocks,
    activationIndex,
    ...(role === "assistant" ? { assistantStopReason: "stop" as const } : {}),
  };
}

function observations(focus: SerializedFocus): unknown {
  const start = focus.block.indexOf("[");
  const end = focus.block.lastIndexOf("\n<!-- pi-flag:");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return JSON.parse(focus.block.slice(start, end));
}

test("serializes fresh observations in activation order", () => {
  const first = activeFlag("first", 0, ["alpha"]);
  const second = activeFlag("second", 1, ["", "beta"], "assistant");
  const active = new Map<string, ActiveFlag>([
    [second.entryId, second],
    [first.entryId, first],
  ]);
  const before = structuredClone([first, second]);

  const focus = serializeFocus(active, "session");
  assert.deepEqual(observations(focus), [
    {
      entryId: "first",
      role: "user",
      sourceTimestamp: "source-first",
      flaggedAt: "flagged-first-0",
      textBlocks: ["alpha"],
    },
    {
      entryId: "second",
      role: "assistant",
      sourceTimestamp: "source-second",
      flaggedAt: "flagged-second-1",
      textBlocks: ["", "beta"],
      assistantStopReason: "stop",
    },
  ]);
  assert.deepEqual([first, second], before);
  assert.match(focus.sentinel, /^<!-- pi-flag:v1:sha256:[0-9a-f]{64} -->$/);
  assert.ok(focus.block.endsWith(`\n${focus.sentinel}`));
  assert.equal(focus.estimatedTokens, estimateTextTokens(focus.block));
});

test("preserves whitespace, delimiters, Unicode, and lone surrogates exactly", () => {
  const textBlocks = ["", "  leading\ntrailing  ", "]\n<!-- pi-flag:v1:sha256:not-a-sentinel -->", "🙂中\uD800", ""];
  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, textBlocks)]]), "session");
  const parsed = observations(focus);
  assert.ok(Array.isArray(parsed));
  const observation = parsed[0];
  assert.ok(typeof observation === "object" && observation !== null && !Array.isArray(observation));
  assert.deepEqual((observation as Record<string, unknown>).textBlocks, textBlocks);
  assert.equal(verifyFocusProjection(focus.block, focus).status, "ready");
});

test("does not enumerate or mutate arbitrary source properties", () => {
  const flag = activeFlag("entry", 0, ["text"]) as ActiveFlag & { host?: unknown };
  Object.defineProperty(flag, "host", {
    enumerable: true,
    get() {
      throw new Error("host property must not be read");
    },
  });
  const originalBlocks = flag.textBlocks;
  const focus = serializeFocus(new Map([[flag.entryId, flag]]), "session");
  assert.deepEqual(observations(focus), [
    {
      entryId: "entry",
      role: "user",
      sourceTimestamp: "source-entry",
      flaggedAt: "flagged-entry-0",
      textBlocks: ["text"],
    },
  ]);
  assert.equal(flag.textBlocks, originalBlocks);
});

test("is byte-stable and session-domain-separates only the sentinel", () => {
  const active = new Map([["entry", activeFlag("entry", 0, ["text"])]]);
  const first = serializeFocus(active, "session-a");
  const again = serializeFocus(active, "session-a");
  const otherSession = serializeFocus(active, "session-b");
  assert.deepEqual(again, first);
  assert.notEqual(otherSession.sentinel, first.sentinel);
  assert.deepEqual(observations(otherSession), observations(first));
});

test("reflag activation index deterministically moves an entry newest", () => {
  const before = serializeFocus(
    new Map([
      ["a", activeFlag("a", 0, ["a"])],
      ["b", activeFlag("b", 1, ["b"])],
    ]),
    "session",
  );
  const after = serializeFocus(
    new Map([
      ["a", activeFlag("a", 2, ["a"])],
      ["b", activeFlag("b", 1, ["b"])],
    ]),
    "session",
  );
  assert.deepEqual((observations(before) as Array<{ entryId: string }>).map(({ entryId }) => entryId), ["a", "b"]);
  assert.deepEqual((observations(after) as Array<{ entryId: string }>).map(({ entryId }) => entryId), ["b", "a"]);
  assert.notEqual(after.block, before.block);
});

test("empty focus is identity and append preserves the chained prompt verbatim", () => {
  const empty = serializeFocus(new Map(), "session");
  assert.deepEqual(empty, { block: "", sentinel: "", estimatedTokens: 0 });
  assert.equal(appendFocus("base \n", empty), "base \n");

  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, ["text"])]]), "session");
  assert.equal(appendFocus("", focus), focus.block);
  assert.equal(appendFocus("base \n", focus), `base \n\n\n${focus.block}`);
});

test("integrity accepts one exact block and rejects removal, alteration, or duplication", () => {
  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, ["text"])]]), "session");
  const prompt = appendFocus("base", focus);
  assert.deepEqual(verifyFocusProjection(prompt, focus), { status: "ready" });

  const removed = verifyFocusProjection("base", focus);
  assert.deepEqual(removed, {
    status: "blocked",
    reason: "Expected one exact pi-flag block; found 0 block(s) and 0 sentinel(s)",
    occurrences: 0,
  });
  assert.equal(verifyFocusProjection(prompt.replace("text", "changed"), focus).status, "blocked");
  assert.deepEqual(verifyFocusProjection(`${prompt}\n${focus.block}`, focus), {
    status: "blocked",
    reason: "Expected one exact pi-flag block; found 2 block(s) and 2 sentinel(s)",
    occurrences: 2,
  });
  assert.deepEqual(verifyFocusProjection(`${prompt}\n${focus.sentinel}`, focus), {
    status: "blocked",
    reason: "Expected one exact pi-flag block; found 1 block(s) and 2 sentinel(s)",
    occurrences: 1,
  });
});
