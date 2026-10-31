import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "pi-coding-agent-1x";
// The aliased runtime nests its own pi-ai, and the faux provider must register with that copy. The
// top-level @earendil-works/pi-ai is the 0.84.4 one.
import {
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from "../../node_modules/pi-coding-agent-1x/node_modules/@earendil-works/pi-ai/dist/index.js";

export {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "../../node_modules/pi-coding-agent-1x/node_modules/@earendil-works/pi-ai/dist/index.js";

export const PI_1X_VERSION = (
  JSON.parse(readFileSync(new URL("../../node_modules/pi-coding-agent-1x/package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

// Upstream Pi lacks the bounded history reads pi-flag uses; supply them as test/extension.test.ts does.
type EntryPageOptions = { afterOrdinal?: number; customType?: string; limit?: number };
const boundedSessionManager = SessionManager.prototype as unknown as Record<string, unknown>;
boundedSessionManager.getRecentActiveEntries = function (
  this: SessionManager,
  { customType, limit = 256 }: EntryPageOptions,
): SessionEntry[] {
  return this.getBranch()
    .filter((entry) => customType === undefined || (entry.type === "custom" && entry.customType === customType))
    .slice(-limit);
};
boundedSessionManager.getHistorySummary = function (this: SessionManager): { entryCount: number } {
  return { entryCount: this.getEntries().length };
};
boundedSessionManager.getEntriesPage = function (
  this: SessionManager,
  { afterOrdinal = -1, customType, limit = 256 }: EntryPageOptions,
): { entries: SessionEntry[] } {
  return {
    entries: this.getEntries()
      .slice(afterOrdinal + 1)
      .filter((entry) => customType === undefined || (entry.type === "custom" && entry.customType === customType))
      .slice(0, limit),
  };
};

export type TestHost1x = {
  root: string;
  faux: FauxProviderHandle;
  session: AgentSession;
  sessionManager: SessionManager;
  cleanup(): void;
};

export async function createTestHost1x(
  options: { faux?: RegisterFauxProviderOptions; tools?: string[] } = {},
): Promise<TestHost1x> {
  const root = mkdtempSync(join(tmpdir(), "pi-flag-1x-test-"));
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const faux = fauxProvider(options.faux);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const sessionManager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: options.tools ?? [],
  });

  return {
    root,
    faux,
    session,
    sessionManager,
    cleanup() {
      session.dispose();
      modelRuntime.unregisterProvider(faux.provider.id);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
