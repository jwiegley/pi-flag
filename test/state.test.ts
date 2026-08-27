import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FLAG_RECORD_TYPE, parseFlagRecord, replayFlags, type PiFlagRecordV1 } from "../src/state.ts";

function timestamp(index: number): string {
  return `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
}

function userEntry(id: string, text: string, index = 0): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: timestamp(index),
    message: { role: "user", content: text, timestamp: index },
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
