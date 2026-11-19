// #1237: the one rule that decides a terminal tab's instance is retired (renderer/retired-tabs.mjs). The panels are
// the server's own: the shared views (panelData) over the server's `held`, with Alex's deployments as fixtures
// (helpers/workspace-views-fixture.mjs): local A and B and the devbox remote in the oats view.
import test from "node:test";
import assert from "node:assert/strict";
import * as remote from "../../client/remote-roster.mjs";
import { retiredTabs, tabShowsRow, otherIncarnation, terminalOrigin } from "../renderer/retired-tabs.mjs";
import { terminalKey } from "../renderer/instance-tree-view.mjs";
import { loadViews, identity, observed, row, remoteRow, group, A, B, V_OATS } from "./helpers/workspace-views-fixture.mjs";

const AT = "2026-10-11T12:00:00.000Z";
const T1 = "2026-10-01T00:00:00.000Z", T2 = "2026-10-05T00:00:00.000Z";
const FAR = "/home/alex/oats";
const devbox = (instances, extra = {}) => group("devbox:a1", "devbox", FAR, identity(), instances, extra);

/** The oats view's panel as the server answers it. `a`: A's rows; `aEntry`: A's whole snapshot entry; `far`: devbox's
 * rows; `groupExtra`: devbox's group (its probe); `keptReadAt`: the groups a filtered read kept (#1124). */
function answer({ a = [row(A, "dev-a", { createdAt: T1 })], aEntry = null, far = [remoteRow("far-a", FAR, { createdAt: T1 })], groupExtra = {}, keptReadAt = new Map(), remembered } = {}) {
  const g = devbox(far, groupExtra);
  const byWs = new Map([[A, aEntry ?? observed(A, { reachable: true, ...identity() }, a)], [B, observed(B, { reachable: true, ...identity() }, [row(B, "dev-b")])]]);
  return loadViews({ ctxs: [A, B], snapshot: { byWs }, remoteGroups: [g], keptReadAt, ...(remembered ? { remoteIdentities: remembered } : {}) }).panelData(V_OATS);
}

/** A terminal tab exactly as openTerminalTabInner records it: its key, workspace and the origin of the row it opened. */
const tabOf = (panel, name, workspace = V_OATS) => {
  const opened = panel.instances.find(i => i.instance === name);
  assert.ok(opened, `the row ${name} the tab opened`);
  return { kind: "terminal", workspace, key: terminalKey(workspace, opened), origin: terminalOrigin(opened) };
};
const open = answer();
const tabs = (...entries) => new Map(entries.map((tab, at) => [at + 1, tab]));
const LOCAL = tabOf(open, "dev-a"), REMOTE = tabOf(open, "far-a");

test("the fixture: the oats view holds A, B and devbox, each reached and current; the tabs record their row's facts", () => {
  assert.equal(open.workspace.id, V_OATS);
  assert.deepEqual(open.deployments.map(d => [d.id, d.local, d.reachable, d.stale ?? false]),
    [[A, true, true, false], [B, true, true, false], ["remote:devbox:a1", false, true, false]]);
  assert.deepEqual({ ...LOCAL.origin }, { incarnation: T1, deployment: A, server: null });
  assert.deepEqual({ ...REMOTE.origin }, { incarnation: T1, deployment: "remote:devbox:a1", server: "devbox" });
  assert.deepEqual(retiredTabs(tabs(LOCAL, REMOTE), open), [], "both listed, same incarnation: nothing retired");
});

test("(R) replaced: the same home with another incarnation, local or remote", () => {
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ a: [row(A, "dev-a", { createdAt: T2 })] })), [1]);
  assert.deepEqual(retiredTabs(tabs(REMOTE), answer({ far: [remoteRow("far-a", FAR, { createdAt: T2 })] })), [1]);
});

test("(G) gone on its host: a reached host that no longer lists it (missingRemotely)", () => {
  const gone = remoteRow("far-a", FAR, { createdAt: null, running: null, savedRoute: true, addressable: false, missingRemotely: true });
  const panel = answer({ far: [gone] });
  assert.equal(panel.instances.find(i => i.instance === "far-a").missingRemotely, true);
  assert.deepEqual(retiredTabs(tabs(REMOTE), panel), [1]);
});

test("(A) absent from a good read: a reached, current read of its deployment that does not list it", () => {
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ a: [] })), [1], "local: A observed, not kept");
  assert.deepEqual(retiredTabs(tabs(REMOTE), answer({ far: [] })), [1], "remote: devbox reached, not kept");
  assert.deepEqual(retiredTabs(tabs(LOCAL, REMOTE, tabOf(open, "dev-b")), answer({ a: [], far: [] })), [1, 2], "only the absent ones");
});

test("every tab of the identity: open twice, or in two groups", () => {
  assert.deepEqual(retiredTabs(tabs(LOCAL, { ...LOCAL }, REMOTE), answer({ a: [] })), [1, 2]);
});

test("unreachable is not retired: a failed probe, its last-known rows, and no rows at all", () => {
  const unreached = { probe: { ok: false, error: { code: "E_SSH", message: "ssh to devbox timed out" } } };
  // The held rows marked not reached (remote-roster.mjs unavailableGroups): last-known, serverUnreached.
  const remembered = { all: () => [], get: () => ({ workspace: identity() }), note: () => null };
  const lastKnown = answer({ far: [remoteRow("far-a", FAR, { createdAt: T1, running: null })], groupExtra: unreached, remembered });
  assert.equal(lastKnown.deployments.find(d => d.id === "remote:devbox:a1")?.reachable, false);
  assert.equal(lastKnown.instances.find(i => i.instance === "far-a").serverUnreached, true);
  assert.deepEqual(retiredTabs(tabs(REMOTE), lastKnown), []);
  // Not reached and no rows (a host never read this run): absent, but no read proves it.
  assert.deepEqual(retiredTabs(tabs(REMOTE), answer({ far: [], groupExtra: unreached, remembered })), []);
  // Unreached and its identity unknown: the deployment leaves this view.
  const left = answer({ far: [], groupExtra: unreached });
  assert.equal(left.deployments.some(d => d.id === "remote:devbox:a1"), false);
  assert.deepEqual(retiredTabs(tabs(REMOTE), left), []);
});

test("a kept or stale read proves nothing: a local failed re-read, a remote group a filtered read did not ask", () => {
  const kept = { ...observed(A, { reachable: true, ...identity() }, []), error: "status timed out", errorOrigin: "kernel" };
  const local = answer({ aEntry: kept });
  assert.equal(local.deployments.find(d => d.id === A).stale, true);
  assert.equal(local.error, "status timed out", "the primary's kept failure");
  assert.deepEqual(retiredTabs(tabs(LOCAL), local), []);
  const filtered = answer({ far: [], keptReadAt: new Map([["devbox:a1", AT]]) });
  assert.equal(filtered.deployments.find(d => d.id === "remote:devbox:a1").stale, true);
  assert.deepEqual(retiredTabs(tabs(REMOTE), filtered), []);
});

test("pending, unavailable or no data yet proves nothing", () => {
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ aEntry: { deployment: { status: "pending" }, instances: [] } })), []);
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ aEntry: { deployment: { status: "unavailable", reason: { code: "E_CLI_FAILED", message: "boom" } }, instances: [] } })), []);
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ aEntry: undefined })), [], "no snapshot of A at all");
  for (const panel of [null, undefined, {}, { workspace: { id: V_OATS } }, { workspace: null, instances: [] }]) assert.deepEqual(retiredTabs(tabs(LOCAL), panel), []);
});

test("a deployment the answer does not carry, or one the tab never recorded, proves nothing", () => {
  const moved = { ...LOCAL, origin: terminalOrigin({ createdAt: T1, deployment: { id: "/Users/alex/elsewhere" } }) };
  assert.deepEqual(retiredTabs(tabs(moved), answer({ a: [] })), [], "not in this view's deployments");
  const unknown = { ...LOCAL, origin: terminalOrigin({ createdAt: T1 }) };
  assert.deepEqual(retiredTabs(tabs(unknown), answer({ a: [] })), [], "a row without a deployment tag (an older server)");
  const wrongKind = { ...REMOTE, origin: terminalOrigin({ createdAt: T1, deployment: { id: A }, server: "devbox" }) };
  assert.deepEqual(retiredTabs(tabs(wrongKind), answer({ a: [], far: [] })), [], "a remote tab is never judged by a local read");
});

test("still listed is never retired: stopped, retire pending, rollback incomplete, not addressable, retiring in any state (#1247)", () => {
  const retire = state => ({ retire: { state, since: T2, self: true, ...(state === "failed" ? { code: "E_RETIRE_HOOK", message: "the hook exited 1" } : {}) } });
  // A row reading Retiring… (the kernel's retire, or this window's own in flight) keeps its tab until (R), (G) or (A).
  for (const extra of [{ running: false }, { retirePending: true }, { rollbackIncomplete: true }, { retireInFlight: true },
    retire("running"), retire("unknown"), retire("failed"), retire("interrupted"), { retireInFlight: true, running: false, ...retire("running") }]) {
    assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ a: [row(A, "dev-a", { createdAt: T1, ...extra })] })), [], JSON.stringify(extra));
  }
  assert.deepEqual(retiredTabs(tabs(REMOTE), answer({ far: [remoteRow("far-a", FAR, { createdAt: T1, addressable: false })] })), [], "addressable: false");
});

test("a null incarnation on either side is no evidence of (R); (G) and (A) still apply", () => {
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ a: [row(A, "dev-a", { createdAt: null })] })), [], "the row's");
  const unborn = { ...LOCAL, origin: terminalOrigin({ deployment: { id: A } }) };
  assert.deepEqual(retiredTabs(tabs(unborn), answer({ a: [row(A, "dev-a", { createdAt: T2 })] })), [], "the tab's");
  const unbornRemote = { ...REMOTE, origin: terminalOrigin({ deployment: { id: "remote:devbox:a1" }, server: "devbox" }) };
  assert.deepEqual(retiredTabs(tabs(unbornRemote), answer({ far: [remoteRow("far-a", FAR, { createdAt: null, missingRemotely: true, addressable: false })] })), [1], "(G)");
  assert.deepEqual(retiredTabs(tabs(unborn), answer({ a: [] })), [1], "(A)");
});

test("identity is the workspace and the home: another workspace's tab, and a same-named instance of another home", () => {
  assert.deepEqual(retiredTabs(tabs({ ...LOCAL, workspace: "ws:other" }), answer({ a: [row(A, "dev-a", { createdAt: T2 })] })), [],
    "a tab of a workspace that is not this answer's is not judged");
  const twin = row(A, "dev-a", { home: `${A}/agents/other/instances/dev-a`, agentsRoot: `${A}/agents`, createdAt: T2 });
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ a: [row(A, "dev-a", { createdAt: T1 }), twin] })), [], "the twin is another instance");
});

test("tabShowsRow: the key and the incarnation; otherIncarnation: only two known, different values", () => {
  const listed = open.instances.find(i => i.instance === "dev-a");
  assert.equal(tabShowsRow(LOCAL, V_OATS, listed), true);
  assert.equal(tabShowsRow(LOCAL, V_OATS, { ...listed, createdAt: T2 }), false, "a respawn is another row");
  assert.equal(tabShowsRow(LOCAL, V_OATS, { ...listed, createdAt: null }), true);
  assert.equal(tabShowsRow({ ...LOCAL, origin: undefined }, V_OATS, listed), true, "a tab opened before it recorded one");
  assert.equal(tabShowsRow({ ...LOCAL, kind: "file" }, V_OATS, listed), false);
  assert.equal(tabShowsRow(LOCAL, "ws:other", listed), false);
  assert.equal(otherIncarnation(T1, T2), true);
  for (const [a, b] of [[T1, T1], [T1, null], [null, T2], [undefined, T2], ["", T2], [T1, 5]]) assert.equal(otherIncarnation(a, b), false, `${a} ${b}`);
  assert.equal(Object.isFrozen(terminalOrigin({})), true, "recorded once");
});

test("a row's own evidence counts only from a current read of its deployment: held rows keep their last-read facts", () => {
  const unreached = { probe: { ok: false, error: { code: "E_SSH", message: "ssh to devbox timed out" } } };
  const remembered = { all: () => [], get: () => ({ workspace: identity() }), note: () => null };
  // The roster learned T2 (or that the host no longer lists it), then the next probe failed: the held group
  // (remote-roster.mjs unavailableGroups) keeps createdAt and missingRemotely, serverUnreached, reachable false.
  const held = rows => remote.unavailableGroups([devbox(rows)], { code: "E_SSH", message: "ssh to devbox timed out" })[0];
  const respawned = remoteRow("far-a", FAR, { createdAt: T2 });
  const gone = remoteRow("far-a", FAR, { createdAt: null, running: null, savedRoute: true, addressable: false, missingRemotely: true });
  for (const [what, rows] of [["another incarnation", [respawned]], ["missingRemotely", [gone]]]) {
    const panel = answer({ far: held(rows).instances, groupExtra: unreached, remembered });
    const row = panel.instances.find(i => i.instance === "far-a");
    assert.equal(row.serverUnreached, true); assert.equal(panel.error, undefined, "the primary read fine");
    assert.equal(panel.deployments.find(d => d.id === "remote:devbox:a1").reachable, false);
    assert.deepEqual(retiredTabs(tabs(REMOTE), panel), [], `unreached, ${what}`);
    // A group a filtered read did not ask (#1124): reached when it was read, stale now.
    const filtered = answer({ far: rows, keptReadAt: new Map([["devbox:a1", AT]]) });
    assert.equal(filtered.deployments.find(d => d.id === "remote:devbox:a1").stale, true);
    assert.deepEqual(retiredTabs(tabs(REMOTE), filtered), [], `kept by a filtered read, ${what}`);
  }
  // A local deployment whose re-read failed keeps its last observation: its rows prove nothing either.
  const kept = { ...observed(A, { reachable: true, ...identity() }, [row(A, "dev-a", { createdAt: T2 })]), error: "status timed out" };
  assert.deepEqual(retiredTabs(tabs(LOCAL), answer({ aEntry: kept })), [], "kept local read, another incarnation");
  // The same facts from a current read do close it (the positives above), whichever deployment is primary.
  assert.deepEqual(retiredTabs(tabs(REMOTE), answer({ far: [respawned] })), [1]);
});
