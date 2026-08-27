import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  Extension,
  ExtensionCommandContext,
  ExtensionUIContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  KeybindingsManager,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

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
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;

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
