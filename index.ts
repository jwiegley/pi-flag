import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendFocus,
  assessFinalRequest,
  assessFocusAdmission,
  estimateInputTokens,
  serializeFocus,
  verifyFocusProjection,
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
        `pi-flag will resend ${state.replay.active.size} active flag(s) (~${state.serialized.estimatedTokens} tokens) in full to provider ${event.model.provider} on the next user-input run.`,
        "warning",
      );
    }
  });

  pi.on("input", (_event, ctx) => {
    delete state.run;
    refreshState(ctx);
    const blocker = state.replay.blockers[0];
    if (blocker) {
      ctx.ui.notify(`${blocker.message}. Nothing was omitted. Open /flag to unflag it.`, "error");
      return { action: "handled" };
    }
    const admission = assessFocusAdmission({ focus: state.serialized, model: ctx.model });
    if (admission.status === "blocked") {
      ctx.ui.notify(admission.reason, "error");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    if (state.serialized.block.length === 0) {
      delete state.run;
      return;
    }
    const focus = state.serialized;
    state.run = {
      focus,
      expandedInputTokens: estimateInputTokens(event.prompt, event.images),
      blocked: false,
    };
    return { systemPrompt: appendFocus(event.systemPrompt, focus) };
  });

  pi.on("context", (_event, ctx) => {
    if (state.replay.active.size === 0 && state.replay.blockers.length === 0) return;
    const run = state.run;
    if (!run) {
      ctx.ui.notify(
        "pi-flag blocked an unsupported direct-trigger turn because its user-input projection hook did not run. Use sendUserMessage for extension-triggered turns.",
        "error",
      );
      ctx.abort();
      return;
    }
    if (run.blocked) return;
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
