// #1577, the clients' half: which parent→child lines a roster draws (packages/client/related-work.mjs), the order
// under one parent that follows from it, and how the kernel's `sameWork` flag and the gate's answer reach every
// row through the shared readers (deployment-data.mjs, panelInstance, remotePanel, panel-views.mjs
// deploymentPanel). The Desktop's connectors over these rows: packages/desktop/test/related-work-lines.test.mjs.
//
// It imports packages/client only, so it runs on a root-only checkout with nothing installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAME_WORK_FEATURE, sameWorkDeclared, withSameWorkGate, withParentGate, drawsParentLine } from "../packages/client/related-work.mjs";
import { clusterInstances, recencyOrder, rosterGroups, groupRosterFamilies, instanceId } from "../packages/client/instance-tree.mjs";
import { deploymentStatusData, SESSION_ENDS } from "../packages/client/deployment-data.mjs";
import { rosterRows, panelInstances, observedEntry } from "../packages/client/deployment-panel.mjs";
import { remotePanel, remoteWorkspace } from "../packages/client/remote-roster.mjs";
import { deploymentPanel } from "../packages/client/panel-views.mjs";

const AT = "2026-10-27T12:00:00.000Z";
const BASE = ["workspace-v2", "waiting-on-you"];
const cliWith = (...features) => ({ ok: true, bin: "/opt/oats/bin/oats.mjs", features: [...BASE, ...features] });
const PROBE = "server-probe-features";
const groupWith = (probe, instances = []) => ({
  id: "host:build:/remote/project", server: "host", label: "Build server", registrationPresent: true,
  target: { sshHost: "build", workspace: "/remote/project" }, probe, agentsRoot: "/remote/project/agents", workspace: null,
  souls: [{ name: "dev", harness: "claude" }], instances, retireFailures: [],
});
const remoteRow = (name, extra = {}) => ({ server: "host", instance: name, agent: "dev", home: `/remote/project/agents/dev/instances/${name}`,
  agentsRoot: "/remote/project/agents", harness: "claude", tmux: { session: "oats", window: name }, running: true, parentInstance: null, ...extra });

test("the gate: a local row's host is this CLI; a remote row's needs this CLI, its relay of hosts' features and the host's own list", () => {
  assert.equal(SAME_WORK_FEATURE, "instance-same-work");
  assert.equal(sameWorkDeclared(cliWith(SAME_WORK_FEATURE)), true);
  assert.equal(sameWorkDeclared(cliWith()), false, "a CLI without the feature");
  assert.equal(sameWorkDeclared({ ...cliWith(SAME_WORK_FEATURE), ok: false }), false, "a CLI the client cannot use");
  assert.equal(sameWorkDeclared(null), false);
  assert.equal(sameWorkDeclared({ ok: true, features: "instance-same-work" }), false, "only an array lists features");
  const host = groupWith({ ok: true, features: [SAME_WORK_FEATURE] });
  assert.equal(sameWorkDeclared(cliWith(SAME_WORK_FEATURE, PROBE), host), true);
  assert.equal(sameWorkDeclared(cliWith(PROBE), host), false, "this CLI without the feature: no host declares it");
  assert.equal(sameWorkDeclared(cliWith(SAME_WORK_FEATURE), host), false, "this CLI does not relay the hosts' features");
  assert.equal(sameWorkDeclared(cliWith(SAME_WORK_FEATURE, PROBE), groupWith({ ok: true, features: [PROBE] })), false, "the host without it");
  // Unknown is not supported: a failed probe, a host whose list was not relayed (null), a group not read.
  for (const probe of [{ ok: false, error: { message: "unreachable" }, features: [SAME_WORK_FEATURE] }, { ok: true, features: null }, { ok: true }, undefined]) {
    assert.equal(sameWorkDeclared(cliWith(SAME_WORK_FEATURE, PROBE), groupWith(probe)), false, JSON.stringify(probe));
  }
});

test("drawsParentLine: every row draws without the gate; with it, only sameWork === true, and no other value throws", () => {
  for (const sameWork of [true, false, "true", 1, null, undefined, {}, []]) {
    assert.equal(drawsParentLine({ instance: "x", sameWork }), true, `no gate, sameWork ${JSON.stringify(sameWork)}`);
    assert.equal(drawsParentLine({ instance: "x", sameWork, sameWorkKnown: true }), sameWork === true, `gate, sameWork ${JSON.stringify(sameWork)}`);
  }
  assert.equal(drawsParentLine({ instance: "x", sameWork: true, sameWorkKnown: "true" }), true, "only the stamp's true is the gate");
  assert.equal(drawsParentLine({ instance: "x", sameWorkKnown: 1 }), true);
  assert.deepEqual(withSameWorkGate({ instance: "x", sameWorkKnown: true }, false), { instance: "x" }, "a carried stamp is dropped");
  assert.deepEqual(withSameWorkGate({ instance: "x" }, true), { instance: "x", sameWorkKnown: true });
  assert.deepEqual(withParentGate({ instance: "p1" }, { instance: "p", sameWorkKnown: true }), { instance: "p1", sameWorkKnown: true });
  assert.deepEqual(withParentGate({ instance: "p1", sameWorkKnown: true }, null), { instance: "p1" }, "no parent, no stamp");
  assert.deepEqual(withParentGate({ instance: "p1" }, { instance: "p" }), { instance: "p1" });
});

test("deployment-data keeps sameWork only when it is exactly true, and drops anything else silently", () => {
  const status = { root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev", instances: [
    ["dev-a", true], ["dev-b", "true"], ["dev-c", 1], ["dev-d", false], ["dev-e", null], ["dev-f", undefined],
  ].map(([name, sameWork]) => ({ instance: name, home: `/d/agents/dev/instances/${name}`, running: true, ...(sameWork === undefined ? {} : { sameWork }) })) }] };
  const data = deploymentStatusData(status, "/d");
  const rows = data.agents[0].instances;
  assert.deepEqual(rows.map((row) => row.instance), ["dev-a", "dev-b", "dev-c", "dev-d", "dev-e", "dev-f"], "no value fails a row");
  assert.deepEqual(rows.map((row) => Object.hasOwn(row, "sameWork") ? row.sameWork : "absent"), [true, "absent", "absent", "absent", "absent", "absent"]);
  // panelInstance forwards it, true only, and never stamps the gate itself.
  const listed = rosterRows(data, cliWith(SAME_WORK_FEATURE));
  const panel = panelInstances(listed, listed.map(() => ({})));
  assert.deepEqual(panel.filter((row) => row.sameWork === true).map((row) => row.instance), ["dev-a"]);
  assert.ok(panel.every((row) => !Object.hasOwn(row, "sameWorkKnown")));
  const raw = panelInstances([{ ...listed[1], sameWork: "true", sameWorkKnown: true }], [{}]);
  assert.equal(Object.hasOwn(raw[0], "sameWork"), false); assert.equal(Object.hasOwn(raw[0], "sameWorkKnown"), false);
});

test("remotePanel keeps a host's sameWork only when true, and never a host's sameWorkKnown", () => {
  const group = groupWith({ ok: true, features: [SAME_WORK_FEATURE] }, [
    remoteRow("r-a", { sameWork: true }), remoteRow("r-b", { sameWork: "true" }), remoteRow("r-c", { sameWork: 1, sameWorkKnown: true }), remoteRow("r-d"),
  ]);
  const rows = remotePanel(group, AT).instances;
  assert.deepEqual(rows.map((row) => [row.instance, Object.hasOwn(row, "sameWork") ? row.sameWork : "absent", Object.hasOwn(row, "sameWorkKnown")]),
    [["r-a", true, false], ["r-b", "absent", false], ["r-c", "absent", false], ["r-d", "absent", false]]);
});

/** A `held` holding one local deployment `/d` observed with `rows` (kernel rows of soul dev), and `groups`. */
function heldOf(cli, rows, groups = []) {
  const roster = { root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev", instances: rows.map(([name, extra]) => ({
    instance: name, home: `/d/agents/dev/instances/${name}`, running: true, ...extra })) }] };
  const listed = rosterRows(deploymentStatusData(roster, "/d"), cli);
  const entry = observedEntry({ roster, workspaceStatus: { workspace: { name: "d" } }, observedAt: AT }, panelInstances(listed, listed.map(() => ({}))), AT);
  return { ctxs: ["/d"], snapshot: { byWs: new Map([["/d", entry]]) }, remoteGroups: groups, cli, observing: new Set(), remoteCollecting: false, at: AT };
}
const LOCAL_WS = { id: "/d", name: "d" };
const stamps = (panel) => Object.fromEntries(panel.instances.map((row) => [row.instance, [row.sameWork === true, row.sameWorkKnown === true]]));

test("deploymentPanel stamps the gate's answer on every row it serves, local and remote, and only there", () => {
  const local = [["lead", {}], ["dev-a", { parentInstance: "lead", sameWork: true }], ["dev-b", { parentInstance: "lead" }]];
  const declaring = groupWith({ ok: true, features: [SAME_WORK_FEATURE] }, [remoteRow("r-lead"), remoteRow("r-a", { parentInstance: "r-lead", sameWork: true })]);
  const silent = groupWith({ ok: true, features: [] }, [remoteRow("s-lead"), remoteRow("s-a", { parentInstance: "s-lead", sameWork: true })]);
  const failed = groupWith({ ok: false, error: { message: "unreachable" } }, [remoteRow("f-lead"), remoteRow("f-a", { parentInstance: "f-lead", sameWork: true })]);
  const remote = (group) => ({ ...remoteWorkspace(group), group });

  // The CLI without the feature: every row, local and remote, draws today's lines.
  let held = heldOf(cliWith(PROBE), local, [declaring]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS)), { lead: [false, false], "dev-a": [true, false], "dev-b": [false, false] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, false], "r-a": [true, false] });
  assert.ok(deploymentPanel(held, LOCAL_WS).instances.every(drawsParentLine));

  // The CLI with it: the local rows follow the flag; a remote host without it, or whose probe failed, keeps today's lines.
  held = heldOf(cliWith(SAME_WORK_FEATURE, PROBE), local, [declaring, silent, failed]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS)), { lead: [false, true], "dev-a": [true, true], "dev-b": [false, true] });
  assert.deepEqual(Object.fromEntries(deploymentPanel(held, LOCAL_WS).instances.map((row) => [row.instance, drawsParentLine(row)])),
    { "dev-a": true, "dev-b": false, lead: false }, "a root's answer is never read: it has no parent line");
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, true], "r-a": [true, true] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(silent))), { "s-lead": [false, false], "s-a": [true, false] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(failed))), { "f-lead": [false, false], "f-a": [true, false] });

  // Session resume's row field (#1564) travels beside the flag and its stamp: neither reader drops the other.
  held = heldOf(cliWith(SAME_WORK_FEATURE), [["lead", {}], ["dev-a", { parentInstance: "lead", sameWork: true, sessionEnd: SESSION_ENDS.lost }]]);
  const both = deploymentPanel(held, LOCAL_WS).instances.find((row) => row.instance === "dev-a");
  assert.deepEqual([both.sameWork, both.sameWorkKnown, both.sessionEnd], [true, true, SESSION_ENDS.lost]);

  // The CLI with it but not relaying the hosts' features: local rows follow the flag, no remote row does.
  held = heldOf(cliWith(SAME_WORK_FEATURE), local, [declaring]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS))["dev-b"], [false, true]);
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, false], "r-a": [true, false] });
});

// --- The order -------------------------------------------------------------------------

const known = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, sameWorkKnown: true, ...extra });
const order = (clusters) => clusters.map((c) => c.instances.map((i) => [i.instance, i.depth]));
// A mixed parent: flagged a and c, unflagged b, plus a flagged child (x) under an unflagged one (b), and a flagged root.
const MIXED = [
  known("b", { parentInstance: "p" }), known("p"), known("c", { parentInstance: "p", sameWork: true }), known("root", { sameWork: true }),
  known("x", { parentInstance: "b", sameWork: true }), known("a", { parentInstance: "p", sameWork: true }), known("y", { parentInstance: "b" }),
];

test("clusterInstances: under one parent the children that draw come first, by name within each part; roots and clusters keep their order", () => {
  assert.deepEqual(order(clusterInstances(MIXED)), [
    [["p", 0], ["a", 1], ["c", 1], ["b", 1], ["x", 2], ["y", 2]],
    [["root", 0]],
  ]);
  // Without the gate (a host without the feature), today's order: by name.
  const today = MIXED.map(({ sameWorkKnown: _gate, ...row }) => row);
  assert.deepEqual(order(clusterInstances(today)), [[["p", 0], ["a", 1], ["b", 1], ["x", 2], ["y", 2], ["c", 1]], [["root", 0]]]);
  // A flagged row with no resolvable parent is a root like any other.
  const orphan = [known("q"), known("o", { parentInstance: "gone", sameWork: true }), known("n")];
  assert.deepEqual(order(clusterInstances(orphan)), [[["n", 0]], [["o", 0]], [["q", 0]]]);
  // The groups take the order as it is: the cluster is one group, the flagged root one run.
  assert.deepEqual(rosterGroups(MIXED, MIXED).map((g) => [g.label, g.clusters.map((c) => c.instances.map((i) => i.instance))]),
    [["p", [["p", "a", "c", "b", "x", "y"]]], ["independent", [["root"]]]]);
});

test("recencyOrder: the palette keeps the split under a parent, recency deciding inside each part; roots are not split", () => {
  const focus = new Map([["b", 50], ["c", 40], ["a", 30], ["y", 20], ["x", 10]].map(([name, time]) => [instanceId(MIXED.find((i) => i.instance === name)), time]));
  assert.deepEqual(order(recencyOrder(clusterInstances(MIXED), focus)), [
    [["p", 0], ["c", 1], ["a", 1], ["b", 1], ["x", 2], ["y", 2]],
    [["root", 0]],
  ], "c before a (more recent), b after both though focused last; under b, x (flagged) before y (more recent)");
  // Roots: a flagged root and an unflagged one are ordered by recency alone.
  const roots = [known("r1", { sameWork: true }), known("r2"), known("k", { parentInstance: "r2" })];
  const rootFocus = new Map([[instanceId(roots[1]), 9], [instanceId(roots[0]), 1]]);
  assert.deepEqual(order(recencyOrder(clusterInstances(roots), rootFocus)), [[["r2", 0], ["k", 1]], [["r1", 0]]]);
  // The palette's groups go through the same split.
  assert.deepEqual(rosterGroups(MIXED, MIXED, { lastFocus: focus })[0].clusters[0].instances.map((i) => i.instance), ["p", "c", "a", "b", "x", "y"]);
});

test("groupRosterFamilies (no client calls it) orders children the same way", () => {
  const family = groupRosterFamilies(MIXED, "name").get("workspace").get("dev");
  assert.deepEqual(family.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["c", 1], ["b", 1], ["x", 2], ["y", 2], ["root", 0]]);
});
