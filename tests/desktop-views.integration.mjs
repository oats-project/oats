// Desktop renderer views — integration-boundary regressions (no DOM needed).
// Guards the seams the harness masks: module naming the shell imports, the
// theme.css fallback URL, the ctx.api dual-shape seam, and the harness
// proxy's origin guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = join(ROOT, "packages", "desktop", "renderer");

// doSpawn requires a VERIFIED compatible CLI (frozen contract) — seed the
// shared cli-status state as available; the CLI dimension has its own suite.
{
  const cs = await import(new URL("../packages/desktop/renderer/views/cli-status.mjs", import.meta.url).href);
  await cs.refreshCli({
    api: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bin: "/seed/oats", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.21.0" }, probedAt: 1, tried: [] }) }),
  });
}

test("views ship as .mjs with mount/unmount (shell imports ./views/<name>.mjs)", () => {
  for (const name of ["hierarchy", "spawn"]) {
    const f = join(RENDERER, "views", `${name}.mjs`);
    assert.ok(existsSync(f), `${name}.mjs missing`);
    const src = readFileSync(f, "utf8");
    assert.match(src, /export function mount\(/, `${name}: no mount export`);
    assert.match(src, /export function unmount\(/, `${name}: no unmount export`);
    assert.match(src, /from "\.\/common\.mjs"/, `${name}: must import common.mjs`);
  }
});

test("theme fallback URL resolves from views/ to renderer/theme.css", () => {
  const src = readFileSync(join(RENDERER, "views", "common.mjs"), "utf8");
  const m = src.match(/new URL\("([^"]+)", import\.meta\.url\)/);
  assert.ok(m, "ensureTheme must resolve theme.css via import.meta.url");
  const resolved = join(RENDERER, "views", m[1]);
  assert.ok(existsSync(resolved), `theme URL "${m[1]}" resolves to a missing file: ${resolved}`);
});

test("apiJson accepts both a Fetch Response and shell-parsed JSON", async () => {
  const { apiJson } = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  // Response-shaped (harness): ok → parsed body; !ok → throws server error.
  const asResponse = (ok, status, body) => ({ ok, status, json: async () => body });
  assert.deepEqual(await apiJson({ api: async () => asResponse(true, 200, { a: 1 }) }, "/api/panel"), { a: 1 });
  await assert.rejects(apiJson({ api: async () => asResponse(false, 409, { error: "nope" }) }, "/api/spawn"), /nope/);
  // Shell-shaped: ctx.api resolves already-parsed data (and throws itself on non-2xx).
  assert.deepEqual(await apiJson({ api: async () => ({ agents: [] }) }, "/api/agents"), { agents: [] });
});

test("harness proxy: 403s hostile Host/Origin without reaching upstream; forwards the real Origin on loopback requests", async () => {
  const { createHarnessServer, HARNESS_TOKEN_HEADER } = await import(new URL("../packages/desktop/renderer/harness-server.mjs", import.meta.url).href);
  const { backendSecret, privateSocketDir } = await import(new URL("../packages/desktop/test/helpers/backend-server.mjs", import.meta.url).href);
  // fake upstream on the backend's private socket: records what actually reaches it
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, origin: req.headers.origin ?? null, host: req.headers.host });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const socket = privateSocketDir();
  await new Promise((ok) => upstream.listen(socket.socketPath, ok));
  const harnessToken = backendSecret();
  const harness = createHarnessServer({ apiSocket: socket.socketPath, secret: backendSecret(), harnessToken });
  const token = { [HARNESS_TOKEN_HEADER]: harnessToken };
  await new Promise((ok) => harness.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${harness.address().port}`;
  // fetch() strips forbidden headers like Host, so drive raw HTTP for forgeries
  const raw = (path, { method = "GET", headers = {} } = {}) => new Promise((ok, err) => {
    const q = httpRequest({ hostname: "127.0.0.1", port: harness.address().port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => b += c); res.on("end", () => ok({ status: res.statusCode, body: b }));
    });
    q.on("error", err); q.end();
  });
  try {
    // hostile Host: 403, upstream never sees it, the harness token notwithstanding
    let r = await raw("/api/panel", { headers: { ...token, host: "evil.example" } });
    assert.equal(r.status, 403);
    // hostile Origin on a mutating request: 403, upstream never sees it
    r = await raw("/api/spawn", { method: "POST", headers: { ...token, host: "127.0.0.1", origin: "http://evil.example" } });
    assert.equal(r.status, 403);
    // malformed Origin: 403
    r = await raw("/api/panel", { headers: { ...token, host: "127.0.0.1", origin: "null" } });
    assert.equal(r.status, 403);
    assert.equal(seen.length, 0, "hostile requests must never reach upstream");
    // loopback request: proxied, with the browser's ORIGINAL Origin unchanged
    const myOrigin = base; // a loopback origin, but NOT the upstream's authority
    const r2 = await fetch(`${base}/api/panel?x=1`, { headers: { ...token, origin: myOrigin } });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/panel?x=1");
    assert.equal(seen[0].origin, myOrigin, "the real Origin must be forwarded, never rewritten");
    assert.equal(seen[0].host, "localhost", "Host is rewritten for routing only: the backend is on its socket");
    // loopback request WITHOUT an Origin header stays origin-less upstream
    const r3 = await fetch(`${base}/api/agents`, { headers: token });
    assert.equal(r3.status, 200);
    assert.equal(seen[1].origin, null, "no Origin must not be invented");
  } finally {
    harness.close();
    upstream.close();
    socket.remove();
  }
});

test("per-instance requests are workspace-scoped: same-named instance in two workspaces never resolves across the selected one", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  // Fake backend with TWO workspaces each owning an instance named "dev-1",
  // honoring ?ws= the way the real server's findInstance(name, wsId) does:
  // scoped lookup only in that workspace, strict 404 on unknown ws.
  const byWs = { wsA: { "dev-1": "A" }, wsB: { "dev-1": "B" } };
  const started = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/api\/(start|restart)\/([^/]+)$/);
    const ws = url.searchParams.get("ws");
    const ok = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const notFound = () => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown instance" })); };
    if (!m) return notFound();
    const owner = ws ? byWs[ws]?.[m[2]] : Object.values(byWs).find((w) => w[m[2]])?.[m[2]]; // unscoped = global (the hazard)
    if (!owner) return notFound();
    if (m[1] === "start") started.push(owner);
    return ok({ owner });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const ctx = { api: (pathname, opts) => fetch(base + pathname, opts) };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsB");
    // the path builder itself pins the selected workspace on every kind
    for (const kind of ["start", "restart"]) {
      const p = common.instanceApiPath(kind, "dev-1");
      assert.match(p, new RegExp(`^/api/${kind}/dev-1\\?ws=wsB$`), `${kind} must carry the selected ws`);
    }
    assert.equal(common.instanceApiPath("restart", "dev-1", "limit=150"), "/api/restart/dev-1?limit=150&ws=wsB");
    // MUTATING request viewed from wsB lands on wsB's instance — never wsA's
    assert.deepEqual(await common.postJson(ctx, common.instanceApiPath("start", "dev-1"), {}), { owner: "B" });
    assert.deepEqual(started, ["B"], "start must resolve only inside the selected workspace");
    // another instance route scopes identically
    assert.deepEqual(await common.postJson(ctx, common.instanceApiPath("restart", "dev-1"), {}), { owner: "B" });
    // an instance that exists only in the OTHER workspace is a strict miss
    common.setWorkspace("wsC");
    await assert.rejects(common.postJson(ctx, common.instanceApiPath("start", "dev-1"), {}), /unknown instance/);
    assert.deepEqual(started, ["B"], "no cross-workspace start leaked");
  } finally {
    common.setWorkspace(prevWs);
    upstream.close();
  }
});

test("ws generation: deferred roster/agents responses from workspace A never paint after switching to B", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { refresh } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const gate = [];
  const payload = (body) => ({ ok: true, status: 200, json: async () => body });
  const ctx = { api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })) };
  const painted = [];
  // renderList/renderWorkspaceSelect touch the DOM; stub the minimum and
  // observe paints via s.souls
  const fakeEl = () => ({ style: {}, dataset: {}, classList: { toggle() {}, add() {} }, innerHTML: "", textContent: "", title: "",
                          appendChild() {}, querySelectorAll: () => [], addEventListener() {} });
  const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, "document");
  if (!hadDoc) globalThis.document = { createElement: fakeEl };
  const s = {
    alive: true, ctx, souls: { agents: [] }, filterText: "",
    q: () => fakeEl(),
  };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    const inFlightA = refresh(s);            // /api/agents + /api/panel for wsA in flight
    assert.match(gate[0].pathname, /ws=wsA/);
    common.setWorkspace("wsB");              // switch bumps the generation
    const inFlightB = refresh(s);
    assert.match(gate[2].pathname, /ws=wsB/);
    // wsB's responses land and paint
    gate[2].ok(payload({ agents: [{ name: "from-B" }] }));
    gate[3].ok(payload({ workspaces: [], workspace: { id: "wsB" }, instances: [] }));
    await inFlightB;
    assert.equal(s.souls.agents[0].name, "from-B");
    // wsA's STALE responses land late — they must not overwrite wsB's list
    gate[0].ok(payload({ agents: [{ name: "from-A" }] }));
    gate[1].ok(payload({ workspaces: [], workspace: { id: "wsA" }, instances: [] }));
    await inFlightA;
    assert.equal(s.souls.agents[0].name, "from-B", "stale workspace-A agents must never paint after switching to B");
  } finally {
    common.setWorkspace(prevWs);
    if (!hadDoc) delete globalThis.document;
  }
});

// The legacy LOCAL doSpawn these tests drove (form clearing, button
// re-enable, local roster wait) was deleted with the v2 spawn dialog — every
// local spawn is the confirmed prepare → apply transaction (§3b: deleted, not
// ported). Its ownership properties are covered where they now live:
// packages/desktop/test/spawn-dialog.test.mjs (late results never touch a
// newer dialog; closing in flight; roster wait before the terminal handoff)
// and remote-spawn-handoff.test.mjs (a workspace switch never auto-opens).
// The op-token rule still guards the execution-server doSpawn, ported here.
async function remoteSpawnHarness() {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const { refreshCli } = await import(new URL("../packages/desktop/renderer/views/cli-status.mjs", import.meta.url).href);
  await refreshCli({ api: async () => ({ ok: true, version: "0.25.7", bin: "/oats", remote: ["spawn"] }) });
  const releases = [], opened = [];
  const ctx = { api: (pathname) => pathname === "/api/spawn" ? new Promise((ok, err) => releases.push({ ok, err })) : Promise.resolve({ instances: [] }),
    openTerminal: (ref) => opened.push(ref) };
  const s = { ctx, alive: true, selAgent: { name: "dev", agentsRoot: "/a" }, spawnOp: 0, waitOpts: { delayMs: 0, tries: 1, sleep: async () => {} } };
  return { common, doSpawn, releases, opened, s };
}
const remoteFields = (log) => ({ server: "host", task: "t", status: (text) => log.push(text) });

test("spawn op token: a superseded execution-server spawn completing late never writes status or opens a terminal", async () => {
  const { common, doSpawn, releases, opened, s } = await remoteSpawnHarness();
  const prevWs = common.currentWorkspace(); common.setWorkspace("wsA");
  try {
    const first = [], second = [];
    const spawn1 = doSpawn(s, remoteFields(first));
    const spawn2 = doSpawn(s, remoteFields(second)); // supersedes spawn1
    releases[0].ok({ instance: "inst-1", home: "/h1", server: "host" });
    assert.equal(await spawn1, undefined, "the stale completion is not reported as created by this op");
    assert.deepEqual(first, ["Spawning on host…"], "stale success writes nothing after its dispatch");
    releases[1].ok({ instance: "inst-2", home: "/h2", server: "host" });
    assert.deepEqual(await spawn2, { created: true });
    assert.match(second.at(-1), /^Spawned inst-2 on host\./);
    assert.deepEqual(opened, []);
  } finally { common.setWorkspace(prevWs); }
});

test("spawn op token: a superseded execution-server spawn ERROR never overwrites the active spawn's status", async () => {
  const { common, doSpawn, releases, s } = await remoteSpawnHarness();
  const prevWs = common.currentWorkspace(); common.setWorkspace("wsA");
  try {
    const first = [], second = [];
    const spawn1 = doSpawn(s, remoteFields(first));
    const spawn2 = doSpawn(s, remoteFields(second));
    releases[0].err(Object.assign(new Error("boom"), { code: "E_SPAWN_FAILED" }));
    await spawn1;
    assert.deepEqual(first, ["Spawning on host…"], "stale error paints nothing");
    releases[1].ok({ instance: "inst-2", home: "/h2", server: "host" });
    await spawn2;
    assert.match(second.at(-1), /^Spawned inst-2 on host\./);
  } finally { common.setWorkspace(prevWs); }
});

test("stale snapshot: a workspace switch during the roster wait aborts the auto-open", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  let panelCalls = 0;
  const ctx = {
    api: (pathname) => {
      if (!pathname.startsWith("/api/panel"))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-new", launched: true }) });
      panelCalls++;
      if (panelCalls === 2) common.setWorkspace("wsB"); // switch mid-wait
      // the instance only appears AFTER the switch has happened
      const names = panelCalls >= 3 ? [{ instance: "dev-new" }] : [];
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: names }) });
    },
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 5 } };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    await doSpawn(s);
    assert.deepEqual(opened, [], "ws switched during the wait: opening now would resolve in the wrong workspace");
  } finally {
    common.setWorkspace(prevWs);
  }
});
