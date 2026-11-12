// The identity a replacement server must answer before the add executor accepts it
// (workspace-registry.mjs createAddExecutor): GET /api/version answers { capability, version }
// matching packages/desktop/package.json. Main only ever talks to a server it started itself
// (server-host.mjs, backend-client.mjs); it never selects or reuses another one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverCompatible } from "../packages/desktop/server-compat.mjs";
import { startBackend } from "../packages/desktop/test/helpers/backend-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = (() => {
  const m = JSON.parse(readFileSync(join(ROOT, "packages", "desktop", "package.json"), "utf8"));
  return { capability: m.name, version: m.version };
})();

test("matching capability+version is compatible", () => {
  const r = serverCompatible({ ok: true, status: 200, body: { ...LOCAL } }, LOCAL);
  assert.equal(r.compatible, true);
});

test("404 on /api/version is incompatible", () => {
  const r = serverCompatible({ ok: false, status: 404, body: { error: "not found" } }, LOCAL);
  assert.equal(r.compatible, false);
  assert.match(r.reason, /no \/api\/version answer/);
});

test("transport failure, wrong capability, and version mismatch are incompatible", () => {
  assert.equal(serverCompatible(null, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: "other.thing", version: LOCAL.version } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: LOCAL.capability, version: "0.0.0-other" } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: null }, LOCAL).compatible, false);
});

test("REAL bundled server serves /api/version matching its package identity, which serverCompatible accepts", async () => {
  // Boots the actual packages/desktop/server/oats-web.mjs — removing the
  // /api/version route (or breaking its identity payload) fails THIS test.
  // Hermetic: no CLI candidate is discoverable, so no installed kernel or
  // login shell runs; identity needs neither.
  const s = await startBackend({ dirs: [ROOT], env: { ...process.env, OATS_DESKTOP_OATS_BIN: "", PATH: "/nonexistent", SHELL: "/bin/false" } });
  try {
    const v = await s.request("/api/version");
    assert.equal(v.ok, true, "real /api/version answers");
    const body = await v.json();
    assert.deepEqual(body, LOCAL, "identity matches the desktop package");
    assert.equal(serverCompatible({ ok: v.ok, status: v.status, body }, LOCAL).compatible, true);
  } finally {
    await s.stop();
  }
});
