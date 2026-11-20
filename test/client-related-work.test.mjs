// The related-work lines, the clients' half: which lines a roster draws (packages/client/related-work.mjs: no flag,
// no line), the order under one parent that follows from it, and how the kernel's `relatedWork` (and an older
// host's `sameWork`) flag and the gate's answer reach every row through the shared readers (deployment-data.mjs,
// panelInstance, remotePanel, panel-views.mjs deploymentPanel). The Desktop's connectors over these rows: packages/desktop/test/related-work-lines.test.mjs.
//
// It imports packages/client only, so it runs on a root-only checkout with nothing installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RELATED_WORK_FEATURE, SAME_WORK_FEATURE, relatedWorkDeclared, withRelatedWorkGate, withParentGate, drawsParentLine, drawsSiblingLink, relatedWork } from "../packages/client/related-work.mjs";
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

test("the gate: a local row's host is this CLI; a remote row's is the lesser of this CLI's relay and the host's own list", () => {
  assert.equal(RELATED_WORK_FEATURE, "instance-related-work");
  assert.equal(SAME_WORK_FEATURE, "instance-same-work");
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE)), RELATED_WORK_FEATURE);
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE, SAME_WORK_FEATURE)), RELATED_WORK_FEATURE, "the newer wins");
  assert.equal(relatedWorkDeclared(cliWith(SAME_WORK_FEATURE)), SAME_WORK_FEATURE, "an older CLI");
  assert.equal(relatedWorkDeclared(cliWith()), null, "a CLI with neither");
  assert.equal(relatedWorkDeclared({ ...cliWith(RELATED_WORK_FEATURE), ok: false }), null, "a CLI the client cannot use");
  assert.equal(relatedWorkDeclared(null), null);
  assert.equal(relatedWorkDeclared({ ok: true, features: "instance-related-work" }), null, "only an array lists features");
  const hostWith = (...features) => groupWith({ ok: true, features });
  // This CLI relays the hosts' lists; the host's answer is the lesser of the two.
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE, PROBE), hostWith(RELATED_WORK_FEATURE)), RELATED_WORK_FEATURE);
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE, PROBE), hostWith(SAME_WORK_FEATURE)), SAME_WORK_FEATURE, "an older host");
  assert.equal(relatedWorkDeclared(cliWith(SAME_WORK_FEATURE, PROBE), hostWith(RELATED_WORK_FEATURE)), SAME_WORK_FEATURE,
    "an older CLI relays only sameWork, whatever the host knows");
  assert.equal(relatedWorkDeclared(cliWith(SAME_WORK_FEATURE, PROBE), hostWith(SAME_WORK_FEATURE)), SAME_WORK_FEATURE);
  assert.equal(relatedWorkDeclared(cliWith(PROBE), hostWith(RELATED_WORK_FEATURE)), null, "this CLI with neither: no host declares one");
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE), hostWith(RELATED_WORK_FEATURE)), null, "this CLI does not relay the hosts' features");
  assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE, PROBE), hostWith(PROBE)), null, "the host with neither");
  // Unknown is not supported: a failed probe, a host whose list was not relayed (null), a group not read.
  for (const probe of [{ ok: false, error: { message: "unreachable" }, features: [RELATED_WORK_FEATURE] }, { ok: true, features: null }, { ok: true }, undefined]) {
    assert.equal(relatedWorkDeclared(cliWith(RELATED_WORK_FEATURE, PROBE), groupWith(probe)), null, JSON.stringify(probe));
  }
});

test("drawsParentLine: no flag, no line; with the new feature relatedWork === true, with the older one sameWork === true", () => {
  const values = [true, false, "true", 1, null, undefined, {}, []];
  for (const flag of values) {
    const child = { instance: "x", parentInstance: "p" };
    assert.equal(drawsParentLine({ ...child, relatedWork: flag, sameWork: flag }), false, `no gate, flags ${JSON.stringify(flag)}`);
    assert.equal(drawsParentLine({ ...child, relatedWork: flag, relatedWorkKnown: RELATED_WORK_FEATURE }), flag === true, `new gate, relatedWork ${JSON.stringify(flag)}`);
    assert.equal(drawsParentLine({ ...child, sameWork: flag, relatedWorkKnown: RELATED_WORK_FEATURE }), false, `new gate reads no sameWork ${JSON.stringify(flag)}`);
    assert.equal(drawsParentLine({ ...child, sameWork: flag, relatedWorkKnown: SAME_WORK_FEATURE }), flag === true, `older gate, sameWork ${JSON.stringify(flag)}`);
    assert.equal(drawsParentLine({ ...child, relatedWork: flag, relatedWorkKnown: SAME_WORK_FEATURE }), flag === true,
      `older gate, relatedWork as a relaying CLI sends it ${JSON.stringify(flag)}`);
  }
  for (const gate of [true, "true", 1, "instance-pin", {}]) {
    assert.equal(drawsParentLine({ instance: "x", parentInstance: "p", relatedWork: true, sameWork: true, relatedWorkKnown: gate }), false, `stamp ${JSON.stringify(gate)} is no gate`);
  }
  // A row with no parent has no parent line, whatever it carries.
  for (const gate of [RELATED_WORK_FEATURE, SAME_WORK_FEATURE]) {
    for (const parentInstance of [undefined, null, "", 7]) {
      assert.equal(drawsParentLine({ instance: "x", parentInstance, relatedWork: true, sameWork: true, relatedWorkKnown: gate }), false, `${gate} ${JSON.stringify(parentInstance)}`);
    }
  }
});

test("drawsSiblingLink: only a top-level row with relatedWork === true on a host that declares instance-related-work", () => {
  for (const flag of [true, false, "true", 1, null, undefined, {}]) {
    assert.equal(drawsSiblingLink({ instance: "s", siblingInstance: "r", relatedWork: flag, relatedWorkKnown: RELATED_WORK_FEATURE }), flag === true, JSON.stringify(flag));
  }
  assert.equal(drawsSiblingLink({ instance: "s", siblingInstance: "r", relatedWork: true }), false, "no gate");
  assert.equal(drawsSiblingLink({ instance: "s", siblingInstance: "r", relatedWork: true, sameWork: true, relatedWorkKnown: SAME_WORK_FEATURE }), false, "an older host joins no sibling");
  assert.equal(drawsSiblingLink({ instance: "s", parentInstance: "p", relatedWork: true, relatedWorkKnown: RELATED_WORK_FEATURE }), false,
    "a row with a parent: its flag is bound to the parent");
  assert.equal(relatedWork({ instance: "s", siblingInstance: "r", relatedWork: true, relatedWorkKnown: RELATED_WORK_FEATURE }), true);
  assert.equal(relatedWork({ instance: "c", parentInstance: "p", sameWork: true, relatedWorkKnown: SAME_WORK_FEATURE }), true);
  assert.equal(relatedWork({ instance: "c", parentInstance: "p", sameWork: true }), false);
});

test("the stamp: whatever a row carries under it is dropped first; only a feature's name is stamped; a pending row takes its parent's", () => {
  assert.deepEqual(withRelatedWorkGate({ instance: "x", relatedWorkKnown: RELATED_WORK_FEATURE }, null), { instance: "x" }, "a carried stamp is dropped");
  assert.deepEqual(withRelatedWorkGate({ instance: "x", relatedWorkKnown: SAME_WORK_FEATURE }, RELATED_WORK_FEATURE), { instance: "x", relatedWorkKnown: RELATED_WORK_FEATURE });
  assert.deepEqual(withRelatedWorkGate({ instance: "x" }, SAME_WORK_FEATURE), { instance: "x", relatedWorkKnown: SAME_WORK_FEATURE });
  for (const declared of [true, "instance-pin", 1, undefined]) assert.deepEqual(withRelatedWorkGate({ instance: "x" }, declared), { instance: "x" }, JSON.stringify(declared));
  assert.deepEqual(withParentGate({ instance: "p1" }, { instance: "p", relatedWorkKnown: RELATED_WORK_FEATURE }), { instance: "p1", relatedWorkKnown: RELATED_WORK_FEATURE });
  assert.deepEqual(withParentGate({ instance: "p1", relatedWorkKnown: RELATED_WORK_FEATURE }, null), { instance: "p1" }, "no parent, no stamp");
  assert.deepEqual(withParentGate({ instance: "p1" }, { instance: "p" }), { instance: "p1" });
  assert.equal(drawsParentLine(withParentGate({ instance: "p1", parentInstance: "p" }, { instance: "p", relatedWorkKnown: RELATED_WORK_FEATURE })), false,
    "a pending row carries no flag: no line");
});

test("deployment-data keeps relatedWork and sameWork only when exactly true, and drops anything else silently", () => {
  const status = { root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev", instances: [
    ["dev-a", true], ["dev-b", "true"], ["dev-c", 1], ["dev-d", false], ["dev-e", null], ["dev-f", undefined],
  ].map(([name, flag]) => ({ instance: name, home: `/d/agents/dev/instances/${name}`, running: true, ...(flag === undefined ? {} : { relatedWork: flag, sameWork: flag }) })) }] };
  const data = deploymentStatusData(status, "/d");
  const rows = data.agents[0].instances;
  assert.deepEqual(rows.map((row) => row.instance), ["dev-a", "dev-b", "dev-c", "dev-d", "dev-e", "dev-f"], "no value fails a row");
  for (const key of ["relatedWork", "sameWork"]) {
    assert.deepEqual(rows.map((row) => Object.hasOwn(row, key) ? row[key] : "absent"), [true, "absent", "absent", "absent", "absent", "absent"], key);
  }
  // panelInstance forwards them, true only, and never stamps the gate itself.
  const listed = rosterRows(data, cliWith(RELATED_WORK_FEATURE));
  const panel = panelInstances(listed, listed.map(() => ({})));
  assert.deepEqual(panel.filter((row) => row.relatedWork === true).map((row) => row.instance), ["dev-a"]);
  assert.deepEqual(panel.filter((row) => row.sameWork === true).map((row) => row.instance), ["dev-a"]);
  assert.ok(panel.every((row) => !Object.hasOwn(row, "relatedWorkKnown")));
  const raw = panelInstances([{ ...listed[1], relatedWork: "true", sameWork: "true", relatedWorkKnown: RELATED_WORK_FEATURE }], [{}]);
  for (const key of ["relatedWork", "sameWork", "relatedWorkKnown"]) assert.equal(Object.hasOwn(raw[0], key), false, key);
});

test("remotePanel keeps a host's relatedWork and sameWork only when true, and never a host's relatedWorkKnown", () => {
  const group = groupWith({ ok: true, features: [RELATED_WORK_FEATURE] }, [
    remoteRow("r-a", { relatedWork: true }), remoteRow("r-b", { relatedWork: "true" }), remoteRow("r-c", { relatedWork: 1, relatedWorkKnown: RELATED_WORK_FEATURE }),
    remoteRow("r-d"), remoteRow("r-e", { sameWork: true }), remoteRow("r-f", { sameWork: "true", relatedWorkKnown: SAME_WORK_FEATURE }),
  ]);
  const rows = remotePanel(group, AT).instances;
  const has = (row, key) => (Object.hasOwn(row, key) ? row[key] : "absent");
  assert.deepEqual(rows.map((row) => [row.instance, has(row, "relatedWork"), has(row, "sameWork"), Object.hasOwn(row, "relatedWorkKnown")]), [
    ["r-a", true, "absent", false], ["r-b", "absent", "absent", false], ["r-c", "absent", "absent", false],
    ["r-d", "absent", "absent", false], ["r-e", "absent", true, false], ["r-f", "absent", "absent", false],
  ]);
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
/** Each served row: [relatedWork === true, sameWork === true, its stamp or null]. */
const stamps = (panel) => Object.fromEntries(panel.instances.map((row) => [row.instance, [row.relatedWork === true, row.sameWork === true, row.relatedWorkKnown ?? null]]));
const R = RELATED_WORK_FEATURE, S = SAME_WORK_FEATURE;

test("deploymentPanel stamps the gate's answer on every row it serves, local and remote, and only there", () => {
  const local = [["lead", {}], ["dev-a", { parentInstance: "lead", relatedWork: true }], ["dev-b", { parentInstance: "lead" }]];
  const declaring = groupWith({ ok: true, features: [R] }, [remoteRow("r-lead"), remoteRow("r-a", { parentInstance: "r-lead", relatedWork: true })]);
  // An older host, as a CLI with instance-related-work relays it: its sameWork arrives as relatedWork.
  const older = groupWith({ ok: true, features: [S] }, [remoteRow("o-lead"), remoteRow("o-a", { parentInstance: "o-lead", relatedWork: true })]);
  const silent = groupWith({ ok: true, features: [] }, [remoteRow("s-lead"), remoteRow("s-a", { parentInstance: "s-lead", relatedWork: true })]);
  const failed = groupWith({ ok: false, error: { message: "unreachable" } }, [remoteRow("f-lead"), remoteRow("f-a", { parentInstance: "f-lead", relatedWork: true })]);
  const remote = (group) => ({ ...remoteWorkspace(group), group });
  const drawn = (panel) => Object.fromEntries(panel.instances.map((row) => [row.instance, drawsParentLine(row)]));

  // The CLI with neither feature: no row is stamped, and no row draws a line, local or remote.
  let held = heldOf(cliWith(PROBE), local, [declaring]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS)), { lead: [false, false, null], "dev-a": [true, false, null], "dev-b": [false, false, null] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, false, null], "r-a": [true, false, null] });
  assert.ok(deploymentPanel(held, LOCAL_WS).instances.every((row) => !drawsParentLine(row)), "no flag read, no line");

  // The CLI with instance-related-work: the local rows follow the flag; each remote host by the lesser gate.
  held = heldOf(cliWith(R, PROBE), local, [declaring, older, silent, failed]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS)), { lead: [false, false, R], "dev-a": [true, false, R], "dev-b": [false, false, R] });
  assert.deepEqual(drawn(deploymentPanel(held, LOCAL_WS)), { "dev-a": true, "dev-b": false, lead: false }, "a root has no parent line");
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, false, R], "r-a": [true, false, R] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(older))), { "o-lead": [false, false, S], "o-a": [true, false, S] });
  assert.deepEqual(drawn(deploymentPanel(held, remote(older))), { "o-lead": false, "o-a": true }, "an older host's child, relayed as relatedWork, draws");
  assert.deepEqual(stamps(deploymentPanel(held, remote(silent))), { "s-lead": [false, false, null], "s-a": [true, false, null] });
  assert.deepEqual(stamps(deploymentPanel(held, remote(failed))), { "f-lead": [false, false, null], "f-a": [true, false, null] });
  assert.ok([silent, failed].every((group) => deploymentPanel(held, remote(group)).instances.every((row) => !drawsParentLine(row))));

  // An older CLI (instance-same-work only): its rows' sameWork, and any host it relays from at the older gate.
  const oldLocal = [["lead", {}], ["dev-a", { parentInstance: "lead", sameWork: true }], ["dev-b", { parentInstance: "lead" }]];
  held = heldOf(cliWith(S, PROBE), oldLocal, [declaring]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS)), { lead: [false, false, S], "dev-a": [false, true, S], "dev-b": [false, false, S] });
  assert.deepEqual(drawn(deploymentPanel(held, LOCAL_WS)), { "dev-a": true, "dev-b": false, lead: false });
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring)))["r-a"], [true, false, S]);

  // Session resume's row field (#1564) travels beside the flag and its stamp: neither reader drops the other.
  held = heldOf(cliWith(R), [["lead", {}], ["dev-a", { parentInstance: "lead", relatedWork: true, sessionEnd: SESSION_ENDS.lost }]]);
  const both = deploymentPanel(held, LOCAL_WS).instances.find((row) => row.instance === "dev-a");
  assert.deepEqual([both.relatedWork, both.relatedWorkKnown, both.sessionEnd], [true, R, SESSION_ENDS.lost]);

  // The CLI with it but not relaying the hosts' features: local rows follow the flag, no remote row does.
  held = heldOf(cliWith(R), local, [declaring]);
  assert.deepEqual(stamps(deploymentPanel(held, LOCAL_WS))["dev-b"], [false, false, R]);
  assert.deepEqual(stamps(deploymentPanel(held, remote(declaring))), { "r-lead": [false, false, null], "r-a": [true, false, null] });
});

// --- The order -------------------------------------------------------------------------

const known = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, relatedWorkKnown: RELATED_WORK_FEATURE, ...extra });
const order = (clusters) => clusters.map((c) => c.instances.map((i) => [i.instance, i.depth]));
// A mixed parent: related a and c, unrelated b, plus a related child (x) under an unrelated one (b), and a flagged root.
const MIXED = [
  known("b", { parentInstance: "p" }), known("p"), known("c", { parentInstance: "p", relatedWork: true }), known("root", { relatedWork: true }),
  known("x", { parentInstance: "b", relatedWork: true }), known("a", { parentInstance: "p", relatedWork: true }), known("y", { parentInstance: "b" }),
];
/** The same rows from an older host: its flag is sameWork, and its gate the older feature. */
const OLDER = MIXED.map(({ relatedWork, ...row }) => ({ ...row, relatedWorkKnown: SAME_WORK_FEATURE, ...(relatedWork ? { sameWork: true } : {}) }));

test("clusterInstances: under one parent the children that draw come first, by name within each part; roots and clusters keep their order", () => {
  const split = [
    [["p", 0], ["a", 1], ["c", 1], ["b", 1], ["x", 2], ["y", 2]],
    [["root", 0]],
  ];
  assert.deepEqual(order(clusterInstances(MIXED)), split);
  assert.deepEqual(order(clusterInstances(OLDER)), split, "an older host's sameWork splits the same way");
  // Without the gate (a host with neither feature), no row draws: the order is by name, as it was.
  const today = MIXED.map(({ relatedWorkKnown: _gate, ...row }) => row);
  assert.deepEqual(order(clusterInstances(today)), [[["p", 0], ["a", 1], ["b", 1], ["x", 2], ["y", 2], ["c", 1]], [["root", 0]]]);
  // A flagged row with no resolvable parent is a root like any other.
  const orphan = [known("q"), known("o", { parentInstance: "gone", relatedWork: true }), known("n")];
  assert.deepEqual(order(clusterInstances(orphan)), [[["n", 0]], [["o", 0]], [["q", 0]]]);
  // The groups take the order as it is: the cluster is one group, the flagged root one run.
  assert.deepEqual(rosterGroups(MIXED, MIXED).map((g) => [g.label, g.clusters.map((c) => c.instances.map((i) => i.instance))]),
    [["p", [["p", "a", "c", "b", "x", "y"]]], ["independent", [["root"]]]]);
  // A related sibling link moves no root (the lead's choice B): a bundle's roots keep the roster's order, newest first.
  const t = (n) => `2026-11-20T10:0${n}:00.000Z`;
  const bundle = [known("R", { createdAt: t(1) }), known("s2", { siblingInstance: "R", createdAt: t(2) }), known("s3", { siblingInstance: "R", relatedWork: true, createdAt: t(3) })];
  const plainBundle = bundle.map(({ relatedWork: _flag, ...row }) => row);
  assert.deepEqual(order(clusterInstances(bundle)), [[["s3", 0], ["s2", 0], ["R", 0]]]);
  assert.deepEqual(order(clusterInstances(plainBundle)), order(clusterInstances(bundle)));
});

test("recencyOrder: the palette keeps the split under a parent, recency deciding inside each part; roots are not split", () => {
  const focus = new Map([["b", 50], ["c", 40], ["a", 30], ["y", 20], ["x", 10]].map(([name, time]) => [instanceId(MIXED.find((i) => i.instance === name)), time]));
  assert.deepEqual(order(recencyOrder(clusterInstances(MIXED), focus)), [
    [["p", 0], ["c", 1], ["a", 1], ["b", 1], ["x", 2], ["y", 2]],
    [["root", 0]],
  ], "c before a (more recent), b after both though focused last; under b, x (related) before y (more recent)");
  // Roots: a flagged root and an unflagged one are ordered by recency alone.
  const roots = [known("r1", { relatedWork: true }), known("r2"), known("k", { parentInstance: "r2" })];
  const rootFocus = new Map([[instanceId(roots[1]), 9], [instanceId(roots[0]), 1]]);
  assert.deepEqual(order(recencyOrder(clusterInstances(roots), rootFocus)), [[["r2", 0], ["k", 1]], [["r1", 0]]]);
  // The palette's groups go through the same split.
  assert.deepEqual(rosterGroups(MIXED, MIXED, { lastFocus: focus })[0].clusters[0].instances.map((i) => i.instance), ["p", "c", "a", "b", "x", "y"]);
  // An older host's rows split the same way.
  assert.deepEqual(order(recencyOrder(clusterInstances(OLDER), focus))[0].map(([name]) => name), ["p", "c", "a", "b", "x", "y"]);
});

test("groupRosterFamilies (no client calls it) orders children the same way", () => {
  const family = groupRosterFamilies(MIXED, "name").get("workspace").get("dev");
  assert.deepEqual(family.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["c", 1], ["b", 1], ["x", 2], ["y", 2], ["root", 0]]);
});
