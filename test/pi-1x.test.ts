import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "pi-coding-agent-1x";

import { FLAG_CHECKPOINT_TYPE, FLAG_RECORD_TYPE, parseFlagRecord } from "../src/state.ts";
import {
  createTestHost1x,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  PI_1X_VERSION,
  type TestHost1x,
} from "./support/host-1x.ts";

// pi-flag inside a real upstream Pi 1.x session, where sendCustomMessage({ triggerTurn: true }) runs emit
// before_agent_start. Pi 1.x providers receive the system prompt as system messages.

type Notification = { message: string; type: string | undefined };

const SENTINEL = "<!-- pi-flag:v1:sha256:";

function appendFlaggedUser(host: TestHost1x, text: string): void {
  const targetEntryId = host.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId: host.sessionManager.getSessionId(),
    targetEntryId,
    active: true,
  });
}

function appendDanglingFlag(host: TestHost1x): void {
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId: host.sessionManager.getSessionId(),
    targetEntryId: "missing-entry",
    active: true,
  });
}

async function bindExtensions(host: TestHost1x): Promise<Notification[]> {
  const notifications: Notification[] = [];
  const ui = {
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
  };
  await host.session.bindExtensions({ mode: "tui", uiContext: ui as never });
  return notifications;
}

async function sendCustomTrigger(host: TestHost1x): Promise<void> {
  await host.session.sendCustomMessage(
    { customType: "test/direct", content: "trigger", display: false },
    { triggerTurn: true },
  );
  await host.session.waitForIdle();
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// Holds the first faux request open so a test can act while the run streams.
function createGate(): { started: Promise<void>; hold(): Promise<void>; release(): void } {
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    async hold() {
      markStarted();
      await released;
    },
    release: () => release(),
  };
}

test("runs against upstream Pi 1.x through the pi-coding-agent-1x alias", () => {
  assert.equal(PI_1X_VERSION, "1.4.0");
});

test("Pi 1.x custom-message runs carry exactly one focus block", async () => {
  const host = await createTestHost1x();
  appendFlaggedUser(host, "CUSTOM RUN FOCUS");
  const systemPrompts: string[] = [];
  host.faux.setResponses([
    (context) => {
      systemPrompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage("ok");
    },
  ]);
  try {
    const notifications = await bindExtensions(host);
    await sendCustomTrigger(host);
    assert.equal(host.faux.state.callCount, 1);
    assert.equal(countOccurrences(systemPrompts[0] ?? "", SENTINEL), 1);
    assert.match(systemPrompts[0] ?? "", /CUSTOM RUN FOCUS/);
    assert.deepEqual(notifications, []);
  } finally {
    host.cleanup();
  }
});

for (const withValidFlag of [true, false]) {
  test(`Pi 1.x custom-message runs with ${withValidFlag ? "a valid and" : "only"} a dangling flag send nothing`, async () => {
    const host = await createTestHost1x();
    if (withValidFlag) appendFlaggedUser(host, "VALID FOCUS");
    appendDanglingFlag(host);
    host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
    try {
      const notifications = await bindExtensions(host);
      await sendCustomTrigger(host);
      assert.equal(host.faux.state.callCount, 0);
      assert.equal(host.faux.getPendingResponseCount(), 1);
      assert.deepEqual(notifications, [
        {
          message:
            "pi-flag refused an extension-started run. Active flag target missing-entry is missing. Nothing was omitted. Open /flag to unflag it.",
          type: "error",
        },
      ]);
    } finally {
      host.cleanup();
    }
  });
}

test("Pi 1.x custom-message runs obey the focus limit even when the request would fit", async () => {
  const host = await createTestHost1x({ faux: { models: [{ id: "mid", contextWindow: 12000, maxTokens: 1000 }] } });
  appendFlaggedUser(host, "x".repeat(12000));
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    const notifications = await bindExtensions(host);
    await sendCustomTrigger(host);
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.equal(notifications.length, 1);
    assert.match(
      notifications[0]?.message ?? "",
      /Focus requires ~\d+ tokens; this model permits 3000\. Nothing was truncated/,
    );
  } finally {
    host.cleanup();
  }
});

for (const streamingBehavior of ["steer", "followUp", undefined] as const) {
  test(`Pi 1.x mid-run input (${streamingBehavior ?? "no streamingBehavior"}) keeps the run's one focus block`, async () => {
    const host = await createTestHost1x({ tools: ["read"] });
    appendFlaggedUser(host, "RUN FOCUS");
    const file = join(host.root, "tool-input.txt");
    writeFileSync(file, "tool output");
    const gate = createGate();
    const systemPrompts: string[] = [];
    const requestMessages: string[] = [];
    const record = (context: { messages: Parameters<typeof getCurrentSystemPrompt>[0] }) => {
      systemPrompts.push(getCurrentSystemPrompt(context.messages));
      requestMessages.push(JSON.stringify(context.messages));
    };
    host.faux.setResponses([
      async (context) => {
        record(context);
        await gate.hold();
        return fauxAssistantMessage([fauxText("checking"), fauxToolCall("read", { path: file }, { id: "read-1" })], {
          stopReason: "toolUse",
        });
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("after tool");
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("after follow-up");
      },
    ]);
    try {
      const notifications = await bindExtensions(host);
      const run = host.session.prompt("start");
      await gate.started;
      if (streamingBehavior === undefined) {
        await assert.rejects(host.session.prompt("mid-run input"), /already processing/);
      } else {
        await host.session.prompt("mid-run input", { streamingBehavior });
      }
      gate.release();
      await run;
      await host.session.waitForIdle();
      assert.equal(host.faux.state.callCount, streamingBehavior === "followUp" ? 3 : 2);
      assert.equal(systemPrompts.length, host.faux.state.callCount);
      for (const systemPrompt of systemPrompts) {
        assert.equal(systemPrompt, systemPrompts[0]);
        assert.equal(countOccurrences(systemPrompt, SENTINEL), 1);
      }
      assert.match(systemPrompts[0] ?? "", /RUN FOCUS/);
      assert.equal(requestMessages.at(-1)?.includes("mid-run input"), streamingBehavior !== undefined);
      assert.deepEqual(notifications, []);
    } finally {
      host.cleanup();
    }
  });
}

// The focus block that pi-flag appended to a system prompt.
function focusBlock(systemPrompt: string): string {
  const start = systemPrompt.indexOf("## pi-flag: significant session observations");
  const sentinel = systemPrompt.indexOf(SENTINEL, start);
  assert.ok(start >= 0 && sentinel > start);
  return systemPrompt.slice(start, systemPrompt.indexOf("-->", sentinel) + "-->".length);
}

// pi-flag checks at turn_start and agent_settled, plain events in Pi 1.x as in 0.84. Pi 1.x
// dispatches turn_end as an actionable boundary that rebuilds context, which pi-flag stays out of.
test("Pi 1.x keeps a flag through one run longer than the restore window and after reopening the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-flag-1x-checkpoint-"));
  const sessionDir = join(root, "sessions");
  const file = join(root, "tool-input.txt");
  writeFileSync(file, "tool output");
  let sessionFile = "";
  let block = "";
  try {
    const first = await createTestHost1x({
      tools: ["read"],
      root,
      sessionManager: SessionManager.create(root, sessionDir, { id: "pi-1x-checkpoint" }),
    });
    const systemPrompts: string[] = [];
    first.faux.setResponses([
      ...Array.from({ length: 140 }, (_, index) => (context: { messages: Parameters<typeof getCurrentSystemPrompt>[0] }) => {
        systemPrompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage([fauxToolCall("read", { path: file }, { id: `read-${index}` })], {
          stopReason: "toolUse",
        });
      }),
      (context) => {
        systemPrompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage("done");
      },
    ]);
    try {
      appendFlaggedUser(first, "PI 1X CHECKPOINTED FOCUS");
      const notifications = await bindExtensions(first);
      await first.session.prompt("long run");
      await first.session.waitForIdle();
      assert.equal(systemPrompts.length, 141);
      block = focusBlock(systemPrompts[0] ?? "");
      assert.match(block, /PI 1X CHECKPOINTED FOCUS/);
      for (const systemPrompt of systemPrompts) assert.equal(systemPrompt, systemPrompts[0]);

      const entries = first.sessionManager.getEntries();
      const marker = entries.findIndex(
        (entry) => entry.type === "custom" && entry.customType === FLAG_RECORD_TYPE && parseFlagRecord(entry.data)?.active,
      );
      assert.ok(marker >= 0 && marker < entries.length - 256, "the marker record left the restore window");
      const written = entries.flatMap((entry, ordinal) =>
        entry.type === "custom" && entry.customType === FLAG_CHECKPOINT_TYPE ? [ordinal] : [],
      );
      assert.ok(written.length >= 2);
      for (const [index, ordinal] of written.entries()) {
        assert.ok(ordinal - (written[index - 1] ?? marker) > 128);
        // A mid-run checkpoint sits between turns: right after the previous turn's tool result and
        // right before the next assistant message.
        const previous = entries[ordinal - 1];
        const next = entries[ordinal + 1];
        assert.ok(previous?.type === "message" && previous.message.role === "toolResult");
        assert.ok(next?.type === "message" && next.message.role === "assistant");
      }
      assert.deepEqual(notifications, []);
      sessionFile = first.sessionManager.getSessionFile() ?? "";
    } finally {
      first.cleanup();
    }

    const reopened = await createTestHost1x({ root, sessionManager: SessionManager.open(sessionFile, sessionDir, root) });
    let resumed = "";
    reopened.faux.setResponses([
      (context) => {
        resumed = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage("resumed");
      },
    ]);
    try {
      const notifications = await bindExtensions(reopened);
      await reopened.session.prompt("after reopening");
      await reopened.session.waitForIdle();
      assert.equal(focusBlock(resumed), block);
      assert.deepEqual(notifications, []);
    } finally {
      reopened.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
