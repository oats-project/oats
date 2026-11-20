// Session providers, the clients' half (spec C1): how a status row of an instance that runs on a session
// provider (a capability's backend, "bb" say) reaches every client through the shared readers
// (deployment-data.mjs, deployment-panel.mjs), and what they make of it: never a tmux probe, the kernel's
// own state, no terminal to open, the provider's link. The acts table is in
// packages/desktop/test/instance-acts.test.mjs, the collector's rule in packages/desktop/test/liveness.test.mjs.
//
// It imports packages/client only, so it runs on a root-only checkout with nothing installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentStatusData } from "../packages/client/deployment-data.mjs";
import { rosterRows, livenessInput, livenessAnswers, panelInstances } from "../packages/client/deployment-panel.mjs";
import { observeLiveness } from "../packages/client/liveness.mjs";
import { instanceActs, openAct } from "../packages/client/instance-acts.mjs";
import { sessionProvider, sessionProviderName, openLink, sessionThreadId } from "../packages/client/instance-presentation.mjs";
import { remotePanel } from "../packages/client/remote-roster.mjs";
import { sessionProviderNames, sessionBackendNames } from "../packages/client/session-backends.mjs";
import { spawnArgv } from "../packages/client/cli-adapter.mjs";
import { waitingClaim } from "../packages/client/waiting-on-you.mjs";
import { homeBoard } from "../packages/client/home-board.mjs";

const CLI = { ok: true, features: ["workspace-v2", "status-liveness", "session-providers"] };
const home = (name) => `/d/agents/dev/instances/${name}`;
/** A full endpoint, which no status row carries (interface v3): the reader keeps nothing of one. */
const ENDPOINT = { server: "http://127.0.0.1:38886", projectId: "proj_1", threadId: "thr_endpoint" };
const LINK = { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" };
/** A kernel status row of a bb home on this machine, as the status interface (v3) gives it. */
const bbRow = (name, extra = {}) => ({ instance: name, home: home(name), backend: "bb", session: { provider: "oats.bb", threadId: "thr_x" },
  tmux: null, running: true, runtimeState: "unknown", waitingOnYou: null, open: LINK, ...extra });
const statusOf = (instances) => ({ root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev", instances }] });
const projected = (instances) => deploymentStatusData(statusOf(instances), "/d").agents[0].instances;

test("deployment-data keeps a row's backend, its provider and thread id, and its link; of an endpoint nothing", () => {
  const [row] = projected([bbRow("dev-a")]);
  assert.equal(row.backend, "bb");
  assert.deepEqual(row.session, { provider: "oats.bb", threadId: "thr_x" });
  // A row with no thread id (one relayed from another host) keeps the provider alone; an endpoint is never read.
  assert.deepEqual(projected([bbRow("dev-r", { session: { provider: "oats.bb" } })])[0].session, { provider: "oats.bb" });
  assert.deepEqual(projected([bbRow("dev-e", { session: { provider: "oats.bb", endpoint: ENDPOINT } })])[0].session, { provider: "oats.bb" });
  assert.deepEqual(row.open, LINK);
  assert.equal(row.tmux, null);
  // A tmux row of a kernel with the feature says "tmux", and carries neither of the others.
  const [tmux] = projected([{ instance: "dev-t", home: home("dev-t"), backend: "tmux", running: true, tmux: { session: "oats", window: "dev-t", socket: "/s" } }]);
  assert.equal(tmux.backend, "tmux");
  assert.ok(!Object.hasOwn(tmux, "session") && !Object.hasOwn(tmux, "open"));
  // A row of a kernel before the feature has none of the three keys.
  const [old] = projected([{ instance: "dev-o", home: home("dev-o"), running: true }]);
  for (const key of ["backend", "session", "open"]) assert.ok(!Object.hasOwn(old, key), key);
});

test("deployment-data validates the three fields and never refuses the roster for them: a backend that is text is kept, whatever it says; anything else out of the contract is dropped", () => {
  const rows = projected([
    bbRow("b1", { backend: "Not A Name" }), bbRow("b2", { backend: 7 }), bbRow("b3", { backend: null }), bbRow("b4", { backend: "-bb" }), bbRow("b5", { backend: "" }),
    bbRow("s1", { session: null }), bbRow("s2", { session: "thr_x" }), bbRow("s3", { session: { provider: 7, threadId: 7, endpoint: ENDPOINT } }),
    bbRow("s4", { session: { provider: "oats.bb", endpoint: null } }), bbRow("s5", { session: { threadId: "thr_y", token: "never kept" } }),
    bbRow("o1", { open: null }), bbRow("o2", { open: { label: "Open", url: "file:///etc/passwd" } }), bbRow("o3", { open: "http://127.0.0.1/" }),
    bbRow("o4", { open: { label: "Open", url: "http://user:pw@127.0.0.1/" } }), bbRow("o5", { open: { label: "Open", url: "https://bb.example/t/1", more: true } }),
  ]);
  const by = Object.fromEntries(rows.map((row) => [row.instance, row]));
  assert.equal(rows.length, 15, "no row is withheld or refused");
  for (const name of ["b2", "b3", "b5"]) assert.ok(!Object.hasOwn(by[name], "backend"), name);
  // "herdr" is never kept on a row of this machine: such a row is known by its sessionTarget or its state, as before
  // session providers, and one that only names the backend reads as it always did (a probed tmux row).
  const [herdr] = projected([{ instance: "dev-h", home: home("dev-h"), backend: "herdr", running: true, tmux: { session: "oats", window: "dev-h", socket: "/s" } }]);
  assert.ok(!Object.hasOwn(herdr, "backend"));
  assert.equal(sessionProvider(herdr), null);
  assert.deepEqual(openAct(herdr), { verb: "open", enabled: true, reason: null });
  // Present, text and not "tmux": the row is a provider's (never asked of tmux), also when it is no name the contract allows.
  assert.deepEqual([by.b1.backend, by.b4.backend], ["Not A Name", "-bb"]);
  // A value the reader cannot carry (over-long, or with a NUL) is no tmux's either: the row names the reserved word
  // for any provider, is never asked of tmux and keeps the kernel's fields, through the collector and the panel.
  const odd = [bbRow("u1", { backend: "b".repeat(8193) }), bbRow("u2", { backend: "bb\0x" }), { instance: "dev-t", home: home("dev-t"), running: true, tmux: { session: "oats", window: "dev-t", socket: "/s" } }];
  const oddRows = rosterRows(deploymentStatusData(statusOf(odd), "/d"), { ok: true, features: [] });
  assert.deepEqual(oddRows.map((row) => row.backend), ["session-provider", "session-provider", undefined]);
  const asked = [], oddPrinted = JSON.stringify(observeLiveness(JSON.parse(JSON.stringify(livenessInput(oddRows))), { tmuxReader: (row) => { asked.push(row.instance); return { tmux: row.tmux, running: false, runtimeState: "stopped" }; } }));
  assert.deepEqual(asked, ["dev-t"]);
  for (const row of panelInstances(oddRows, livenessAnswers(oddRows, oddPrinted)).filter((each) => each.instance !== "dev-t")) {
    assert.deepEqual([row.running, row.runtimeState, row.tmux], [true, "unknown", null], row.instance);
    assert.equal(openAct({ ...row, open: undefined }).reason.sentence, "Runs outside tmux; it has no terminal to open.", row.instance);
  }
  for (const name of ["b1", "b4"]) {
    assert.equal(sessionProvider(by[name]), by[name].backend, name);
    assert.deepEqual(openAct({ ...by[name], open: undefined }), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence: "Runs outside tmux; it has no terminal to open." } }, `${name}: its text is in no sentence`);
  }
  for (const name of ["s1", "s2", "s3"]) assert.ok(!Object.hasOwn(by[name], "session"), name);
  assert.deepEqual(by.s4.session, { provider: "oats.bb" });
  assert.deepEqual(by.s5.session, { threadId: "thr_y" });
  for (const name of ["o1", "o2", "o3", "o4"]) assert.ok(!Object.hasOwn(by[name], "open"), name);
  assert.deepEqual(by.o5.open, { label: "Open", url: "https://bb.example/t/1" });
});

test("the panel's row carries the three fields as validated, absent when absent; the collector's input names the backend", () => {
  const rows = rosterRows(deploymentStatusData(statusOf([bbRow("dev-a"), { instance: "dev-t", home: home("dev-t"), running: true, tmux: { session: "oats", window: "dev-t", socket: "/s" } }]), "/d"), CLI);
  const input = livenessInput(rows);
  assert.deepEqual(input[0], { instance: "dev-a", running: true, tmux: null, sessionTarget: undefined, backend: "bb", runtimeState: "unknown", runtimeError: undefined });
  assert.deepEqual(Object.keys(input[1]), ["instance", "running", "tmux", "sessionTarget", "runtimeState", "runtimeError"], "a row with no backend is sent as it always was");
  // Under status-liveness the rows are the reading: no answers.
  const panel = panelInstances(rows, []), bb = panel.find((row) => row.instance === "dev-a"), tmux = panel.find((row) => row.instance === "dev-t");
  assert.equal(bb.backend, "bb");
  assert.deepEqual(bb.session, { provider: "oats.bb", threadId: "thr_x" });
  assert.deepEqual(bb.open, LINK);
  assert.equal(bb.running, true); assert.equal(bb.runtimeState, "unknown"); assert.equal(bb.tmux, null);
  for (const key of ["backend", "session", "open"]) assert.ok(!Object.hasOwn(tmux, key), key);
});

test("a kernel without status-liveness: the collector leaves a provider row as the kernel reported it, whatever tmux would say", () => {
  const kernel = [bbRow("dev-a"), bbRow("dev-b", { running: false, runtimeState: "stopped" }), bbRow("dev-c", { running: null, runtimeState: "unreachable", runtimeError: "E_SESSION_UNAVAILABLE: bb did not answer" }),
    { instance: "dev-t", home: home("dev-t"), running: true, tmux: { session: "oats", window: "dev-t", socket: "/s" } }];
  const rows = rosterRows(deploymentStatusData(statusOf(kernel), "/d"), { ok: true, features: [] });
  const seen = [], tmuxReader = (row) => { seen.push(row.instance); return { tmux: row.tmux, running: false, runtimeState: "stopped" }; };
  const printed = JSON.stringify(observeLiveness(JSON.parse(JSON.stringify(livenessInput(rows))), { tmuxReader }));
  assert.deepEqual(seen, ["dev-t"], "only the tmux row is asked of tmux");
  const panel = Object.fromEntries(panelInstances(rows, livenessAnswers(rows, printed)).map((row) => [row.instance, row]));
  assert.deepEqual([panel["dev-a"].running, panel["dev-a"].runtimeState], [true, "unknown"]);
  assert.deepEqual([panel["dev-b"].running, panel["dev-b"].runtimeState], [false, "stopped"]);
  assert.deepEqual([panel["dev-c"].running, panel["dev-c"].runtimeState, panel["dev-c"].runtimeError, panel["dev-c"].runtimeErrorOrigin],
    [null, "unreachable", "E_SESSION_UNAVAILABLE: bb did not answer", "kernel"]);
  assert.deepEqual([panel["dev-t"].running, panel["dev-t"].runtimeState], [false, "stopped"], "the tmux row is the probe's, as before");
  for (const name of ["dev-a", "dev-b", "dev-c"]) assert.equal(panel[name].tmux, null, name);
});

test("a kernel without status-liveness, a collector that failed or printed nonsense: a provider row keeps the kernel's three fields whole; the tmux rows read unknown, as before", () => {
  const long = `E_SESSION_UNAVAILABLE: ${"x".repeat(400)}`;
  const kernel = [bbRow("dev-a"), bbRow("dev-b", { running: false, runtimeState: "stopped" }), bbRow("dev-c", { running: null, runtimeState: "unreachable", runtimeError: long }),
    { instance: "dev-t", home: home("dev-t"), running: true, tmux: { session: "oats", window: "dev-t", socket: "/s" } }];
  const rows = rosterRows(deploymentStatusData(statusOf(kernel), "/d"), { ok: true, features: [] });
  const expected = { "dev-a": [true, "unknown", undefined, undefined], "dev-b": [false, "stopped", undefined, undefined], "dev-c": [null, "unreachable", long, "kernel"] };
  // The collector's own answer for a provider row cuts its text at 300 characters and may say anything: none of it is taken.
  const printed = JSON.stringify(observeLiveness(JSON.parse(JSON.stringify(livenessInput(rows))), { tmuxReader: (row) => ({ tmux: row.tmux, running: true, runtimeState: "running" }) }));
  const lying = JSON.stringify(rows.map(() => ({ running: false, runtimeState: "stopped", runtimeError: "no such window", tmux: { session: "oats" } })));
  for (const [what, stdout] of [["failed", null], ["not JSON", "{"], ["too few answers", "[]"], ["its own answers", printed], ["answers that say stopped", lying]]) {
    const panel = Object.fromEntries(panelInstances(rows, livenessAnswers(rows, stdout)).map((row) => [row.instance, row]));
    for (const [name, fields] of Object.entries(expected)) {
      assert.deepEqual([panel[name].running, panel[name].runtimeState, panel[name].runtimeError, panel[name].runtimeErrorOrigin], fields, `${what}: ${name}`);
      assert.equal(panel[name].tmux, null, `${what}: ${name} has no tmux target`);
    }
    if (stdout === null || stdout === "{" || stdout === "[]") assert.deepEqual([panel["dev-t"].running, panel["dev-t"].runtimeState, panel["dev-t"].runtimeErrorOrigin], [null, "unreachable", "terminal-probe"], what);
  }
});

test("from the kernel's row to the acts: a bb row offers what its state offers, opens no terminal, and carries its link", () => {
  const panel = panelInstances(rosterRows(deploymentStatusData(statusOf([bbRow("dev-a"), bbRow("dev-b", { running: false, runtimeState: "stopped", open: null }),
    bbRow("dev-c", { running: null, runtimeState: "unknown" })]), "/d"), CLI), []);
  const by = Object.fromEntries(panel.map((row) => [row.instance, row]));
  const verbs = (row) => instanceActs(row).acts.map((act) => act.verb);
  assert.deepEqual(verbs(by["dev-a"]), ["inspect", "restart", "stop", "retire"]);
  assert.deepEqual(verbs(by["dev-b"]), ["inspect", "start", "stop", "retire"]);
  assert.deepEqual(verbs(by["dev-c"]), ["inspect", "stop", "retire"]);
  const sentence = "Runs in a bb thread; open it in bb.";
  assert.deepEqual(openAct(by["dev-a"]), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence, link: LINK } });
  assert.deepEqual(openAct(by["dev-b"]), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence } });
  assert.deepEqual(openAct(by["dev-c"]), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence, link: LINK } });
});

test("another machine's bb row: its acts by its state, no terminal, and no link (the url is that host's own loopback)", () => {
  const group = { id: "host:build:/remote/project", server: "host", label: "Build server", registrationPresent: true,
    target: { sshHost: "build", workspace: "/remote/project" }, probe: { ok: true, features: [] }, agentsRoot: "/remote/project/agents", workspace: null,
    souls: [{ name: "dev", harness: "claude" }], retireFailures: [],
    instances: [{ server: "host", instance: "r-a", agent: "dev", home: "/remote/project/agents/dev/instances/r-a", agentsRoot: "/remote/project/agents",
      harness: "claude", backend: "bb", tmux: null, running: true, addressable: true, session: { provider: "oats.bb" }, open: LINK }] };
  const [row] = remotePanel(group, "2026-11-19T12:00:00.000Z").instances;
  assert.equal(row.running, true);
  assert.deepEqual(instanceActs(row).acts.map((act) => act.verb), ["inspect", "restart", "stop", "retire"]);
  assert.deepEqual(openAct(row), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence: "Runs in a bb thread; open it in bb." } });
});

test("the three readers: a provider's name, the link, the thread id", () => {
  for (const name of ["bb", "my-provider-2", "0", "a".repeat(40)]) assert.equal(sessionProviderName(name), true, name);
  for (const name of ["tmux", "session-provider", "", "BB", "b b", "bb!", "a".repeat(41), "bb\n", "-bb", "--json", null, undefined, 7, ["bb"]]) assert.equal(sessionProviderName(name), false, String(name));
  assert.equal(sessionProvider({ backend: "bb" }), "bb");
  // Any text that is not "tmux" is a provider's row, also one that is no name: it is never asked of tmux.
  for (const backend of ["-bb", "session-provider", "Not A Name", "x".repeat(41)]) assert.equal(sessionProvider({ backend }), backend);
  for (const backend of ["", 7, null, undefined, ["bb"]]) assert.equal(sessionProvider({ backend }), null, String(backend));
  assert.equal(sessionProvider({ backend: "tmux" }), null);
  assert.equal(sessionProvider({}), null);
  assert.equal(sessionProvider(null), null);
  // Herdr first: a row OATS can no longer run is never a provider's.
  assert.equal(sessionProvider({ backend: "herdr" }), null);
  assert.equal(sessionProvider({ backend: "bb", sessionTarget: { backend: "herdr" } }), null);
  assert.equal(sessionProvider({ backend: "bb", runtimeState: "unsupported" }), null);
  assert.deepEqual(openLink({ open: LINK }), LINK);
  assert.equal(openLink({}), null);
  assert.equal(openLink(null), null);
  assert.equal(sessionThreadId({ session: { threadId: "thr_x" } }), "thr_x");
  for (const session of [undefined, null, {}, { endpoint: ENDPOINT }, { threadId: "" }, { threadId: 7 }, { threadId: "x".repeat(201) }]) assert.equal(sessionThreadId({ session }), null);
});

test("the backend names the kernel lists: its own from the probe, a soul's session providers from its inspection, and nothing else", () => {
  // The inspection's list: rows naming a provider; only names the contract allows, each once; never herdr.
  assert.deepEqual(sessionProviderNames({ sessionProviders: [{ name: "bb", capability: "oats.bb" }, { name: "other" }, { name: "bb" }] }), ["bb", "other"]);
  assert.deepEqual(sessionProviderNames({ sessionProviders: [{ name: "tmux" }, { name: "session-provider" }, { name: "herdr" }, { name: "Not A Name" }, { name: "--json" }, { name: 7 }, null, 7, { capability: "x" }, "bb"] }), []);
  for (const inspection of [null, undefined, {}, { sessionProviders: null }, { sessionProviders: "bb" }, { sessionProviders: { bb: { capability: "oats.bb" } } }, "bb", []]) assert.deepEqual(sessionProviderNames(inspection), [], JSON.stringify(inspection));
  assert.deepEqual(sessionBackendNames({ sessionBackends: ["tmux", "herdr"] }, { sessionProviders: [{ name: "herdr" }, { name: "bb" }] }), ["tmux", "bb"]);
  // With the probe's own list first; "tmux" alone for a probe record without one; never herdr.
  assert.deepEqual(sessionBackendNames({ sessionBackends: ["tmux"] }), ["tmux"]);
  assert.deepEqual(sessionBackendNames({ sessionBackends: ["tmux", "herdr"] }, { sessionProviders: [{ name: "bb" }] }), ["tmux", "bb"]);
  assert.deepEqual(sessionBackendNames({}, { sessionProviders: [{ name: "bb" }] }), ["tmux", "bb"]);
  assert.deepEqual(sessionBackendNames(null), ["tmux"]);
  assert.deepEqual(sessionBackendNames({ sessionBackends: [] }), [], "a kernel that lists none offers none");
  assert.deepEqual(sessionBackendNames({ sessionBackends: ["tmux", 7, "", null] }), ["tmux"]);
  // What the list is for: a spawn's --backend is held to it.
  const backends = sessionBackendNames({ sessionBackends: ["tmux"] }, { sessionProviders: [{ name: "bb" }] });
  assert.ok(spawnArgv("dev", "/ws", "/t", { backend: "bb", backends }).includes("bb"));
  assert.throws(() => spawnArgv("dev", "/ws", "/t", { backend: "bb", backends: sessionBackendNames({ sessionBackends: ["tmux"] }) }), /invalid backend value/);
});

// Needs input and Home: a provider's `runtimeState` is its own word ("unknown" while it runs), and an agent that
// waits on a person is idle, which the kernel reports as `running: null`.
const CLAIM = { since: "2026-11-19T10:00:00.000Z", producer: "claude-hook", reason: "question", message: "Which branch?" };

test("needs input on a provider row: the kernel's claim shows unless the row is stopped, under the stale and unreached rules; a tmux row's gate is as it was", () => {
  const bb = (extra) => ({ instance: "dev-a", backend: "bb", tmux: null, waitingOnYou: CLAIM, ...extra });
  for (const state of [{ running: true, runtimeState: "unknown" }, { running: null, runtimeState: "unknown" }, { running: null, runtimeState: "unreachable" }, { running: null }, { running: true }])
    assert.deepEqual(waitingClaim(bb(state)), CLAIM, JSON.stringify(state));
  for (const state of [{ running: false, runtimeState: "stopped" }, { running: false, runtimeState: "shell" }, { running: false }]) assert.equal(waitingClaim(bb(state)), null, JSON.stringify(state));
  // Currency, as for any row: a stale roster, an unreached server.
  assert.equal(waitingClaim(bb({ running: null, runtimeState: "unknown" }), { stale: true }), null);
  assert.equal(waitingClaim(bb({ running: true, server: "host", serverUnreached: true })), null);
  // No claim, a null one or a malformed one is none.
  for (const waitingOnYou of [undefined, null, {}, "waiting"]) assert.equal(waitingClaim(bb({ running: null, waitingOnYou })), null);
  // A tmux row, named or not: running and no state but "running", exactly as before.
  for (const backend of [undefined, "tmux", "", 7]) {
    const tmux = (extra) => ({ instance: "dev-t", ...(backend === undefined ? {} : { backend }), waitingOnYou: CLAIM, ...extra });
    assert.deepEqual(waitingClaim(tmux({ running: true, runtimeState: "running" })), CLAIM, String(backend));
    assert.deepEqual(waitingClaim(tmux({ running: true })), CLAIM, String(backend));
    for (const state of [{ running: null, runtimeState: "unknown" }, { running: null }, { running: true, runtimeState: "unknown" }, { running: true, runtimeState: "shell" }, { running: false }])
      assert.equal(waitingClaim(tmux(state)), null, `${backend} ${JSON.stringify(state)}`);
  }
  // A Herdr-recorded row is no provider's: never a claim.
  assert.equal(waitingClaim({ instance: "dev-h", backend: "herdr", running: null, runtimeState: "unsupported", waitingOnYou: CLAIM }), null);
});

test("Home's board: a provider row that runs is Running on `running: true` alone, one that waits is in Needs you, a stopped or idle one is on neither; tmux rows as before", () => {
  const row = (instance, extra) => ({ instance, home: home(instance), createdAt: "2026-11-19T09:00:00.000Z", ...extra });
  const rows = [
    row("bb-run", { backend: "bb", running: true, runtimeState: "unknown" }),
    row("bb-idle", { backend: "bb", running: null, runtimeState: "unknown" }),
    row("bb-waiting", { backend: "bb", running: null, runtimeState: "unknown", waitingOnYou: CLAIM }),
    row("bb-stopped", { backend: "bb", running: false, runtimeState: "stopped", waitingOnYou: CLAIM }),
    row("bb-far", { backend: "bb", running: true, runtimeState: "unknown", server: "host", serverUnreached: true }),
    row("tmux-run", { running: true, runtimeState: "running" }),
    row("tmux-shell", { running: true, runtimeState: "shell" }),
    row("tmux-odd", { backend: "tmux", running: true, runtimeState: "unknown" }),
  ];
  const board = homeBoard(rows);
  assert.deepEqual(board.running.map((each) => each.instance).sort(), ["bb-run", "tmux-run"]);
  assert.deepEqual(board.needsYou.map((each) => each.row.instance), ["bb-waiting"]);
});
