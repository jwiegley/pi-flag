import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, StopReason, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractFlagSource,
  FLAG_RECORD_TYPE,
  parseFlagRecord,
  replayFlags,
  type PiFlagRecordV1,
} from "../src/state.ts";

function timestamp(index: number): string {
  return `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
}

function userContentEntry(id: string, content: UserMessage["content"], index = 0): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: timestamp(index),
    message: { role: "user", content, timestamp: index },
  };
}

function userEntry(id: string, text: string, index = 0): SessionEntry {
  return userContentEntry(id, text, index);
}

const zeroUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(
  id: string,
  stopReason: StopReason,
  content: AssistantMessage["content"],
  index = 0,
  errorMessage?: string,
): SessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: zeroUsage,
    stopReason,
    timestamp: index,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: timestamp(index),
    message,
  };
}

function markerEntry(
  id: string,
  data: unknown,
  index: number,
  customType = FLAG_RECORD_TYPE,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: timestamp(index),
    customType,
    data,
  };
}

function marker(sessionId: string, targetEntryId: string, active: boolean): PiFlagRecordV1 {
  return { version: 1, sessionId, targetEntryId, active };
}

test("parses only exact V1 records", () => {
  const valid = marker("session", "entry", true);
  assert.deepEqual(parseFlagRecord(valid), valid);

  for (const invalid of [
    undefined,
    null,
    false,
    1,
    "record",
    [],
    {},
    { version: 2, sessionId: "session", targetEntryId: "entry", active: true },
    { version: 1, sessionId: "", targetEntryId: "entry", active: true },
    { version: 1, sessionId: "session", targetEntryId: "", active: true },
    { version: 1, sessionId: "session", targetEntryId: "entry", active: "yes" },
    { ...valid, extra: true },
  ]) {
    assert.equal(parseFlagRecord(invalid), undefined);
  }
});

test("ignores foreign sessions and unrelated custom entries", () => {
  const replay = replayFlags(
    [
      userEntry("a", "alpha"),
      markerEntry("foreign", marker("other", "a", true), 1),
      markerEntry("unrelated", marker("current", "a", true), 2, "other/record"),
    ],
    "current",
  );
  assert.deepEqual([...replay.active], []);
  assert.deepEqual(replay.warnings, []);
  assert.deepEqual(replay.blockers, []);
});

test("duplicate activation is idempotent and preserves order", () => {
  const replay = replayFlags(
    [
      userEntry("a", "alpha"),
      userEntry("b", "beta"),
      markerEntry("a-on", marker("session", "a", true), 1),
      markerEntry("a-duplicate", marker("session", "a", true), 2),
      markerEntry("b-on", marker("session", "b", true), 3),
    ],
    "session",
  );
  assert.deepEqual([...replay.active.keys()], ["a", "b"]);
  assert.equal(replay.active.get("a")?.flaggedAt, timestamp(1));
  assert.equal(replay.active.get("a")?.activationIndex, 0);
  assert.equal(replay.active.get("b")?.activationIndex, 1);
});

test("inactive is a no-op and reactivation moves the target newest", () => {
  const replay = replayFlags(
    [
      userEntry("a", "alpha"),
      userEntry("b", "beta"),
      markerEntry("absent-off", marker("session", "b", false), 1),
      markerEntry("a-on", marker("session", "a", true), 2),
      markerEntry("a-off", marker("session", "a", false), 3),
      markerEntry("b-on", marker("session", "b", true), 4),
      markerEntry("a-again", marker("session", "a", true), 5),
    ],
    "session",
  );
  assert.deepEqual([...replay.active.keys()], ["b", "a"]);
  assert.equal(replay.active.get("b")?.activationIndex, 1);
  assert.equal(replay.active.get("a")?.activationIndex, 2);
  assert.equal(replay.active.get("a")?.flaggedAt, timestamp(5));
});

test("keeps malformed warnings deterministic without inventing state", () => {
  const entries = [
    markerEntry("bad-1", { version: 9 }, 1),
    markerEntry("future-on", marker("session", "later", true), 2),
    markerEntry("bad-2", { ...marker("session", "later", true), extra: true }, 3),
    userEntry("later", "resolved after marker", 4),
  ];
  const first = replayFlags(entries, "session");
  const second = replayFlags(entries, "session");
  assert.deepEqual(first, second);
  assert.deepEqual(first.warnings.map((warning) => warning.recordEntryId), ["bad-1", "bad-2"]);
  assert.deepEqual([...first.active.keys()], ["later"]);
  assert.equal(first.active.get("later")?.activationIndex, 0);
});

test("reports active missing and ineligible targets as blockers", () => {
  const replay = replayFlags(
    [
      markerEntry("missing-on", marker("session", "missing", true), 1),
      markerEntry("ineligible-source", { ignored: true }, 2, "unrelated"),
      markerEntry("ineligible-on", marker("session", "ineligible-source", true), 3),
    ],
    "session",
  );
  assert.deepEqual([...replay.active], []);
  assert.deepEqual(
    replay.blockers.map(({ code, recordEntryId, targetEntryId }) => ({ code, recordEntryId, targetEntryId })),
    [
      { code: "missing-source", recordEntryId: "missing-on", targetEntryId: "missing" },
      { code: "ineligible-source", recordEntryId: "ineligible-on", targetEntryId: "ineligible-source" },
    ],
  );
});

test("preserves exact user text blocks and rejects image-bearing prompts", () => {
  const single = extractFlagSource(userEntry("single", "  alpha\nβ  ", 1));
  assert.deepEqual(single?.textBlocks, ["  alpha\nβ  "]);

  const blocks = [
    { type: "text" as const, text: "" },
    { type: "text" as const, text: "first\n" },
    { type: "text" as const, text: "\u{1F642}中\uD800" },
    { type: "text" as const, text: "" },
  ];
  const multiple = extractFlagSource(userContentEntry("multiple", blocks, 2));
  assert.deepEqual(multiple?.textBlocks, blocks.map((block) => block.text));
  assert.equal(multiple?.role, "user");
  assert.equal(multiple?.sourceTimestamp, timestamp(2));

  assert.equal(
    extractFlagSource(
      userContentEntry("image", [
        { type: "text", text: "caption" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ]),
    ),
    undefined,
  );
  assert.equal(extractFlagSource(userContentEntry("empty", [])), undefined);
});

test("handles every assistant stop reason and preserves only visible text blocks", () => {
  const eligibleStopReasons: StopReason[] = ["stop", "length", "toolUse", "error", "aborted"];
  for (const [index, stopReason] of eligibleStopReasons.entries()) {
    const source = extractFlagSource(
      assistantEntry(
        `assistant-${stopReason}`,
        stopReason,
        [
          { type: "text", text: "" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: " visible\n\u{1F642}中\uD800 " },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "secret" } },
          { type: "text", text: "" },
        ],
        index + 10,
        stopReason === "error" ? "private transport failure" : undefined,
      ),
    );
    assert.deepEqual(source, {
      entryId: `assistant-${stopReason}`,
      role: "assistant",
      sourceTimestamp: timestamp(index + 10),
      textBlocks: ["", " visible\n\u{1F642}中\uD800 ", ""],
      assistantStopReason: stopReason,
    });
    assert.equal(JSON.stringify(source).includes("private transport failure"), false);
  }

  for (const stopReason of ["pending", "deferred"] as const) {
    assert.equal(
      extractFlagSource(assistantEntry(`assistant-${stopReason}`, stopReason, [{ type: "text", text: "visible" }])),
      undefined,
    );
  }
});

test("rejects assistants without nonempty visible text", () => {
  for (const stopReason of ["stop", "length", "toolUse", "error", "aborted"] as const) {
    assert.equal(
      extractFlagSource(
        assistantEntry(`empty-${stopReason}`, stopReason, [
          { type: "text", text: "" },
          { type: "thinking", thinking: "hidden" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
        ]),
      ),
      undefined,
    );
  }

  const whitespace = extractFlagSource(assistantEntry("whitespace", "stop", [{ type: "text", text: " \n" }]));
  assert.deepEqual(whitespace?.textBlocks, [" \n"]);
});

test("rejects tool results and every non-message session entry", () => {
  const toolResult: SessionEntry = {
    type: "message",
    id: "tool-result",
    parentId: null,
    timestamp: timestamp(1),
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: 1,
    },
  };
  assert.equal(extractFlagSource(toolResult), undefined);

  const base = { id: "entry", parentId: null, timestamp: timestamp(1) };
  const nonMessages: SessionEntry[] = [
    { ...base, type: "thinking_level_change", thinkingLevel: "high" },
    { ...base, type: "model_change", provider: "faux", modelId: "faux-1" },
    { ...base, type: "compaction", summary: "summary", firstKeptEntryId: "entry", tokensBefore: 1 },
    { ...base, type: "branch_summary", fromId: "entry", summary: "summary" },
    { ...base, type: "custom", customType: "other", data: { text: "hidden" } },
    { ...base, type: "custom_message", customType: "other", content: "hidden", display: false },
    { ...base, type: "label", targetId: "entry", label: "label" },
    { ...base, type: "session_info", name: "name" },
  ];
  for (const entry of nonMessages) assert.equal(extractFlagSource(entry), undefined);
});

test("replay resolves eligible assistant sources without error metadata", () => {
  const source = assistantEntry(
    "assistant",
    "error",
    [{ type: "text", text: "recoverable answer" }],
    1,
    "provider secret",
  );
  const replay = replayFlags(
    [source, markerEntry("assistant-on", marker("session", "assistant", true), 2)],
    "session",
  );
  assert.deepEqual(replay.active.get("assistant")?.textBlocks, ["recoverable answer"]);
  assert.equal(replay.active.get("assistant")?.assistantStopReason, "error");
  assert.equal(JSON.stringify(replay.active.get("assistant")).includes("provider secret"), false);
});
