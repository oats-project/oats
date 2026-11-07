// Regression for the phase-2 hook: the desktop must not reuse an OLDER
// installed server that answers /api/panel (workspace covered) but lacks
// the desktop endpoints — /api/brain 404s and Brain looks broken. Reuse
// requires GET /api/version to identify THIS checkout (capability+version
// match against packages/desktop/package.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverCompatible, selectServer, ensureServerOnPort } from "../packages/desktop/server-compat.mjs";
import { matchWorkspaceDirs } from "../packages/desktop/workspace-registry.mjs";
import { buildViews } from "../packages/client/workspace-views.mjs";
import { spawn } from "node:child_process";

const CONTROL_TOKEN = "desktop-compat-test-token-1234567890123456";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = (() => {
  const m = JSON.parse(readFileSync(join(ROOT, "packages", "desktop", "package.json"), "utf8"));
  return { capability: m.name, version: m.version };
})();

test("matching capability+version is compatible (reuse)", () => {
  const r = serverCompatible({ ok: true, status: 200, body: { ...LOCAL } }, LOCAL);
  assert.equal(r.compatible, true);
});

test("404 on /api/version (older server) is incompatible — spawn own server", () => {
  const r = serverCompatible({ ok: false, status: 404, body: { error: "not found" } }, LOCAL);
  assert.equal(r.compatible, false);
  assert.match(r.reason, /older server/);
});

test("network failure, wrong capability, and version mismatch are incompatible", () => {
  assert.equal(serverCompatible(null, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: "other.thing", version: LOCAL.version } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: LOCAL.capability, version: "0.0.0-other" } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: null }, LOCAL).compatible, false);
});

// End-to-end through the PRODUCTION seam (selectServer, exactly what
// ensureServer runs) against fake servers — re-implementing the decision in
// the test would leave the real gate unprotected (review srvcompat).
async function selectAgainst(url, matchWorkspace = (ws) => ws[0]?.id || null) {
  const panelWorkspaces = async () => {
    try {
      const r = await fetch(`${url}/api/panel`, { headers: { "x-oats-desktop-token": CONTROL_TOKEN } });
      if (r.status === 403) return { forbidden: true };
      return r.ok ? (await r.json()).workspaces || [] : null;
    } catch { return null; }
  };
  const probeVersion = async () => {
    try {
      const r = await fetch(`${url}/api/version`);
      let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
      return { ok: r.ok, status: r.status, body };
    } catch { return null; }
  };
  return selectServer({ panelWorkspaces, probeVersion, matchWorkspace, local: LOCAL });
}

test("fake older server: /api/panel answers, /api/version 404s → selectServer says spawn", async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/panel")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workspaces: [{ id: "/tmp/ws", name: "ws" }], instances: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`);
    assert.equal(choice.action, "spawn", "older server must not be reused");
    assert.match(choice.reason, /older server/);
  } finally { server.close(); }
});

test("fake matching server → selectServer says reuse with the matched workspace", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/api/panel")) {
      res.end(JSON.stringify({ workspaces: [{ id: "/tmp/ws", name: "ws" }], instances: [] }));
    } else if (req.url.startsWith("/api/version")) {
      res.end(JSON.stringify({ capability: LOCAL.capability, version: LOCAL.version }));
    } else { res.end("{}"); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(choice, { action: "reuse", wsId: "/tmp/ws" });
  } finally { server.close(); }
});

test("no server on the port → spawn", async () => {
  const choice = await selectAgainst("http://127.0.0.1:1"); // nothing listens
  assert.equal(choice.action, "spawn");
  assert.equal(choice.portOccupied, false, "no listener — caller keeps the port");
});

test("spawn decisions carry the portOccupied discriminator (not reason strings)", async () => {
  // review srvcompat2 nit: port selection must key on an explicit flag, so a
  // wording change in reason can never alter behavior.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces: [{ id: "/other", name: "other" }], instances: [] }))
      : res.end("{}");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`, () => null); // no workspace match
    assert.equal(choice.action, "spawn");
    assert.equal(choice.portOccupied, true, "occupied port — caller must move");
  } finally { server.close(); }
});

// #698: this app's own server at another version (another installed Desktop, a dev checkout, or one
// an earlier Desktop left running) is reported as exactly that, whatever it serves — never as "not
// the requested workspace" — and left running: the reuse rule is unchanged and nothing is stopped.
const OTHER_VERSION = "0.0.1-older";
async function otherVersionServer(workspaces) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces, instances: [] }))
      : req.url.startsWith("/api/version")
        ? res.end(JSON.stringify({ capability: LOCAL.capability, version: OTHER_VERSION }))
        : res.end("{}");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

for (const [label, matchWorkspace] of [["not covering our workspace", () => null], ["covering our workspace", (ws) => ws[0]?.id || null]]) {
  test(`same-capability server at another version, ${label} → a version reason, port occupied, left running`, async () => {
    const { server, seen, url } = await otherVersionServer([{ id: "/w", name: "w" }]);
    try {
      const choice = await selectAgainst(url, matchWorkspace);
      assert.equal(choice.action, "spawn", "another version is never reused");
      assert.equal(choice.portOccupied, true, "the port stays taken: the caller moves");
      assert.ok(choice.reason.includes(OTHER_VERSION) && choice.reason.includes(LOCAL.version), choice.reason);
      assert.match(choice.reason, /not started by this app/);
      assert.match(choice.reason, /left running/);
      assert.doesNotMatch(choice.reason, /not the requested workspace/);
      assert.ok(seen.every((r) => r.startsWith("GET ")), "only read: nothing is posted to it");
      assert.equal((await fetch(`${url}/api/panel`)).ok, true, "still answering");
    } finally { server.close(); }
  });
}

test("ensureServerOnPort: the startup log names both versions, that the server is left running, and the port used instead", async () => {
  const { server, url } = await otherVersionServer([{ id: "/other", name: "other" }]);
  const logs = [], calls = [];
  try {
    const r = await ensureServerOnPort({
      panelWorkspaces: async () => (await (await fetch(`${url}/api/panel`)).json()).workspaces,
      probeVersion: async () => { const v = await fetch(`${url}/api/version`); return { ok: v.ok, status: v.status, body: await v.json() }; },
      matchWorkspace: () => null,
      local: LOCAL,
      port: 4820,
      freePort: async (from) => { calls.push(["freePort", from]); return 4823; },
      spawnServer: (p) => calls.push(["spawn", p]),
      log: (m) => logs.push(m),
    });
    assert.deepEqual(r, { spawned: true, port: 4823, wsId: null });
    assert.deepEqual(calls, [["freePort", 4821], ["spawn", 4823]]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], `server on 4820 — this app's server at version ${OTHER_VERSION} (this app is ${LOCAL.version}), `
      + "not started by this app — left running — starting a dedicated one on 4823");
    assert.equal((await fetch(`${url}/api/version`)).ok, true, "the other version still answers");
  } finally { server.close(); }
});

test("same capability and version, other workspace → still 'not the requested workspace'", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces: [{ id: "/other", name: "other" }], instances: [] }))
      : res.end(JSON.stringify(LOCAL));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`, () => null);
    assert.deepEqual(choice, { action: "spawn", portOccupied: true, reason: "serves other — not the requested workspace" });
  } finally { server.close(); }
});

test("same capability and version serving the requested deployment attached to a workspace identity → reuse (#807)", async () => {
  // The panel lists the attached view by ws:<hash>, with the deployment's path in `deployments`.
  const workspaces = buildViews([{ id: "/srv/acme", name: "acme", local: true, attach: { key: "acme.example/agents", team: "default:acme" } }]);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces, instances: [] }))
      : res.end(JSON.stringify(LOCAL));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`,
      (ws) => matchWorkspaceDirs(["/srv/acme"], ws));
    assert.match(workspaces[0].id, /^ws:/);
    assert.deepEqual(choice, { action: "reuse", wsId: workspaces[0].id });
  } finally { server.close(); }
});

// ensureServerOnPort: the CONSUMER of the discriminator (review srvcompat3 —
// proving the emitter is not enough; review srvcompat4 — the decision is
// INJECTED with arbitrary reason text so a consumer keying on any reason
// wording, e.g. the old `reason !== "no server on the port"`, fails these).
function ensureIo(choice, port, calls) {
  return {
    select: async () => choice,   // arbitrary decision, arbitrary wording
    port,
    freePort: async (from) => { calls.push(["freePort", from]); return from + 7; },
    spawnServer: (p) => calls.push(["spawn", p]),
    log: () => {},
  };
}

test("ensureServerOnPort: occupied decision moves ports and spawns there — regardless of reason text", async () => {
  // Reason text deliberately says the magic free-port phrase: a consumer
  // comparing reason strings would keep the port; the discriminator moves it.
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "spawn", portOccupied: true, reason: "no server on the port" }, 4820, calls));
  assert.deepEqual(calls, [["freePort", 4821], ["spawn", 4828]], "moved off the occupied port before spawning");
  assert.deepEqual(r, { spawned: true, port: 4828, wsId: null });
});

test("ensureServerOnPort: free port spawns in place (no freePort call) — regardless of reason text", async () => {
  // Inverse trap: an occupied-sounding reason on a free-port decision.
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "spawn", portOccupied: false, reason: "incompatible (wording trap)" }, 4820, calls));
  assert.deepEqual(calls, [["spawn", 4820]], "kept the free port");
  assert.equal(r.port, 4820);
});

test("ensureServerOnPort: reuse neither spawns nor moves", async () => {
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "reuse", wsId: "/w" }, 4820, calls));
  assert.deepEqual(calls, [], "no effects on reuse");
  assert.deepEqual(r, { spawned: false, port: 4820, wsId: "/w" });
});

test("ensureServerOnPort defaults to the real selectServer when no select is injected", async () => {
  // Keeps the production wiring covered: end-to-end against a fake matching
  // server through the DEFAULT selection path.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces: [{ id: "/w", name: "w" }], instances: [] }))
      : res.end(JSON.stringify({ capability: LOCAL.capability, version: LOCAL.version }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  try {
    const r = await ensureServerOnPort({
      panelWorkspaces: async () => (await (await fetch(`${url}/api/panel`)).json()).workspaces,
      probeVersion: async () => { const v = await fetch(`${url}/api/version`); return { ok: v.ok, status: v.status, body: await v.json() }; },
      matchWorkspace: (ws) => ws[0]?.id || null,
      local: LOCAL,
      port: 4820,
      freePort: async (from) => { calls.push(["freePort", from]); return from; },
      spawnServer: (p) => calls.push(["spawn", p]),
    });
    assert.deepEqual(r, { spawned: false, port: 4820, wsId: "/w" }, "real selection path reuses the matching server");
    assert.deepEqual(calls, []);
  } finally { server.close(); }
});

test("REAL bundled server serves /api/version matching its package identity → reuse through the seam", async (t) => {
  // Boots the actual packages/desktop/server/oats-web.mjs — removing the
  // /api/version route (or breaking its identity payload) fails THIS test.
  const free = await new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); });
  });
  const bin = join(ROOT, "packages", "desktop", "server", "oats-web.mjs");
  // Hermetic: no CLI candidate is discoverable, so no installed kernel or
  // login shell runs; identity and workspace advertisement need neither.
  const child = spawn(process.execPath, [bin, "start", "--port", String(free), "--dir", ROOT], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OATS_DESKTOP_TOKEN: CONTROL_TOKEN, OATS_DESKTOP_OATS_BIN: "", PATH: "/nonexistent", SHELL: "/bin/false" } });
  const url = `http://127.0.0.1:${free}`;
  try {
    // wait for the server to answer (max ~10s) — readiness via /api/panel,
    // NOT /api/version: the route under test must not gate the skip, or
    // removing it would skip this test instead of failing it.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(`${url}/api/panel`, { headers: { "x-oats-desktop-token": CONTROL_TOKEN }, signal: AbortSignal.timeout(500) })).ok; }
      catch { await new Promise((ok) => setTimeout(ok, 250)); }
    }
    if (!up) return t.skip("server did not come up (environment)");
    const v = await fetch(`${url}/api/version`);
    assert.equal(v.ok, true, "real /api/version answers");
    assert.deepEqual(await v.json(), LOCAL, "identity matches the desktop package");
    const choice = await selectAgainst(url);
    assert.equal(choice.action, "reuse", "the real current server is reused");
  } finally {
    child.kill();
  }
});


test("another launch's token leaves its server running and selects the next port", async () => {
  const { createControlFetch } = await import('../packages/desktop/control-fetch.mjs');
  const { checkControlRequest, controlRequestHeaders } = await import('../packages/desktop/control-request.mjs');
  const token = 'another-launch-token-12345678901234567890';
  let refused = 0;
  const server = createServer((req, res) => {
    const guard = checkControlRequest({ method: req.method, path: req.url, headers: controlRequestHeaders(req) }, token);
    res.writeHead(guard.ok ? 200 : 403, { 'content-type': 'application/json' });
    if (!guard.ok) { refused++; return res.end(JSON.stringify({ error: 'forbidden' })); }
    res.end(JSON.stringify(req.url === '/api/version' ? LOCAL : { workspaces: [] }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    const fetch = createControlFetch(CONTROL_TOKEN);
    const spawns = [], logs = [];
    const result = await ensureServerOnPort({
      port, local: LOCAL,
      probeVersion: async () => { const r = await fetch(`${base}/api/version`); return { ok: r.ok, body: await r.json() }; },
      panelWorkspaces: async () => { const r = await fetch(`${base}/api/panel`); return r.status === 403 ? { forbidden: true } : (await r.json()).workspaces; },
      matchWorkspace: () => assert.fail('a refused read has no workspace facts'),
      freePort: async from => { assert.equal(from, port + 1); return from; },
      spawnServer: selected => spawns.push(selected), log: line => logs.push(line),
    });
    assert.equal(result.port, port + 1);
    assert.deepEqual(spawns, [port + 1]);
    assert.match(logs[0], /another token/);
    assert.equal(refused, 1);
    assert.equal((await globalThis.fetch(`${base}/api/version`)).status, 200);
  } finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
});
