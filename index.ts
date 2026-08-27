import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessFocusAdmission, serializeFocus, type SerializedFocus } from "./src/focus.ts";
import {
  FlagSelector,
  type FlagSelectorRow,
  type FlagSelectorSnapshot,
} from "./src/selector.ts";
import {
  extractFlagSource,
  FLAG_RECORD_TYPE,
  parseFlagRecord,
  replayFlags,
  type FlagReplay,
  type PiFlagRecordV1,
} from "./src/state.ts";

type RuntimeState = {
  sessionId?: string;
  replay: FlagReplay;
  serialized: SerializedFocus;
  manualCompactionActive: boolean;
  hasCurrentSessionRecords: boolean;
};

function emptyReplay(): FlagReplay {
  return { active: new Map(), warnings: [], blockers: [] };
}

export default function piFlag(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    replay: emptyReplay(),
    serialized: { block: "", sentinel: "", estimatedTokens: 0 },
    manualCompactionActive: false,
    hasCurrentSessionRecords: false,
  };

  const refreshState = (ctx: ExtensionContext): void => {
    const entries = ctx.sessionManager.getEntries();
    const sessionId = ctx.sessionManager.getSessionId();
    state.sessionId = sessionId;
    state.replay = replayFlags(entries, sessionId);
    state.serialized = serializeFocus(state.replay.active, sessionId);
    state.hasCurrentSessionRecords = entries.some((entry) => {
      if (entry.type !== "custom" || entry.customType !== FLAG_RECORD_TYPE) return false;
      const record = parseFlagRecord(entry.data);
      return record?.sessionId === sessionId;
    });
  };

  const buildSnapshot = (ctx: ExtensionContext): FlagSelectorSnapshot => {
    const entries = ctx.sessionManager.getEntries();
    const branchIds = new Set(ctx.sessionManager.getBranch().map(({ id }) => id));
    const seen = new Set<string>();
    const rows: FlagSelectorRow[] = [];

    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      const source = extractFlagSource(entry);
      if (!source) continue;
      seen.add(entry.id);
      rows.push({
        entryId: source.entryId,
        role: source.role,
        sourceTimestamp: source.sourceTimestamp,
        textBlocks: [...source.textBlocks],
        active: state.replay.active.has(source.entryId),
        onActiveBranch: branchIds.has(source.entryId),
        ...(source.assistantStopReason === undefined ? {} : { assistantStopReason: source.assistantStopReason }),
      });
    }

    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    for (const blocker of state.replay.blockers) {
      if (!blocker.targetEntryId || seen.has(blocker.targetEntryId)) continue;
      const recordEntry = entryById.get(blocker.recordEntryId);
      rows.push({
        entryId: blocker.targetEntryId,
        role: "unknown",
        sourceTimestamp: recordEntry?.timestamp ?? "",
        textBlocks: [],
        active: true,
        onActiveBranch: false,
        diagnostic: blocker.message,
      });
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionStatus =
      sessionFile === undefined ? "ephemeral" : existsSync(sessionFile) ? "durable" : "not-yet-saved";
    return {
      rows,
      estimatedTokens: state.serialized.estimatedTokens,
      sessionStatus,
      warnings: state.replay.warnings.map(({ message }) => message),
    };
  };


  const toggle = async (
    entryId: string,
    nextActive: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<FlagSelectorSnapshot> => {
    if (!ctx.isIdle() || state.manualCompactionActive) {
      throw new Error("Cannot change pi-flag state while the agent or manual compaction is active");
    }
    refreshState(ctx);
    if (nextActive && state.replay.blockers.length > 0) {
      throw new Error("Resolve dangling active flags before adding another flag");
    }

    const candidate = new Map(state.replay.active);
    if (nextActive && !candidate.has(entryId)) {
      const sourceEntry = ctx.sessionManager.getEntry(entryId);
      const source = sourceEntry ? extractFlagSource(sourceEntry) : undefined;
      if (!source) throw new Error(`Entry ${entryId} is not eligible flag text`);
      let activationIndex = 0;
      for (const flag of candidate.values()) activationIndex = Math.max(activationIndex, flag.activationIndex + 1);
      candidate.set(entryId, {
        ...source,
        flaggedAt: new Date().toISOString(),
        activationIndex,
      });
    } else if (!nextActive) {
      candidate.delete(entryId);
    }

    if (nextActive) {
      const assessment = assessFocusAdmission({
        focus: serializeFocus(candidate, state.sessionId ?? ctx.sessionManager.getSessionId()),
        model: ctx.model,
      });
      if (assessment.status === "blocked") throw new Error(assessment.reason);
    }

    const record: PiFlagRecordV1 = {
      version: 1,
      sessionId: state.sessionId ?? ctx.sessionManager.getSessionId(),
      targetEntryId: entryId,
      active: nextActive,
    };
    pi.appendEntry(FLAG_RECORD_TYPE, record);
    refreshState(ctx);
    return buildSnapshot(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    state.manualCompactionActive = false;
    refreshState(ctx);
  });

  pi.on("session_shutdown", () => {
    delete state.sessionId;
    state.replay = emptyReplay();
    state.serialized = { block: "", sentinel: "", estimatedTokens: 0 };
    state.manualCompactionActive = false;
    state.hasCurrentSessionRecords = false;
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "manual" && ctx.isIdle()) state.manualCompactionActive = true;
  });

  pi.on("session_compact", (_event, ctx) => {
    state.manualCompactionActive = false;
    refreshState(ctx);
  });

  pi.on("session_compact_failed", () => {
    state.manualCompactionActive = false;
  });

  pi.registerCommand("flag", {
    description: "Flag session messages as persistent model focus",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/flag is available only in interactive TUI mode", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Cannot open /flag while the agent is running", "warning");
        return;
      }
      if (state.manualCompactionActive) {
        ctx.ui.notify("Cannot open /flag during manual compaction", "warning");
        return;
      }

      refreshState(ctx);
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new FlagSelector({
            tui,
            theme,
            keybindings,
            snapshot: buildSnapshot(ctx),
            needsPrivacyConsent: !state.hasCurrentSessionRecords,
            onToggle: (entryId, nextActive) => toggle(entryId, nextActive, ctx),
            onClose: () => done(undefined),
          }),
        { overlay: false },
      );
    },
  });
}
