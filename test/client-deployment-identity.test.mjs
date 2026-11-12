// A listed deployment's workspace identity, read before a client serves it (#482): the shared read
// (packages/client/deployment-identity.mjs) and what the views make of its answers (panel-views.mjs:
// `held.learned` in deploymentInfo, listedInfo and listedViews, with buildViews' own rule underneath).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliDeploymentIdentity, identityReadable, identityTimedOut } from "../packages/client/deployment-identity.mjs";
import { deploymentInfo, deployments, listedInfo, listedViews, viewModel } from "../packages/client/panel-views.mjs";
import { observedEntry, pendingEntry } from "../packages/client/deployment-panel.mjs";
import { viewId } from "../packages/client/workspace-views.mjs";
import { clientTerms } from "../packages/client/client-terms.mjs";

const TERMS = clientTerms({ name: "oats tui", self: "oats tui", selfInitial: "oats tui", update: "OATS", thisMachine: "This machine" });
const CLI = Object.freeze({ ok: true, bin: "/opt/oats/bin/oats.mjs", version: "0.66.0", workspaceApi: 2,
  features: Object.freeze(["workspace-v2", "instance-modules", "served-identity", "packages-no-approval", "workspace-identity", "observe-max-age"]) });
const OATS = Object.freeze({ key: "github.com/awebai/oats", ref: "main", keyFrom: "workspace", standalone: false, defaultTeam: { label: "eng", team: "t-oats" }, teams: { eng: "t-oats" }, teamsFrom: "observed" });
const LAB = Object.freeze({ ...OATS, key: "github.com/example-org/lab-oats-workspace", defaultTeam: { label: "eng", team: "t-lab" }, teams: { eng: "t-lab" } });
const HERE = "/home/u/OATS", LAB_PATH = "/home/u/Work/lab", AT = "2026-10-20T10:00:00.000Z";

/** A `status --json` document of deployment `dir` reporting `identity`. */
const statusOf = (dir, identity) => ({ root: `${dir}/agents`, agents: [], workspace: { reachable: true, ...identity } });
/** An exec that answers `document` (or fails as `error`), recording what it ran. */
function execAnswering(document, { error = null, calls = [] } = {}) {
  const exec = (bin, argv, options, callback) => { calls.push({ bin, argv, options }); setImmediate(() => callback(error, document === null ? "" : JSON.stringify(document), "")); };
  return { exec, calls };
}
/** What a client holds: one observed deployment of this machine and the remote groups given. */
function held({ learned = new Map(), groups = [], ctxs = [HERE], entries = null } = {}) {
  const byWs = entries ?? new Map([[HERE, observedEntry({ roster: statusOf(HERE, OATS), workspaceStatus: { workspace: { name: "oats" } }, observedAt: AT }, [], AT)]]);
  return { ctxs, snapshot: { byWs }, remoteGroups: groups, remembered: { get: () => null, note: () => null, all: () => [] }, rosterAnswered: true, rosterFailure: null,
    cli: { ...CLI, remote: ["roster"] }, observing: new Set(), remoteCollecting: false, home: "/home/u", at: AT, learned };
}
/** A reached remote group reporting `identity`. */
const group = (id, label, identity) => ({ id, server: "builder", label, registrationPresent: true, target: { workspace: "/home/dev/x", sshHost: "builder" }, probe: { ok: true }, workspace: identity, agentsRoot: "/home/dev/x/agents", souls: [], instances: [] });

test("cliDeploymentIdentity reads `oats status --dir <path> [--max-age N] --json` in the deployment and answers its projected workspace object", async () => {
  const { exec, calls } = execAnswering(statusOf(LAB_PATH, LAB));
  const answer = await cliDeploymentIdentity(CLI, LAB_PATH, { maxAge: 60 }, { exec, env: {} });
  assert.deepEqual(calls.map((c) => [c.bin, c.argv, c.options.cwd, c.options.timeout]), [[CLI.bin, ["status", "--dir", LAB_PATH, "--max-age", "60", "--json"], LAB_PATH, 30_000]]);
  assert.equal(answer.ok, true);
  assert.deepEqual([answer.workspace.key, answer.workspace.reachable, answer.workspace.defaultTeam], [LAB.key, true, LAB.defaultTeam]);
});

test("cliDeploymentIdentity answers every failure as a reason, never a rejection: the kernel's refusal, a timeout, garbage, another deployment's answer, a throwing exec, a CLI without the deployment features", async () => {
  const refusal = { schemaVersion: 1, ok: false, error: { code: "E_NO_DEPLOYMENT", message: "not a deployment" } };
  assert.deepEqual(await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: execAnswering(refusal, { error: Object.assign(new Error("exit 1"), { code: 1 }) }).exec }), { ok: false, reason: { code: "E_NO_DEPLOYMENT", message: "not a deployment", origin: "kernel" } });
  assert.equal((await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: execAnswering(null, { error: Object.assign(new Error("killed"), { killed: true }) }).exec })).reason.code, "E_CLI_TIMEOUT");
  assert.equal((await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: execAnswering("not json").exec })).reason.code, "E_CLI_PROTOCOL");
  assert.equal((await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: execAnswering(statusOf("/somewhere/else", LAB)).exec })).reason.code, "E_DEPLOYMENT_SCOPE");
  assert.equal((await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: () => { throw new Error("no"); } })).reason.code, "E_CLI_FAILED");
  assert.equal((await cliDeploymentIdentity({ ...CLI, features: ["workspace-v2"] }, LAB_PATH, {}, { exec: () => assert.fail("ran") })).reason.code, "E_DEPLOYMENT_FEATURE");
  // An answer with no workspace object is read, and reports none.
  assert.deepEqual(await cliDeploymentIdentity(CLI, LAB_PATH, {}, { exec: execAnswering({ root: `${LAB_PATH}/agents`, agents: [] }).exec }), { ok: true, workspace: null });
  assert.deepEqual([identityReadable(CLI), identityReadable({ ...CLI, features: ["workspace-v2"] }), identityReadable(null)], [true, false, false]);
  assert.deepEqual(identityTimedOut().reason.code, "E_CLI_TIMEOUT");
});

test("listedViews: a listed deployment whose identity was learned joins its workspace's view by buildViews' own rule, named by the listed folder as a local name; one that attaches nowhere, or is not read, is unmatched with the reason", () => {
  const labGroup = group("builder:lab", "builder (lab)", LAB), oatsGroup = group("builder:oats", "builder", OATS);
  const rows = [{ path: HERE, name: "OATS" }, { path: LAB_PATH, name: "lab" }, { path: "/home/u/other", name: "other" }];
  const learned = new Map([[LAB_PATH, { ok: true, workspace: { reachable: true, ...LAB } }], ["/home/u/other", { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "late" } }]]);
  const h = held({ learned, groups: [oatsGroup, labGroup] });
  const { views, infos, unmatched } = listedViews(h, rows, TERMS);
  assert.deepEqual(views.map((v) => [v.id, v.name, v.deployments, v.primary]), [
    [viewId(OATS.key, "t-oats"), "oats", [HERE, "remote:builder:oats"], HERE],
    [viewId(LAB.key, "t-lab"), "lab", ["remote:builder:lab", LAB_PATH], LAB_PATH],
  ]);
  assert.deepEqual([infos.get(LAB_PATH).listed, infos.get(LAB_PATH).live, infos.get(LAB_PATH).identityFrom, infos.get(LAB_PATH).read], [true, false, "learned", "read"]);
  assert.deepEqual(unmatched.map((i) => [i.id, i.read, i.short]), [["/home/u/other", "failed", "Timed out"]], "the served one is passed over");
  // The served views are the same as viewModel's: a listed deployment is in no panel and no route.
  assert.deepEqual(viewModel(h, TERMS).views.map((v) => v.deployments), [[HERE, "remote:builder:oats"], ["remote:builder:lab"]]);
  assert.equal(deployments(h).some((d) => d.id === LAB_PATH), false);
  // Not read yet: unmatched, with no reason.
  assert.deepEqual(listedInfo(held(), { path: LAB_PATH, name: "lab" }, TERMS).read, "pending");
  assert.equal(listedInfo(held(), { path: LAB_PATH, name: "lab" }, TERMS).short, null);
  // Read, and attaching to no workspace: the shared reason of the identity.
  const member = listedInfo(held({ learned: new Map([[LAB_PATH, { ok: true, workspace: { reachable: true, ...LAB, keyFrom: "member" } }]]) }), { path: LAB_PATH, name: "lab" }, TERMS);
  assert.deepEqual([member.attach.unattached, member.short], ["member", "Workspace not known yet"]);
  // A kernel without workspace identities matches nothing.
  const old = held({ learned });
  old.cli = { ...old.cli, features: ["workspace-v2"] };
  assert.equal(listedInfo(old, { path: LAB_PATH, name: "lab" }, TERMS).attach.unattached, "no-report");
});

test("deploymentInfo: a served deployment of this machine not observed yet is placed by its learned identity, still not live, with its reading sentence; once observed the reported one wins; without held.learned nothing changes", () => {
  const entries = new Map([[HERE, observedEntry({ roster: statusOf(HERE, OATS), workspaceStatus: { workspace: { name: "oats" } }, observedAt: AT }, [], AT)], [LAB_PATH, pendingEntry(null, AT)]]);
  const learned = new Map([[LAB_PATH, { ok: true, workspace: { reachable: true, ...LAB } }]]);
  const pendingInfo = deploymentInfo(held({ learned, ctxs: [HERE, LAB_PATH], entries }), { id: LAB_PATH, name: "lab", remote: false }, TERMS);
  assert.deepEqual([pendingInfo.live, pendingInfo.reachable, pendingInfo.identityFrom, pendingInfo.attach.key, pendingInfo.short], [false, false, "learned", LAB.key, "Not observed"]);
  assert.match(pendingInfo.reason, /Reading the deployment/);
  const views = viewModel(held({ learned, ctxs: [HERE, LAB_PATH], entries, groups: [group("builder:lab", "builder (lab)", LAB)] }), TERMS).views;
  assert.deepEqual(views.find((v) => v.key === LAB.key).deployments, [LAB_PATH, "remote:builder:lab"], "one view before the first read");
  // Without held.learned (the Desktop's held), it is unattached until its first read, as before.
  const bare = held({ ctxs: [HERE, LAB_PATH], entries });
  delete bare.learned;
  assert.equal(deploymentInfo(bare, { id: LAB_PATH, name: "lab", remote: false }, TERMS).attach.unattached, "no-report");
  // A failed identity read places nothing.
  const failed = deploymentInfo(held({ learned: new Map([[LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT" } }]]), ctxs: [HERE, LAB_PATH], entries }), { id: LAB_PATH, name: "lab", remote: false }, TERMS);
  assert.equal(failed.attach.unattached, "no-report");
  // Observed: the reported identity, not the learned one.
  const observed = new Map([...entries, [LAB_PATH, observedEntry({ roster: statusOf(LAB_PATH, OATS), workspaceStatus: { workspace: { name: "lab" } }, observedAt: AT }, [], AT)]]);
  const read = deploymentInfo(held({ learned, ctxs: [HERE, LAB_PATH], entries: observed }), { id: LAB_PATH, name: "lab", remote: false }, TERMS);
  assert.deepEqual([read.live, read.identityFrom, read.attach.key], [true, "reported", OATS.key]);
});
