import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  type Extension,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type SessionEntry,
  SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  KeybindingsManager,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

import { serializeFocus } from "../src/focus.ts";
import { FlagSelector } from "../src/selector.ts";
import { FLAG_RECORD_TYPE, parseFlagRecord, replayFlags } from "../src/state.ts";
import { createTestHost, type TestHost } from "./support/host.ts";

type CustomSessionEntry = Extract<SessionEntry, { type: "custom" }>;

type TestComponent = Component & { dispose?(): void };
type CustomFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: void) => void,
) => TestComponent | Promise<TestComponent>;

type UiHarness = {
  ui: ExtensionUIContext;
  notifications: Array<{ message: string; type: string | undefined }>;
  components: TestComponent[];
  overlays: Array<boolean | undefined>;
};

const plainTheme = {
  bold(text: string) {
    return text;
  },
  fg(_color: string, text: string) {
    return text;
  },
  inverse(text: string) {
    return text;
  },
} as unknown as Theme;

function packageExtension(host: TestHost): Extension {
  const packagePath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const extension = host.extensionsResult.extensions.find((candidate) => candidate.resolvedPath === packagePath);
  assert.ok(extension, `missing loaded extension ${packagePath}`);
  return extension;
}

function requireFlagSelector(component: TestComponent): FlagSelector {
  const selector = component as unknown as FlagSelector;
  assert.equal(typeof selector.getFilteredRows, "function");
  return selector;
}

function createUiHarness(onOpen?: (component: TestComponent) => Promise<void> | void): UiHarness {
  const notifications: UiHarness["notifications"] = [];
  const components: TestComponent[] = [];
  const overlays: Array<boolean | undefined> = [];
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {} } as unknown as TUI;

  const implementation = {
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
    async custom(factory: CustomFactory, options?: { overlay?: boolean }): Promise<void> {
      overlays.push(options?.overlay);
      let finish = () => {};
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const component = await factory(tui, plainTheme, keybindings, finish);
      components.push(component);
      await onOpen?.(component);
      finish();
      await completion;
      component.dispose?.();
    },
  };
  return { ui: implementation as unknown as ExtensionUIContext, notifications, components, overlays };
}

function sessionView(host: TestHost, sessionFile: string | undefined): ExtensionCommandContext["sessionManager"] {
  return {
    getEntries: () => host.sessionManager.getEntries(),
    getSessionId: () => host.sessionManager.getSessionId(),
    getBranch: () => host.sessionManager.getBranch(),
    getSessionFile: () => sessionFile,
    getEntry: (entryId: string) => host.sessionManager.getEntry(entryId),
  } as unknown as ExtensionCommandContext["sessionManager"];
}

function commandContext(
  host: TestHost,
  ui: ExtensionUIContext,
  options: {
    mode?: ExtensionCommandContext["mode"];
    idle?: boolean;
    sessionFile?: string;
    useActualSessionFile?: boolean;
  } = {},
): ExtensionCommandContext {
  const sessionFile = options.useActualSessionFile ? host.sessionManager.getSessionFile() : options.sessionFile;
  return {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui,
    sessionManager: sessionView(host, sessionFile),
    model: host.session.model,
    isIdle: () => options.idle ?? true,
  } as unknown as ExtensionCommandContext;
}

async function runFlag(host: TestHost, ctx: ExtensionCommandContext): Promise<void> {
  const command = packageExtension(host).commands.get("flag");
  assert.ok(command);
  await command.handler("", ctx);
}

async function emitHandler(
  host: TestHost,
  eventName: string,
  event: unknown,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const handlers = packageExtension(host).handlers.get(eventName);
  assert.ok(handlers && handlers.length > 0, `missing ${eventName} handler`);
  for (const handler of handlers) await handler(event as never, ctx);
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function appendFlaggedUser(host: TestHost, text: string): string {
  const entryId = host.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId: host.sessionManager.getSessionId(),
    targetEntryId: entryId,
    active: true,
  });
  return entryId;
}

function focusForHost(host: TestHost) {
  const replay = replayFlags(host.sessionManager.getEntries(), host.sessionManager.getSessionId());
  return serializeFocus(replay.active, host.sessionManager.getSessionId());
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function fauxContentText(content: Extract<Message, { role: "user" | "toolResult" }>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`))
    .join("\n");
}

function fauxMessageText(message: Message): string {
  if (message.role === "user") return fauxContentText(message.content);
  if (message.role === "assistant") {
    return message.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return block.thinking;
        return `${block.name}:${JSON.stringify(block.arguments)}`;
      })
      .join("\n");
  }
  return [message.toolName, ...message.content.map((block) => fauxContentText([block]))].join("\n");
}

function serializeFauxContext(context: Context): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(`system:${context.systemPrompt}`);
  for (const message of context.messages) parts.push(`${message.role}:${fauxMessageText(message)}`);
  if (context.tools?.length) parts.push(`tools:${JSON.stringify(context.tools)}`);
  return parts.join("\n\n");
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index++;
  return index;
}

function latestAssistant(host: TestHost) {
  const message = [...host.session.messages].reverse().find((candidate) => candidate.role === "assistant");
  assert.ok(message?.role === "assistant");
  return message;
}

test("loads the package and dispatches a public extension event", async () => {
  let sessionStarts = 0;
  const host = await createTestHost([
    {
      name: "observer",
      factory(pi) {
        pi.on("session_start", () => {
          sessionStarts++;
        });
      },
    },
  ]);

  try {
    assert.deepEqual(host.extensionsResult.errors, []);
    packageExtension(host);
    await host.session.bindExtensions({});
    assert.equal(sessionStarts, 1);
    assert.equal(host.faux.state.callCount, 0);
  } finally {
    host.cleanup();
  }
});

test("registers only the flag command and planned lifecycle handlers", async () => {
  const host = await createTestHost();
  try {
    const extension = packageExtension(host);
    assert.deepEqual([...extension.commands.keys()], ["flag"]);
    assert.deepEqual([...extension.handlers.keys()].sort(), [
      "agent_settled",
      "before_agent_start",
      "context",
      "input",
      "model_select",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "session_shutdown",
      "session_start",
    ]);
    assert.equal(extension.tools.size, 0);
    assert.equal(extension.shortcuts.size, 0);
    assert.equal(extension.flags.size, 0);
    assert.equal(extension.messageRenderers.size, 0);
    assert.equal(extension.entryRenderers?.size ?? 0, 0);
    assert.equal(extension.commands.has("tree"), false);
  } finally {
    host.cleanup();
  }
});

test("refuses print, json, and RPC modes without opening custom UI", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    for (const mode of ["print", "json", "rpc"] as const) {
      await runFlag(host, commandContext(host, ui.ui, { mode }));
    }
    assert.equal(ui.components.length, 0);
    assert.equal(ui.notifications.length, 3);
    assert.ok(ui.notifications.every(({ message, type }) => message.includes("interactive TUI") && type === "error"));
    assert.equal(host.faux.state.callCount, 0);
  } finally {
    host.cleanup();
  }
});

test("refuses non-idle command use", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runFlag(host, commandContext(host, ui.ui, { idle: false }));
    assert.equal(ui.components.length, 0);
    assert.deepEqual(ui.notifications, [{ message: "Cannot open /flag while the agent is running", type: "warning" }]);
  } finally {
    host.cleanup();
  }
});

test("manual compaction blocks the selector until success or failure", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  const ctx = commandContext(host, ui.ui);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await emitHandler(host, "session_before_compact", { type: "session_before_compact", reason: "manual" }, ctx);
    await runFlag(host, ctx);
    assert.equal(ui.components.length, 0);
    assert.ok(ui.notifications.at(-1)?.message.includes("manual compaction"));

    await emitHandler(host, "session_compact_failed", { type: "session_compact_failed" }, ctx);
    await runFlag(host, ctx);
    assert.equal(ui.components.length, 1);

    await emitHandler(host, "session_before_compact", { type: "session_before_compact", reason: "manual" }, ctx);
    await emitHandler(host, "session_compact", { type: "session_compact" }, ctx);
    await runFlag(host, ctx);
    assert.equal(ui.components.length, 2);
  } finally {
    host.cleanup();
  }
});

test("labels undefined, absent, and existing session files correctly", async () => {
  const host = await createTestHost();
  const rendered: string[] = [];
  const ui = createUiHarness((component) => {
    const selector = requireFlagSelector(component);
    rendered.push(selector.render(100).join("\n"));
  });
  const absentPath = join(host.root, "future-session.jsonl");
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runFlag(host, commandContext(host, ui.ui));
    await runFlag(host, commandContext(host, ui.ui, { sessionFile: absentPath }));
    assert.equal(existsSync(absentPath), false);
    writeFileSync(absentPath, "");
    await runFlag(host, commandContext(host, ui.ui, { sessionFile: absentPath }));

    assert.match(rendered[0] ?? "", /ephemeral/);
    assert.match(rendered[1] ?? "", /not-yet-saved/);
    assert.match(rendered[2] ?? "", /durable/);
  } finally {
    host.cleanup();
  }
});

test("appends, rescans, and preserves several toggles in one selector", async () => {
  const host = await createTestHost();
  const firstId = host.sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const secondId = host.sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  const ui = createUiHarness(async (component) => {
    const selector = requireFlagSelector(component);
    const initialId = selector.getSelectedEntryId();
    assert.ok(initialId === firstId || initialId === secondId);
    const otherId = initialId === firstId ? secondId : firstId;

    selector.handleInput("\r");
    selector.render(100);
    selector.handleInput("\r");
    await nextTurn();
    assert.equal(selector.getSelectedEntryId(), initialId);
    assert.equal(selector.getFilteredRows().find(({ entryId }) => entryId === initialId)?.active, true);

    if (selector.getSelectedEntryId() !== otherId) selector.handleInput("\x1b[B");
    assert.equal(selector.getSelectedEntryId(), otherId);
    selector.handleInput("\r");
    await nextTurn();
    assert.equal(selector.getFilteredRows().filter(({ active }) => active).length, 2);
    selector.handleInput("\x1b");
  });

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runFlag(host, commandContext(host, ui.ui));
    assert.deepEqual(ui.overlays, [false]);

    const entries = host.sessionManager.getEntries();
    const markers = entries.filter(
      (entry): entry is CustomSessionEntry => entry.type === "custom" && entry.customType === FLAG_RECORD_TYPE,
    );
    assert.equal(markers.length, 2);
    assert.ok(markers.every((entry) => parseFlagRecord(entry.data)?.active === true));
    const replay = replayFlags(entries, host.sessionManager.getSessionId());
    assert.deepEqual(new Set(replay.active.keys()), new Set([firstId, secondId]));
    for (const marker of markers) {
      const record = parseFlagRecord(marker.data);
      assert.ok(record);
      assert.equal(replay.active.get(record.targetEntryId)?.flaggedAt, marker.timestamp);
    }
    assert.equal(host.faux.state.callCount, 0);
  } finally {
    host.cleanup();
  }
});

test("keeps /flag available to tombstone a dangling active record", async () => {
  const host = await createTestHost();
  const sessionId = host.sessionManager.getSessionId();
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId,
    targetEntryId: "missing-entry",
    active: true,
  });
  const ui = createUiHarness(async (component) => {
    const selector = requireFlagSelector(component);
    assert.equal(selector.getSelectedEntryId(), "missing-entry");
    assert.equal(selector.getFilteredRows()[0]?.diagnostic?.includes("missing"), true);
    selector.handleInput("\r");
    await nextTurn();
    selector.handleInput("\x1b");
  });

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runFlag(host, commandContext(host, ui.ui));
    const replay = replayFlags(host.sessionManager.getEntries(), sessionId);
    assert.deepEqual(replay.blockers, []);
    assert.deepEqual([...replay.active], []);
    const records = host.sessionManager
      .getEntries()
      .filter(
        (entry): entry is CustomSessionEntry => entry.type === "custom" && entry.customType === FLAG_RECORD_TYPE,
      );
    assert.equal(records.length, 2);
    assert.equal(parseFlagRecord(records.at(-1)?.data)?.active, false);
  } finally {
    host.cleanup();
  }
});

test("leaves an unflagged system prompt byte-identical", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  let capturedSystemPrompt: string | undefined;
  host.faux.setResponses([
    (context) => {
      capturedSystemPrompt = context.systemPrompt;
      return fauxAssistantMessage("ok");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    const basePrompt = host.session.systemPrompt;
    await host.session.prompt("hello");
    assert.equal(capturedSystemPrompt, basePrompt);
    assert.equal(capturedSystemPrompt?.includes("<!-- pi-flag:v1:sha256:"), false);
    assert.equal(ui.notifications.length, 0);
  } finally {
    host.cleanup();
  }
});

test("input blocks dangling state before consuming a faux response", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId: host.sessionManager.getSessionId(),
    targetEntryId: "missing",
    active: true,
  });
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("blocked");
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.ok(ui.notifications.some(({ message, type }) => message.includes("missing") && message.includes("/flag") && type === "error"));
  } finally {
    host.cleanup();
  }
});

test("input blocks focus-cap overflow without reading or sending a system prompt", async () => {
  const host = await createTestHost([], {
    faux: { models: [{ id: "tiny", contextWindow: 4000, maxTokens: 1000 }] },
  });
  const ui = createUiHarness();
  appendFlaggedUser(host, "x".repeat(6000));
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("blocked");
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.ok(ui.notifications.some(({ message }) => message.includes("Focus requires") && message.includes("Nothing was truncated")));
  } finally {
    host.cleanup();
  }
});

test("two sequential user runs send one byte-identical focus block without stale double count", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  appendFlaggedUser(host, "persistent focus");
  const systemPrompts: string[] = [];
  host.faux.setResponses([
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("first");
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("second");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("one");
    await host.session.prompt("two");
    const focus = focusForHost(host);
    assert.equal(host.faux.state.callCount, 2);
    assert.equal(systemPrompts.length, 2);
    assert.equal(systemPrompts[0], systemPrompts[1]);
    assert.equal(countOccurrences(systemPrompts[0] ?? "", focus.block), 1);
    assert.equal(countOccurrences(systemPrompts[1] ?? "", focus.block), 1);
    assert.equal(ui.notifications.some(({ type }) => type === "error"), false);
  } finally {
    host.cleanup();
  }
});

test("input and before-agent middleware chain around one canonical focus block", async () => {
  const beforePath = fileURLToPath(new URL("./fixtures/before-middleware.ts", import.meta.url));
  const packagePath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const host = await createTestHost(
    [
      {
        name: "after-middleware",
        factory(pi) {
          pi.on("input", (event) => ({
            action: "transform",
            text: `${event.text}:after`,
            ...(event.images === undefined ? {} : { images: event.images }),
          }));
          pi.on("before_agent_start", (event) => ({
            systemPrompt: `${event.systemPrompt}\nLATE-MIDDLEWARE`,
          }));
        },
      },
    ],
    { extensionPaths: [beforePath, packagePath] },
  );
  const ui = createUiHarness();
  appendFlaggedUser(host, "focus");
  let capturedSystemPrompt = "";
  let capturedInput = "";
  host.faux.setResponses([
    (context) => {
      capturedSystemPrompt = context.systemPrompt ?? "";
      const message = context.messages.at(-1);
      assert.equal(message?.role, "user");
      if (message?.role === "user") {
        capturedInput =
          typeof message.content === "string"
            ? message.content
            : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      }
      return fauxAssistantMessage("ok");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("original");
    const focus = focusForHost(host);
    assert.equal(capturedInput, "before:original:after");
    assert.equal(countOccurrences(capturedSystemPrompt, focus.block), 1);
    assert.ok(capturedSystemPrompt.indexOf("EARLY-MIDDLEWARE") < capturedSystemPrompt.indexOf(focus.block));
    assert.ok(capturedSystemPrompt.indexOf(focus.block) < capturedSystemPrompt.indexOf("LATE-MIDDLEWARE"));
  } finally {
    host.cleanup();
  }
});

test("a later handled input prevents the run and leaves the faux queue untouched", async () => {
  const host = await createTestHost([
    {
      name: "handled-after-pi-flag",
      factory(pi) {
        pi.on("input", () => ({ action: "handled" }));
      },
    },
  ]);
  const ui = createUiHarness();
  appendFlaggedUser(host, "focus");
  host.faux.setResponses([fauxAssistantMessage("queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("handled");
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
  } finally {
    host.cleanup();
  }
});

test("final capacity aborts visibly with one block and unchanged context messages", async () => {
  let signalWasAborted = false;
  let capturedSystemPrompt = "";
  let capturedMessages: unknown;
  const host = await createTestHost(
    [
      {
        name: "post-pi-flag-observer",
        factory(pi) {
          pi.on("before_agent_start", (event) => {
            capturedSystemPrompt = event.systemPrompt;
          });
          pi.on("context", (event, ctx) => {
            signalWasAborted = ctx.signal?.aborted === true;
            capturedMessages = structuredClone(event.messages);
          });
        },
      },
    ],
    { faux: { models: [{ id: "tiny-final", contextWindow: 4000, maxTokens: 1000 }] } },
  );
  const ui = createUiHarness();
  appendFlaggedUser(host, "small focus");
  const recordsBefore = host.sessionManager
    .getEntries()
    .filter((entry): entry is CustomSessionEntry => entry.type === "custom" && entry.customType === FLAG_RECORD_TYPE)
    .map((entry) => structuredClone(entry));
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("current input");
    const focus = focusForHost(host);
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.equal(signalWasAborted, true);
    assert.equal(countOccurrences(capturedSystemPrompt, focus.block), 1);
    assert.ok(Array.isArray(capturedMessages));
    assert.equal(capturedMessages.length, 1);
    assert.ok(ui.notifications.some(({ message, type }) => message.includes("Nothing was truncated") && type === "error"));
    const recordsAfter = host.sessionManager
      .getEntries()
      .filter((entry): entry is CustomSessionEntry => entry.type === "custom" && entry.customType === FLAG_RECORD_TYPE);
    assert.deepEqual(recordsAfter, recordsBefore);

    await runFlag(host, commandContext(host, ui.ui));
    assert.equal(ui.components.length, 1);
  } finally {
    host.cleanup();
  }
});

test("destructive, altered, and duplicate later prompts abort with an already-raised signal", async () => {
  for (const mode of ["replace", "alter", "duplicate"] as const) {
    let signalWasAborted = false;
    let messagesAfterGuard: unknown;
    let finalSystemPrompt = "";
    const host = await createTestHost([
      {
        name: `destructive-${mode}`,
        factory(pi) {
          pi.on("before_agent_start", (event) => {
            if (mode === "replace") return { systemPrompt: "DESTROYED" };
            if (mode === "alter") {
              return { systemPrompt: event.systemPrompt.replace("significant session observations", "changed") };
            }
            return { systemPrompt: `${event.systemPrompt}\n${event.systemPrompt}` };
          });
        },
      },
      {
        name: `observer-${mode}`,
        factory(pi) {
          pi.on("before_agent_start", (event) => {
            finalSystemPrompt = event.systemPrompt;
          });
          pi.on("context", (event, ctx) => {
            signalWasAborted = ctx.signal?.aborted === true;
            messagesAfterGuard = structuredClone(event.messages);
          });
        },
      },
    ]);
    const ui = createUiHarness();
    appendFlaggedUser(host, `focus-${mode}`);
    host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
    try {
      await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
      await host.session.prompt(`input-${mode}`);
      const focus = focusForHost(host);
      assert.equal(signalWasAborted, true, mode);
      assert.equal(host.faux.state.callCount, 0, mode);
      assert.equal(host.faux.getPendingResponseCount(), 1, mode);
      assert.ok(Array.isArray(messagesAfterGuard));
      assert.equal(messagesAfterGuard.length, 1);
      assert.equal(countOccurrences(finalSystemPrompt, focus.block), mode === "duplicate" ? 2 : 0);
      const error = ui.notifications.find(({ type }) => type === "error");
      assert.ok(error, mode);
      assert.match(error.message, /Expected one exact pi-flag block/);
      if (mode === "duplicate") assert.match(error.message, /found 2 block/);
      else assert.match(error.message, /found 0 block/);
    } finally {
      host.cleanup();
    }
  }
});

test("reload observes the current chained system prompt and preserves one block", async () => {
  let suffix = "RESOURCE-A";
  const host = await createTestHost([
    {
      name: "reloadable-system-prompt",
      factory(pi) {
        pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n${suffix}` }));
      },
    },
  ]);
  const ui = createUiHarness();
  appendFlaggedUser(host, "reload focus");
  const prompts: string[] = [];
  host.faux.setResponses([
    (context) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("first");
    },
    (context) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("second");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("before reload");
    suffix = "RESOURCE-B";
    await host.session.reload();
    await host.session.prompt("after reload");
    const focus = focusForHost(host);
    assert.match(prompts[0] ?? "", /RESOURCE-A/);
    assert.doesNotMatch(prompts[0] ?? "", /RESOURCE-B/);
    assert.match(prompts[1] ?? "", /RESOURCE-B/);
    assert.equal(countOccurrences(prompts[0] ?? "", focus.block), 1);
    assert.equal(countOccurrences(prompts[1] ?? "", focus.block), 1);
  } finally {
    host.cleanup();
  }
});

test("direct custom-trigger turns abort visibly when active flags lack a run cache", async () => {
  let signalWasAborted = false;
  let messagesAfterGuard: unknown;
  const host = await createTestHost([
    {
      name: "direct-trigger-observer",
      factory(pi) {
        pi.on("context", (event, ctx) => {
          signalWasAborted = ctx.signal?.aborted === true;
          messagesAfterGuard = structuredClone(event.messages);
        });
      },
    },
  ]);
  const ui = createUiHarness();
  appendFlaggedUser(host, "direct trigger focus");
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.sendCustomMessage(
      { customType: "test/direct", content: "trigger", display: false },
      { triggerTurn: true },
    );
    assert.equal(signalWasAborted, true);
    assert.ok(Array.isArray(messagesAfterGuard));
    assert.equal(messagesAfterGuard.length, 1);
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.ok(ui.notifications.some(({ message }) => message.includes("unsupported direct-trigger")));
  } finally {
    host.cleanup();
  }
});

test("provider-change warning is content-free and only fires across providers with active flags", async () => {
  const host = await createTestHost([], {
    faux: {
      models: [
        { id: "same-a", contextWindow: 128000, maxTokens: 16384 },
        { id: "same-b", contextWindow: 128000, maxTokens: 16384 },
      ],
    },
  });
  const ui = createUiHarness();
  const other = fauxProvider({
    api: "other-api",
    provider: "other-provider",
    models: [{ id: "other", contextWindow: 128000, maxTokens: 16384 }],
  });
  host.modelRuntime.registerNativeProvider(other.provider);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.setModel(other.getModel());
    await host.session.setModel(host.faux.models[0]);
    assert.equal(ui.notifications.length, 0);

    appendFlaggedUser(host, "TOP SECRET FLAG TEXT");
    const sameProviderModel = host.faux.models[1];
    assert.ok(sameProviderModel);
    await host.session.setModel(sameProviderModel);
    assert.equal(ui.notifications.length, 0);
    await host.session.setModel(other.getModel());
    assert.equal(ui.notifications.length, 1);
    const warning = ui.notifications[0];
    assert.equal(warning?.type, "warning");
    assert.match(warning?.message ?? "", /1 active flag/);
    assert.match(warning?.message ?? "", /other-provider/);
    assert.match(warning?.message ?? "", /tokens/);
    assert.doesNotMatch(warning?.message ?? "", /TOP SECRET FLAG TEXT/);
  } finally {
    host.modelRuntime.unregisterProvider(other.provider.id);
    host.cleanup();
  }
});

test("model downsizing blocks before send and leaves /flag available for recovery", async () => {
  const host = await createTestHost([], {
    faux: {
      models: [
        { id: "large", contextWindow: 128000, maxTokens: 16384 },
        { id: "small", contextWindow: 4000, maxTokens: 1000 },
      ],
    },
  });
  const ui = createUiHarness();
  appendFlaggedUser(host, "x".repeat(6000));
  host.faux.setResponses([fauxAssistantMessage("must remain queued")]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    const small = host.faux.models[1];
    assert.ok(small);
    await host.session.setModel(small);
    assert.equal(ui.notifications.length, 0);
    await host.session.prompt("blocked after downsize");
    assert.equal(host.faux.state.callCount, 0);
    assert.equal(host.faux.getPendingResponseCount(), 1);
    assert.ok(ui.notifications.some(({ message }) => message.includes("Focus requires")));
    await runFlag(host, commandContext(host, ui.ui));
    assert.equal(ui.components.length, 1);
  } finally {
    host.cleanup();
  }
});

test("overflow compaction failure gives active-flag recovery guidance without content", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  appendFlaggedUser(host, "PRIVATE FLAG CONTENT");
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await emitHandler(
      host,
      "session_compact_failed",
      { type: "session_compact_failed", reason: "overflow" },
      commandContext(host, ui.ui),
    );
    const notification = ui.notifications.at(-1);
    assert.equal(notification?.type, "error");
    assert.match(notification?.message ?? "", /Nothing was truncated/);
    assert.match(notification?.message ?? "", /\/flag/);
    assert.doesNotMatch(notification?.message ?? "", /PRIVATE FLAG CONTENT/);
  } finally {
    host.cleanup();
  }
});

test("preserves the exact focus block through two real manual compactions", async () => {
  let summaryIndex = 0;
  const host = await createTestHost(
    [
      {
        name: "deterministic-compaction",
        factory(pi) {
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: `summary-${++summaryIndex}`,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { source: "test" },
            },
          }));
        },
      },
    ],
    { settings: { compaction: { keepRecentTokens: 1 } } },
  );
  const ui = createUiHarness();
  const capturedPrompts: string[] = [];
  host.faux.setResponses([
    fauxAssistantMessage("source response"),
    fauxAssistantMessage("filler response"),
    (context) => {
      capturedPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("before compact response");
    },
    (context) => {
      capturedPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("after compact response");
    },
    fauxAssistantMessage("second filler response"),
    (context) => {
      capturedPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("after second compact response");
    },
  ]);
  const sourceText = "UNIQUE FLAGGED SOURCE <tag>\n  exact whitespace 🙂中\uD800";
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt(sourceText);
    const sourceEntry = host.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    assert.ok(sourceEntry?.type === "message");
    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId: host.sessionManager.getSessionId(),
      targetEntryId: sourceEntry.id,
      active: true,
    });
    await host.session.reload();

    await host.session.prompt("filler before compact");
    await host.session.prompt("capture before compact");
    await host.session.compact();
    await host.session.prompt("capture after compact");
    await host.session.prompt("filler before second compact");
    await host.session.compact();
    await host.session.prompt("capture after second compact");

    const focus = focusForHost(host);
    assert.equal(capturedPrompts.length, 3);
    assert.ok(capturedPrompts.every((prompt) => countOccurrences(prompt, focus.block) === 1));
    assert.equal(capturedPrompts[0], capturedPrompts[1]);
    assert.equal(capturedPrompts[1], capturedPrompts[2]);
    assert.ok(capturedPrompts.every((prompt) => prompt.includes(JSON.stringify(sourceText))));
    assert.equal(host.sessionManager.getEntry(sourceEntry.id)?.id, sourceEntry.id);
    assert.equal(JSON.stringify(host.session.messages).includes(sourceText), false);
    assert.equal(host.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 2);
  } finally {
    host.cleanup();
  }
});

test("keeps one identical focus block through a tool-call continuation", async () => {
  const host = await createTestHost([], { tools: ["read"] });
  const ui = createUiHarness();
  appendFlaggedUser(host, "tool continuation focus");
  const file = join(host.root, "tool-input.txt");
  writeFileSync(file, "tool output");
  const prompts: string[] = [];
  host.faux.setResponses([
    (context) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(
        [fauxText("checking"), fauxToolCall("read", { path: file }, { id: "read-1" })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("done");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("use the tool");
    const focus = focusForHost(host);
    assert.equal(host.faux.state.callCount, 2);
    assert.deepEqual(prompts, [prompts[0], prompts[0]]);
    assert.equal(countOccurrences(prompts[0] ?? "", focus.block), 1);
    assert.ok(host.session.messages.some((message) => message.role === "toolResult"));
  } finally {
    host.cleanup();
  }
});

test("faux cache accounting follows stable prefix and flag suffix invalidation", async () => {
  const host = await createTestHost();
  const ui = createUiHarness();
  const firstId = host.sessionManager.appendMessage({ role: "user", content: "first flag", timestamp: 1 });
  const secondId = host.sessionManager.appendMessage({ role: "user", content: "second flag", timestamp: 2 });
  const sessionId = host.sessionManager.getSessionId();
  host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId,
    targetEntryId: firstId,
    active: true,
  });
  const contexts: Context[] = [];
  const responses = Array.from({ length: 6 }, (_, index) => (context: Context) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage(`response-${index}`);
  });
  host.faux.setResponses(responses);
  const usages: Array<ReturnType<typeof latestAssistant>["usage"]> = [];
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });

    await host.session.prompt("turn-1");
    usages.push(latestAssistant(host).usage);
    await host.session.prompt("turn-2");
    usages.push(latestAssistant(host).usage);

    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId,
      targetEntryId: secondId,
      active: true,
    });
    await host.session.reload();
    await host.session.prompt("turn-3-add");
    usages.push(latestAssistant(host).usage);

    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId,
      targetEntryId: firstId,
      active: false,
    });
    await host.session.reload();
    await host.session.prompt("turn-4-remove");
    usages.push(latestAssistant(host).usage);

    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId,
      targetEntryId: firstId,
      active: true,
    });
    await host.session.reload();
    await host.session.prompt("turn-5-reflag");
    usages.push(latestAssistant(host).usage);

    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId,
      targetEntryId: firstId,
      active: false,
    });
    host.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId,
      targetEntryId: secondId,
      active: false,
    });
    await host.session.reload();
    await host.session.prompt("turn-6-empty");
    usages.push(latestAssistant(host).usage);

    assert.equal(contexts.length, 6);
    assert.equal(usages.length, 6);
    const serialized = contexts.map(serializeFauxContext);
    for (let index = 0; index < serialized.length; index++) {
      const previous = serialized[index - 1];
      const current = serialized[index] ?? "";
      const prefixLength = previous === undefined ? 0 : commonPrefixLength(previous, current);
      const expectedRead = previous === undefined ? 0 : Math.ceil(prefixLength / 4);
      const expectedWrite = Math.ceil(current.slice(prefixLength).length / 4);
      assert.equal(usages[index]?.cacheRead, expectedRead, `cacheRead turn ${index + 1}`);
      assert.equal(usages[index]?.cacheWrite, expectedWrite, `cacheWrite turn ${index + 1}`);
    }

    const systems = contexts.map((context) => context.systemPrompt ?? "");
    assert.equal(systems[0], systems[1]);
    const blockStart = systems[0]?.indexOf("\n\n## pi-flag: significant session observations") ?? -1;
    assert.ok(blockStart > 0);
    const basePrompt = systems[0]?.slice(0, blockStart) ?? "";
    for (const system of systems.slice(2)) assert.ok(system.startsWith(basePrompt));
    for (const system of systems.slice(0, 5)) assert.equal(countOccurrences(system, "<!-- pi-flag:v1:sha256:"), 1);
    assert.equal(countOccurrences(systems[5] ?? "", "<!-- pi-flag:v1:sha256:"), 0);
    assert.notEqual(systems[1], systems[2]);
    assert.notEqual(systems[2], systems[3]);
    assert.notEqual(systems[3], systems[4]);
    assert.ok((systems[4]?.indexOf(secondId) ?? -1) < (systems[4]?.indexOf(firstId) ?? -1));
    assert.equal(usages[0]?.cacheRead, 0);
    assert.ok((usages[0]?.cacheWrite ?? 0) > 0);
    assert.ok((usages[1]?.cacheRead ?? 0) > 0);
  } finally {
    host.cleanup();
  }
});

test("persists flags when reopening the same session ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-flag-resume-"));
  const sessionDir = join(root, "sessions");
  let sessionFile = "";
  let sessionId = "";
  const sourceText = "persistent resume source 🙂";
  try {
    const firstManager = SessionManager.create(root, sessionDir, { id: "resume-session" });
    const first = await createTestHost([], {
      root,
      sessionManager: firstManager,
      removeRootOnCleanup: false,
    });
    try {
      first.faux.setResponses([fauxAssistantMessage("source response")]);
      await first.session.bindExtensions({ mode: "tui", uiContext: createUiHarness().ui });
      await first.session.prompt(sourceText);
      const sourceEntry = first.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(sourceEntry?.type === "message");
      first.sessionManager.appendCustomEntry(FLAG_RECORD_TYPE, {
        version: 1,
        sessionId: first.sessionManager.getSessionId(),
        targetEntryId: sourceEntry.id,
        active: true,
      });
      sessionFile = first.sessionManager.getSessionFile() ?? "";
      sessionId = first.sessionManager.getSessionId();
      assert.equal(existsSync(sessionFile), true);
    } finally {
      first.cleanup();
    }

    const reopenedManager = SessionManager.open(sessionFile, sessionDir, root);
    const reopened = await createTestHost([], {
      root,
      sessionManager: reopenedManager,
      removeRootOnCleanup: false,
    });
    let systemPrompt = "";
    reopened.faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("resumed");
      },
    ]);
    try {
      await reopened.session.bindExtensions({ mode: "tui", uiContext: createUiHarness().ui });
      await reopened.session.prompt("after resume");
      const focus = focusForHost(reopened);
      assert.equal(reopened.sessionManager.getSessionId(), sessionId);
      assert.equal(countOccurrences(systemPrompt, focus.block), 1);
      assert.match(systemPrompt, new RegExp(JSON.stringify(sourceText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      reopened.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("labels a pre-assistant flag not-yet-saved and durable after assistant flush", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-flag-durability-"));
  const sessionDir = join(root, "sessions");
  const manager = SessionManager.create(root, sessionDir, { id: "durability-session" });
  const host = await createTestHost([], { root, sessionManager: manager, removeRootOnCleanup: false });
  const rendered: string[] = [];
  const ui = createUiHarness((component) => {
    rendered.push(requireFlagSelector(component).render(100).join("\n"));
  });
  try {
    const sourceId = manager.appendMessage({ role: "user", content: "before assistant", timestamp: 1 });
    manager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId: manager.getSessionId(),
      targetEntryId: sourceId,
      active: true,
    });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(existsSync(sessionFile), false);
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runFlag(host, commandContext(host, ui.ui, { useActualSessionFile: true }));
    assert.match(rendered[0] ?? "", /not-yet-saved/);

    manager.appendMessage(fauxAssistantMessage("first assistant"));
    assert.equal(existsSync(sessionFile), true);
    await runFlag(host, commandContext(host, ui.ui, { useActualSessionFile: true }));
    assert.match(rendered[1] ?? "", /durable/);
  } finally {
    host.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects an off-branch flag after rewinding before its marker", async () => {
  const host = await createTestHost();
  const manager = host.sessionManager;
  const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const offBranchId = manager.appendMessage({ role: "user", content: "OFF BRANCH SOURCE", timestamp: 2 });
  manager.branch(rootId);
  manager.appendMessage({ role: "user", content: "active branch", timestamp: 3 });
  manager.appendCustomEntry(FLAG_RECORD_TYPE, {
    version: 1,
    sessionId: manager.getSessionId(),
    targetEntryId: offBranchId,
    active: true,
  });
  manager.branch(rootId);
  let systemPrompt = "";
  const ui = createUiHarness((component) => {
    const selector = requireFlagSelector(component);
    const offBranch = selector.getFilteredRows().find(({ entryId }) => entryId === offBranchId);
    assert.equal(offBranch?.active, true);
    assert.equal(offBranch?.onActiveBranch, false);
  });
  host.faux.setResponses([
    (context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("active response");
    },
  ]);
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("after rewind");
    await runFlag(host, commandContext(host, ui.ui));
    const focus = focusForHost(host);
    assert.equal(countOccurrences(systemPrompt, focus.block), 1);
    assert.match(systemPrompt, /OFF BRANCH SOURCE/);
    assert.equal(manager.getBranch().some(({ id }) => id === offBranchId), false);
    assert.equal(replayFlags(manager.getEntries(), manager.getSessionId()).active.has(offBranchId), true);
  } finally {
    host.cleanup();
  }
});

test("forked session IDs ignore copied flags while imported same-ID files restore them", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "pi-flag-source-session-"));
  const forkRoot = mkdtempSync(join(tmpdir(), "pi-flag-fork-session-"));
  const importRoot = mkdtempSync(join(tmpdir(), "pi-flag-import-session-"));
  try {
    const sourceDir = join(sourceRoot, "sessions");
    const sourceManager = SessionManager.create(sourceRoot, sourceDir, { id: "source-session" });
    const sourceId = sourceManager.appendMessage({ role: "user", content: "COPIED FLAG SOURCE", timestamp: 1 });
    sourceManager.appendCustomEntry(FLAG_RECORD_TYPE, {
      version: 1,
      sessionId: sourceManager.getSessionId(),
      targetEntryId: sourceId,
      active: true,
    });
    sourceManager.appendMessage(fauxAssistantMessage("flush source"));
    const sourceFile = sourceManager.getSessionFile();
    assert.ok(sourceFile && existsSync(sourceFile));

    const forkDir = join(forkRoot, "sessions");
    const forkManager = SessionManager.forkFrom(sourceFile, forkRoot, forkDir, { id: "forked-session" });
    const forked = await createTestHost([], {
      root: forkRoot,
      sessionManager: forkManager,
      removeRootOnCleanup: false,
    });
    let forkSystemPrompt = "";
    forked.faux.setResponses([
      (context) => {
        forkSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("fork response");
      },
    ]);
    try {
      await forked.session.bindExtensions({ mode: "tui", uiContext: createUiHarness().ui });
      await forked.session.prompt("fork prompt");
      assert.equal(focusForHost(forked).block, "");
      assert.equal(forkSystemPrompt.includes("<!-- pi-flag:v1:sha256:"), false);
      assert.notEqual(forked.sessionManager.getSessionId(), sourceManager.getSessionId());
    } finally {
      forked.cleanup();
    }

    const importDir = join(importRoot, "sessions");
    mkdirSync(importDir, { recursive: true });
    const importedFile = join(importDir, "imported.jsonl");
    copyFileSync(sourceFile, importedFile);
    const importedManager = SessionManager.open(importedFile, importDir, importRoot);
    const imported = await createTestHost([], {
      root: importRoot,
      sessionManager: importedManager,
      removeRootOnCleanup: false,
    });
    let importedSystemPrompt = "";
    imported.faux.setResponses([
      (context) => {
        importedSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("import response");
      },
    ]);
    try {
      await imported.session.bindExtensions({ mode: "tui", uiContext: createUiHarness().ui });
      await imported.session.prompt("import prompt");
      const focus = focusForHost(imported);
      assert.equal(imported.sessionManager.getSessionId(), sourceManager.getSessionId());
      assert.equal(countOccurrences(importedSystemPrompt, focus.block), 1);
      assert.match(importedSystemPrompt, /COPIED FLAG SOURCE/);
    } finally {
      imported.cleanup();
    }
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(forkRoot, { recursive: true, force: true });
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test("allows an append-only flag toggle while branch summarization is pending", async () => {
  let markSummaryStarted = () => {};
  const summaryStarted = new Promise<void>((resolve) => {
    markSummaryStarted = resolve;
  });
  let releaseSummary = () => {};
  const summaryRelease = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  const host = await createTestHost([
    {
      name: "delayed-branch-summary",
      factory(pi) {
        pi.on("session_before_tree", async () => {
          markSummaryStarted();
          await summaryRelease;
          return { summary: { summary: "deterministic branch summary", details: { source: "test" } } };
        });
      },
    },
  ]);
  const manager = host.sessionManager;
  const rootId = manager.appendMessage({ role: "user", content: "ROOT OVERLAP SOURCE", timestamp: 1 });
  const commonId = manager.appendMessage(fauxAssistantMessage("common response"));
  manager.appendMessage({ role: "user", content: "old branch", timestamp: 2 });
  const oldLeafId = manager.appendMessage(fauxAssistantMessage("old response"));
  manager.branch(commonId);
  manager.appendMessage({ role: "user", content: "branch being summarized", timestamp: 3 });
  manager.appendMessage(fauxAssistantMessage("new response"));
  host.session.state.messages = manager.buildSessionContext().messages;
  const ui = createUiHarness(async (component) => {
    const selector = requireFlagSelector(component);
    selector.handleInput("ROOT OVERLAP SOURCE");
    assert.equal(selector.getSelectedEntryId(), rootId);
    selector.handleInput("\r");
    selector.render(100);
    selector.handleInput("\r");
    await nextTurn();
    selector.handleInput("\x1b");
  });
  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    const navigation = host.session.navigateTree(oldLeafId, { summarize: true });
    await summaryStarted;
    assert.equal(host.session.isIdle, true);
    await runFlag(host, commandContext(host, ui.ui));
    const marker = manager
      .getEntries()
      .find(
        (entry): entry is CustomSessionEntry =>
          entry.type === "custom" &&
          entry.customType === FLAG_RECORD_TYPE &&
          parseFlagRecord(entry.data)?.targetEntryId === rootId,
      );
    assert.ok(marker);
    releaseSummary();
    const result = await navigation;
    assert.equal(result.cancelled, false);
    assert.equal(result.summaryEntry?.summary, "deterministic branch summary");
    assert.equal(replayFlags(manager.getEntries(), manager.getSessionId()).active.has(rootId), true);

    let systemPrompt = "";
    host.faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("after overlap");
      },
    ]);
    await host.session.prompt("after overlap");
    const focus = focusForHost(host);
    assert.equal(countOccurrences(systemPrompt, focus.block), 1);
    assert.match(systemPrompt, /ROOT OVERLAP SOURCE/);
  } finally {
    releaseSummary();
    host.cleanup();
  }
});
