import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestHost } from "./support/host.ts";

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
    const packagePath = fileURLToPath(new URL("../index.ts", import.meta.url));
    assert.ok(host.extensionsResult.extensions.some((extension) => extension.resolvedPath === packagePath));

    await host.session.bindExtensions({});
    assert.equal(sessionStarts, 1);
    assert.equal(host.faux.state.callCount, 0);
  } finally {
    host.cleanup();
  }
});
