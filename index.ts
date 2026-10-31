import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  appendFocus,
  assessFinalRequest,
  assessFocusAdmission,
  estimateInputTokens,
  serializeFocus,
  verifyFocusProjection,
  type InputImage,
  type SerializedFocus,
} from "./src/focus.ts";
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
  run?: {
    focus: SerializedFocus;
    expandedInputTokens: number;
    blocked: boolean;
  };
};

const MAX_RESTORED_FLAG_RECORDS = 256;
const MAX_SELECTOR_ENTRIES = 256;

type BoundedSessionManager = Pick<ExtensionContext["sessionManager"], "getEntry"> & {
  getEntriesPage(options: { afterOrdinal?: number; customType?: string; limit?: number }): { entries: SessionEntry[] };
  getHistorySummary(): { entryCount: number };
  getRecentActiveEntries(options: { limit?: number }): SessionEntry[];
};

function boundedSessionManager(ctx: ExtensionContext): BoundedSessionManager {
  return ctx.sessionManager as unknown as BoundedSessionManager;
}

function emptyReplay(): FlagReplay {
  return { active: new Map(), warnings: [], blockers: [] };
}

// Since Pi 1.2.0, a run that sendCustomMessage({ triggerTurn: true }) starts also emits
// before_agent_start, with messageType "custom" and no prompt (some builds send ""). The
// Pi 0.84 types predate both. No input event precedes such a run.
type AgentStartInput = { messageType?: string; prompt?: string; images?: readonly InputImage[] };

// The prompt of a run that user input started; undefined for a custom-message run.
function userPrompt(start: AgentStartInput): string | undefined {
  return start.messageType === "custom" ? undefined : start.prompt;
}

export default function piFlag(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    replay: emptyReplay(),
    serialized: { block: "", sentinel: "", estimatedTokens: 0 },
    manualCompactionActive: false,
    hasCurrentSessionRecords: false,
  };

  const restoreEntries = (ctx: ExtensionContext): SessionEntry[] => {
    const sessionManager = boundedSessionManager(ctx);
    const { entryCount } = sessionManager.getHistorySummary();
    const afterOrdinal = entryCount > MAX_RESTORED_FLAG_RECORDS
      ? entryCount - MAX_RESTORED_FLAG_RECORDS - 1
      : undefined;
    const records = sessionManager.getEntriesPage({
      ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
      customType: FLAG_RECORD_TYPE,
      limit: MAX_RESTORED_FLAG_RECORDS,
    }).entries;
    const sources = new Map<string, SessionEntry>();
    for (const recordEntry of records) {
      if (recordEntry.type !== "custom") continue;
      const record = parseFlagRecord(recordEntry.data);
      if (!record) continue;
      const source = sessionManager.getEntry(record.targetEntryId);
      if (source) sources.set(source.id, source);
    }
    return [...sources.values(), ...records];
  };

  const refreshState = (ctx: ExtensionContext): void => {
    const entries = restoreEntries(ctx);
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

  // Refresh the flags and say why a new run must not be sent, if it must not. Runs that user
  // input starts and runs that custom messages start pass the same checks.
  const admissionRefusal = (ctx: ExtensionContext): string | undefined => {
    refreshState(ctx);
    const blocker = state.replay.blockers[0];
    if (blocker) return `${blocker.message}. Nothing was omitted. Open /flag to unflag it.`;
    const admission = assessFocusAdmission({ focus: state.serialized, model: ctx.model });
    return admission.status === "blocked" ? admission.reason : undefined;
  };

  const buildSnapshot = (ctx: ExtensionContext): FlagSelectorSnapshot => {
    const recentEntries = boundedSessionManager(ctx).getRecentActiveEntries({ limit: MAX_SELECTOR_ENTRIES });
    const restoredEntries = restoreEntries(ctx);
    const entries = [...recentEntries, ...restoredEntries];
    const branchIds = new Set(recentEntries.map(({ id }) => id));
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
    delete state.run;
    refreshState(ctx);
  });

  pi.on("session_shutdown", () => {
    delete state.sessionId;
    state.replay = emptyReplay();
    state.serialized = { block: "", sentinel: "", estimatedTokens: 0 };
    state.manualCompactionActive = false;
    state.hasCurrentSessionRecords = false;
    delete state.run;
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "manual" && ctx.isIdle()) state.manualCompactionActive = true;
  });

  pi.on("session_compact", (_event, ctx) => {
    state.manualCompactionActive = false;
    refreshState(ctx);
  });

  pi.on("session_compact_failed", (event, ctx) => {
    state.manualCompactionActive = false;
    if (event.reason === "overflow" && state.replay.active.size > 0) {
      ctx.ui.notify(
        `Context overflow recovery failed with ${state.replay.active.size} active pi-flag entr${state.replay.active.size === 1 ? "y" : "ies"}. Nothing was truncated. Open /flag to unflag an entry or select a larger model.`,
        "error",
      );
    }
  });

  pi.on("model_select", (event, ctx) => {
    refreshState(ctx);
    if (
      state.replay.active.size > 0 &&
      event.previousModel !== undefined &&
      event.previousModel.provider !== event.model.provider
    ) {
      ctx.ui.notify(
        `pi-flag will resend ${state.replay.active.size} active flag(s) (~${state.serialized.estimatedTokens} tokens) in full to provider ${event.model.provider} on the next run.`,
        "warning",
      );
    }
  });

  pi.on("input", (event, ctx) => {
    // Steering and follow-up input typed while a run streams joins that run and keeps its focus.
    // Idle input drops any stale cache; agent_settled and before_agent_start reset it as well.
    if (ctx.isIdle()) delete state.run;
    const refusal = admissionRefusal(ctx);
    if (refusal !== undefined) {
      ctx.ui.notify(refusal, "error");
      return { action: "handled" };
    }
    // Queued input enters the run's next request, so the final guard counts it too. It is not
    // expanded yet, so this is a lower bound.
    if (state.run) {
      state.run.expandedInputTokens = Math.max(
        state.run.expandedInputTokens,
        estimateInputTokens(event.text, event.images),
      );
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const prompt = userPrompt(event);
    if (prompt === undefined) {
      // No input event admitted this custom-message run, and this hook cannot refuse it. Abort
      // it before its first request; the context guard aborts it again if it gets that far.
      const refusal = admissionRefusal(ctx);
      if (refusal !== undefined) {
        state.run = { focus: state.serialized, expandedInputTokens: 0, blocked: true };
        ctx.ui.notify(`pi-flag refused an extension-started run. ${refusal}`, "error");
        ctx.abort();
        return;
      }
    }
    if (state.serialized.block.length === 0) {
      delete state.run;
      return;
    }
    const focus = state.serialized;
    state.run = {
      focus,
      expandedInputTokens: prompt === undefined ? 0 : estimateInputTokens(prompt, event.images),
      blocked: false,
    };
    return { systemPrompt: appendFocus(event.systemPrompt, focus) };
  });

  pi.on("context", (_event, ctx) => {
    if (state.replay.active.size === 0 && state.replay.blockers.length === 0) return;
    const run = state.run;
    if (!run) {
      ctx.ui.notify(
        "pi-flag blocked an unsupported direct-trigger turn because Pi started it without before_agent_start, so the focus could not be projected. Nothing was omitted. On Pi 0.84, extensions must start turns with sendUserMessage.",
        "error",
      );
      ctx.abort();
      return;
    }
    if (run.blocked) {
      // Requests Pi makes after the abort, such as queued follow-ups, stay blocked.
      ctx.abort();
      return;
    }
    const finalSystemPrompt = ctx.getSystemPrompt();
    const integrity = verifyFocusProjection(finalSystemPrompt, run.focus);
    if (integrity.status === "blocked") {
      run.blocked = true;
      ctx.ui.notify(integrity.reason, "error");
      ctx.abort();
      return;
    }
    const assessment = assessFinalRequest({
      finalSystemPrompt,
      focus: run.focus,
      expandedInputTokens: run.expandedInputTokens,
      model: ctx.model,
    });
    if (assessment.status === "blocked") {
      run.blocked = true;
      ctx.ui.notify(assessment.reason, "error");
      ctx.abort();
    }
  });

  pi.on("agent_settled", () => {
    delete state.run;
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
