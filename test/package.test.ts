import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PRIVACY_NOTICE } from "../src/selector.ts";

const packageJsonPath = new URL("../package.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const lockfilePath = new URL("../package-lock.json", import.meta.url);
const packageRoot = new URL("..", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: URL): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(value));
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

const expectedPeers = {
  "@earendil-works/pi-coding-agent": ">=0.84.4 <0.85.0",
  "@earendil-works/pi-tui": ">=0.84.4 <0.85.0",
};

const expectedDevDependencies = {
  "@earendil-works/pi-ai": "0.84.4",
  "@earendil-works/pi-coding-agent": "0.84.4",
  "@earendil-works/pi-tui": "0.84.4",
  "@types/node": "22.19.19",
  "pi-coding-agent-1x": "npm:@earendil-works/pi-coding-agent@1.4.0",
  typescript: "5.9.3",
};

const lifecycleScripts = ["build", "prepare", "prepack", "preinstall", "install", "postinstall"];

// The signed coding-agent tarball includes a shrinkwrap whose nested Pi entries omit integrity.
// Task 0.1 separately verifies these exact 0.84.4 registry artifacts and their SLSA provenance.
const reviewedShrinkwrapUrls = new Set([
  "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.4.tgz",
  "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.4.tgz",
  "https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-0.84.4.tgz",
  "https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-0.84.4.tgz",
  "https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-0.84.4.tgz",
  "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.4.tgz",
]);

test("package metadata matches the approved contract", () => {
  const manifest = readJson(packageJsonPath);
  assert.equal(manifest.name, "pi-flag");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "UNLICENSED");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.engines, { node: ">=22.19.0" });
  assert.deepEqual(manifest.files, ["index.ts", "src/**/*.ts", "README.md"]);
  assert.deepEqual(manifest.peerDependencies, expectedPeers);
  assert.deepEqual(manifest.peerDependenciesMeta, {
    "@earendil-works/pi-coding-agent": { optional: true },
    "@earendil-works/pi-tui": { optional: true },
  });
  assert.deepEqual(manifest.devDependencies, expectedDevDependencies);
  assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });

  for (const forbidden of ["main", "exports", "bin", "dependencies", "bundledDependencies", "bundleDependencies"]) {
    assert.equal(manifest[forbidden], undefined, `${forbidden} must be absent`);
  }

  const scripts = requireRecord(manifest.scripts);
  for (const script of lifecycleScripts) {
    assert.equal(scripts[script], undefined, `${script} must be absent`);
  }
  assert.equal(existsSync(new URL("../index.ts", import.meta.url)), true);
});

test("README states the complete compatibility and behavior contract", () => {
  const readme = readFileSync(readmePath, "utf8");
  assert.match(
    readme,
    /pi-flag 0\.1\.x supports Pi `@earendil-works\/pi-coding-agent` and `@earendil-works\/pi-tui` versions `>=0\.84\.4 <0\.85\.0`; tested against 0\.84\.4\./,
  );
  for (const heading of [
    "## Installation",
    "## Using `/flag`",
    "## Eligible content",
    "## Session, branch, and persistence semantics",
    "## Model projection and compaction",
    "## Finite context and refusal",
    "## Accessibility and terminal behavior",
    "## Unsupported behavior",
    "## Removal",
    "## Development",
  ]) {
    assert.ok(readme.includes(heading), `missing README section ${heading}`);
  }
  assert.match(readme, /resends flagged text in full/);
  assert.match(readme, /does not erase session history or prior provider requests/);
  assert.match(readme, /\[resize required\].*ignores confirmation/);
  assert.match(readme, /branch summarization is pending/);
  assert.match(readme, /Nothing was truncated|nothing was truncated/);
  assert.match(readme, /zero build step|no build step/);
  assert.match(readme, /zero runtime dependencies|no runtime dependencies/);
  assert.match(readme, /npm install --ignore-scripts/);
  assert.doesNotMatch(readme, /implementation is in progress/i);
  assert.ok(readme.includes(`> ${PRIVACY_NOTICE}`), "README must quote the selector's consent notice exactly");
  assert.doesNotMatch(readme, /user-input/);
});

test("lockfile records exact direct metadata and registry integrity", () => {
  assert.equal(existsSync(lockfilePath), true, "run npm install --ignore-scripts first");
  const lockfile = readJson(lockfilePath);
  assert.equal(lockfile.lockfileVersion, 3);
  const packages = requireRecord(lockfile.packages);
  const root = requireRecord(packages[""]);
  assert.deepEqual(root.devDependencies, expectedDevDependencies);
  assert.deepEqual(root.peerDependencies, expectedPeers);

  const integrityByResolved = new Map<string, string>();
  for (const entryValue of Object.values(packages)) {
    const entry = requireRecord(entryValue);
    if (typeof entry.resolved === "string" && typeof entry.integrity === "string") {
      integrityByResolved.set(entry.resolved, entry.integrity);
    }
  }

  for (const [path, entryValue] of Object.entries(packages)) {
    if (path === "") continue;
    const entry = requireRecord(entryValue);
    if (entry.link === true) continue;
    assert.equal(typeof entry.version, "string", `${path} has no version`);
    assert.equal(typeof entry.resolved, "string", `${path} has no resolved URL`);
    const resolved = String(entry.resolved);
    assert.match(resolved, /^https:\/\//, `${path} is not registry-resolved`);
    const integrity = typeof entry.integrity === "string" ? entry.integrity : integrityByResolved.get(resolved);
    if (integrity === undefined) {
      assert.ok(reviewedShrinkwrapUrls.has(resolved), `${path} has no reviewed sha512 integrity`);
    } else {
      assert.match(integrity, /^sha512-/, `${path} has invalid sha512 integrity`);
    }
  }
});

test("dry-run tarball contains only the approved package surface", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  const pack = parsed[0];
  assert.ok(isRecord(pack));
  const files = pack.files;
  assert.ok(Array.isArray(files));
  const paths = files.map((file) => {
    assert.ok(isRecord(file));
    const path = file.path;
    assert.equal(typeof path, "string");
    return String(path);
  });
  assert.deepEqual(paths.sort(), [
    "README.md",
    "index.ts",
    "package.json",
    "src/focus.ts",
    "src/selector.ts",
    "src/state.ts",
  ]);
  for (const forbidden of ["PLAN.org", "AGENTS.md", "package-lock.json", "test/package.test.ts"] as const) {
    assert.equal(paths.includes(forbidden), false);
  }
});
