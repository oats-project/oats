import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedLocalHome as localHomeIn } from "../packages/client/session-start.mjs";
import { closeGroup, startGroup } from "./helpers/process-group.mjs";
import { privateTmuxTmpdir } from "./helpers/host-fixture.mjs";
import { authorizedHeaders, privateSocketDir, startBackend } from "../packages/desktop/test/helpers/backend-server.mjs";

// Inert server tests: the backend runs against a FAKE installed CLI that
// replays JSON captured from a real `oats` run on the hand-built Northwind
// deployment (test/helpers/desktop-fake-oats.mjs). No kernel, runtime, network
// or tmux session is created here; live tmux checks live in
// desktop-tmux-anchoring.test.mjs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRV = join(ROOT, "packages", "desktop", "server", "oats-web.mjs");
const FAKE = join(ROOT, "test", "helpers", "desktop-fake-oats.mjs");
const SOUL = "release-manager", INSTANCE = "release-manager-cap";


/** The servers this file has started, and the temporary directories it has made. */
const servers = [], made = [];
/** A new temporary directory, removed when the file has ended (below). */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
/** A private TMUX_TMPDIR for a server, removed with the file's directories. The server asks tmux for
 *  the panes it shows, and asks the default server when a home records no socket: here, in a
 *  directory of this file, never at tmux's default place, where the host has its own server. A
 *  TMUX inherited from a session inside tmux still names that session's server for such a call. */
function tmuxTmpdir() {
  const dir = privateTmuxTmpdir();
  made.push(dir);
  return dir;
}
// When the file has ended, its servers are closed first, and the removal waits until everything
// they started has ended (closeGroup): a server that is killed leaves the fake CLI it had just
// started to finish by itself, and that one writes its log in a directory after the server has
// gone. So a server is started with startGroup. (Per file and not per test: a test here shares
// its server with its subtests, and a hook after each test would run after each subtest as well.)
// A test's own earlier removal may stay.
test.after(async () => {
  for (const proc of servers.splice(0)) await closeGroup(proc);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch deployment directory holding the FILE CONTENT the brain/file
 * viewers read, at the paths the captured kernel status reports. The kernel
 * JSON (not this layout) is the data authority for every roster fact. */
function northwindDeployment() {
  const scope = realpathSync(tempDir("oatsweb-northwind-"));
  writeFileSync(join(scope, "oats-local.yaml"), "workspace: fixture\n");
  const agent = join(scope, "agents", SOUL), soul = join(agent, "soul");
  mkdirSync(join(soul, "skills", "release-checklist"), { recursive: true });
  mkdirSync(join(soul, "knowledge"), { recursive: true });
  writeFileSync(join(soul, "AGENTS.md"), "# release-manager\n");
  writeFileSync(join(soul, "skills", "release-checklist", "SKILL.md"), "---\nname: release-checklist\ndescription: Cut a release\n---\n# c\n");
  writeFileSync(join(soul, "knowledge", "index.md"), "# index\n");
  const home = join(agent, "instances", INSTANCE);
  mkdirSync(join(home, ".agents", "skills", "nw-deploy", "deploy"), { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "nw-deploy", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
  writeFileSync(join(home, "AGENTS.md"), "# composed\n");
  writeFileSync(join(home, "TASK.md"), "# task\n");
  writeFileSync(join(home, "notes", "note.md"), "# note\n");
  return { scope, agent, soul, home };
}

/** A loopback Origin, as a page of the app's own would send it. */
const LOOPBACK = { origin: "http://localhost" };

/** Start the real backend (a fresh credential on fd 3, a private socket: helpers/backend-server.mjs) with
 * `args` after its --dirs, as the leader of a process group of its own (startGroup). */
async function startBackendGroup({ dirs = [], args = [], env, cwd } = {}) {
  const socket = privateSocketDir(); made.push(socket.dir);
  const s = await startBackend({ dirs, args, env, cwd, socket, spawn: (command, argv, options) => { const proc = startGroup(command, argv, options); servers.push(proc); return proc; } });
  return s;
}

/** Start the real backend with the fake CLI as its only discovery candidate. `raw` sends exactly the
 * headers given (add `authorizedHeaders(secret, …)` to carry the credential). */
async function startServer(dir, { env = {}, drop = [], observed = true } = {}) {
  const tools = tempDir("oatsweb-fake-cli-");
  const bin = join(tools, "oats"), log = join(tools, "calls.jsonl");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(bin, 0o755);
  const s = await startBackendGroup({ dirs: [dir],
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir(), OATS_DESKTOP_OATS_BIN: bin, FAKE_OATS_LOG: log, FAKE_OATS_DROP_FEATURES: drop.join(","), ...env } });
  let panel = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { panel = await (await s.request("/api/panel")).json(); } catch { continue; }
    if (!observed || panel.deployment?.status !== "pending") break;
  }
  assert.ok(panel, "server came up");
  if (observed) assert.equal(panel.deployment?.status, "observed", JSON.stringify(panel.deployment));
  const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { proc: s.child, secret: s.secret, raw: s.raw, panel, calls, get: (p) => s.request(p),
    post: (p, body, headers = {}) => s.request(p, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) };
}

// ---- marked-block extraction ----
function extractBlock(file, marker) {
  const src = readFileSync(file, "utf8");
  const re = new RegExp(`\\/\\* OATSWEB_${marker}_BEGIN[^*]*\\*\\/([\\s\\S]*?)\\/\\* OATSWEB_${marker}_END \\*\\/`);
  const m = src.match(re);
  assert.ok(m, marker + " block markers present");
  return m[1];
}

test("desktop server: the retired collect helper is refused; no deployment reader ships", () => {
  const r = spawnSync(process.execPath, [SRV, "collect", "--dir", ROOT], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /usage: oats-web\.mjs start/);
  const server = join(ROOT, "packages", "desktop", "server");
  for (const retired of ["deployment.mjs", "model.mjs", "catalog.mjs"]) assert.ok(!readdirSync(server).includes(retired), retired);
});

// ---- HTTP guards and the kernel-observed roster ----

test("desktop server: POST origin guard rejects hostile/null origins without crashing", async () => {
  const { scope } = northwindDeployment();
  const { proc, post, get, raw, secret } = await startServer(scope);
  try {
    // An instance-addressed POST that would run a command (start launches a harness in the instance's terminal).
    assert.equal((await post("/api/start/x", {}, { origin: "null" })).status, 403, "Origin: null is rejected, not a crash");
    assert.equal((await post("/api/start/x", {}, { origin: "http://evil.com" })).status, 403);
    // A raw request for the rebinding case, carrying the credential: the Host guard alone refuses it.
    const hostStatus = (await raw({ path: "/api/start/x", method: "POST", body: "{}",
      headers: authorizedHeaders(secret, { "content-type": "application/json", host: "evil.com" }) })).status;
    assert.equal(hostStatus, 403, "non-loopback Host is rejected");
    const passed = await post("/api/start/x", {}, LOOPBACK);
    assert.equal(passed.status, 404, "loopback origin passes the guard (unknown instance)");
    assert.deepEqual(await passed.json(), { error: 'unknown instance "x"' }, "the 404 is instance resolution's, not routing's");
    assert.equal((await get("/api/panel")).status, 200, "server survived the malformed origin");
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

test("desktop server: no route reads a pane, types into it or reads its session log by instance name (#609, #627)", async (t) => {
  const { scope } = northwindDeployment();
  const { proc, post, get, raw, secret } = await startServer(scope);
  try {
    const loopback = LOOPBACK;
    const unknown = await get("/api/no-such-route");
    assert.equal(unknown.status, 404);
    const notFound = await unknown.json();
    assert.deepEqual(notFound, { error: "not found" });
    // An unknown name and the deployment's own instance: neither is resolved, the path is no route at all.
    // One subtest per request, so each removed route reports on its own.
    for (const name of ["x", INSTANCE]) {
      for (const [route, ask] of [
        [`GET /api/session/${name}`, () => get(`/api/session/${name}`)],
        [`POST /api/keys/${name}`, () => post(`/api/keys/${name}`, { data: "x" }, loopback)],
        [`POST /api/interrupt/${name}`, () => post(`/api/interrupt/${name}`, {}, loopback)],
        [`GET /api/chat/${name}`, () => get(`/api/chat/${name}`)],
        [`GET /api/chat/${name}?limit=10`, () => get(`/api/chat/${name}?limit=10`)],
        [`POST /api/chat/${name}`, () => post(`/api/chat/${name}`, {}, loopback)],
      ]) {
        await t.test(`${route} answers as an unknown route does`, async () => {
          const answer = await ask();
          assert.equal(answer.status, 404);
          assert.deepEqual(await answer.json(), notFound);
        });
      }
    }
    // The guards run before routing: an unknown path is still refused to a foreign origin, and every
    // path, a GET included, to a non-loopback Host (a raw request carrying the credential).
    for (const path of ["/api/keys/x", "/api/interrupt/x", `/api/chat/${INSTANCE}`]) {
      assert.equal((await post(path, { data: "x" }, { origin: "http://evil.com" })).status, 403, path);
    }
    for (const path of [`/api/chat/${INSTANCE}`, "/api/no-such-route"]) {
      const hostStatus = (await raw({ path, headers: authorizedHeaders(secret, { host: "evil.com" }) })).status;
      assert.equal(hostStatus, 403, `${path}: a non-loopback Host is refused before routing`);
    }
    // A kept read of an agent's files, by name, still answers.
    const brain = await get(`/api/brain/${SOUL}`);
    assert.equal(brain.status, 200, "GET /api/brain/<agent> still answers");
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

test("desktop server: no dedicated harvest route: POST /api/harvest/<name> answers as an unknown route does (#818)", async (t) => {
  const { scope, home } = northwindDeployment();
  const { proc, post, calls, raw, secret } = await startServer(scope);
  try {
    const loopback = LOOPBACK;
    const unknown = await post("/api/no-such-route", {}, loopback);
    assert.equal(unknown.status, 404);
    const notFound = await unknown.json();
    assert.deepEqual(notFound, { error: "not found" });
    // An unknown name and the deployment's own instance, bare and qualified as a row would address it: the
    // path is no route at all, so nothing resolves the name (an unknown one would answer 'unknown instance').
    const qualified = `?ws=${encodeURIComponent(scope)}&home=${encodeURIComponent(home)}`;
    for (const [label, path] of [["an unknown name", "/api/harvest/x"], ["the deployment's own instance", `/api/harvest/${INSTANCE}`],
      ["the deployment's own instance, qualified by ws and home", `/api/harvest/${INSTANCE}${qualified}`]]) {
      await t.test(`POST /api/harvest/<name>, ${label}, answers as an unknown route does`, async () => {
        const answer = await post(path, {}, loopback);
        assert.equal(answer.status, 404);
        assert.deepEqual(await answer.json(), notFound);
      });
    }
    assert.equal(calls().some((argv) => argv[0] === "operation"), false, "no provider operation ran");
    // The guards run before routing: a foreign Origin, and a non-loopback Host (a raw request carrying the credential).
    assert.equal((await post(`/api/harvest/${INSTANCE}`, {}, { origin: "http://evil.com" })).status, 403);
    const hostStatus = (await raw({ path: `/api/harvest/${INSTANCE}`, method: "POST", body: "{}",
      headers: authorizedHeaders(secret, { "content-type": "application/json", host: "evil.com" }) })).status;
    assert.equal(hostStatus, 403, "a non-loopback Host is refused before routing");
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

test("desktop server: the roster, header and souls are the kernel's status/workspace-status JSON", async () => {
  const { scope, home } = northwindDeployment();
  const { proc, panel, get, calls } = await startServer(scope);
  try {
    assert.equal(panel.workspace.id, scope); assert.equal(panel.workspace.name, "northwind");
    assert.equal(panel.deployment.root, join(scope, "agents"));
    assert.equal(panel.deployment.workspaceStatus.workspaceStatusApi, 1);
    assert.deepEqual(panel.deployment.workspaceStatus.packages.map((p) => p.id), ["nw.tools", "oats.framework", "oats.okf"]);
    assert.equal(Object.hasOwn(panel.deployment.workspaceStatus, "approval"), false, "there is no package approval (packages-no-approval)");
    assert.equal(Object.hasOwn(panel.deployment, "souls"), false, "private soul rows stay server-side");
    assert.equal(panel.instances.length, 1);
    const i = panel.instances[0];
    assert.equal(i.instance, INSTANCE); assert.equal(i.home, home); assert.equal(i.agentsRoot, join(scope, "agents"));
    assert.equal(i.modules.length, 5); assert.ok(i.modules.every((m) => m.status === "current"));
    assert.equal(i.soul.status, "current"); assert.equal(Object.hasOwn(i, "identity"), false, "absent identity is not synthesized");
    for (const key of ["task", "next", "knowledgeCount", "command", "launch"]) assert.equal(Object.hasOwn(i, key), false, key);
    // Spawnable souls are the kernel's spawn catalog (`oats souls`), not the roster.
    const catalog = JSON.parse(readFileSync(join(ROOT, "packages", "desktop", "test", "fixtures", "workspace-v2", "f3", "souls.json"), "utf8")).result.souls;
    const agents = (await (await get("/api/agents")).json()).agents;
    assert.deepEqual(agents.map((a) => a.name), catalog.map((c) => c.name).sort());
    const rm = agents.find((a) => a.name === SOUL);
    assert.deepEqual([rm.kind, rm.agentsRoot, rm.team, rm.work], ["persistent", join(scope, "agents"), "engineering", "worktree"]);
    // The two native reads, the spawn catalog and the probe; no removed verbs.
    const verbs = calls().map((argv) => argv.slice(0, argv[0] === "workspace" ? 2 : 1).join(" "));
    assert.ok(verbs.includes("status") && verbs.includes("workspace status") && verbs.includes("version") && verbs.includes("souls"));
    assert.ok(!verbs.some((v) => ["catalog", "list", "setup"].includes(v)), verbs.join(", "));
    const reads = calls().filter((a) => a[0] === "status" || a[0] === "workspace");
    assert.ok(reads.length >= 2);
    for (const argv of reads) assert.deepEqual(argv.slice(-3), ["--dir", scope, "--json"]);
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

for (const feature of ["workspace-v2", "instance-modules", "served-identity", "packages-no-approval"]) test(`desktop server: a CLI without ${feature} yields an unavailable deployment naming it — no fallback reader`, async () => {
  const { scope } = northwindDeployment();
  const { proc, get, calls } = await startServer(scope, { drop: [feature], observed: false });
  try {
    let panel;
    for (let n = 0; n < 50; n++) { panel = await (await get("/api/panel")).json(); if (panel.deployment.status !== "pending") break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(panel.deployment.status, "unavailable"); assert.equal(panel.deployment.reason.feature, feature);
    assert.match(panel.deployment.reason.message, new RegExp(feature));
    assert.deepEqual(panel.instances, []);
    assert.deepEqual((await (await get("/api/agents")).json()).agents, []);
    assert.deepEqual(calls().filter((a) => a[0] === "status" || a[0] === "workspace"), [], "an unadvertised read is never invoked");
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

test("desktop server: findInstance is workspace-scoped and snapshot-only — same-named instance elsewhere doesn't answer", () => {
  const src = extractBlock(SRV, "FINDINST");
  const snapshot = { byWs: new Map([
    ["ws-a", { instances: [{ instance: "dev-1", home: "/a/dev-1", running: false }] }],
    ["ws-b", { instances: [{ instance: "dev-1", home: "/b/dev-1", running: true }, { instance: "only-b", home: "/b/only-b", running: true }] }],
  ]) };
  const findInstance = new Function("snapshot", src + "\nreturn findInstance;")(snapshot);
  assert.equal(findInstance("dev-1", "ws-a").running, false, "ws-a's dev-1 is stopped");
  assert.equal(findInstance("dev-1", "ws-b").running, true, "ws-b's dev-1 is running");
  assert.equal(findInstance("only-b", "ws-a"), undefined, "scoped lookup never leaks another workspace");
  assert.equal(findInstance("dev-1"), findInstance.AMBIGUOUS, "an unscoped twin is ambiguous, not an arbitrary pick");
  assert.equal(findInstance("dev-1", undefined, "/b/dev-1").running, true, "exact home qualifies");
  const empty = new Function("snapshot", src + "\nreturn findInstance;")({ byWs: new Map() });
  assert.equal(empty("dev-1"), undefined, "no cold-start collection: an unobserved roster has no instance");
});

test("desktop server: brain: skill-path expansion covers leaf and module-tree forms; merge keeps first", () => {
  const src = extractBlock(SRV, "BRAINSKILLS");
  const { expandSkillPath, mergeSkills } = new Function("join",
    src + "\nreturn { expandSkillPath, mergeSkills };")((...p) => p.join("/"));
  const entry = (p) => ({ name: p.split("/").pop(), path: p + "/SKILL.md", description: "" });
  const list = (p) => [entry(p + "/a"), entry(p + "/b")];
  assert.deepEqual(expandSkillPath("/home/.agents/skills/soul-skill", (f) => f === "/home/.agents/skills/soul-skill/SKILL.md", list, entry)
    .map((s) => s.name), ["soul-skill"]);
  // materialized module tree `.agents/skills/<module>/<skill>/SKILL.md`
  assert.deepEqual(expandSkillPath("/home/.agents/skills/nw-deploy", () => false, list, entry).map((s) => s.name), ["a", "b"]);
  const merged = mergeSkills(
    [{ name: "dup", path: "/first/dup/SKILL.md" }, { name: "z", path: "/first/z/SKILL.md" }],
    [{ name: "dup", path: "/second/dup/SKILL.md" }, { name: "a", path: "/second/a/SKILL.md" }]);
  assert.deepEqual(merged.map((s) => s.name), ["a", "dup", "z"]);
  assert.equal(merged.find((s) => s.name === "dup").path, "/first/dup/SKILL.md");
});

test("desktop harness: every shipped view has a tab in the shared harness", () => {
  // README claims a single shared harness for ALL views — enforce it: each
  // views/*.mjs exporting the view contract (mount) must be reachable from a
  // harness.html tab (regression: Brain shipped with a standalone harness).
  const rendererDir = join(ROOT, "packages", "desktop", "renderer");
  const viewsDir = join(rendererDir, "views");
  const views = readdirSync(viewsDir).filter((f) => f.endsWith(".mjs"))
    .filter((f) => /export (async )?function mount\(/.test(readFileSync(join(viewsDir, f), "utf8")))
    .map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(views.length >= 4, `shipped views found (got: ${views.join(", ")})`);
  const harness = readFileSync(join(rendererDir, "harness.html"), "utf8");
  for (const v of views)
    assert.ok(harness.includes(`data-view="${v}"`), `harness.html has a tab for the "${v}" view`);
  // and no stray standalone harnesses reappear next to the shared one
  const strays = readdirSync(rendererDir).filter((f) => /^dev-.*\.(html|mjs)$/.test(f));
  assert.deepEqual(strays, [], "no standalone dev-* harness files alongside the shared harness");
});

test("desktop server: /api/brain returns the contract shape for the kernel-reported soul and instances", async () => {
  const { scope, soul, home } = northwindDeployment();
  const { proc, get } = await startServer(scope);
  try {
    const d = await (await get(`/api/brain/${SOUL}`)).json();
    assert.equal(d.agent, SOUL); assert.equal(typeof d.description, "string");
    assert.equal(d.agentsRoot, join(scope, "agents"));
    assert.equal(d.soul.agentsMd, join(soul, "AGENTS.md"));
    assert.deepEqual(d.soul.skills, [{ name: "release-checklist", path: join(soul, "skills", "release-checklist", "SKILL.md"), description: "Cut a release" }]);
    assert.deepEqual(d.soul.knowledge, { index: join(soul, "knowledge", "index.md"), tree: [join(soul, "knowledge", "index.md")] });
    assert.equal(d.instances.length, 1);
    const i = d.instances[0];
    assert.equal(i.instance, INSTANCE); assert.equal(i.home, home); assert.equal(i.running, false);
    assert.deepEqual(i.skills.map((s) => s.name), ["deploy"], "materialized module skills are listed from the home");
    assert.equal(i.agentsMd, join(home, "AGENTS.md")); assert.equal(i.task, join(home, "TASK.md")); assert.equal(i.state, null);
    assert.deepEqual(i.notes, [join(home, "notes", "note.md")]);
    assert.equal((await get("/api/brain/no-such-agent")).status, 404);
    assert.equal((await get("/api/brain/..%2F..%2Fetc")).status, 404, "traversal-shaped names don't match the route");
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

test("desktop server: /api/brain never returns skills from symlinks escaping the soul or home", async () => {
  const { scope, soul, home } = northwindDeployment();
  const outside = tempDir("oatsweb-brainesc-");
  writeFileSync(join(outside, "SKILL.md"), "---\nname: leaked-skill\ndescription: TOP-SECRET-SOUL-SKILL\n---\n");
  mkdirSync(join(soul, "skills", "sneaky")); symlinkSync(join(outside, "SKILL.md"), join(soul, "skills", "sneaky", "SKILL.md"));
  mkdirSync(join(home, ".agents", "skills", "evil")); symlinkSync(join(outside, "SKILL.md"), join(home, ".agents", "skills", "evil", "SKILL.md"));
  const { proc, get } = await startServer(scope);
  try {
    const d = await (await get(`/api/brain/${SOUL}`)).json();
    assert.ok(!JSON.stringify(d).includes("leaked-skill") && !JSON.stringify(d).includes("TOP-SECRET"), "no escaping skill surfaces");
    assert.deepEqual(d.soul.skills.map((s) => s.name), ["release-checklist"], "contained skill still resolves");
    assert.deepEqual(d.instances[0].skills.map((s) => s.name), ["deploy"]);
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("desktop server: verifiedLocalHome admits only the exact kernel-reported home inside its deployment", () => {
  const src = extractBlock(SRV, "VERIFIEDLOCALHOME");
  const { scope, home } = northwindDeployment();
  const outside = realpathSync(tempDir("oatsweb-hh-outside-"));
  const evil = join(outside, "instances", "evil-1"); mkdirSync(evil, { recursive: true });
  const unreported = join(scope, "agents", SOUL, "instances", "other-1"); mkdirSync(unreported, { recursive: true });
  const escaping = join(scope, "agents", SOUL, "instances", "link-1"); symlinkSync(evil, escaping);
  const snapshot = { byWs: new Map([[scope, { instances: [
    { instance: INSTANCE, home }, { instance: "link-1", home: escaping }, { instance: "evil-1", home: evil },
  ] }]]) };
  // The server's wrapper over the shared rule (session-start.mjs verifiedLocalHome), given the deployments it holds.
  const verifiedLocalHome = new Function("realpathSync", "basename", "dirname", "sep", "deployments", "snapshot", "localHomeIn", `const held = () => null; ${src}; return verifiedLocalHome;`)(
    realpathSync, basename, dirname, sep, () => [{ id: scope }], snapshot, localHomeIn);
  try {
    assert.equal(verifiedLocalHome({ instance: INSTANCE, home }), home, "the reported home is accepted");
    assert.equal(verifiedLocalHome({ instance: "other-1", home: unreported }), null, "an in-layout home the kernel did not report is rejected");
    assert.equal(verifiedLocalHome({ instance: "link-1", home: escaping }), null, "a reported home canonicalizing outside the deployment is rejected");
    assert.equal(verifiedLocalHome({ instance: "evil-1", home: evil }), null, "a reported home outside the deployment is rejected");
    assert.equal(verifiedLocalHome({ instance: "other-name", home }), null, "basename/instance mismatch rejected");
    assert.equal(verifiedLocalHome({ instance: INSTANCE, home, server: "remote" }), null, "remote rows never grant a local cwd");
    assert.equal(verifiedLocalHome({ instance: INSTANCE }), null, "missing home rejected");
    assert.equal(verifiedLocalHome({ instance: INSTANCE, home: 42 }), null, "non-string home rejected");
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("desktop server: an ordinary /api/spawn body is execution-server only — a local one is refused before any CLI call", async () => {
  // The legacy local route (its own roster validation, then the CLI) was
  // deleted with the v2 spawn dialog (§3b: deleted, not ported): every local
  // spawn is the confirmed prepare → apply transaction on /api/spawn?ws=.
  const { scope } = northwindDeployment();
  const { proc, post, calls } = await startServer(scope, { drop: ["spawn-apply-2"], env: { PATH: "/nonexistent", SHELL: "/bin/false" } });
  try {
    for (const body of [{}, { agent: SOUL, agentsRoot: join(scope, "agents") }, { agent: SOUL, agentsRoot: "/tmp" }]) {
      const r = await post("/api/spawn", body);
      assert.equal(r.status, 409); assert.equal((await r.json()).code, "E_PLAN_REQUIRED", "even for a CLI without the apply fence");
    }
    assert.equal((await post("/api/spawn", { serverId: "host" })).status, 400, "an execution-server body still needs { agent, agentsRoot }");
    const keyed = await post("/api/spawn", { serverId: "host", agent: SOUL, agentsRoot: join(scope, "agents"), decision: {} });
    assert.equal(keyed.status, 409); assert.equal((await keyed.json()).code, "E_UNSUPPORTED_OPTION");
    assert.equal(calls().some((argv) => argv[0] === "spawn"), false);
  } finally { proc.kill(); rmSync(scope, { recursive: true, force: true }); }
});

// ---- /api/models: advisory model catalog for the spawn modal ----

test("desktop server: parsePiModelList drops the header and yields provider/model ids", () => {
  const src = extractBlock(SRV, "MODELPARSE");
  const parse = new Function(src + "\nreturn parsePiModelList;")();
  const out = [
    "provider        model                       context  max-out  thinking  images",
    "anthropic       claude-opus-4-5             200K     64K      yes       yes",
    "openai          gpt-5.2                     400K     128K     yes       yes",
    "",
    "   ", // blank-ish lines are dropped
  ].join("\n");
  assert.deepEqual(parse(out), ["anthropic/claude-opus-4-5", "openai/gpt-5.2"]);
  assert.deepEqual(parse(null), [], "missing catalog → empty list, never a throw");
});

test("desktop server: POST /api/models serves harness-scoped catalogs, coalesces concurrent misses into ONE probe, guards Origin, and 400s unknown harnesses", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // Fake `pi` on PATH: a deterministic catalog that COUNTS its invocations
  // (append-per-run marker) — the coalescing assertion reads it back. node
  // must stay reachable for the server itself, so prepend to the REAL PATH.
  const bindir = tempDir("oats-models-");
  const fakePi = join(bindir, "pi");
  const countFile = join(bindir, "runs");
  writeFileSync(fakePi, `#!/bin/sh\necho x >> ${countFile}\nsleep 0.3\ncat <<'EOF'\nprovider        model                       context\nanthropic       claude-opus-4-5             200K\nanthropic       claude-sonnet-4-5           200K\nopenai          gpt-5.2                     400K\nEOF\n`);
  chmodSync(fakePi, 0o755);
  const { scope } = northwindDeployment();
  const { proc, get, post: send } = await startServer(scope, { env: { PATH: `${bindir}:${process.env.PATH}` } });
  try {
    const post = (harness, headers = {}) => send("/api/models", harness === undefined ? {} : { harness }, headers);
    // concurrent COLD misses (both runtimes) fan in to ONE child-process run
    const burst = await Promise.all([post("pi"), post("claude"), post("pi"), post("claude"), post("pi")]);
    for (const r of burst) assert.equal(r.status, 200);
    const runs = rf(countFile, "utf8").trim().split("\n").length;
    assert.equal(runs, 1, `concurrent misses coalesce into one probe (got ${runs} runs)`);
    const pi = await (await post("pi")).json();
    assert.equal(pi.harness, "pi");
    assert.deepEqual(pi.models.map((m) => m.id),
      ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5", "openai/gpt-5.2"],
      "pi catalog is the full provider/model list");
    const cl = await (await post("claude")).json();
    assert.equal(cl.harness, "claude");
    const ids = cl.models.map((m) => m.id);
    for (const alias of ["opus", "sonnet", "haiku"]) assert.ok(ids.includes(alias), `claude alias ${alias} offered`);
    assert.ok(ids.includes("claude-opus-4-5"), "anthropic ids offered WITHOUT the provider prefix");
    assert.ok(!ids.some((id) => id.startsWith("openai/") || id === "gpt-5.2"), "non-anthropic models never offered to claude");
    assert.deepEqual(await (await post("codex")).json(), { harness: "codex", models: [] }, "Codex accepts native model ids without Pi catalog guesses");
    assert.equal((await post("unknown")).status, 400, "unknown harness → 400");
    assert.equal((await (await post(undefined)).json()).harness, "pi", "harness defaults to pi");
    // command-running route sits behind the POST Origin guard — a hostile
    // page can never fan out child processes cross-origin (review 9b1e3ff)
    assert.equal((await post("pi", { origin: "http://evil.com" })).status, 403, "hostile origin rejected");
    assert.equal((await get("/api/models?runtime=pi")).status, 404, "no GET surface for the command-running route");
  } finally { proc.kill(); }
});

test("desktop server: /api/models degrades to an empty list when pi is not installed", async () => {
  const { scope } = northwindDeployment();
  const { proc, post: send } = await startServer(scope, { env: { PATH: "/nonexistent", SHELL: "/bin/false" } });
  try {
    const post = (harness) => send("/api/models", { harness });
    const pi = await (await post("pi")).json();
    assert.deepEqual(pi.models, [], "no pi → empty catalog, not an error");
    const cl = await (await post("claude")).json();
    assert.ok(cl.models.some((m) => m.id === "opus"), "claude aliases still offered without pi");
  } finally { proc.kill(); }
});

// ---- /api/file guard (desktop viewers) ----

test("desktop server: file guard: traversal, prefix-sneak, and symlink escapes fail closed", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { sep, resolve } = await import("node:path");
  const src = extractBlock(SRV, "FILEGUARD");
  const resolveGuardedFile = new Function("realpathSync", "resolve", "sep",
    `${src}; return resolveGuardedFile;`)(realpathSync, resolve, sep);
  const base = tempDir("oatsweb-guard-");
  const root = join(base, "root"); mkdirSync(root);
  const evil = join(base, "root-evil"); mkdirSync(evil);
  writeFileSync(join(root, "ok.md"), "# hi");
  writeFileSync(join(evil, "secret"), "no");
  writeFileSync(join(base, "outside"), "no");
  symlinkSync(join(base, "outside"), join(root, "link"));
  // CONTRACT (review 9db1e81): roots are PRE-CANONICALIZED at admission;
  // the guard never re-resolves them.
  const realRoot = realpathSync(root);
  assert.ok(resolveGuardedFile(join(root, "ok.md"), [realRoot]).real, "in-root file allowed");
  assert.equal(resolveGuardedFile(join(root, "..", "outside"), [realRoot]).code, 403, "dotdot traversal rejected");
  assert.equal(resolveGuardedFile(join(evil, "secret"), [realRoot]).code, 403, "prefix-sneak sibling rejected");
  assert.equal(resolveGuardedFile(join(root, "link"), [realRoot]).code, 403, "symlink escape rejected");
  assert.equal(resolveGuardedFile("relative/path", [realRoot]).code, 400, "relative path rejected");
  assert.equal(resolveGuardedFile(join(root, "missing"), [realRoot]).code, 404, "missing file is 404");
});

test("desktop server: file guard never re-resolves roots — a dir→symlink swap AFTER admission cannot re-target them (review 9db1e81)", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { sep, resolve } = await import("node:path");
  const src = extractBlock(SRV, "FILEGUARD");
  const resolveGuardedFile = new Function("realpathSync", "resolve", "sep",
    `${src}; return resolveGuardedFile;`)(realpathSync, resolve, sep);
  // The reviewer's exact reproduction: capture the canonical root at
  // admission time, swap the directory for a symlink to a secret dir, THEN
  // run the guard. Because the guard consults only the captured canonical
  // string, the request (which now resolves into the secret dir) falls
  // outside it and must 403.
  const base = tempDir("oatsweb-swap-");
  const secret = tempDir("oatsweb-swap-secret-");
  writeFileSync(join(secret, "secret.md"), "TOCTOU-SECRET");
  const la = join(base, "agents"); mkdirSync(la);
  writeFileSync(join(la, "real.md"), "legit");
  const admittedRealBase = realpathSync(la);            // fileRoots-style admission capture
  // sanity pre-swap: legit file serves through the admitted root
  assert.ok(resolveGuardedFile(join(la, "real.md"), [admittedRealBase]).real, "pre-swap file allowed");
  // THE SWAP happens between admission and guarded resolution
  rmSync(la, { recursive: true, force: true });
  symlinkSync(secret, la);
  for (const p of [join(la, "secret.md"), join(secret, "secret.md")]) {
    const r = resolveGuardedFile(p, [admittedRealBase]);
    assert.equal(r.code, 403, `post-swap request rejected (${p}) — got ${JSON.stringify(r)}`);
  }
  // mutation guard: the extracted source must not canonicalize roots at use
  assert.ok(!/allowedRoots\)\s*\{[\s\S]*realpathSync\(r\)/.test(src) && !src.includes("for (const r of allowedRoots) { try { roots.push(realpathSync"),
    "guard source must not re-resolve allowed roots");
});

test("desktop server: /api/file serves kernel-reported soul files; a symlinked soul pointer cannot widen the roots", async () => {
  const { scope, agent, soul } = northwindDeployment();
  const { proc, get } = await startServer(scope);
  try {
    const denied = await get(`/api/file?path=${encodeURIComponent("/etc/hosts")}`);
    assert.ok([403, 404].includes(denied.status), `outside path rejected (${denied.status})`);
    assert.equal((await get("/api/file?path=relative.md")).status, 400, "relative path is 400");
    const r = await get(`/api/file?path=${encodeURIComponent(join(soul, "AGENTS.md"))}`);
    assert.equal(r.status, 200); const d = await r.json();
    assert.equal(d.path, join(soul, "AGENTS.md")); assert.equal(d.markdown, true);
    assert.ok(d.content.length && d.name && d.size > 0 && d.mtime, "content and metadata served");
  } finally { proc.kill(); }
  // Swap the soul pointer for a symlink to a secret directory outside the
  // deployment: neither the pointer path nor its target may serve.
  const secret = tempDir("oatsweb-secret-");
  writeFileSync(join(secret, "AGENTS.md"), "# TOP-SECRET");
  rmSync(soul, { recursive: true, force: true }); symlinkSync(secret, join(agent, "soul"));
  const second = await startServer(scope);
  try {
    for (const path of [join(agent, "soul", "AGENTS.md"), join(secret, "AGENTS.md")]) {
      const r = await second.get(`/api/file?path=${encodeURIComponent(path)}`);
      assert.ok([403, 404].includes(r.status), `escaping soul pointer rejected (${path} → ${r.status})`);
    }
  } finally { second.proc.kill(); }
  // Now the kernel-reported soul DIRECTORY itself (and so every instance home
  // under it) is a symlink out of the deployment: nothing it points at serves.
  const elsewhere = realpathSync(tempDir("oatsweb-soul-elsewhere-"));
  mkdirSync(join(elsewhere, "soul"), { recursive: true }); writeFileSync(join(elsewhere, "soul", "AGENTS.md"), "# TOP-SECRET-SOUL-DIR");
  mkdirSync(join(elsewhere, "instances", INSTANCE), { recursive: true }); writeFileSync(join(elsewhere, "instances", INSTANCE, "TASK.md"), "# TOP-SECRET-HOME");
  rmSync(agent, { recursive: true, force: true }); symlinkSync(elsewhere, agent);
  const third = await startServer(scope);
  try {
    for (const path of [join(agent, "soul", "AGENTS.md"), join(elsewhere, "soul", "AGENTS.md"),
      join(agent, "instances", INSTANCE, "TASK.md"), join(elsewhere, "instances", INSTANCE, "TASK.md")]) {
      const r = await third.get(`/api/file?path=${encodeURIComponent(path)}`);
      assert.ok([403, 404].includes(r.status), `escaping soul directory rejected (${path} → ${r.status})`);
    }
  } finally {
    third.proc.kill(); rmSync(scope, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("desktop server: hostile Host header is rejected on GET file APIs (DNS rebinding)", async () => {
  const { scope } = northwindDeployment();
  const { proc, get, raw, secret } = await startServer(scope);
  try {
    // Carrying the credential: the Host guard alone refuses these.
    const rawGet = async (path) => (await raw({ path, headers: authorizedHeaders(secret, { host: "attacker.example" }) })).status;
    assert.equal(await rawGet(`/api/file?path=${encodeURIComponent(join(scope, "agents", "release-manager", "soul", "AGENTS.md"))}`), 403, "rebinding host cannot read files");
    assert.equal(await rawGet("/api/panel"), 403, "rebinding host cannot enumerate roots");
    assert.equal((await get("/api/panel")).status, 200, "loopback host still serves");
  } finally { proc.kill(); }
});

test("desktop server: started with no --dir it serves no local deployment, never its cwd (#518)", async () => {
  const tools = tempDir("oatsweb-fake-cli-");
  const bin = join(tools, "oats");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(bin, 0o755);
  const cwd = realpathSync(tempDir("oatsweb-not-a-deployment-"));
  const s = await startBackendGroup({ cwd, env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir(), OATS_DESKTOP_OATS_BIN: bin } });
  const proc = s.child;
  try {
    let panel = null;
    for (let i = 0; i < 100 && !panel; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { panel = await (await s.request("/api/panel")).json(); } catch { /* not up yet */ }
    }
    assert.ok(panel, "server came up");
    const local = (panel.workspaces || []).filter((w) => w.id.startsWith("/"));
    assert.deepEqual(local, [], `no local workspace is served: ${JSON.stringify(panel.workspaces)}`);
    assert.ok(!(panel.workspaces || []).some((w) => w.id === cwd || w.id === "/"), "never the cwd, never /");
    assert.equal((await s.request("/api/cli")).ok, true, "the CLI probe still answers");
  } finally { proc.kill(); rmSync(cwd, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true }); }
});
