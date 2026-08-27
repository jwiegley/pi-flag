import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  FlagSelector,
  type FlagSelectorOptions,
  type FlagSelectorRow,
  type FlagSelectorSnapshot,
} from "../src/selector.ts";

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

function row(
  entryId: string,
  sourceTimestamp: string,
  text: string,
  options: Partial<FlagSelectorRow> = {},
): FlagSelectorRow {
  return {
    entryId,
    role: "user",
    sourceTimestamp,
    textBlocks: [text],
    active: false,
    onActiveBranch: true,
    ...options,
  };
}

function snapshot(rows: readonly FlagSelectorRow[]): FlagSelectorSnapshot {
  return {
    rows,
    estimatedTokens: 321,
    sessionStatus: "durable",
    warnings: [],
  };
}

function createTui(rows = 24): { tui: TUI; terminal: { rows: number }; renders(): number } {
  const terminal = { rows };
  let renderCount = 0;
  const tui = {
    terminal,
    requestRender() {
      renderCount++;
    },
  } as unknown as TUI;
  return { tui, terminal, renders: () => renderCount };
}

function createSelector(
  initialSnapshot: FlagSelectorSnapshot,
  options: {
    rows?: number;
    keybindings?: KeybindingsManager;
    onToggle?: FlagSelectorOptions["onToggle"];
    onClose?: () => void;
  } = {},
): { selector: FlagSelector; terminal: { rows: number }; renders(): number } {
  const tui = createTui(options.rows);
  const keybindings = options.keybindings ?? new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  let currentSnapshot = initialSnapshot;
  const selector = new FlagSelector({
    tui: tui.tui,
    theme: plainTheme,
    keybindings,
    snapshot: initialSnapshot,
    onToggle:
      options.onToggle ??
      (async (entryId, nextActive) => {
        currentSnapshot = {
          ...currentSnapshot,
          rows: currentSnapshot.rows.map((item) =>
            item.entryId === entryId ? { ...item, active: nextActive } : item,
          ),
        };
        return currentSnapshot;
      }),
    onClose: options.onClose ?? (() => {}),
  });
  selector.focused = true;
  return { selector, terminal: tui.terminal, renders: tui.renders };
}

function ids(selector: FlagSelector): string[] {
  return selector.getFilteredRows().map(({ entryId }) => entryId);
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("renders newest-first rows and applies modes before fuzzy full-corpus search", () => {
  const { selector } = createSelector(
    snapshot([
      row("old-user", "2026-01-01T00:00:01.000Z", "legacy request"),
      row("new-assistant", "2026-01-01T00:00:03.000Z", "Calibration knob result", {
        role: "assistant",
        active: true,
        onActiveBranch: false,
        assistantStopReason: "length",
      }),
      row("middle-user", "2026-01-01T00:00:02.000Z", "other request"),
    ]),
  );
  assert.deepEqual(ids(selector), ["new-assistant", "middle-user", "old-user"]);

  selector.handleInput("clbtn");
  assert.equal(selector.getQuery(), "clbtn");
  assert.deepEqual(ids(selector), ["new-assistant"]);

  selector.handleInput("\t");
  assert.equal(selector.getMode(), "user");
  assert.deepEqual(ids(selector), []);
  selector.handleInput("\t");
  assert.equal(selector.getMode(), "assistant");
  assert.deepEqual(ids(selector), ["new-assistant"]);
  selector.handleInput("\t");
  assert.equal(selector.getMode(), "flagged");
  assert.deepEqual(ids(selector), ["new-assistant"]);
});

test("selection survives query and snapshot rebuilds by entry ID", async () => {
  const initial = snapshot([
    row("c", "2026-01-01T00:00:03.000Z", "charlie"),
    row("b", "2026-01-01T00:00:02.000Z", "beta target"),
    row("a", "2026-01-01T00:00:01.000Z", "alpha"),
  ]);
  const { selector } = createSelector(initial);
  selector.handleInput("\x1b[B");
  assert.equal(selector.getSelectedEntryId(), "b");
  selector.handleInput("beta");
  assert.equal(selector.getSelectedEntryId(), "b");

  selector.setSnapshot({
    ...initial,
    rows: initial.rows.map((item) => (item.entryId === "b" ? { ...item, active: true } : item)),
  });
  assert.equal(selector.getSelectedEntryId(), "b");

  selector.handleInput("\r");
  await nextTurn();
  assert.equal(selector.getSelectedEntryId(), "b");
});

test("accessibility: width and narrow-terminal fallbacks stay bounded", () => {
  const { selector, terminal } = createSelector(
    snapshot(
      Array.from({ length: 12 }, (_, index) =>
        row(`entry-${index}`, `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, `row ${index} 🙂中`),
      ),
    ),
  );

  for (const [width, height] of [
    [80, 24],
    [40, 10],
    [20, 5],
    [1, 3],
  ] as const) {
    terminal.rows = height;
    const lines = selector.render(width);
    assert.ok(lines.length <= height);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width} columns: ${line}`);
  }
  assert.deepEqual(selector.render(0), []);
});

test("accessibility: non-color state and focus remain explicit in plain text", () => {
  const { selector } = createSelector(
    snapshot([
      row("flagged", "2026-01-01T00:00:03.000Z", "flagged text", {
        role: "assistant",
        active: true,
        onActiveBranch: false,
      }),
      row("diagnostic", "2026-01-01T00:00:02.000Z", "", {
        role: "unknown",
        active: true,
        onActiveBranch: false,
        diagnostic: "Missing source entry",
      }),
      row("plain", "2026-01-01T00:00:01.000Z", "plain text"),
    ]),
  );
  const rendered = selector.render(100).map(stripTerminalSequences);
  assert.equal(rendered.filter((line) => line.startsWith("> ")).length, 1);
  assert.ok(rendered.some((line) => line.includes("[flagged]") && line.includes("[off-branch]")));
  assert.ok(rendered.some((line) => line.includes("[!] unknown") && line.includes("Missing source")));
  assert.ok(rendered.some((line) => line.includes("[ ] user") && line.includes("[active]")));
});

test("accessibility: unicode and bracketed paste use Input semantics", () => {
  const { selector } = createSelector(
    snapshot([
      row("unicode", "2026-01-01T00:00:02.000Z", "中🙂needle"),
      row("other", "2026-01-01T00:00:01.000Z", "other"),
    ]),
  );
  selector.handleInput("\x1b[200~中🙂\nneedle\x1b[201~");
  assert.equal(selector.getQuery(), "中🙂needle");
  assert.deepEqual(ids(selector), ["unicode"]);

  const grapheme = createSelector(snapshot([row("accent", "2026-01-01T00:00:01.000Z", "accent")])).selector;
  grapheme.handleInput("e\u0301");
  grapheme.handleInput("\x7f");
  assert.equal(grapheme.getQuery(), "");

  const kitty = createSelector(snapshot([row("alpha", "2026-01-01T00:00:01.000Z", "alpha")])).selector;
  kitty.handleInput("\x1b[97u");
  assert.equal(kitty.getQuery(), "a");
  assert.deepEqual(ids(kitty), ["alpha"]);

  const kittyControl = createSelector(
    snapshot([
      row("new", "2026-01-01T00:00:02.000Z", "new"),
      row("old", "2026-01-01T00:00:01.000Z", "old"),
    ]),
  ).selector;
  kittyControl.handleInput("\x1b[57420u");
  assert.equal(kittyControl.getSelectedEntryId(), "old");
});

test("accessibility: configurable bindings replace defaults without raw-key fallbacks", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
    "tui.select.pageUp": "ctrl+b",
    "tui.select.pageDown": "ctrl+f",
    "tui.select.confirm": "ctrl+x",
    "tui.select.cancel": "ctrl+g",
    "tui.input.tab": "ctrl+t",
  });
  const toggles: Array<{ entryId: string; active: boolean }> = [];
  let closes = 0;
  const initial = snapshot([
    row("c", "2026-01-01T00:00:03.000Z", "charlie"),
    row("b", "2026-01-01T00:00:02.000Z", "beta"),
    row("a", "2026-01-01T00:00:01.000Z", "alpha"),
  ]);
  const { selector } = createSelector(initial, {
    keybindings,
    onToggle: async (entryId, active) => {
      toggles.push({ entryId, active });
      return initial;
    },
    onClose: () => {
      closes++;
    },
  });

  selector.handleInput("\x1b[B");
  assert.equal(selector.getSelectedEntryId(), "c");
  selector.handleInput("\x0e");
  assert.equal(selector.getSelectedEntryId(), "b");
  selector.handleInput("\x06");
  assert.equal(selector.getSelectedEntryId(), "a");
  selector.handleInput("\x02");
  assert.equal(selector.getSelectedEntryId(), "c");
  selector.handleInput("\x14");
  assert.equal(selector.getMode(), "user");
  selector.handleInput("\x18");
  await nextTurn();
  assert.deepEqual(toggles, [{ entryId: "c", active: true }]);

  selector.handleInput("\x1b");
  assert.equal(closes, 0);
  selector.handleInput("\x07");
  assert.equal(closes, 1);
});

test("shows a bounded no-match state and still honors cancel", () => {
  let closes = 0;
  const { selector, terminal } = createSelector(snapshot([row("a", "2026-01-01T00:00:01.000Z", "alpha")]), {
    rows: 5,
    onClose: () => {
      closes++;
    },
  });
  selector.handleInput("zzz");
  assert.equal(selector.getSelectedEntryId(), undefined);
  terminal.rows = 5;
  const lines = selector.render(20).map(stripTerminalSequences);
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.includes("No matching")));
  selector.handleInput("\x1b");
  assert.equal(closes, 1);
});
