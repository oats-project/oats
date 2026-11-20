// The client's own terms (packages/client/client-terms.mjs) and the sentence tables that take them.
// A second client must show the same explanation for the same failure without showing the first one's
// name: every sentence a table builds is built here with a second client's terms, and none of them may
// hold the Desktop's words.
//
// It imports packages/client only, so it runs on a root-only checkout with nothing installed. The
// Desktop's own strings, byte for byte, are held by packages/desktop/test/desktop-terms.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientTerms, requireTerms } from "../packages/client/client-terms.mjs";
import { LIFECYCLE_CODES, lifecycleReason, lifecycleFailure, lifecycleCode, lifecycleDetailCode, undescribedAnswer, undescribedRefusal } from "../packages/client/lifecycle-contract.mjs";
import { WORKSPACE_FAILURE_CODES, workspaceFailure, workspaceGate, cliWorkspace } from "../packages/client/workspace-cli.mjs";
import { capabilityShowUnreadable } from "../packages/client/capability-show-contract.mjs";
import { deploymentReasonParts, deploymentReason } from "../packages/client/workspace-views.mjs";
import { originLead } from "../packages/client/instance-presentation.mjs";
import { kernelLines } from "../packages/client/kernel-lines.mjs";
import { deploymentLabelParts, deploymentLabel, machineLabels, machineLabelParts } from "../packages/client/deployment-label.mjs";
import { rosterSections } from "../packages/client/roster-sections.mjs";
import { deploymentUnavailableText, deploymentUnavailableParts } from "../packages/client/deployment-facts.mjs";
import { deploymentInfo, viewModel, viewFor, deploymentFor, surfaceDeployment, viewForgeContext, isServed, teamMembersFor, machineScope, panelData,
  workspaceChoices } from "../packages/client/panel-views.mjs";

/** The two clients' values (specs: the Desktop's are its words today; the TUI's are #855's). */
const DESKTOP = { name: "Desktop", self: "this Desktop", selfInitial: "This Desktop", update: "OATS Desktop", thisMachine: "This Mac" };
const TUI = { name: "oats tui", self: "oats tui", selfInitial: "oats tui", update: "OATS", thisMachine: "This machine" };
const KEYS = ["name", "self", "selfInitial", "update", "thisMachine"];

// ── clientTerms ───────────────────────────────────────────────────────────────

test("clientTerms returns the same five, frozen", () => {
  const terms = clientTerms(TUI);
  assert.deepEqual({ ...terms }, TUI);
  assert.deepEqual(Object.keys(terms), KEYS);
  assert.equal(Object.isFrozen(terms), true);
  assert.throws(() => { "use strict"; terms.name = "other"; }, TypeError);
  assert.notEqual(clientTerms(TUI), clientTerms(TUI), "each call makes its own object: nothing is kept");
});

test("clientTerms refuses a missing, empty, non-string, multi-line or unknown term, by name", () => {
  for (const key of KEYS) {
    const { [key]: _dropped, ...without } = TUI;
    assert.throws(() => clientTerms(without), { name: "TypeError", message: `clientTerms: ${key} is missing` });
    // Empty, not a string, and not one display line: a line break, a control character, a bidi override,
    // spaces at an end, text the display filter withholds, a line longer than the filter's bound.
    for (const bad of ["", undefined, null, 7, ["Desktop"], { toString: () => "Desktop" }, "two\nlines", "tab\there", "bell\u0007", "‮desrever",
      " padded", "padded ", "token=abc123", "x".repeat(2049)]) {
      assert.throws(() => clientTerms({ ...TUI, [key]: bad }), { name: "TypeError", message: `clientTerms: ${key} must be a string of one display line, and not empty` }, `${key}: ${JSON.stringify(bad)}`);
    }
  }
  assert.throws(() => clientTerms({ ...TUI, host: "devbox" }), { name: "TypeError", message: /^clientTerms: host is not a term/ });
  assert.throws(() => clientTerms({ ...TUI, [Symbol("made")]: true }), { name: "TypeError", message: /^clientTerms: Symbol\(made\) is not a term/ });
  for (const none of [undefined, null, "Desktop", 7, [], () => TUI]) assert.throws(() => clientTerms(none), { name: "TypeError", message: /^clientTerms: pass an object/ });
  // A term that an ancestor supplies is not the client's own.
  assert.throws(() => clientTerms(Object.create(TUI)), { name: "TypeError", message: "clientTerms: name is missing" });
});

test("only clientTerms makes terms: the class is not reachable from the object it returns", () => {
  const real = clientTerms(TUI), prototype = Object.getPrototypeOf(real);
  // `constructor` would be the way in: `new real.constructor({})` would carry the private field and no value.
  assert.deepEqual(Reflect.ownKeys(prototype), [], "the prototype names nothing, its constructor least of all");
  assert.equal(Object.isFrozen(prototype), true);
  assert.equal(real.constructor, Object, "what an object without a constructor of its own inherits");
  assert.equal(Object.getPrototypeOf(prototype), Object.prototype);
  // Whatever can be made from what terms give away is refused, and prints no sentence.
  const forged = { "new terms.constructor({})": new real.constructor({}), "new terms.constructor(real values)": new real.constructor({ ...TUI }),
    "Reflect.construct on it": Reflect.construct(real.constructor, [{}]), "an object on the same prototype": Object.create(prototype),
    "one with the five values on it": Object.assign(Object.create(prototype), TUI), "a clone": structuredClone({ ...real }) };
  for (const [what, value] of Object.entries(forged)) {
    assert.throws(() => requireTerms(value, "a table"), { name: "TypeError", message: "a table: terms must be the object clientTerms() returned" }, what);
    assert.throws(() => lifecycleReason("E_PLAN_LIMIT", value), TypeError, what);
  }
  assert.throws(() => { "use strict"; prototype.constructor = function Terms() {}; }, TypeError, "and the way in cannot be put back");
});

test("clientTerms reads each value once: what it checked is what it keeps", () => {
  // A getter that answers a valid term the first time and something else after: checked on one reading,
  // kept from another, it would put an unchecked value in a sentence.
  for (const key of KEYS) for (const later of [undefined, "", "two\nlines", 7]) {
    let reads = 0;
    const values = Object.defineProperty({ ...TUI }, key, { enumerable: true, get() { return ++reads === 1 ? TUI[key] : later; } });
    const terms = clientTerms(values);
    assert.equal(reads, 1, `${key} was read once`);
    assert.deepEqual({ ...terms }, TUI, `${key}: the value kept is the value checked`);
    assert.doesNotMatch(JSON.stringify([lifecycleReason("E_PLAN_LIMIT", terms), capabilityShowUnreadable(terms), deploymentLabel(undefined, terms),
      workspaceFailure("E_WORKSPACE_FEATURE", terms)]), /undefined|\\n/);
  }
  // A getter that is wrong on its only reading is refused like any wrong value.
  assert.throws(() => clientTerms(Object.defineProperty({ ...TUI }, "name", { enumerable: true, get: () => undefined })), { name: "TypeError", message: /^clientTerms: name must be/ });
  // The caller's object is not kept: changing it afterwards changes no term.
  const mine = { ...TUI }, terms = clientTerms(mine);
  mine.name = "changed"; delete mine.self;
  assert.deepEqual({ ...terms }, TUI);
  // Nor is a proxy's second answer: whatever it says is asked once per term.
  const asked = [];
  const proxied = clientTerms(new Proxy({ ...TUI }, { get(target, key, receiver) { asked.push(key); return Reflect.get(target, key, receiver); } }));
  assert.deepEqual(asked, KEYS); assert.deepEqual({ ...proxied }, TUI);
});

// ── Every table, every sentence ───────────────────────────────────────────────

const CLI = { ok: true, bin: "/usr/local/bin/oats", workspaceApi: 2, features: ["workspace-v2", "packages-no-approval"] };
const SHOW_CLI = { ...CLI, capabilityShowApi: 1, features: [...CLI.features, "capability-show"] };
const execOf = (error, stdout) => (_bin, _argv, _options, done) => done(error, stdout);
/** One cliWorkspace call per failure the adapter raises itself: `[code it must answer, cli, options, exec]`. */
const WORKSPACE_PATHS = [
  ["E_CLI_UNAVAILABLE", null, { action: "sync", context: "/w" }, assert.fail],
  ["E_WORKSPACE_FEATURE", { ...CLI, workspaceApi: 1 }, { action: "sync", context: "/w" }, assert.fail],
  ["E_CAPABILITY_SHOW_FEATURE", CLI, { action: "capability-show", context: "/w", name: "house-style", member: "github.com/x/y" }, assert.fail],
  ["E_BAD_ARGS", CLI, { action: "sync", context: "relative" }, assert.fail],
  ["E_CLI_OUTPUT_LIMIT", CLI, { action: "sync", context: "/w" }, execOf({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "")],
  ["E_CLI_TIMEOUT", CLI, { action: "sync", context: "/w" }, execOf({ killed: true }, "")],
  ["E_CLI_FAILED", CLI, { action: "sync", context: "/w" }, execOf({ code: 1 }, "not json")],
  ["E_CLI_PROTOCOL", SHOW_CLI, { action: "capability-show", context: "/w", name: "house-style", member: "github.com/x/y" }, execOf(null, "not json")],
];

/** Every input of deploymentReasonParts: the product of each field's values, so every branch that
 * builds a sentence is reached with and without a machine of its own. */
function reasonInputs() {
  const fields = {
    local: [true, false], machine: [undefined, "devbox"], sshHost: [undefined, "devbox.lan"], unavailable: [undefined, "E_CLI_FAILED: boom"],
    readError: [undefined, "the cache is locked", ""], readErrorOrigin: [undefined, "kernel"], identityStatus: [undefined, "identity", "feature", "old", "none", "invalid"],
    cliReadsRemotes: [undefined, false], rosterError: [undefined, "no route to host"],
    probe: [undefined, { ok: true }, { ok: false }, { ok: false, error: { code: "E_SSH", message: "Host key verification failed." } },
      { ok: false, error: { code: "E_SSH", message: "Connection timed out" } }, { ok: false, error: { code: "E_SSH", message: "ssh to devbox.lan timed out: no answer within 20 s" } }, { ok: false, error: { code: "E_OTHER", message: "x" } }],
    attach: [undefined, { key: "k", team: "t" }, { unattached: "no-report" }, { unattached: "member" }, { unattached: "invalid-ref" }, { unattached: "unknown-team" }, { unattached: "standalone" }],
    ref: [undefined, "git:x"],
  };
  let inputs = [{}];
  for (const [key, values] of Object.entries(fields)) inputs = inputs.flatMap((d) => values.map((value) => (value === undefined ? d : { ...d, [key]: value })));
  return inputs;
}
const REASON_INPUTS = reasonInputs();
const DEPLOYMENTS = [undefined, null, {}, { machine: "devbox" }, { label: "~/Agents/oats" }, { machine: "devbox", label: "~/Agents/app" }];
const DEPLOYMENT_LISTS = [[{ id: "a", path: "/a/oats" }], [{ id: "a", path: "/a/oats" }, { id: "b", path: "/b/oats" }, { id: "c", machine: "devbox", path: "/c/app" }]];
/** Every branch of deploymentUnavailableText, by what the deployment is. */
const UNOBSERVED = { "nothing": undefined, "pending": { status: "pending" }, "observed": { status: "observed" },
  "feature": { status: "unavailable", reason: { code: "E_DEPLOYMENT_FEATURE", feature: "served-identity" } },
  "code and message": { status: "unavailable", reason: { code: "E_CLI_FAILED", message: "boom" } },
  "message": { status: "unavailable", reason: { message: "boom" } }, "no reason": { status: "unavailable" },
  // 3a: a reason the reader marked as the kernel's own, said, withheld and with nothing to show.
  "kernel": { status: "unavailable", reason: { code: "E_WORKSPACE_SCHEMA", message: "the workspace file is not valid", origin: "kernel" } },
  "kernel withheld": { status: "unavailable", reason: { code: "E_REMOTE_UNREADABLE", message: "token=abcdef0123456789", origin: "kernel" } },
  "kernel silent": { status: "unavailable", reason: { code: "E_X", message: "", origin: "kernel" } } };
/** What a client holds (panel-views.mjs `held`): this machine's three deployments, each with a sentence or a label of
 * its own. One reported a workspace that cannot be read, one is not read yet, one has a kernel without a feature. */
const HELD = () => ({
  ctxs: ["/a/oats", "/a/loose", "/a/old"],
  snapshot: { byWs: new Map([
    ["/a/oats", { deployment: { status: "observed", root: "/a/oats/agents", workspace: { name: "oats" }, workspaceStatus: {}, reachable: { reachable: true, identityInvalid: true }, withheld: [], souls: [] },
      instances: [{ instance: "dev-1", agent: "dev", home: "/a/oats/agents/dev/instances/dev-1", running: true, identity: { alias: "dev-1", team: "aweb:oats" } }], generatedAt: "2026-10-11T12:00:00.000Z", observedAt: null }],
    ["/a/old", { deployment: { status: "unavailable", reason: { code: "E_DEPLOYMENT_FEATURE", feature: "served-identity" } }, instances: [], generatedAt: "2026-10-11T12:00:00.000Z" }],
  ]) },
  remoteGroups: [], remembered: { get: () => null, note: () => null, all: () => [] }, rosterAnswered: true, rosterFailure: null,
  cli: { ok: true, features: ["workspace-identity"], remote: ["roster"] }, observing: new Set(), remoteCollecting: false, home: "/a", at: "2026-10-11T12:00:00.000Z",
});
const ROWS = [{ instance: "dev-1", agent: "dev", home: "/a/oats/agents/dev/instances/dev-1", deployment: { id: "a" } },
  { instance: "dev-2", agent: "dev", home: "/c/app/agents/dev/instances/dev-2", deployment: { id: "c" } }];

/** Every answer of every table that takes terms, as `Map<what was asked, the answer>`: each code a table
 * knows (the codes are the tables' own lists) and each branch that builds a sentence. */
async function everyAnswer(terms) {
  const answers = new Map();
  const say = (asked, answer) => { assert.ok(!answers.has(asked), asked); answers.set(asked, answer); };
  for (const code of [...LIFECYCLE_CODES, "E_NOT_IN_THE_TABLE"]) {
    say(`lifecycleReason ${code}`, lifecycleReason(code, terms));
    say(`lifecycleFailure ${code}`, lifecycleFailure(code, terms));
  }
  // The fallback for a code the kernel answered and the table has no sentence for, and that reason as a
  // reader with the same terms re-validates it. `ENOENT` is not in the kernel's code shape.
  for (const code of [...LIFECYCLE_CODES, "E_NOT_IN_THE_TABLE", "ENOENT"]) {
    const answer = undescribedAnswer(code, terms);
    assert.equal(answer === null, code !== "E_NOT_IN_THE_TABLE", `${code}: the fallback is for a kernel code without a sentence`);
    say(`undescribedAnswer ${code}`, answer);
    say(`undescribedRefusal ${code}`, undescribedRefusal(answer ? { ...answer, detail: "one line" } : { code, message: "another sentence" }, terms));
  }
  for (const code of [...WORKSPACE_FAILURE_CODES, "E_NOT_IN_THE_TABLE"]) say(`workspaceFailure ${code}`, workspaceFailure(code, terms));
  say("workspaceGate no cli", workspaceGate(null, terms));
  say("workspaceGate old cli", workspaceGate({ ...CLI, features: [] }, terms));
  const reached = [];
  for (const [code, cli, options, exec] of WORKSPACE_PATHS) {
    const answer = await cliWorkspace(cli, options, terms, { exec, env: {} });
    assert.equal(answer.reason.code, code, `cliWorkspace answers ${code} on the path built for it`);
    reached.push(code); say(`cliWorkspace ${code}`, answer);
  }
  assert.deepEqual(reached.sort(), [...WORKSPACE_FAILURE_CODES].sort(), "one cliWorkspace path for every failure the adapter has a sentence for");
  say("capabilityShowUnreadable", capabilityShowUnreadable(terms));
  for (const origin of ["kernel", "terminal-probe", "roster-read", "not-a-speaker"]) say(`originLead ${origin}`, originLead(origin, terms));
  say("kernelLines", kernelLines("a message", "a fix", terms));
  REASON_INPUTS.forEach((d, n) => {
    const parts = deploymentReasonParts(d, terms);
    assert.equal(deploymentReason(d, terms), parts?.detail ?? null);
    if (parts) say(`deploymentReasonParts ${n} ${JSON.stringify(d)}`, parts);
  });
  DEPLOYMENTS.forEach((d, n) => { say(`deploymentLabelParts ${n}`, deploymentLabelParts(d, terms)); say(`deploymentLabel ${n}`, deploymentLabel(d, terms)); });
  DEPLOYMENT_LISTS.forEach((list, n) => {
    say(`machineLabels ${n}`, [...machineLabels(list, terms)]); say(`machineLabelParts ${n}`, [...machineLabelParts(list, terms)]);
    say(`rosterSections ${n}`, rosterSections(ROWS, ROWS, list, terms).map(({ label, machine, tail }) => ({ label, machine, tail })));
  });
  for (const [what, deployment] of Object.entries(UNOBSERVED)) say(`deploymentUnavailableText ${what}`, deploymentUnavailableText(deployment, terms));
  for (const [what, deployment] of Object.entries(UNOBSERVED)) say(`deploymentUnavailableParts ${what}`, deploymentUnavailableParts(deployment, terms));
  // The views over what a client holds: each deployment's facts, the switcher's list, and every view's panel.
  const model = viewModel(HELD(), terms);
  say("viewModel", { views: model.views, infos: [...model.infos.values()] });
  say("workspaceChoices", workspaceChoices(HELD(), terms));
  for (const id of HELD().ctxs) {
    say(`deploymentInfo ${id}`, deploymentInfo(HELD(), { id, name: id }, terms));
    say(`panelData ${id}`, panelData(HELD(), id, terms));
    say(`teamMembersFor ${id}`, teamMembersFor(HELD(), id, terms));
  }
  return answers;
}

/** Every string an answer holds, at any depth. */
function stringsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}
/** The words that belong to one client: the Desktop, its machine and what it is made of. Whole words, any case. */
const DESKTOP_WORDS = /\b(?:Desktop|Mac|window|menu)\b/i;
/** The second client's own words, none of which the Desktop may show. */
const TUI_WORDS = /\boats tui\b|\bThis machine\b/i;
const holding = (answers, words) => [...answers].filter(([, answer]) => stringsOf(answer).some((text) => words.test(text))).map(([asked]) => asked);

test("second terms: no sentence of any table holds the Desktop's words, or the word undefined", async () => {
  const answers = await everyAnswer(clientTerms(TUI));
  assert.ok(answers.size > 1000, `every table was asked (${answers.size} answers)`);
  assert.deepEqual(holding(answers, DESKTOP_WORDS), [], "a sentence names the Desktop, a Mac, a window or a menu: it is hard-wired, not built from the terms");
  assert.deepEqual(holding(answers, /undefined/), []);
});

test("second terms: every branch of deploymentReasonParts written in the module was reached", () => {
  // The branches have no codes to list, so the module's source says what they are: each one names itself
  // with a `short:` label. A branch added later that the inputs above do not reach fails here.
  const source = readFileSync(new URL("../packages/client/workspace-views.mjs", import.meta.url), "utf8");
  const written = [...source.matchAll(/\bshort: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  assert.ok(written.length >= 14, `the labels were read (${written.length})`);
  const terms = clientTerms(TUI), produced = new Set();
  for (const d of REASON_INPUTS) { const parts = deploymentReasonParts(d, terms); if (parts) produced.add(parts.short); }
  assert.deepEqual(written.filter((short) => !produced.has(short)), [], "a branch no input reaches");
  assert.deepEqual([...produced].filter((short) => !written.includes(short)), [], "a label the reader did not find in the source");
});

test("two clients at once: each answer is in its own client's words, and neither holds the other's", async () => {
  const desktop = clientTerms(DESKTOP), tui = clientTerms(TUI);
  // In turn, in one process: the Desktop, the TUI, the Desktop again. Nothing a call leaves changes the next.
  const first = await everyAnswer(desktop), second = await everyAnswer(tui), third = await everyAnswer(desktop);
  assert.deepEqual([...third], [...first], "the Desktop's answers are the same after the TUI asked");
  assert.deepEqual([...first.keys()], [...second.keys()], "both clients are answered for the same questions");
  assert.deepEqual(holding(first, TUI_WORDS), [], "a Desktop answer holds the TUI's words");
  assert.deepEqual(holding(second, DESKTOP_WORDS), [], "a TUI answer holds the Desktop's words");
  // The answers that differ between the two are the sentences that take a term, and no other: each of
  // them holds its own client's words. If one is hard-wired back it stops differing, and the list changes.
  const differing = [...first.keys()].filter((asked) => JSON.stringify(first.get(asked)) !== JSON.stringify(second.get(asked)));
  const tables = new Set(differing.map((asked) => asked.replace(/^deploymentReasonParts .*$/, "deploymentReasonParts").replace(/ \d+$/, "").replace(/ \/a\/\w+$/, "")));
  assert.deepEqual([...tables].sort(), [
    "capabilityShowUnreadable",
    "cliWorkspace E_WORKSPACE_FEATURE",
    "deploymentInfo", "deploymentLabel", "deploymentLabelParts", "deploymentReasonParts", "deploymentUnavailableParts feature", "deploymentUnavailableText feature",
    "panelData", "teamMembersFor", "viewModel", "workspaceChoices",
    "lifecycleFailure E_CLI_OUTPUT_LIMIT", "lifecycleFailure E_CLI_PROTOCOL", "lifecycleFailure E_LIFECYCLE_UNAVAILABLE", "lifecycleFailure E_PLAN_LIMIT",
    "lifecycleReason E_CLI_OUTPUT_LIMIT", "lifecycleReason E_CLI_PROTOCOL", "lifecycleReason E_LIFECYCLE_UNAVAILABLE", "lifecycleReason E_PLAN_LIMIT",
    "machineLabelParts", "machineLabels", "rosterSections",
    "originLead roster-read", "originLead terminal-probe",
    "undescribedAnswer E_NOT_IN_THE_TABLE", "undescribedRefusal E_NOT_IN_THE_TABLE",
    "workspaceFailure E_WORKSPACE_FEATURE", "workspaceGate old cli",
  ].sort());
  for (const asked of differing) {
    assert.ok(stringsOf(first.get(asked)).some((text) => DESKTOP_WORDS.test(text)), `${asked}: the Desktop's answer is in the Desktop's words`);
    assert.ok(stringsOf(second.get(asked)).some((text) => TUI_WORDS.test(text)), `${asked}: the TUI's answer is in the TUI's words`);
  }
  // Of deploymentReasonParts, the three places the table names: the ssh step, the unreadable report, and
  // the machine's label wherever the deployment names no machine.
  const reasons = differing.filter((asked) => asked.startsWith("deploymentReasonParts "));
  const shorts = new Set(reasons.map((asked) => first.get(asked).short));
  assert.ok(shorts.has("ssh needs a prompt") && shorts.has("Unreadable workspace report"));
  for (const asked of reasons) {
    const d = JSON.parse(asked.replace(/^deploymentReasonParts \d+ /, "")), { short } = first.get(asked);
    assert.ok(short === "ssh needs a prompt" || short === "Unreadable workspace report" || d.machine === undefined, `${asked}: differs for no reason the table names`);
  }
  // The fallback is known by its sentence, so a reader knows only the one in its own words: a reason
  // worded for the other client is not the fallback to it, and reads by the code's own rule.
  for (const [mine, other] of [[desktop, tui], [tui, desktop]]) {
    const reason = { ...undescribedAnswer("E_NOT_IN_THE_TABLE", mine), detail: "one line" };
    assert.deepEqual(undescribedRefusal(reason, mine), reason);
    assert.equal(undescribedRefusal(reason, other), null);
  }
});

// ── No terms ──────────────────────────────────────────────────────────────────

/** Each table function, called with `terms` in its place and every other argument valid. */
const TABLES = {
  lifecycleReason: (terms) => lifecycleReason("E_CLI_FAILED", terms),
  lifecycleFailure: (terms) => lifecycleFailure("E_CLI_FAILED", terms),
  undescribedAnswer: (terms) => undescribedAnswer("E_NOT_IN_THE_TABLE", terms),
  undescribedRefusal: (terms) => undescribedRefusal({ code: "E_NOT_IN_THE_TABLE", message: "a sentence" }, terms),
  workspaceFailure: (terms) => workspaceFailure("E_CLI_FAILED", terms),
  workspaceGate: (terms) => workspaceGate(CLI, terms),
  cliWorkspace: (terms) => cliWorkspace(CLI, { action: "sync", context: "/w" }, terms, { exec: assert.fail, env: {} }),
  capabilityShowUnreadable: (terms) => capabilityShowUnreadable(terms),
  originLead: (terms) => originLead("kernel", terms),
  kernelLines: (terms) => kernelLines("a message", "a fix", terms),
  deploymentReasonParts: (terms) => deploymentReasonParts({ local: true }, terms),
  deploymentReason: (terms) => deploymentReason({ local: true }, terms),
  deploymentLabelParts: (terms) => deploymentLabelParts({ machine: "devbox" }, terms),
  deploymentLabel: (terms) => deploymentLabel({ machine: "devbox" }, terms),
  machineLabels: (terms) => machineLabels([], terms),
  machineLabelParts: (terms) => machineLabelParts([], terms),
  rosterSections: (terms) => rosterSections([], [], [], terms),
  deploymentUnavailableText: (terms) => deploymentUnavailableText({ status: "pending" }, terms),
  deploymentUnavailableParts: (terms) => deploymentUnavailableParts({ status: "pending" }, terms),
  // The views (panel-views.mjs): each refuses by its own name, also where it would build no sentence.
  deploymentInfo: (terms) => deploymentInfo(HELD(), { id: "/a/oats", name: "oats" }, terms),
  viewModel: (terms) => viewModel({ ...HELD(), ctxs: [] }, terms),
  viewFor: (terms) => viewFor(HELD(), "/a/oats", terms, { views: [], infos: new Map() }),
  deploymentFor: (terms) => deploymentFor(HELD(), "/a/oats", terms),
  surfaceDeployment: (terms) => surfaceDeployment(HELD(), undefined, {}, terms),
  viewForgeContext: (terms) => viewForgeContext(HELD(), "/a/oats", terms),
  isServed: (terms) => isServed(HELD(), "/a/oats", terms),
  teamMembersFor: (terms) => teamMembersFor(HELD(), "/a/oats", terms),
  machineScope: (terms) => machineScope(HELD(), "/a/oats", terms),
  panelData: (terms) => panelData(HELD(), "/a/oats", terms),
  workspaceChoices: (terms) => workspaceChoices(HELD(), terms, { views: [], infos: new Map() }),
};

test("no terms: every table throws without them, and with an object clientTerms did not make", async () => {
  const real = clientTerms(TUI);
  // A second copy of the module in the same process has its own class: its terms are not this copy's.
  const copy = await import("../packages/client/client-terms.mjs?a-second-copy");
  assert.notEqual(copy.clientTerms, clientTerms);
  const notTerms = { "nothing": undefined, "null": null, "a string": "oats tui", "the five values, by hand": { ...TUI }, "a spread of real terms": { ...real },
    "a frozen look-alike": Object.freeze({ ...TUI }), "an object that inherits real terms": Object.create(real), "a proxy of real terms": new Proxy(real, {}),
    "terms of a second copy of the module": copy.clientTerms(TUI), "an array": [real], "a function": () => real };
  for (const [name, call] of Object.entries(TABLES)) {
    for (const [what, value] of Object.entries(notTerms)) {
      assert.throws(() => call(value), { name: "TypeError", message: `${name}: terms must be the object clientTerms() returned` }, `${name} with ${what}`);
    }
    assert.doesNotThrow(() => call(real), name);
  }
  // No default anywhere: a call that leaves the argument out is the same refusal, never a sentence that says "undefined".
  assert.throws(() => lifecycleReason("E_PLAN_LIMIT"), TypeError);
  assert.throws(() => workspaceFailure("E_WORKSPACE_FEATURE"), TypeError);
  assert.throws(() => capabilityShowUnreadable(), TypeError);
  // rosterSections needs them also where it would not use them (one deployment has no heading), and so
  // does the fallback for a code that has a sentence, and for a reason that is none.
  assert.throws(() => rosterSections(ROWS, ROWS, [{ id: "a" }]), TypeError);
  assert.throws(() => undescribedAnswer("E_CLI_FAILED"), { name: "TypeError", message: "undescribedAnswer: terms must be the object clientTerms() returned" });
  assert.throws(() => undescribedRefusal(null), { name: "TypeError", message: "undescribedRefusal: terms must be the object clientTerms() returned" });
  // kernelLines needs them also where it leads no line: both texts nothing, and both withheld.
  for (const [message, fix] of [[null, null], [" ", ""], ["token: abc123", "token: abc123"]]) {
    assert.throws(() => kernelLines(message, fix), { name: "TypeError", message: "kernelLines: terms must be the object clientTerms() returned" }, JSON.stringify([message, fix]));
    assert.doesNotThrow(() => kernelLines(message, fix, real));
  }
  assert.equal(requireTerms(real, "a table"), real);
});

// ── The speaker of a text (#982) ──────────────────────────────────────────────

test("originLead: the three phrases, each in the client's own words where it names the client, and null for anything else", () => {
  const desktop = clientTerms(DESKTOP), tui = clientTerms(TUI);
  assert.deepEqual(["kernel", "terminal-probe", "roster-read"].map((origin) => originLead(origin, desktop)),
    ["OATS says:", "Desktop's terminal check says:", "Desktop's read of other machines says:"]);
  assert.deepEqual(["kernel", "terminal-probe", "roster-read"].map((origin) => originLead(origin, tui)),
    ["OATS says:", `${TUI.name}'s terminal check says:`, `${TUI.name}'s read of other machines says:`]);
  // The kernel's lead takes no term: it is the same for every client.
  assert.equal(originLead("kernel", desktop), originLead("kernel", tui));
  // Absent, or any value that is not one of the three: no lead, so a client shows the text as its own.
  for (const origin of [undefined, null, "", "Kernel", "KERNEL", "kernel ", "server-probe", "terminal probe", "__proto__", "constructor", "toString", "hasOwnProperty",
    0, 7, NaN, true, ["kernel"], { kernel: true }, Symbol("kernel"), () => "kernel"]) {
    assert.equal(originLead(origin, desktop), null, String(origin));
  }
  // Terms are required, also for the phrase that uses none and for an origin that has no lead.
  for (const origin of ["kernel", "terminal-probe", undefined, "__proto__"]) {
    for (const terms of [undefined, null, { ...TUI }, { name: "Desktop" }]) {
      assert.throws(() => originLead(origin, terms), { name: "TypeError", message: "originLead: terms must be the object clientTerms() returned" });
    }
  }
});

test("what needs only the code needs no terms", () => {
  for (const code of LIFECYCLE_CODES) assert.equal(lifecycleCode(code), code);
  for (const unknown of ["E_NOT_IN_THE_TABLE", "E_FORBIDDEN_FRAME", "toString", "", undefined, null, 7]) assert.equal(lifecycleCode(unknown), "E_CLI_FAILED");
  assert.equal(lifecycleDetailCode("E_LIFECYCLE_BUSY"), true);
  // The lookup and the sentence agree, whatever the terms: the reason's code is the lookup's.
  const terms = clientTerms(TUI);
  for (const code of [...LIFECYCLE_CODES, "E_NOT_IN_THE_TABLE", "toString"]) {
    const reason = lifecycleReason(code, terms);
    assert.equal(reason.code, lifecycleCode(code)); assert.equal(typeof reason.message, "string");
  }
});

test("the shared home holds no terms of its own: none of its modules calls clientTerms", () => {
  const home = new URL("../packages/client/", import.meta.url);
  for (const name of ["lifecycle-contract.mjs", "workspace-cli.mjs", "capability-show-contract.mjs", "workspace-views.mjs", "deployment-label.mjs", "roster-sections.mjs",
    "deployment-facts.mjs", "panel-views.mjs", "instance-presentation.mjs", "kernel-lines.mjs"]) {
    const source = readFileSync(new URL(name, home), "utf8");
    assert.match(source, /import \{ requireTerms \} from '\.\/client-terms\.mjs';/, `${name} checks the terms it is given`);
    assert.doesNotMatch(source, /\bclientTerms\(/, `${name} makes terms of its own`);
  }
});
