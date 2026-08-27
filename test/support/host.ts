import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type InlineExtension,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type TestHost = {
  root: string;
  faux: FauxProviderHandle;
  session: AgentSession;
  sessionManager: SessionManager;
  extensionsResult: LoadExtensionsResult;
  cleanup(): void;
};

export async function createTestHost(extensionFactories: InlineExtension[] = []): Promise<TestHost> {
  const root = mkdtempSync(join(tmpdir(), "pi-flag-test-"));
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))],
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const sessionManager = SessionManager.inMemory(root);
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: [],
  });

  return {
    root,
    faux,
    session,
    sessionManager,
    extensionsResult,
    cleanup() {
      session.dispose();
      modelRuntime.unregisterProvider(faux.provider.id);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
