import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  type Component,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
  truncateToWidth,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type FlagSelectorMode = "all" | "user" | "assistant" | "flagged";

export type FlagSelectorRow = {
  entryId: string;
  role: "user" | "assistant" | "unknown";
  sourceTimestamp: string;
  textBlocks: string[];
  active: boolean;
  onActiveBranch: boolean;
  assistantStopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  diagnostic?: string;
};

export type FlagSelectorSnapshot = {
  rows: readonly FlagSelectorRow[];
  estimatedTokens: number;
  sessionStatus: "durable" | "not-yet-saved" | "ephemeral";
  warnings: readonly string[];
};

export type FlagSelectorOptions = {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  snapshot: FlagSelectorSnapshot;
  onToggle(entryId: string, nextActive: boolean): Promise<FlagSelectorSnapshot>;
  onClose(): void;
};

const MODES: readonly FlagSelectorMode[] = ["all", "user", "assistant", "flagged"];
const MAX_VISIBLE_ROWS = 8;

export class FlagSelector implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly input = new Input();
  private readonly onToggle: FlagSelectorOptions["onToggle"];
  private readonly onClose: FlagSelectorOptions["onClose"];
  private snapshot: FlagSelectorSnapshot;
  private allRows: FlagSelectorRow[] = [];
  private filteredRows: FlagSelectorRow[] = [];
  private selectedEntryId: string | undefined;
  private selectedIndex = 0;
  private mode: FlagSelectorMode = "all";
  private transientError: string | undefined;
  private isFocused = false;

  constructor(options: FlagSelectorOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.snapshot = options.snapshot;
    this.onToggle = options.onToggle;
    this.onClose = options.onClose;
    this.rebuildRows();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  getMode(): FlagSelectorMode {
    return this.mode;
  }

  getQuery(): string {
    return this.input.getValue();
  }

  getSelectedEntryId(): string | undefined {
    return this.selectedEntryId;
  }

  getFilteredRows(): readonly FlagSelectorRow[] {
    return this.filteredRows;
  }

  setSnapshot(snapshot: FlagSelectorSnapshot): void {
    this.snapshot = snapshot;
    this.rebuildRows();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onClose();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      const modeIndex = MODES.indexOf(this.mode);
      this.mode = MODES[(modeIndex + 1) % MODES.length] ?? "all";
      this.rebuildRows();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.movePage(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.movePage(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      void this.toggleSelected();
      return;
    }

    const previousQuery = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previousQuery) this.rebuildRows();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const maxLines = Math.max(1, this.tui.terminal.rows);
    const includeSummary = maxLines >= 4;
    const includeHelp = maxLines >= 5;
    const selected = this.filteredRows[this.selectedIndex];
    const includeDetail = width >= 40 && maxLines >= 8 && selected !== undefined;
    const detailLines = includeDetail ? this.renderDetail(selected, width).slice(0, 2) : [];
    const reservedLines = 2 + (includeSummary ? 1 : 0) + (includeHelp ? 1 : 0) + detailLines.length;
    const listCapacity = Math.max(0, Math.min(MAX_VISIBLE_ROWS, maxLines - reservedLines));
    const lines: string[] = [];

    lines.push(this.fit(this.theme.bold(`pi-flag — ${this.mode}`), width));
    if (lines.length >= maxLines) return lines;

    const queryWidth = Math.max(1, width - 7);
    const queryLine = this.input.render(queryWidth)[0] ?? "";
    lines.push(this.fit(`${this.theme.fg("accent", "Filter")} ${queryLine}`, width));
    if (lines.length >= maxLines) return lines;

    if (includeSummary) {
      const activeCount = this.snapshot.rows.filter((row) => row.active).length;
      const warningText = this.snapshot.warnings.length === 0 ? "" : ` · ${this.snapshot.warnings.length} warning(s)`;
      const summary = `${this.filteredRows.length}/${this.allRows.length} shown · ${activeCount} flagged · ~${this.snapshot.estimatedTokens} tokens · ${this.snapshot.sessionStatus}${warningText}`;
      lines.push(this.fit(this.theme.fg("muted", summary), width));
    }

    if (listCapacity > 0) {
      if (this.filteredRows.length === 0) {
        lines.push(this.fit(this.theme.fg("muted", "> No matching entries"), width));
      } else {
        const start = Math.max(
          0,
          Math.min(this.selectedIndex - Math.floor(listCapacity / 2), this.filteredRows.length - listCapacity),
        );
        for (const row of this.filteredRows.slice(start, start + listCapacity)) {
          lines.push(this.renderRow(row, row.entryId === this.selectedEntryId, width));
        }
      }
    }

    if (this.transientError && lines.length < maxLines - (includeHelp ? 1 : 0)) {
      lines.push(this.fit(this.theme.fg("error", `[!] ${this.transientError}`), width));
    } else {
      for (const line of detailLines) {
        if (lines.length >= maxLines - (includeHelp ? 1 : 0)) break;
        lines.push(this.fit(this.theme.fg("dim", line), width));
      }
    }

    if (includeHelp && lines.length < maxLines) lines.push(this.renderHelp(width));
    return lines.slice(0, maxLines);
  }

  private rebuildRows(): void {
    const selectedEntryId = this.selectedEntryId;
    const previousIndex = this.selectedIndex;
    this.allRows = [...this.snapshot.rows].sort((left, right) => {
      if (left.sourceTimestamp !== right.sourceTimestamp) {
        return left.sourceTimestamp < right.sourceTimestamp ? 1 : -1;
      }
      return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
    });
    const modeRows = this.allRows.filter((row) => {
      if (this.mode === "user") return row.role === "user";
      if (this.mode === "assistant") return row.role === "assistant";
      if (this.mode === "flagged") return row.active;
      return true;
    });
    const query = this.input.getValue();
    this.filteredRows = query.length === 0 ? modeRows : fuzzyFilter(modeRows, query, (row) => this.searchText(row));

    const retainedIndex = selectedEntryId
      ? this.filteredRows.findIndex((row) => row.entryId === selectedEntryId)
      : -1;
    this.selectedIndex = retainedIndex >= 0 ? retainedIndex : Math.min(previousIndex, Math.max(0, this.filteredRows.length - 1));
    this.selectedEntryId = this.filteredRows[this.selectedIndex]?.entryId;
  }

  private searchText(row: FlagSelectorRow): string {
    return [
      row.entryId,
      row.role,
      row.active ? "flagged" : "unflagged",
      row.onActiveBranch ? "active branch" : "off branch",
      row.assistantStopReason ?? "",
      row.diagnostic ?? "",
      ...row.textBlocks,
    ].join("\n");
  }

  private moveSelection(delta: number): void {
    if (this.filteredRows.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filteredRows.length) % this.filteredRows.length;
    this.selectedEntryId = this.filteredRows[this.selectedIndex]?.entryId;
    this.tui.requestRender();
  }

  private movePage(direction: -1 | 1): void {
    if (this.filteredRows.length === 0) return;
    const pageSize = Math.max(1, Math.min(MAX_VISIBLE_ROWS, this.tui.terminal.rows - 4));
    this.selectedIndex = Math.max(0, Math.min(this.filteredRows.length - 1, this.selectedIndex + direction * pageSize));
    this.selectedEntryId = this.filteredRows[this.selectedIndex]?.entryId;
    this.tui.requestRender();
  }

  private async toggleSelected(): Promise<void> {
    const row = this.filteredRows[this.selectedIndex];
    if (!row) return;
    try {
      this.transientError = undefined;
      const snapshot = await this.onToggle(row.entryId, !row.active);
      this.setSnapshot(snapshot);
    } catch (error) {
      this.transientError = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    }
  }

  private renderRow(row: FlagSelectorRow, selected: boolean, width: number): string {
    const cursor = selected ? "> " : "  ";
    const state = row.diagnostic ? "[!]" : row.active ? "[flagged]" : "[ ]";
    const branch = row.onActiveBranch ? "[active]" : "[off-branch]";
    const stopReason = row.assistantStopReason ? ` [${row.assistantStopReason}]` : "";
    const contentPreview = row.textBlocks.join(" ").replace(/[\r\n]+/g, " ").trim();
    const preview = row.diagnostic ?? (contentPreview || "(empty)");
    const plain = `${cursor}${state} ${row.role} ${row.entryId.slice(0, 8)} ${branch}${stopReason} ${preview}`;
    const fitted = this.fit(plain, width);
    if (row.diagnostic) return this.theme.fg("error", fitted);
    return selected ? this.theme.inverse(fitted) : fitted;
  }

  private renderDetail(row: FlagSelectorRow, width: number): string[] {
    const text = row.diagnostic ?? row.textBlocks.join("\n\n");
    const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 2));
    return wrapped.map((line, index) => `${index === 0 ? "Detail: " : "        "}${line}`);
  }

  private renderHelp(width: number): string {
    const up = this.keys("tui.select.up");
    const down = this.keys("tui.select.down");
    const confirm = this.keys("tui.select.confirm");
    const cancel = this.keys("tui.select.cancel");
    const tab = this.keys("tui.input.tab");
    return this.fit(this.theme.fg("muted", `${up}/${down} move · ${confirm} toggle · ${tab} mode · ${cancel} close`), width);
  }

  private keys(action: Keybinding): string {
    const keys = this.keybindings.getKeys(action);
    return keys.length === 0 ? "unbound" : keys.join("/");
  }

  private fit(line: string, width: number): string {
    return truncateToWidth(line, width, "");
  }
}
