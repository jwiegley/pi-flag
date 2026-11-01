import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, StopReason, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { serializeFocus } from "../src/focus.ts";
import {
  dueCheckpoint,
  extractFlagSource,
  FLAG_CHECKPOINT_TYPE,
  FLAG_RECORD_TYPE,
  type FlagActivation,
  parseFlagCheckpoint,
  parseFlagEntry,
  parseFlagRecord,
  replayFlags,
  type PiFlagCheckpointV1,
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

function checkpoint(sessionId: string, flags: FlagActivation[]): PiFlagCheckpointV1 {
  return { version: 1, sessionId, flags };
}

function checkpointEntry(id: string, data: unknown, index: number): SessionEntry {
  return markerEntry(id, data, index, FLAG_CHECKPOINT_TYPE);
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

test("parses only exact checkpoints, which V1 parsing rejects", () => {
  const flag = { targetEntryId: "a", flaggedAt: timestamp(1) };
  const valid = checkpoint("session", [{ targetEntryId: "b", flaggedAt: timestamp(2) }, flag]);
  assert.deepEqual(parseFlagCheckpoint(valid), valid);
  assert.deepEqual(parseFlagCheckpoint(checkpoint("session", [])), checkpoint("session", []));
  // Builds that predate checkpoints read only FLAG_RECORD_TYPE, and their parser rejects this shape.
  assert.notEqual(FLAG_CHECKPOINT_TYPE, FLAG_RECORD_TYPE);
  assert.equal(parseFlagRecord(valid), undefined);

  for (const invalid of [
    undefined,
    null,
    "checkpoint",
    [],
    {},
    { ...valid, version: 2 },
    { ...valid, sessionId: "" },
    { ...valid, extra: true },
    { version: 1, sessionId: "session" },
    { ...valid, flags: "a" },
    { ...valid, flags: [null] },
    { ...valid, flags: [[flag]] },
    { ...valid, flags: [{ ...flag, extra: true }] },
    { ...valid, flags: [{ targetEntryId: "a" }] },
    { ...valid, flags: [{ ...flag, targetEntryId: "" }] },
    { ...valid, flags: [{ ...flag, flaggedAt: 1 }] },
    { ...valid, flags: [flag, { ...flag, flaggedAt: timestamp(2) }] },
  ]) {
    assert.equal(parseFlagCheckpoint(invalid), undefined, JSON.stringify(invalid));
  }
});

test("names the session and targets of valid marker records and checkpoints only", () => {
  const flags = [
    { targetEntryId: "a", flaggedAt: timestamp(1) },
    { targetEntryId: "b", flaggedAt: timestamp(2) },
  ];
  assert.deepEqual(parseFlagEntry(markerEntry("on", marker("session", "a", false), 1)), {
    sessionId: "session",
    targetEntryIds: ["a"],
  });
  assert.deepEqual(parseFlagEntry(checkpointEntry("cp", checkpoint("other", flags), 2)), {
    sessionId: "other",
    targetEntryIds: ["a", "b"],
  });
  for (const entry of [
    markerEntry("bad", { version: 9 }, 3),
    markerEntry("swapped", checkpoint("session", flags), 4),
    checkpointEntry("bad-cp", marker("session", "a", true), 5),
    markerEntry("unrelated", marker("session", "a", true), 6, "other/record"),
    userEntry("a", "alpha"),
  ]) {
    assert.equal(parseFlagEntry(entry), undefined, entry.id);
  }
});

test("a checkpoint replaces earlier records and later records apply over it", () => {
  const replay = replayFlags(
    [
      ...["a", "b", "c", "d"].map((id) => userEntry(id, id)),
      markerEntry("d-on", marker("session", "d", true), 1),
      markerEntry("a-on", marker("session", "a", true), 2),
      markerEntry("b-on", marker("session", "b", true), 3),
      markerEntry("d-off", marker("session", "d", false), 4),
      markerEntry("c-on", marker("session", "c", true), 5),
      // What pi-flag writes here: every active flag in activation order.
      checkpointEntry(
        "cp",
        checkpoint("session", [
          { targetEntryId: "a", flaggedAt: timestamp(2) },
          { targetEntryId: "b", flaggedAt: timestamp(3) },
          { targetEntryId: "c", flaggedAt: timestamp(5) },
        ]),
        6,
      ),
      markerEntry("a-off", marker("session", "a", false), 7),
      markerEntry("c-duplicate", marker("session", "c", true), 8),
      markerEntry("a-again", marker("session", "a", true), 9),
    ],
    "session",
  );
  assert.deepEqual(replay.activations, [
    { targetEntryId: "b", flaggedAt: timestamp(3) },
    { targetEntryId: "c", flaggedAt: timestamp(5) },
    { targetEntryId: "a", flaggedAt: timestamp(9) },
  ]);
  assert.deepEqual([...replay.active.keys()], ["b", "c", "a"]);
  assert.equal(replay.active.has("d"), false);
  assert.deepEqual(replay.warnings, []);
  assert.deepEqual(replay.blockers, []);
});

test("restores the same flags from a checkpoint as from the full history", () => {
  const sources = ["a", "b"].map((id) => userEntry(id, id));
  // Both activations have left the window. Alone, the later duplicate of b would restore a later
  // flaggedAt; the checkpoint after it carries the original order and times.
  const window = [
    markerEntry("b-duplicate", marker("session", "b", true), 4),
    checkpointEntry(
      "cp",
      checkpoint("session", [
        { targetEntryId: "a", flaggedAt: timestamp(1) },
        { targetEntryId: "b", flaggedAt: timestamp(2) },
      ]),
      5,
    ),
  ];
  const full = replayFlags(
    [
      ...sources,
      markerEntry("a-on", marker("session", "a", true), 1),
      markerEntry("b-on", marker("session", "b", true), 2),
      ...window,
    ],
    "session",
  );
  const restored = replayFlags([...sources, ...window], "session");
  assert.deepEqual(restored.activations, full.activations);
  assert.deepEqual([...restored.active.keys()], ["a", "b"]);
  assert.equal(serializeFocus(restored.active, "session").block, serializeFocus(full.active, "session").block);
});

test("ignores another session's checkpoint and warns about a malformed one without changing flags", () => {
  const replay = replayFlags(
    [
      userEntry("a", "alpha"),
      userEntry("b", "beta"),
      markerEntry("a-on", marker("session", "a", true), 1),
      checkpointEntry("foreign", checkpoint("other", [{ targetEntryId: "b", flaggedAt: timestamp(2) }]), 2),
      checkpointEntry("malformed", { version: 1, sessionId: "session", flags: [{ targetEntryId: "b" }] }, 3),
    ],
    "session",
  );
  assert.deepEqual(replay.activations, [{ targetEntryId: "a", flaggedAt: timestamp(1) }]);
  assert.deepEqual(replay.warnings, [
    {
      code: "malformed-record",
      recordEntryId: "malformed",
      message: `Ignored malformed ${FLAG_CHECKPOINT_TYPE} record malformed`,
    },
  ]);
});

test("keeps a dangling target in its checkpoint so that it still blocks", () => {
  const before = replayFlags([markerEntry("missing-on", marker("session", "missing", true), 1)], "session");
  const written = dueCheckpoint(before, [], "session");
  assert.deepEqual(written, checkpoint("session", [{ targetEntryId: "missing", flaggedAt: timestamp(1) }]));
  const after = replayFlags([checkpointEntry("cp", written, 2)], "session");
  assert.deepEqual(
    after.blockers.map(({ code, recordEntryId, targetEntryId }) => ({ code, recordEntryId, targetEntryId })),
    [{ code: "missing-source", recordEntryId: "cp", targetEntryId: "missing" }],
  );
});

test("a checkpoint is due only when the newest entries alone would restore other flags", () => {
  const sources = [userEntry("a", "alpha"), userEntry("b", "beta")];
  const aOn = markerEntry("a-on", marker("session", "a", true), 1);
  const bOn = markerEntry("b-on", marker("session", "b", true), 2);
  const filler = userEntry("filler", "filler", 3);
  const full = replayFlags([...sources, aOn, bOn], "session");
  const flags = [
    { targetEntryId: "a", flaggedAt: timestamp(1) },
    { targetEntryId: "b", flaggedAt: timestamp(2) },
  ];
  const expected = checkpoint("session", flags);

  const unflagged = replayFlags([aOn, markerEntry("a-off", marker("session", "a", false), 2)], "session");
  assert.equal(dueCheckpoint(unflagged, [], "session"), undefined);
  assert.equal(dueCheckpoint(full, [aOn, bOn, filler], "session"), undefined);
  assert.deepEqual(dueCheckpoint(full, [bOn, filler], "session"), expected);
  assert.deepEqual(dueCheckpoint(full, [filler], "session"), expected);
  // A newer duplicate activation alone would restore a later flaggedAt.
  assert.deepEqual(dueCheckpoint(full, [markerEntry("a-again", marker("session", "a", true), 3), bOn], "session"), expected);

  const written = dueCheckpoint(full, [filler], "session");
  assert.ok(written);
  assert.notEqual(written.flags[0], full.activations[0]);
  assert.equal(dueCheckpoint(full, [checkpointEntry("cp", written, 4), filler], "session"), undefined);
  assert.deepEqual(dueCheckpoint(full, [checkpointEntry("foreign", checkpoint("other", flags), 4)], "session"), expected);
  assert.deepEqual(
    dueCheckpoint(full, [checkpointEntry("reordered", checkpoint("session", [...flags].reverse()), 4)], "session"),
    expected,
  );
});

// Deterministic pseudo-random numbers, so that every history below is reproducible.
function randomNumbers(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current = (Math.imul(current, 1664525) + 1013904223) >>> 0;
    return current / 2 ** 32;
  };
}

test("every restore window that holds the latest checkpoint matches the full history, and none resurrects", () => {
  const targets = ["t0", "t1", "t2", "t3", "t4"];
  const sources = targets.map((id) => userEntry(id, `text of ${id}`));
  let windowsFromCheckpoint = 0;
  let rescued = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const next = randomNumbers(seed);
    const pick = () => targets[Math.floor(next() * targets.length)] ?? "t0";
    // `markers` is the user's own history; checkpoints are what pi-flag would derive from it.
    const markers: SessionEntry[] = [];
    const history: SessionEntry[] = [];
    for (let index = 10; index < 90; index++) {
      const roll = next();
      if (roll < 0.55) {
        const entry = markerEntry(`r${index}`, marker("session", pick(), next() < 0.65), index);
        markers.push(entry);
        history.push(entry);
      } else if (roll < 0.75) {
        const { activations } = replayFlags(markers, "session");
        history.push(checkpointEntry(`c${index}`, checkpoint("session", activations), index));
      } else if (roll < 0.83) {
        history.push(markerEntry(`f${index}`, marker("other", pick(), true), index));
      } else if (roll < 0.9) {
        const foreign = checkpoint("other", [{ targetEntryId: pick(), flaggedAt: timestamp(index) }]);
        history.push(checkpointEntry(`fc${index}`, foreign, index));
      } else if (roll < 0.95) {
        history.push(checkpointEntry(`m${index}`, { version: 1, sessionId: "session", flags: "broken" }, index));
      } else {
        history.push(markerEntry(`u${index}`, { unrelated: true }, index, "other/record"));
      }
    }

    const expected = replayFlags([...sources, ...markers], "session");
    const expectedBlock = serializeFocus(expected.active, "session").block;
    let latestCheckpoint = -1;
    history.forEach((entry, index) => {
      if (entry.type === "custom" && entry.customType === FLAG_CHECKPOINT_TYPE) {
        if (parseFlagCheckpoint(entry.data)?.sessionId === "session") latestCheckpoint = index;
      }
    });
    for (let start = 0; start <= history.length; start++) {
      const window = history.slice(start);
      const replay = replayFlags([...sources, ...window], "session");
      for (const targetEntryId of replay.active.keys()) {
        assert.ok(expected.active.has(targetEntryId), `seed ${seed} start ${start} resurrected ${targetEntryId}`);
      }
      if (start > latestCheckpoint) continue;
      windowsFromCheckpoint++;
      assert.deepEqual(replay.activations, expected.activations, `seed ${seed} start ${start}`);
      assert.equal(serializeFocus(replay.active, "session").block, expectedBlock, `seed ${seed} start ${start}`);
      const markersOnly = replayFlags([...sources, ...window.filter((entry) => markers.includes(entry))], "session");
      if (JSON.stringify(markersOnly.activations) !== JSON.stringify(expected.activations)) rescued++;
    }
  }
  // The checkpoint did real work: many windows lost a marker record that mattered.
  assert.ok(windowsFromCheckpoint > 2000, `${windowsFromCheckpoint} windows held a checkpoint`);
  assert.ok(rescued > 1000, `${rescued} windows needed their checkpoint`);
});
