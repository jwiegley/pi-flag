import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  appendFocus,
  assessFinalRequest,
  assessFocusAdmission,
  estimateInputTokens,
  estimateTextTokens,
  focusLimit,
  responseReserve,
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

function testModel(contextWindow = 128000, maxTokens = 16384) {
  return { ...fauxProvider().getModel(), contextWindow, maxTokens };
}

function focusWithTokens(estimatedTokens: number): SerializedFocus {
  return { block: "focus", sentinel: "sentinel", estimatedTokens };
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

test("estimates text, images, focus limits, and response reserves", () => {
  assert.equal(estimateTextTokens("abcde"), 2);
  assert.equal(
    estimateInputTokens("text", [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "image", data: "AA==", mimeType: "image/jpeg" },
    ]),
    2401,
  );
  assert.equal(focusLimit(128000), 32000);
  assert.equal(focusLimit(200000), 32768);
  assert.equal(focusLimit(3), 0);
  assert.equal(responseReserve(testModel(128000, 1000)), 4096);
  assert.equal(responseReserve(testModel(128000, 8000)), 8000);
  assert.equal(responseReserve(testModel(128000, 20000)), 16384);
});

test("focus admission handles no model, exact boundaries, and downsizing without prompt input", () => {
  const emptyFocus = serializeFocus(new Map(), "session");
  assert.deepEqual(assessFocusAdmission({ focus: emptyFocus, model: undefined }), {
    status: "ready",
    focusTokens: 0,
  });

  const noModel = assessFocusAdmission({ focus: focusWithTokens(1), model: undefined });
  assert.equal(noModel.status, "blocked");
  if (noModel.status === "blocked") {
    assert.match(noModel.reason, /no model/);
    assert.match(noModel.reason, /Nothing was truncated/);
    assert.match(noModel.reason, /\/flag/);
  }

  assert.deepEqual(assessFocusAdmission({ focus: focusWithTokens(100), model: testModel(400) }), {
    status: "ready",
    focusTokens: 100,
  });
  const over = assessFocusAdmission({ focus: focusWithTokens(101), model: testModel(400) });
  assert.equal(over.status, "blocked");
  if (over.status === "blocked") {
    assert.match(over.reason, /~101 tokens/);
    assert.match(over.reason, /permits 100/);
  }

  const unchanged = focusWithTokens(20000);
  const before = structuredClone(unchanged);
  assert.equal(assessFocusAdmission({ focus: unchanged, model: testModel(128000) }).status, "ready");
  assert.equal(assessFocusAdmission({ focus: unchanged, model: testModel(32000) }).status, "blocked");
  assert.deepEqual(unchanged, before);
});

test("final assessment counts one final system prompt, expanded input, and reserve", () => {
  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, ["text"])]]), "session");
  const finalSystemPrompt = appendFocus("base", focus);
  const expandedInputTokens = 25;
  const mandatoryTokens = estimateTextTokens(finalSystemPrompt) + expandedInputTokens + 4096;

  assert.deepEqual(
    assessFinalRequest({
      finalSystemPrompt,
      focus,
      expandedInputTokens,
      model: testModel(mandatoryTokens, 4096),
    }),
    { status: "ready", mandatoryTokens, focusTokens: focus.estimatedTokens },
  );
  const blocked = assessFinalRequest({
    finalSystemPrompt,
    focus,
    expandedInputTokens,
    model: testModel(mandatoryTokens - 1, 4096),
  });
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") {
    assert.equal(blocked.mandatoryTokens, mandatoryTokens);
    assert.match(blocked.reason, new RegExp(`~${mandatoryTokens} tokens`));
    assert.match(blocked.reason, /Nothing was truncated/);
  }
});

test("final assessment includes expanded images and current chained prompt changes", () => {
  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, ["text"])]]), "session");
  const images = [
    { type: "image" as const, data: "AA==", mimeType: "image/png" },
    { type: "image" as const, data: "AA==", mimeType: "image/jpeg" },
  ];
  const expandedInputTokens = estimateInputTokens("look", images);
  assert.equal(expandedInputTokens, 2401);

  const shortPrompt = appendFocus("base", focus);
  const longPrompt = appendFocus(`base${"x".repeat(400)}`, focus);
  const model = testModel(128000, 4096);
  const short = assessFinalRequest({ finalSystemPrompt: shortPrompt, focus, expandedInputTokens, model });
  const long = assessFinalRequest({ finalSystemPrompt: longPrompt, focus, expandedInputTokens, model });
  assert.ok(long.mandatoryTokens > short.mandatoryTokens);
});

test("two sequential admissions cannot double-count a stale prior effective prompt", () => {
  const focus = serializeFocus(new Map([["entry", activeFlag("entry", 0, ["text"])]]), "session");
  const model = testModel();
  const staleEffectivePrompt = appendFocus("base", focus);

  const firstAdmission = assessFocusAdmission({ focus, model });
  const secondAdmission = assessFocusAdmission({ focus, model });
  assert.deepEqual(secondAdmission, firstAdmission);
  assert.equal(firstAdmission.status, "ready");

  const final = assessFinalRequest({
    finalSystemPrompt: staleEffectivePrompt,
    focus,
    expandedInputTokens: 1,
    model,
  });
  assert.equal(final.mandatoryTokens, estimateTextTokens(staleEffectivePrompt) + 1 + responseReserve(model));
});

test("final assessment reports missing model without mutating focus", () => {
  const focus = focusWithTokens(10);
  const before = structuredClone(focus);
  const result = assessFinalRequest({
    finalSystemPrompt: "system",
    focus,
    expandedInputTokens: 3,
    model: undefined,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.mandatoryTokens, estimateTextTokens("system") + 3);
  if (result.status === "blocked") assert.match(result.reason, /no model/);
  assert.deepEqual(focus, before);
});
