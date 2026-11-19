// This computer's deployments list in the Desktop's privileged side (#1390): what the switcher is told of a
// list read, the suggestions fed from it, the Remove's provenance and its saved entry, each committed add
// listed after the commit, and the one-time import of the Desktop's own lists (the recents file renamed).
// The switcher's DOM (the Add dialog, where this computer's stale rows and their Remove are) is workspace-switcher.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAddExecutor, createGenerations, createPerformAdd, createRemoveListed, createSerialQueue, importDesktopLists, listDeployment, listState, settledCli, unsavedOpenSet, workspaceSuggestions } from "../workspace-registry.mjs";
import { deploymentListArgv, DEPLOYMENT_IMPORT_MAX } from "../../client/deployment-list-cli.mjs";

test("listState: what the switcher says of a list read", () => {
  assert.deepEqual(listState({ ok: true, value: { ok: true, rows: [] } }), { state: "ok" });
  assert.deepEqual(listState({ ok: false, reason: { code: "E_DEPLOYMENTS_FEATURE", message: "x" } }), { state: "unsupported" });
  assert.deepEqual(listState({ ok: false, reason: { code: "E_CLI_UNAVAILABLE", message: "x" } }), { state: "unavailable" });
  assert.deepEqual(listState({ ok: false, reason: { code: "E_DEPLOYMENTS_INVALID", message: "not JSON" } }), { state: "failed", message: "not JSON" });
  assert.equal(listState(null).state, "failed");
});

test("suggestions: a stale row is offered with its state, never validated or added, and a served path is never offered", () => {
  const validate = (p) => (p === "/h/acme" || p === "/h/served" ? { id: p, name: p.split("/").pop(), team: null, path: p } : null);
  const rows = [{ path: "/h/acme", name: "acme", state: "ok" }, { path: "/h/gone", name: "gone", state: "missing" },
    { path: "/h/served", name: "served", state: "ok" }, { path: "/h/raced", name: "raced", state: "ok" }];
  const list = workspaceSuggestions({ knownPaths: [], listed: rows, advertised: new Set(["/h/served"]), validate });
  assert.deepEqual(list.map((s) => [s.path, s.state, s.removable]), [["/h/acme", "ok", true], ["/h/gone", "missing", true]],
    "a row the kernel called ok that does not validate here is left for the next read");
});

const removeIo = (over = {}) => {
  const log = { removed: [], unsaved: [] };
  const io = {
    removable: (scope) => (scope === "w1" ? new Set(["/h/gone", "/h/acme"]) : new Set()),
    served: (path) => path === "/h/acme",
    remove: async (path) => { log.removed.push(path); return { ok: true, value: { path, removed: true } }; },
    unsave: (path) => log.unsaved.push(path),
    ...over,
  };
  return { log, remove: createRemoveListed(io) };
};

test("Remove: only a row this window was offered as removable, never a served one; the kernel removes it, then its saved entry goes", async () => {
  const { log, remove } = removeIo();
  assert.deepEqual(await remove("/h/gone", "w1"), { ok: true, removed: true });
  assert.deepEqual(log, { removed: ["/h/gone"], unsaved: ["/h/gone"] });
  assert.equal((await remove("/h/gone", "w2")).code, "not-suggested", "another window was never offered it");
  assert.equal((await remove("/h/other", "w1")).code, "not-suggested");
  assert.equal((await remove(42, "w1")).code, "not-suggested");
  assert.equal((await remove("/h/acme", "w1")).code, "served", "removing a served deployment is #476, not this");
  assert.deepEqual(log.removed, ["/h/gone"], "nothing else reached the kernel");
});

test("Remove: the kernel's refusal is said, and nothing is unsaved; a failed save after the kernel's remove is said too", async () => {
  const refused = removeIo({ remove: async () => ({ ok: false, reason: { code: "E_DEPLOYMENTS_BUSY", message: "locked" } }) });
  assert.deepEqual(await refused.remove("/h/gone", "w1"), { ok: false, code: "E_DEPLOYMENTS_BUSY", reason: "locked" });
  assert.deepEqual(refused.log.unsaved, []);
  const disk = removeIo({ unsave: () => { throw new Error("disk full"); } });
  const answer = await disk.remove("/h/gone", "w1");
  assert.equal(answer.code, "save-failed"); assert.match(answer.reason, /disk full/);
  assert.deepEqual(unsavedOpenSet(["/a", "/h/gone", "/b"], "/h/gone"), ["/a", "/b"]);
});

test("each committed add is listed after the commit; its failure rides on the answer and never undoes the add", async () => {
  const workspace = { id: "/h/acme", name: "acme", team: null, path: "/h/acme" };
  const order = [];
  const performAdd = (listed, decision = { ok: true, workspace, action: "replace-server" }) => createPerformAdd({
    generations: createGenerations(), decide: () => decision, realpath: (p) => p, choices: () => ({ choices: [] }), offer: () => null,
    execute: async () => { order.push("commit"); return { ok: true, workspace }; }, added: () => order.push("added"), listed,
  });
  assert.deepEqual(await performAdd(async (ws) => { order.push(`listed ${ws.path}`); return null; })("/h/acme", true), { ok: true, workspace });
  assert.deepEqual(order, ["commit", "added", "listed /h/acme"]);
  const failure = { code: "E_DEPLOYMENTS_BUSY", message: "locked" };
  assert.deepEqual(await performAdd(async () => failure)("/h/acme", true), { ok: true, workspace, listed: failure });
  assert.deepEqual((await performAdd(async () => { throw new Error("bridge"); })("/h/acme", true)).listed, { code: "E_CLI_FAILED", message: "bridge" });
  let asked = 0;
  await performAdd(async () => { asked++; return null; }, { ok: true, workspace, action: "already-advertised" })("/h/acme", true);
  assert.equal(asked, 0, "a workspace that was already open is not an add");
  const failing = createPerformAdd({ generations: createGenerations(), decide: () => ({ ok: true, workspace, action: "replace-server" }), realpath: (p) => p,
    choices: () => ({ choices: [] }), offer: () => null, execute: async () => ({ ok: false, code: "server-timeout", reason: "late" }),
    listed: async () => { asked++; return null; } });
  assert.equal((await failing("/h/acme", true)).code, "server-timeout");
  assert.equal(asked, 0, "an add that did not commit is not listed");
});

/** userData with the Desktop's own files, and the import as main.mjs wires it (the real rename). */
function userData({ recents, open }) {
  const dir = mkdtempSync(join(tmpdir(), "oats-import-"));
  const recentsFile = join(dir, "workspace-recents.json"), openFile = join(dir, "workspace-open.json"), imported = join(dir, "workspace-recents.imported.json");
  if (recents !== undefined) writeFileSync(recentsFile, recents);
  if (open !== undefined) writeFileSync(openFile, open);
  const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  const asked = [];
  const run = (answer) => importDesktopLists({
    readRecents: () => read(recentsFile), readOpen: () => read(openFile),
    importPaths: async (paths) => { asked.push(paths); return answer; },
    retire: () => renameSync(recentsFile, imported),
  });
  return { dir, recentsFile, openFile, imported, asked, run };
}

test("the import: recents ∪ the saved open set, as written, once; the kernel answered, so the recents file is renamed and never read again", async () => {
  const u = userData({ recents: JSON.stringify(["/h/acme", "relative", "/h/gone", "/h/acme/", 7]), open: JSON.stringify(["/h/web", "/h/acme", "/Volumes/x/team"]) });
  try {
    assert.deepEqual(await u.run({ ok: true, value: { imported: true, at: "2026-10-19T10:00:00.000Z", added: [] } }), { status: "imported" });
    assert.deepEqual(u.asked, [["/h/acme", "/h/gone", "/h/acme/", "/h/web", "/Volumes/x/team"]], "every absolute path as written, each once, whatever its state");
    assert.equal(existsSync(u.recentsFile), false);
    assert.equal(readFileSync(u.imported, "utf8"), JSON.stringify(["/h/acme", "relative", "/h/gone", "/h/acme/", 7]), "renamed whole");
    assert.equal(existsSync(u.openFile), true, "the open set is the Desktop's own, kept");
    assert.deepEqual(await u.run({ ok: true, value: { imported: true, at: "x", added: [] } }), { status: "none" });
    assert.equal(u.asked.length, 1, "no recents file: the kernel is not asked again");
  } finally { rmSync(u.dir, { recursive: true, force: true }); }
});

test("the import: an import done before (a crash before the rename) also renames; a refusal or a CLI without the list keeps the file", async () => {
  const again = userData({ recents: "[]" });
  const kept = userData({ recents: "not json", open: JSON.stringify(["/h/web"]) });
  try {
    assert.deepEqual(await again.run({ ok: true, value: { imported: false, at: "2026-10-19T10:00:00.000Z", added: [] } }), { status: "already" });
    assert.deepEqual(again.asked, [[]], "nothing to name is still the import: the kernel sets its marker");
    assert.equal(existsSync(again.imported), true);
    const refused = await kept.run({ ok: false, reason: { code: "E_DEPLOYMENTS_BUSY", message: "locked" } });
    assert.deepEqual(refused, { status: "kept", reason: "locked" });
    assert.deepEqual(kept.asked, [["/h/web"]], "a recents file that is not JSON names nothing; the open set still goes");
    assert.equal(existsSync(kept.recentsFile), true, "kept for the next launch");
    assert.equal((await kept.run({ ok: false, reason: { code: "E_DEPLOYMENTS_FEATURE", message: "no list" } })).status, "kept");
    assert.equal(existsSync(kept.imported), false);
  } finally { rmSync(again.dir, { recursive: true, force: true }); rmSync(kept.dir, { recursive: true, force: true }); }
});

test("the import: a rename that fails keeps the status honest", async () => {
  const u = userData({ recents: "[]" });
  try {
    mkdirSync(u.imported); writeFileSync(join(u.imported, "x"), ""); // a non-empty directory where the rename goes
    const answer = await u.run({ ok: true, value: { imported: true, at: "x", added: [] } });
    assert.equal(answer.status, "kept"); assert.match(answer.reason, /could not be renamed/);
  } finally { rmSync(u.dir, { recursive: true, force: true }); }
});

test("the import names every absolute path as written, a non-canonical one with no twin and more than 200 of them, never cut", async () => {
  const many = Array.from({ length: 203 }, (_, i) => `/h/d${i}`);
  const u = userData({ recents: JSON.stringify(["/Volumes/offline/acme/", "/h/parent/../other", ...many]) });
  try {
    await u.run({ ok: true, value: { imported: true, at: "x", added: [] } });
    assert.deepEqual(u.asked, [["/Volumes/offline/acme/", "/h/parent/../other", ...many]]);
    assert.ok(deploymentListArgv({ action: "import", from: "desktop", paths: u.asked[0] }), "the kernel is asked with all of them");
  } finally { rmSync(u.dir, { recursive: true, force: true }); }
  const tooMany = Array.from({ length: DEPLOYMENT_IMPORT_MAX + 1 }, (_, i) => `/h/d${i}`);
  assert.equal(deploymentListArgv({ action: "import", from: "desktop", paths: tooMany }), null, "past the argv bound the import is refused whole");
  const kept = userData({ recents: JSON.stringify(tooMany) });
  try {
    const answer = await kept.run({ ok: false, reason: { code: "E_BAD_ARGS", message: "The request to this computer's deployments list was not valid." } });
    assert.equal(answer.status, "kept"); assert.equal(existsSync(kept.recentsFile), true, "kept: no marker is set for a subset");
  } finally { rmSync(kept.dir, { recursive: true, force: true }); }
});

test("a committed add is listed once the replacement server's probe has settled, never skipped while it is pending", async () => {
  const probes = [{ ok: false, probedAt: null }, { ok: false, probedAt: null }, { ok: true, bin: "/usr/bin/oats", features: ["deployments-list"], probedAt: 1 }];
  const reads = [], runs = [];
  const read = async () => { reads.push(1); return probes[Math.min(reads.length - 1, probes.length - 1)]; };
  const failure = await listDeployment("/h/acme", { cli: () => settledCli(read, { delay: async () => {} }),
    run: async (cli, options) => { runs.push([cli.bin, options]); return { ok: true, value: { path: "/h/acme", added: true } }; } });
  assert.equal(failure, null);
  assert.equal(reads.length, 3, "read again until the probe settled");
  assert.deepEqual(runs, [["/usr/bin/oats", { action: "add", path: "/h/acme", via: "desktop" }]]);
  const never = await listDeployment("/h/acme", { cli: () => settledCli(async () => ({ ok: false, probedAt: null }), { attempts: 3, delay: async () => {} }), run: assert.fail });
  assert.equal(never.code, "E_CLI_TIMEOUT", "a probe that never settles is a failure the add says, not a silent skip");
  const noList = await listDeployment("/h/acme", { cli: async () => ({ ok: true, probedAt: 1 }), run: async () => ({ ok: false, reason: { code: "E_DEPLOYMENTS_FEATURE", message: "x" } }) });
  const noCli = await listDeployment("/h/acme", { cli: async () => ({ ok: false, probedAt: 1 }), run: async () => ({ ok: false, reason: { code: "E_CLI_UNAVAILABLE", message: "x" } }) });
  assert.deepEqual([noList, noCli], [null, null], "no list to put it on is no failure");
  const busy = await listDeployment("/h/acme", { cli: async () => ({ ok: true, probedAt: 1 }), run: async () => ({ ok: false, reason: { code: "E_DEPLOYMENTS_BUSY", message: "locked" } }) });
  assert.deepEqual(busy, { code: "E_DEPLOYMENTS_BUSY", message: "locked" });
});

/** Two windows, one queue, as main.mjs wires them: the real add executor and performAdd, and a Remove. */
function twoWindows({ kernelRemove }) {
  const queue = createSerialQueue(), log = [];
  let served = [], saved = ["/h/acme"];
  const workspace = { id: "/h/acme", name: "acme", team: null, path: "/h/acme" };
  const execute = createAddExecutor({
    getDirs: () => [...served], commitDirs: (dirs) => { served = dirs; saved = [...new Set([...saved, ...dirs])]; log.push("commit"); },
    replaceServer: async () => {}, refreshAdvertised: async () => true, probeVersion: async () => ({ ok: true }), isCompatible: () => true,
    advertises: async () => true, delay: async () => {}, attempts: 2,
  });
  const add = createPerformAdd({ generations: createGenerations(), decide: () => ({ ok: true, workspace, action: "replace-server" }), realpath: (p) => p,
    choices: () => ({ choices: [] }), offer: () => null, execute: (ws, current) => execute(ws, current),
    listed: async () => { log.push("listed"); return null; }, serial: queue });
  const remove = createRemoveListed({ serial: queue, removable: () => new Set(["/h/acme"]), served: (path) => served.includes(path),
    remove: async (path) => { log.push("remove"); await kernelRemove(); return { ok: true, value: { path, removed: true } }; },
    unsave: (path) => { saved = saved.filter((p) => p !== path); log.push("unsave"); } });
  return { add, remove, log, state: () => ({ served, saved }) };
}

test("Remove and another window's add of the same deployment run one after the other: an add queued first wins, and is never unsaved", async () => {
  const w = twoWindows({ kernelRemove: async () => {} });
  const added = w.add("/h/acme", true, "B"), removed = w.remove("/h/acme", "A");
  assert.equal((await added).ok, true);
  assert.deepEqual(await removed, { ok: false, code: "served", reason: "This deployment is open. It can't be removed from here." }, "checked when it runs, after the add");
  assert.deepEqual(w.log, ["commit", "listed"], "the kernel was never asked to remove it");
  assert.deepEqual(w.state(), { served: ["/h/acme"], saved: ["/h/acme"] });
});

test("an add asked while a Remove is with the kernel waits for it, then serves, saves and lists the deployment again", async () => {
  let release; const gate = new Promise((ok) => { release = ok; });
  const w = twoWindows({ kernelRemove: () => gate });
  const removed = w.remove("/h/acme", "A");
  await new Promise((ok) => setImmediate(ok));
  const added = w.add("/h/acme", true, "B");
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(w.log, ["remove"], "the add has not started");
  release();
  assert.deepEqual(await removed, { ok: true, removed: true });
  assert.equal((await added).ok, true);
  assert.deepEqual(w.log, ["remove", "unsave", "commit", "listed"], "its listing clears the kernel's tombstone");
  assert.deepEqual(w.state(), { served: ["/h/acme"], saved: ["/h/acme"] });
});
