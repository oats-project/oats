// Which acts a roster row offers (packages/client/instance-acts.mjs): the decision every client draws its
// own menu from. Pure: a row in, verbs and reasons out; no label, icon or key.
import test from "node:test";
import assert from "node:assert/strict";
import { instanceActs, openAct } from "../../client/instance-acts.mjs";
import { heldHome } from "../../client/instance-tree.mjs";
import { unsupportedSession } from "../../client/instance-presentation.mjs";
import { rowReason } from "../../client/remote-address.mjs";
import { ROWS, RETIRE_INTERRUPTED } from "./helpers/instance-menu-probe.mjs";
import { remotePanel, unavailableGroups } from "../../client/remote-roster.mjs";
import { parseEnvelope } from "../../client/cli-adapter.mjs";
import { kernelRemoteRow, kernelRemoteGroup } from "./helpers/kernel-remote-row.mjs";

const VERBS = ["inspect", "start", "restart", "stop", "retire"];
const LOCAL = { instance: "dev-one", home: "/agents/dev/instances/dev-one" };
const REMOTE = { ...LOCAL, home: "/remote/dev-one", server: "host", repoName: "Build box", addressable: true };
const HERDR = "E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend. (dev-one)";
const on = (verb) => ({ verb, enabled: true, reason: null });
const offered = (acts) => ({ blocked: null, limited: null, acts });
const verbsOf = (row) => instanceActs(row).acts.map((act) => act.verb);

test("a row that runs, is stopped, or whose liveness is unknown: inspect, its launch act, stop, retire, in that order", () => {
  assert.deepEqual(instanceActs({ ...LOCAL, running: true }), offered([on("inspect"), on("restart"), on("stop"), on("retire")]));
  assert.deepEqual(instanceActs({ ...LOCAL, running: false }), offered([on("inspect"), on("start"), on("stop"), on("retire")]));
  // Unknown is neither: no launch act is offered for a row whose liveness nobody reported.
  for (const running of [null, undefined, "yes", 1]) assert.deepEqual(instanceActs({ ...LOCAL, running }), offered([on("inspect"), on("stop"), on("retire")]));
  assert.deepEqual(instanceActs({ ...LOCAL }), offered([on("inspect"), on("stop"), on("retire")]));
  // A remote row the kernel reports addressable is offered what a local one is.
  assert.deepEqual(instanceActs({ ...REMOTE, running: true }), instanceActs({ ...LOCAL, running: true }));
  // A local kernel before 0.31 reports no `addressable`: a row it spawned keeps its saved route.
  assert.deepEqual(verbsOf({ ...REMOTE, addressable: undefined, savedRoute: true, running: false }), ["inspect", "start", "stop", "retire"]);
});

test("a session backend OATS no longer has: Start is listed, not enabled, with the kernel's reason; never Restart; the rest as usual", () => {
  const rows = [{ ...LOCAL, running: null, runtimeState: "unsupported", runtimeError: HERDR },
    { ...LOCAL, running: true, sessionTarget: "herdr:pane-1" }, { ...REMOTE, running: true, backend: "herdr" }, { ...LOCAL, running: false, backend: "herdr" }];
  // The first row's sentence is its own text, beside no speaker: `origin: "unattributed"` (#982). The others' is the stand-in, this home's own: no origin.
  for (const [row, origin] of [[rows[0], { origin: "unattributed" }], [rows[1], {}], [rows[2], {}], [rows[3], {}]]) {
    const sentence = unsupportedSession(row);
    assert.ok(sentence, "the shared table has a sentence for this row");
    assert.deepEqual(instanceActs(row), offered([on("inspect"), { verb: "start", enabled: false, reason: { code: "unsupported-session", sentence, ...origin } }, on("stop"), on("retire")]));
  }
  assert.equal(instanceActs(rows[0]).acts[1].reason.sentence, HERDR, "the kernel's own text when it sent one");
});

test("a home the kernel holds: nothing while it spawns, Retire alone when a spawn or a retire left it half cleaned, Retire secondary while it is retired", () => {
  const spawning = { ...LOCAL, running: false, spawnInProgress: true };
  assert.deepEqual(instanceActs(spawning), { blocked: { code: "held", kind: "spawning", sentence: "dev-one is setting up its worktree. It can't be used until the spawn finishes." }, limited: null, acts: [] });
  assert.deepEqual(instanceActs({ ...LOCAL, running: false, rollbackIncomplete: true }),
    { blocked: null, limited: { code: "held", kind: "spawn-incomplete", sentence: "The spawn of dev-one didn't finish. Retire it to clean up." }, acts: [on("retire")] });
  assert.deepEqual(instanceActs({ ...LOCAL, running: true, retire: RETIRE_INTERRUPTED }),
    { blocked: null, limited: { code: "held", kind: "retire-incomplete", sentence: "The retire of dev-one didn't finish. Retire it again to complete." }, acts: [on("retire")] });
  // #1247: a retire that runs (or an older kernel's bare retirePending): Retire stays offered, enabled, but secondary.
  assert.deepEqual(instanceActs({ ...LOCAL, running: true, retirePending: true }),
    { blocked: null, limited: { code: "held", kind: "retiring", sentence: "dev-one is being retired." }, acts: [{ ...on("retire"), secondary: true }] });
  // The kind is the held home's own (instance-tree.mjs heldHome): a spawn that is gone wins over a live one, a live one over a pending retire.
  assert.equal(instanceActs({ ...LOCAL, rollbackIncomplete: true, spawnInProgress: true }).limited.kind, "spawn-incomplete");
  assert.equal(instanceActs({ ...LOCAL, spawnInProgress: true, retirePending: true }).blocked.kind, "spawning");
  for (const row of [spawning, { ...LOCAL, rollbackIncomplete: true }, { ...LOCAL, retirePending: true }, { ...LOCAL, retire: RETIRE_INTERRUPTED }]) {
    const { blocked, limited } = instanceActs(row), held = heldHome(row);
    assert.deepEqual(blocked ?? limited, { code: "held", kind: held.kind, sentence: held.sentence(row.instance) }, "the sentence is the held home's");
  }
  // `spawnInProgress` is true or nothing: only the kernel's boolean holds a home.
  assert.deepEqual(verbsOf({ ...LOCAL, running: false, spawnInProgress: "true" }), ["inspect", "start", "stop", "retire"]);
});

test("a remote row the kernel does not report addressable: blocked with the row's reason and its key, no acts", () => {
  const cases = [
    [{ ...REMOTE, addressable: false, running: true }, "unaddressable", "Build box did not report this instance as reachable."],
    [{ ...REMOTE, addressable: undefined, running: true }, "unaddressable", "This computer's OATS does not report whether Build box can reach this instance. Update OATS here."],
    [{ ...REMOTE, addressable: false, savedRoute: true, missingRemotely: true }, "missing", "dev-one is no longer on Build box. Remove it from this computer with: oats server forget host --instance dev-one"],
    // The row's own text beside no speaker: `origin: "unattributed"` (#982). Every other sentence here is this home's own.
    [{ ...REMOTE, addressable: false, serverUnreached: true, runtimeError: "ssh: connect to host timed out" }, "unreached", "ssh: connect to host timed out", { origin: "unattributed" }],
    [{ ...REMOTE, addressable: false, serverUnreached: true }, "unreached", "Build box was not reached."],
    [{ ...REMOTE, addressable: false, backend: "herdr" }, "herdr", "E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend."],
  ];
  for (const [row, key, sentence, origin = {}] of cases) {
    assert.deepEqual(instanceActs(row), { blocked: { code: "unaddressable", key, sentence, ...origin }, limited: null, acts: [] });
    assert.equal(rowReason(row).key, key); assert.equal(rowReason(row).sentence, sentence, "the sentence is the row reason's");
  }
});

// ── Who made a reason's sentence (#982) ──────────────────────────────────────
const ORIGINS = ["kernel", "terminal-probe", "roster-read"];

test("both of instanceActs' reasons pass \"unattributed\" on from the row reason: the row's text beside no speaker, a mark that is none of the three, a text that is not a string", () => {
  for (const mark of [{}, { runtimeErrorOrigin: "someone-else" }, { runtimeErrorOrigin: "unattributed" }, { runtimeErrorOrigin: "a\u001b[2Jb" }, { runtimeErrorOrigin: null }]) {
    for (const text of ["the text the row carries", "wipe \u001b[2J the screen", "token: abc123"]) {
      const blocked = instanceActs({ ...REMOTE, addressable: false, serverUnreached: true, runtimeError: text, ...mark });
      assert.deepEqual(blocked, { blocked: { code: "unaddressable", key: "unreached", sentence: text, origin: "unattributed" }, limited: null, acts: [] }, JSON.stringify(mark));
      const start = instanceActs({ ...LOCAL, running: null, runtimeState: "unsupported", runtimeError: text, ...mark }).acts[1];
      assert.deepEqual(start, { verb: "start", enabled: false, reason: { code: "unsupported-session", sentence: text, origin: "unattributed" } }, JSON.stringify(mark));
    }
  }
  // A truthy text that is not a string (another machine's row is spread whole): the reason is as on the base, and it is unattributed whatever key stands beside it.
  for (const text of [7, true, { message: "x" }, ["x"]]) for (const mark of [{}, { runtimeErrorOrigin: "kernel" }]) {
    const { blocked } = instanceActs({ ...REMOTE, addressable: false, serverUnreached: true, runtimeError: text, ...mark });
    assert.deepEqual(blocked, { code: "unaddressable", key: "unreached", sentence: text, origin: "unattributed" }, JSON.stringify(text));
  }
});

test("the unaddressable reason passes the row reason's origin on, and has none when the row reason has none", () => {
  for (const origin of ORIGINS) {
    const own = { runtimeError: "the text the row carries", runtimeErrorOrigin: origin };
    assert.deepEqual(instanceActs({ ...REMOTE, addressable: false, serverUnreached: true, ...own }),
      { blocked: { code: "unaddressable", key: "unreached", sentence: "the text the row carries", origin }, limited: null, acts: [] });
    assert.deepEqual(instanceActs({ ...REMOTE, addressable: false, running: null, runtimeState: "unsupported", ...own }),
      { blocked: { code: "unaddressable", key: "herdr", sentence: "the text the row carries", origin }, limited: null, acts: [] });
    // Sentences written for the row carry no origin, whatever the row's key says.
    for (const [row, key] of [[{ ...REMOTE, addressable: false, running: true, ...own }, "unaddressable"], [{ ...REMOTE, addressable: false, missingRemotely: true, ...own }, "missing"],
      [{ ...REMOTE, addressable: false, serverUnreached: true, runtimeErrorOrigin: origin }, "unreached"], [{ ...REMOTE, addressable: false, backend: "herdr", ...own }, "herdr"]]) {
      const { blocked } = instanceActs(row);
      assert.deepEqual([blocked.key, Object.hasOwn(blocked, "origin")], [key, false], `${origin}: ${key}`);
      assert.equal(blocked.sentence, rowReason(row).sentence);
    }
  }
});

test("Start's unsupported-session reason carries the origin under the same rule: the kernel's own text has its speaker, the stand-in has none", () => {
  for (const origin of ORIGINS) {
    const { acts } = instanceActs({ ...LOCAL, running: null, runtimeState: "unsupported", runtimeError: HERDR, runtimeErrorOrigin: origin });
    assert.deepEqual(acts[1], { verb: "start", enabled: false, reason: { code: "unsupported-session", sentence: HERDR, origin } });
    // An older kernel's row: its runtimeError is a Herdr probe's, the sentence is the stand-in, and no key makes it a speaker's.
    for (const row of [{ ...LOCAL, running: true, sessionTarget: "herdr:pane-1", runtimeError: "spawn herdr ENOENT", runtimeErrorOrigin: origin }, { ...REMOTE, running: true, backend: "herdr", runtimeErrorOrigin: origin }]) {
      const reason = instanceActs(row).acts[1].reason;
      assert.deepEqual(reason, { code: "unsupported-session", sentence: unsupportedSession(row) }, JSON.stringify(row));
    }
  }
  // The kernel's text beside no key, or one that names no speaker: the sentence as it is, and `origin: "unattributed"`,
  // the row reason's own value passed on, never the row's key.
  for (const runtimeErrorOrigin of [undefined, "someone-else", "unattributed", "__proto__", 7, null]) {
    assert.deepEqual(instanceActs({ ...LOCAL, running: null, runtimeState: "unsupported", runtimeError: HERDR, runtimeErrorOrigin }).acts[1].reason,
      { code: "unsupported-session", sentence: HERDR, origin: "unattributed" }, String(runtimeErrorOrigin));
  }
  // A held reason never has one.
  for (const row of [{ ...LOCAL, spawnInProgress: true, runtimeError: "a text", runtimeErrorOrigin: "kernel" }, { ...LOCAL, rollbackIncomplete: true, running: false, runtimeError: "a text", runtimeErrorOrigin: "kernel" }]) {
    const { blocked, limited } = instanceActs(row);
    assert.equal(Object.hasOwn(blocked ?? limited, "origin"), false);
  }
});

test("a kept row of a machine that was not reached, in the kernel's form: with addressable true it lists its acts as before; with addressable false it is blocked with the row's text and its speaker", () => {
  const printed = (error) => parseEnvelope(JSON.stringify({ schemaVersion: 1, ok: false, error })).error;
  const kept = (row, error) => remotePanel(unavailableGroups([kernelRemoteGroup([row])], error)[0], "2026-10-11T12:00:00.000Z").instances[0];
  for (const [error, text, origin] of [[printed({ code: "E_SSH", message: "ssh: connect to host build: No route to host" }), "ssh: connect to host build: No route to host", "kernel"],
    [{ code: "E_REMOTE_ROSTER", message: "Remote roster unavailable: spawn oats ENOENT" }, "Remote roster unavailable: spawn oats ENOENT", "roster-read"], [undefined, "Server is unreachable", "roster-read"]]) {
    // The kernel's form: `addressable: true` on a row it listed. The row carries the facts; the acts are the base's.
    const reachable = kept(kernelRemoteRow("dev-one"), error);
    assert.deepEqual([reachable.serverUnreached, reachable.running, reachable.runtimeError, reachable.runtimeErrorOrigin], [true, null, text, origin]);
    assert.deepEqual(instanceActs(reachable), offered([on("inspect"), on("stop"), on("retire")]), "no blocked reason: running is unknown, so no launch act");
    // `addressable: false`: blocked, key unreached, the row's text as the sentence, and who made it.
    const blocked = kept(kernelRemoteRow("dev-one", { addressable: false }), error);
    assert.deepEqual(instanceActs(blocked), { blocked: { code: "unaddressable", key: "unreached", sentence: text, origin }, limited: null, acts: [] });
  }
});

test("precedence: not addressable, then held, then an unsupported session", () => {
  const unaddressable = { ...REMOTE, addressable: false, running: true };
  // Not addressable and held, every kind: the row's reason, never the held home's, and no Retire.
  for (const hold of [{ spawnInProgress: true }, { rollbackIncomplete: true }, { retirePending: true }]) {
    const row = { ...unaddressable, ...hold };
    assert.ok(heldHome(row), "the home is held");
    assert.deepEqual(instanceActs(row), { blocked: { code: "unaddressable", key: "unaddressable", sentence: "Build box did not report this instance as reachable." }, limited: null, acts: [] });
  }
  // Held and an unsupported session: the hold decides; Start with its reason is not listed.
  assert.deepEqual(instanceActs({ ...LOCAL, rollbackIncomplete: true, runtimeState: "unsupported", runtimeError: HERDR }).acts, [on("retire")]);
  assert.equal(instanceActs({ ...LOCAL, spawnInProgress: true, runtimeState: "unsupported", runtimeError: HERDR }).blocked.code, "held");
  // All three at once: not addressable wins. Its key is the row reason's own, which names the removed backend first.
  for (const hold of [{ spawnInProgress: true }, { rollbackIncomplete: true }, { retirePending: true }]) {
    const all = instanceActs({ ...unaddressable, ...hold, runtimeState: "unsupported", runtimeError: HERDR });
    assert.deepEqual(all, { blocked: { code: "unaddressable", key: "herdr", sentence: HERDR, origin: "unattributed" }, limited: null, acts: [] });
  }
});

test("the answer's shape, on every row the menu's parity test draws: blocked and limited never both, a blocked row has no acts", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    const frozen = Object.freeze({ ...row }), answer = instanceActs(frozen);
    assert.deepEqual(Object.keys(answer), ["blocked", "limited", "acts"], name);
    assert.ok(!(answer.blocked && answer.limited), `${name}: blocked and limited are never both set`);
    if (answer.blocked) assert.deepEqual(answer.acts, [], `${name}: a blocked row offers nothing`);
    else assert.ok(answer.acts.length > 0, `${name}: a row that is not blocked offers something`);
    if (answer.limited) assert.ok(answer.acts.length < 3, `${name}: a limited row offers fewer acts than a home normally does`);
    assert.deepEqual(answer.acts.map((act) => act.verb), [...new Set(answer.acts.map((act) => act.verb))], `${name}: no verb twice`);
    for (const act of answer.acts) {
      assert.deepEqual(Object.keys(act), ["verb", "enabled", "reason"], name);
      assert.ok(VERBS.includes(act.verb), `${name}: ${act.verb} is one of the five verbs`);
      assert.equal(act.enabled, act.reason === null, `${name}: an act is enabled exactly when it has no reason`);
    }
    for (const reason of [answer.blocked, answer.limited, ...answer.acts.map((act) => act.reason)].filter(Boolean)) {
      assert.ok(["unaddressable", "held", "unsupported-session"].includes(reason.code), `${name}: ${reason.code}`);
      // `origin` (#982) is there exactly when the sentence is the row's own text and not this home's stand-in; a held reason never has one.
      const quoted = reason.code !== "held" && reason.sentence === row.runtimeError && reason.sentence !== unsupportedSession({ backend: "herdr" });
      assert.deepEqual(Object.keys(reason), [...{ unaddressable: ["code", "key", "sentence"], held: ["code", "kind", "sentence"], "unsupported-session": ["code", "sentence"] }[reason.code], ...(quoted ? ["origin"] : [])], name);
      if (quoted) assert.ok(["kernel", "terminal-probe", "roster-read", "unattributed"].includes(reason.origin), `${name}: ${reason.origin}`);
      assert.ok(typeof reason.sentence === "string" && reason.sentence.length > 0, `${name}: a reason has a sentence`);
    }
    assert.deepEqual(instanceActs(frozen), answer, `${name}: the same row answers the same`);
  }
});

test("no sentence it returns names the Desktop, its window or its menus", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    const { blocked, limited, acts } = instanceActs(row);
    for (const reason of [blocked, limited, ...acts.map((act) => act.reason)].filter(Boolean))
      assert.doesNotMatch(reason.sentence, /\b(desktop|window|menu|sidebar|click|tab)\b/i, `${name}: ${reason.sentence}`);
  }
});

/* ── openAct: whether a row's terminal can be opened, and why not. It is read from instanceActs' answer,
 *    and of the row only from whether it runs on a session provider (the last tests); it is not one of that
 *    answer's acts. ── */
const NO_TERMINAL = "No live terminal is reported.";
const closed = (reason) => ({ verb: "open", enabled: false, reason });

test("openAct, row by row: a row that runs opens; a stopped one and one whose liveness is unknown do not, each with its own code and one sentence", () => {
  assert.deepEqual(openAct({ ...LOCAL, running: true }), { verb: "open", enabled: true, reason: null });
  assert.deepEqual(openAct({ ...LOCAL, running: false }), closed({ code: "not-running", sentence: NO_TERMINAL }));
  for (const running of [null, undefined, "yes", 1]) assert.deepEqual(openAct({ ...LOCAL, running }), closed({ code: "state-unknown", sentence: NO_TERMINAL }), String(running));
  assert.deepEqual(openAct({ ...LOCAL }), closed({ code: "state-unknown", sentence: NO_TERMINAL }));
  // A remote row the kernel reports addressable answers as a local one does, and so does a saved route on a kernel that reports none.
  for (const running of [true, false, null]) assert.deepEqual(openAct({ ...REMOTE, running }), openAct({ ...LOCAL, running }), String(running));
  assert.deepEqual(openAct({ ...REMOTE, addressable: undefined, savedRoute: true, running: false }), closed({ code: "not-running", sentence: NO_TERMINAL }));
});

test("openAct on a session backend OATS no longer has: not enabled, with the reason the Start act carries, its origin included when it has one", () => {
  const rows = [{ ...LOCAL, running: null, runtimeState: "unsupported", runtimeError: HERDR },
    { ...LOCAL, running: true, sessionTarget: "herdr:pane-1" }, { ...REMOTE, running: true, backend: "herdr" }, { ...LOCAL, running: false, backend: "herdr" }];
  for (const row of rows) {
    const start = instanceActs(row).acts.find((act) => act.verb === "start");
    assert.equal(start.reason.code, "unsupported-session");
    assert.deepEqual(openAct(row), closed(start.reason));
  }
  // The kernel's own text carries its mark on; the stand-in, this home's own, has none. A row that runs on such a backend still opens nothing.
  assert.deepEqual(openAct(rows[0]).reason, { code: "unsupported-session", sentence: HERDR, origin: "unattributed" });
  assert.deepEqual(Object.keys(openAct(rows[1]).reason), ["code", "sentence"]);
  assert.equal(openAct(rows[1]).enabled, false);
});

test("openAct is null exactly when instanceActs answers blocked or limited: such a row says why itself, and a client adds no act to it", () => {
  for (const row of [{ ...LOCAL, running: false, spawnInProgress: true }, { ...LOCAL, running: false, rollbackIncomplete: true }, { ...LOCAL, running: true, retirePending: true },
    { ...REMOTE, addressable: false, running: true }, { ...REMOTE, addressable: false, running: true, retirePending: true },
    { ...LOCAL, rollbackIncomplete: true, runtimeState: "unsupported", runtimeError: HERDR }]) {
    const { blocked, limited } = instanceActs(row);
    assert.ok(blocked || limited, JSON.stringify(row));
    assert.equal(openAct(row), null, JSON.stringify(row));
  }
  let answered = 0, silent = 0;
  for (const [name, row] of Object.entries(ROWS)) {
    const { blocked, limited } = instanceActs(row), open = openAct(row);
    assert.equal(open === null, !!(blocked || limited), name);
    if (open === null) silent += 1; else answered += 1;
  }
  assert.ok(answered > 0 && silent > 0, "the table has rows of both kinds");
});

test("openAct's answer, on every row the menu's parity test draws: one act's shape, and instanceActs' own answer as it was", () => {
  const codes = new Set();
  for (const [name, row] of Object.entries(ROWS)) {
    const frozen = Object.freeze({ ...row }), before = instanceActs(frozen), open = openAct(frozen);
    assert.deepEqual(instanceActs(frozen), before, `${name}: instanceActs answers the same after it`);
    assert.ok(!before.acts.some((act) => act.verb === "open"), `${name}: open is not one of the row's acts`);
    assert.deepEqual(openAct(frozen), open, `${name}: the same row answers the same`);
    if (open === null) continue;
    assert.deepEqual(Object.keys(open), ["verb", "enabled", "reason"], name);
    assert.equal(open.verb, "open", name);
    assert.equal(open.enabled, open.reason === null, `${name}: enabled exactly when it has no reason`);
    // It is read from the row's launch act: Restart listed, Start listed and enabled, Start with its reason, or neither.
    const launch = before.acts.find((act) => act.verb === "restart" || act.verb === "start");
    const expected = !launch ? "state-unknown" : launch.reason ? launch.reason.code : launch.verb === "restart" ? null : "not-running";
    assert.equal(open.reason?.code ?? null, expected, name);
    if (open.reason) {
      codes.add(open.reason.code);
      assert.ok(typeof open.reason.sentence === "string" && open.reason.sentence.length > 0, `${name}: a reason has a sentence`);
      assert.doesNotMatch(open.reason.sentence, /\b(desktop|window|menu|sidebar|click|tab)\b/i, `${name}: ${open.reason.sentence}`);
      if (open.reason.code !== "unsupported-session") assert.deepEqual(open.reason, { code: open.reason.code, sentence: NO_TERMINAL }, name);
    } else codes.add(null);
  }
  assert.deepEqual([...codes].sort(), [null, "not-running", "state-unknown", "unsupported-session"].sort(), "the table draws every answer");
});

test("openAct reads a row that runs in tmux only through instanceActs: it touches no key of the row that instanceActs does not", () => {
  const read = (fn, row) => {
    const keys = new Set(), note = (key) => { if (typeof key === "string") keys.add(key); };
    fn(new Proxy(row, {
      get(target, key, receiver) { note(key); return Reflect.get(target, key, receiver); },
      has(target, key) { note(key); return Reflect.has(target, key); },
      getOwnPropertyDescriptor(target, key) { note(key); return Reflect.getOwnPropertyDescriptor(target, key); },
      ownKeys(target) { keys.add("(all keys)"); return Reflect.ownKeys(target); },
    }));
    return [...keys].sort();
  };
  for (const [name, row] of Object.entries(ROWS)) assert.deepEqual(read(openAct, row), read(instanceActs, row), name);
  // Not vacuous: the reading sees what a row is asked.
  assert.ok(read(instanceActs, ROWS.running).includes("running"));
});

/* ── Session providers (spec C1): a row whose `backend` is a provider's name ("bb") runs in no terminal. Its
 *    acts follow the running table; Open is never enabled, says where the agent runs, and carries the link
 *    the provider offers. ── */
const BB = { ...LOCAL, backend: "bb", tmux: null, session: { provider: "oats.bb", endpoint: { threadId: "thr_x" } } };
const BB_LINK = { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" };
const BB_SENTENCE = "Runs in a bb thread; open it in bb.";

test("A2: a provider row's acts follow the running table; Open is not enabled (no-terminal) and its reason carries the row's link", () => {
  assert.deepEqual(verbsOf({ backend: "bb", running: true }), ["inspect", "restart", "stop", "retire"]);
  const open = openAct({ backend: "bb", running: true });
  assert.equal(open.enabled, false);
  assert.equal(open.reason.code, "no-terminal");
  assert.deepEqual(openAct({ backend: "bb", running: true, open: { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" } }).reason.link,
    { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" });
  assert.deepEqual(verbsOf({ backend: "bb", running: null }), ["inspect", "stop", "retire"]);
});

test("a provider row, state by state: the acts of a tmux row in that state, each enabled; Open the same answer in every state", () => {
  for (const running of [true, false, null, undefined]) {
    assert.deepEqual(instanceActs({ ...BB, running }), instanceActs({ ...LOCAL, running }), String(running));
    assert.deepEqual(openAct({ ...BB, running }), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence: BB_SENTENCE } }, String(running));
    assert.deepEqual(openAct({ ...BB, running, open: BB_LINK }), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence: BB_SENTENCE, link: BB_LINK } }, String(running));
  }
  // The sentence is this home's own (no origin), names the provider, and no client surface.
  assert.equal(openAct({ ...BB, backend: "my-provider-2", running: true }).reason.sentence, "Runs in a my-provider-2 thread; open it in my-provider-2.");
  assert.ok(!Object.hasOwn(openAct({ ...BB, running: true }).reason, "origin"));
});

test("a provider row's link: only an http(s) url with no credentials and a label, only on a row of this machine; anything else is the sentence alone", () => {
  const linkOf = (row) => openAct({ ...BB, running: true, ...row }).reason.link;
  assert.deepEqual(linkOf({ open: { label: "Open in bb", url: "https://bb.example/t/1", extra: 1 } }), { label: "Open in bb", url: "https://bb.example/t/1" });
  for (const open of [null, undefined, "http://127.0.0.1/", [], {}, { label: "Open", url: "file:///etc/passwd" }, { label: "Open", url: "javascript:alert(1)" },
    { label: "Open", url: "not a url" }, { label: "", url: "http://127.0.0.1/" }, { label: 7, url: "http://127.0.0.1/" }, { label: "Open" },
    { label: "Open", url: "http://user:pw@127.0.0.1/" }, { label: "Open", url: "http://user@127.0.0.1/" },
    { label: "x".repeat(201), url: "http://127.0.0.1/" }, { label: "Open", url: `http://127.0.0.1/${"x".repeat(2048)}` }]) {
    assert.equal(linkOf({ open }), undefined, JSON.stringify(open)?.slice(0, 80));
    assert.deepEqual(openAct({ ...BB, running: true, open }).reason, { code: "no-terminal", sentence: BB_SENTENCE });
  }
  // Another machine's row: the url is that host's own loopback, so no link; the reason stands.
  assert.deepEqual(openAct({ ...REMOTE, backend: "bb", running: true, open: BB_LINK }), { verb: "open", enabled: false, reason: { code: "no-terminal", sentence: BB_SENTENCE } });
  assert.deepEqual(verbsOf({ ...REMOTE, backend: "bb", running: true }), ["inspect", "restart", "stop", "retire"]);
});

test("which rows are a provider's: no backend, \"tmux\" and a value that is no provider name open as before; a held or unaddressable provider row says its own reason", () => {
  for (const backend of [undefined, null, "tmux", "", "Not A Name", "bb!", "x".repeat(41), 7]) {
    assert.deepEqual(openAct({ ...LOCAL, backend, running: true, open: BB_LINK }), { verb: "open", enabled: true, reason: null }, String(backend));
    assert.deepEqual(openAct({ ...LOCAL, backend, running: false }), closed({ code: "not-running", sentence: NO_TERMINAL }), String(backend));
  }
  assert.equal(openAct({ ...BB, running: false, spawnInProgress: true }), null);
  assert.equal(openAct({ ...BB, running: true, rollbackIncomplete: true }), null);
  assert.equal(openAct({ ...REMOTE, backend: "bb", addressable: false, running: true }), null);
});

test("A3: a Herdr-recorded row answers as it did before session providers, whatever else it carries", () => {
  const stem = "E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.";
  const start = { verb: "start", enabled: false, reason: { code: "unsupported-session", sentence: stem } };
  for (const row of [{ ...LOCAL, running: true, sessionTarget: "herdr:pane-1" }, { ...REMOTE, running: true, backend: "herdr" }, { ...LOCAL, running: false, backend: "herdr" },
    { ...LOCAL, running: true, backend: "bb", sessionTarget: { backend: "herdr" }, open: BB_LINK }, { ...LOCAL, running: true, backend: "herdr", open: BB_LINK },
    { ...LOCAL, running: null, backend: "bb", runtimeState: "unsupported", open: BB_LINK }]) {
    assert.deepEqual(instanceActs(row), offered([on("inspect"), start, on("stop"), on("retire")]), JSON.stringify(row));
    assert.deepEqual(openAct(row), closed(start.reason), JSON.stringify(row));
  }
  // The kernel's own text, when it sent one, as before.
  const own = { ...LOCAL, running: null, backend: "bb", runtimeState: "unsupported", runtimeError: HERDR, open: BB_LINK };
  assert.deepEqual(openAct(own), closed({ code: "unsupported-session", sentence: HERDR, origin: "unattributed" }));
});
