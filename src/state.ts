import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const FLAG_RECORD_TYPE = "pi-flag/marker";

export type PiFlagRecordV1 = {
  version: 1;
  sessionId: string;
  targetEntryId: string;
  active: boolean;
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
    if (entry.type !== "custom" || entry.customType !== FLAG_RECORD_TYPE) continue;
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

  return { active, warnings, blockers };
}
