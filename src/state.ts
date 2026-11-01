import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const FLAG_RECORD_TYPE = "pi-flag/marker";
// A checkpoint holds every flag active at its position, so restore need not reach the marker
// records that activated them. Builds that predate it read only FLAG_RECORD_TYPE and skip it.
export const FLAG_CHECKPOINT_TYPE = "pi-flag/checkpoint";

export type PiFlagRecordV1 = {
  version: 1;
  sessionId: string;
  targetEntryId: string;
  active: boolean;
};

// flaggedAt is the timestamp of the marker record that activated the target.
export type FlagActivation = {
  targetEntryId: string;
  flaggedAt: string;
};

export type PiFlagCheckpointV1 = {
  version: 1;
  sessionId: string;
  // Oldest activation first.
  flags: FlagActivation[];
};

export type FlagSource = {
  entryId: string;
  role: "user" | "assistant";
  sourceTimestamp: string;
  textBlocks: string[];
  assistantStopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
};

export type ActiveFlag = FlagSource & {
  flaggedAt: string;
  activationIndex: number;
};

export type FlagDiagnostic = {
  code: "malformed-record" | "missing-source" | "ineligible-source";
  recordEntryId: string;
  message: string;
  targetEntryId?: string;
};

export type FlagReplay = {
  active: Map<string, ActiveFlag>;
  // Every active target in activation order, including those reported as blockers.
  activations: FlagActivation[];
  warnings: FlagDiagnostic[];
  blockers: FlagDiagnostic[];
};

export function parseFlagRecord(value: unknown): PiFlagRecordV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys.join(",") !== "active,sessionId,targetEntryId,version") return undefined;
  if (record.version !== 1) return undefined;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
  if (typeof record.targetEntryId !== "string" || record.targetEntryId.length === 0) return undefined;
  if (typeof record.active !== "boolean") return undefined;
  return {
    version: 1,
    sessionId: record.sessionId,
    targetEntryId: record.targetEntryId,
    active: record.active,
  };
}

export function parseFlagCheckpoint(value: unknown): PiFlagCheckpointV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const checkpoint = value as Record<string, unknown>;
  const keys = Object.keys(checkpoint).sort();
  if (keys.length !== 3 || keys.join(",") !== "flags,sessionId,version") return undefined;
  if (checkpoint.version !== 1) return undefined;
  if (typeof checkpoint.sessionId !== "string" || checkpoint.sessionId.length === 0) return undefined;
  if (!Array.isArray(checkpoint.flags)) return undefined;
  const flags: FlagActivation[] = [];
  const targets = new Set<string>();
  for (const item of checkpoint.flags as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const flag = item as Record<string, unknown>;
    const flagKeys = Object.keys(flag).sort();
    if (flagKeys.length !== 2 || flagKeys.join(",") !== "flaggedAt,targetEntryId") return undefined;
    if (typeof flag.targetEntryId !== "string" || flag.targetEntryId.length === 0) return undefined;
    if (targets.has(flag.targetEntryId)) return undefined;
    if (typeof flag.flaggedAt !== "string") return undefined;
    targets.add(flag.targetEntryId);
    flags.push({ targetEntryId: flag.targetEntryId, flaggedAt: flag.flaggedAt });
  }
  return { version: 1, sessionId: checkpoint.sessionId, flags };
}

// The owning session and the targets that a valid marker record or checkpoint names.
export function parseFlagEntry(entry: SessionEntry): { sessionId: string; targetEntryIds: string[] } | undefined {
  if (entry.type !== "custom") return undefined;
  if (entry.customType === FLAG_RECORD_TYPE) {
    const record = parseFlagRecord(entry.data);
    return record && { sessionId: record.sessionId, targetEntryIds: [record.targetEntryId] };
  }
  if (entry.customType !== FLAG_CHECKPOINT_TYPE) return undefined;
  const checkpoint = parseFlagCheckpoint(entry.data);
  return checkpoint && {
    sessionId: checkpoint.sessionId,
    targetEntryIds: checkpoint.flags.map(({ targetEntryId }) => targetEntryId),
  };
}

export function isFlagEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && (entry.customType === FLAG_RECORD_TYPE || entry.customType === FLAG_CHECKPOINT_TYPE);
}

export function extractFlagSource(entry: SessionEntry): FlagSource | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;

  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return {
        entryId: entry.id,
        role: "user",
        sourceTimestamp: entry.timestamp,
        textBlocks: [content],
      };
    }
    if (content.some((block) => block.type === "image")) return undefined;
    const textBlocks = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    if (textBlocks.length === 0) return undefined;
    return {
      entryId: entry.id,
      role: "user",
      sourceTimestamp: entry.timestamp,
      textBlocks,
    };
  }

  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "pending" || message.stopReason === "deferred") return undefined;
  const textBlocks = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  if (!textBlocks.some((block) => block.length > 0)) return undefined;
  return {
    entryId: entry.id,
    role: "assistant",
    sourceTimestamp: entry.timestamp,
    textBlocks,
    assistantStopReason: message.stopReason,
  };
}

export function replayFlags(entries: readonly SessionEntry[], sessionId: string): FlagReplay {
  const entryById = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (!entryById.has(entry.id)) entryById.set(entry.id, entry);
  }

  const activations = new Map<string, { recordEntryId: string; flaggedAt: string; activationIndex: number }>();
  const warnings: FlagDiagnostic[] = [];
  let nextActivationIndex = 0;

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === FLAG_CHECKPOINT_TYPE) {
      const checkpoint = parseFlagCheckpoint(entry.data);
      if (!checkpoint) {
        warnings.push({
          code: "malformed-record",
          recordEntryId: entry.id,
          message: `Ignored malformed ${FLAG_CHECKPOINT_TYPE} record ${entry.id}`,
        });
        continue;
      }
      if (checkpoint.sessionId !== sessionId) continue;
      // The checkpoint lists every flag active at its position, so it supersedes earlier records.
      activations.clear();
      for (const { targetEntryId, flaggedAt } of checkpoint.flags) {
        activations.set(targetEntryId, {
          recordEntryId: entry.id,
          flaggedAt,
          activationIndex: nextActivationIndex++,
        });
      }
      continue;
    }
    if (entry.customType !== FLAG_RECORD_TYPE) continue;
    const record = parseFlagRecord(entry.data);
    if (!record) {
      warnings.push({
        code: "malformed-record",
        recordEntryId: entry.id,
        message: `Ignored malformed ${FLAG_RECORD_TYPE} record ${entry.id}`,
      });
      continue;
    }
    if (record.sessionId !== sessionId) continue;

    if (record.active) {
      if (activations.has(record.targetEntryId)) continue;
      activations.set(record.targetEntryId, {
        recordEntryId: entry.id,
        flaggedAt: entry.timestamp,
        activationIndex: nextActivationIndex++,
      });
    } else {
      activations.delete(record.targetEntryId);
    }
  }

  const active = new Map<string, ActiveFlag>();
  const blockers: FlagDiagnostic[] = [];
  // Map order is activation order: a target enters at the end and leaves only when unflagged.
  const ordered = [...activations].map(([targetEntryId, { flaggedAt }]) => ({ targetEntryId, flaggedAt }));
  for (const [targetEntryId, activation] of activations) {
    const sourceEntry = entryById.get(targetEntryId);
    if (!sourceEntry) {
      blockers.push({
        code: "missing-source",
        recordEntryId: activation.recordEntryId,
        targetEntryId,
        message: `Active flag target ${targetEntryId} is missing`,
      });
      continue;
    }
    const source = extractFlagSource(sourceEntry);
    if (!source) {
      blockers.push({
        code: "ineligible-source",
        recordEntryId: activation.recordEntryId,
        targetEntryId,
        message: `Active flag target ${targetEntryId} is not eligible text`,
      });
      continue;
    }
    active.set(targetEntryId, {
      ...source,
      flaggedAt: activation.flaggedAt,
      activationIndex: activation.activationIndex,
    });
  }

  return { active, activations: ordered, warnings, blockers };
}

// The checkpoint that keeps the active flags restorable once every entry older than
// `recentEntries`, the newest entries of the session, leaves the restore window; undefined when
// those entries alone already restore the same flags in the same order.
export function dueCheckpoint(
  replay: FlagReplay,
  recentEntries: readonly SessionEntry[],
  sessionId: string,
): PiFlagCheckpointV1 | undefined {
  const { activations } = replay;
  if (activations.length === 0) return undefined;
  const recent = replayFlags(recentEntries, sessionId).activations;
  const restored =
    recent.length === activations.length &&
    recent.every(
      (flag, index) =>
        flag.targetEntryId === activations[index]?.targetEntryId && flag.flaggedAt === activations[index]?.flaggedAt,
    );
  if (restored) return undefined;
  return {
    version: 1,
    sessionId,
    flags: activations.map(({ targetEntryId, flaggedAt }) => ({ targetEntryId, flaggedAt })),
  };
}
