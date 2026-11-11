// CLI locator (packages/client/cli-locator.mjs) — Desktop CLI API v1
// discovery order, canonicalization, acceptance, and stable diagnostics.
import { requireRemoteSupport } from "../../client/cli-locator.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { readFileSync } from "node:fs";
import {
  acceptProbe, parseSemver, parseProbeStdout, candidates, discover as locatorDiscover, cliRecord, DESKTOP_API,
  ACCEPT_RANGE, acceptRangeText, testedBound, testedThroughText, PROBE_NAME,
} from "../../client/cli-locator.mjs";

const PROBE = (v = "0.26.0") => ({ schemaVersion: 1, name: "@awebai/oats", version: v, desktopApi: 1 });
// This Desktop's own release version: its tested bound (#1879). The tests that are not about the bound judge
// against it, as the server does (oats-web.mjs cliIo.testedVersion); the bound's own tests name versions.
const DESKTOP = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const accept = (payload) => acceptProbe(payload, DESKTOP);
const discover = (io, probe) => locatorDiscover({ testedVersion: DESKTOP, ...io }, probe);

test("acceptProbe: either npm name of the CLI is the oats CLI, and a refusal lists both", () => {
  assert.deepEqual(PROBE_NAME, ["@awebai/oats", "@oats-project/oats"]);
  for (const name of PROBE_NAME) assert.equal(accept({ ...PROBE(), name }).ok, true, name);
  const refused = accept({ ...PROBE(), name: "@other/oats" });
  assert.equal(refused.ok, false);
  for (const name of [...PROBE_NAME, "@other/oats"]) assert.ok(refused.reason.includes(name), refused.reason);
  assert.equal(accept({ ...PROBE(), name: undefined }).ok, false);
});

test("acceptProbe: exact v1 payload accepted; every deviation rejected with a reason", () => {
  assert.equal(accept(PROBE()).ok, true);
  assert.equal(accept(PROBE("0.26.0")).ok, true, "the 0.26 kernel line is inside the band");
  assert.equal(accept(PROBE("0.26.12")).ok, true);
  const cases = [
    [null, /no probe/],
    [{ ...PROBE(), schemaVersion: 2 }, /schemaVersion/],
    [{ ...PROBE(), name: "@other/pkg" }, /not the oats CLI/],
    [{ ...PROBE(), desktopApi: 2 }, /desktopApi 2/],
    [{ ...PROBE(), desktopApi: undefined }, /desktopApi missing/],
    [PROBE("0.25.9"), /outside/],
    [PROBE("not-a-version"), /unparsable/],
  ];
  for (const [payload, re] of cases) {
    const r = accept(payload);
    assert.equal(r.ok, false, JSON.stringify(payload));
    assert.match(r.reason, re);
  }
});

test("acceptProbe: API version is authoritative — a 0.22.x CLI without desktopApi is rejected", () => {
  // Source adjacency / same version number is NOT enough: the probe field decides.
  const r = accept({ schemaVersion: 1, name: "@awebai/oats", version: "0.26.0" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /desktopApi/);
});

test("parseSemver handles pre-release/build suffixes and rejects garbage", () => {
  assert.deepEqual(parseSemver("0.18.0"), { nums: [0, 18, 0], prerelease: false });
  assert.deepEqual(parseSemver("0.18.1-rc.1"), { nums: [0, 18, 1], prerelease: true });
  assert.deepEqual(parseSemver("0.18.0+build.5"), { nums: [0, 18, 0], prerelease: false });
  assert.equal(parseSemver("v0.18.0"), null);
  assert.equal(parseSemver(""), null);
});

test("acceptProbe: prereleases are rejected — 0.26.0-rc.1 precedes 0.26.0 (review 53a20c7)", () => {
  for (const v of ["0.25.9-rc.1", "0.25.9-0", "0.25.10-beta.2", "0.26.0-rc.1", "0.26.0-0", "0.26.5-beta.2"]) {
    const r = accept(PROBE(v));
    assert.equal(r.ok, false, v);
    assert.match(r.reason, /prerelease/, v);
  }
  assert.equal(accept(PROBE("0.26.0+build.7")).ok, true, "build metadata does not affect precedence");
});

// Release-gate invariant. Desktop and the kernel ship from ONE tag: an app that held anything back from the
// kernel of its own release would ship degraded (the 0.19.0 blocker was its refusal). Inside its own tested
// bound by construction (#1879): the bound is that version's minor.
test("the kernel version this Desktop ships with is accepted inside its tested bound, with no notice", () => {
  assert.deepEqual(accept(PROBE(DESKTOP)), { ok: true }, `Desktop ${DESKTOP} holds back or refuses the same-version oats CLI`);
});

test("the human-readable range is derived from the enforced floor and the tested bound", () => {
  assert.equal(acceptRangeText("0.69.17"), ">=0.26.0, tested through 0.69");
  assert.equal(acceptRangeText("1.4.0-rc.2"), ">=0.26.0, tested through 1.4");
  assert.equal(acceptRangeText(DESKTOP), `>=${ACCEPT_RANGE.min.join(".")}, tested through ${testedThroughText(testedBound(DESKTOP))}`);
  assert.match(accept(PROBE("0.25.0")).reason, new RegExp(acceptRangeText(DESKTOP).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// The floor, spelled with LITERALS on purpose: it is hand-set (#1879 keeps it), and the feature fences are the
// real gate. There is no ceiling: every released v1 CLI at or above the floor is accepted.
test("floor: 0.25.x is refused; every released v1 CLI from 0.26.0 is accepted (the feature fences are the real gate)", () => {
  // Floor 0.26.0: the first kernel the feature gates let through (it is the
  // first to advertise packages-no-approval); those fences stay the real gate.
  assert.deepEqual(ACCEPT_RANGE, { min: [0, 26, 0] });
  assert.equal(DESKTOP_API, 1, "Desktop API stays v1");
  for (const v of ["0.26.0", "0.26.0+build.7", "0.26.99", "0.40.0", "0.53.0", "0.69.0", "0.69.99", "0.70.0", "0.99.0", "1.0.0"]) {
    assert.equal(acceptProbe(PROBE(v), "0.69.17").ok, true, `${v} must be accepted`);
  }
  for (const v of ["0.22.0", "0.25.0", "0.25.9", "0.25.99"]) {
    const r = acceptProbe(PROBE(v), "0.69.17");
    assert.equal(r.ok, false, `${v} must be rejected`);
    assert.match(r.reason, /outside >=0\.26\.0, tested through 0\.69/, v);
  }
  // a PRERELEASE is never a released kernel, below the bound or above it
  for (const v of ["0.26.0-rc.1", "0.69.18-rc.1", "0.70.0-rc.1"]) {
    const pre = acceptProbe(PROBE(v), "0.69.17");
    assert.equal(pre.ok, false, v);
    assert.match(pre.reason, /prerelease/, v);
  }
});

test("acceptProbe refuses without a tested version: a new caller can never fall back to no bound", () => {
  for (const missing of [undefined, null, "", "not-a-version", 69]) {
    const r = acceptProbe(PROBE(DESKTOP), missing);
    assert.equal(r.ok, false, String(missing));
    assert.match(r.reason, /no tested client version/);
  }
  assert.equal(testedBound(undefined), null);
  assert.deepEqual(testedBound("0.69.17"), [0, 69]);
  assert.deepEqual(testedBound("0.70.0-rc.1"), [0, 70], "a prerelease Desktop tests its release's minor");
});

test("discover refuses every candidate when its io names no tested version", async () => {
  const r = await locatorDiscover({ persisted: () => "/fixture/oats", env: { PATH: "" }, isExecutableFile: () => true, canonicalize: (p) => p },
    async () => ({ stdout: JSON.stringify(PROBE(DESKTOP)) }));
  assert.equal(r.ok, false);
  assert.match(r.tried[0].reason, /no tested client version/);
});

test("0.24 version acceptance does not grant API2 or unadvertised execution capabilities", async () => {
  assert.equal(accept({ ...PROBE("0.26.0"), desktopApi: 2 }).ok, false);
  assert.equal(accept({ ...PROBE("0.26.0"), schemaVersion: 2 }).ok, false);
  const cli = await discover({ persisted: () => "/fixture/oats", env: { PATH: "" }, isExecutableFile: () => true },
    async () => ({ stdout: JSON.stringify(PROBE("0.26.0")) }));
  assert.equal(cli.ok, true); assert.equal(cli.version, "0.26.0");
  assert.throws(() => requireRemoteSupport(cli, "spawn"), { code: "unsupported-remote-operation" });
});

test("parseProbeStdout: only a single JSON object passes", () => {
  assert.deepEqual(parseProbeStdout(JSON.stringify(PROBE())), PROBE());
  assert.equal(parseProbeStdout("oats 0.18.0\n"), null);
  assert.equal(parseProbeStdout('{"a":1}\n{"b":2}'), null);
  assert.equal(parseProbeStdout('"just-a-string"'), null);
});

test("candidates: contract discovery order — persisted, env, PATH, npm-global, login-shell", async () => {
  const io = {
    persisted: () => "/chosen/oats",
    env: { OATS_DESKTOP_OATS_BIN: "/env/oats", PATH: ["/p1", "/p2"].join(delimiter) },
    npmGlobalBin: () => "/npmg/bin",
    loginShellWhich: () => "/login/oats",
  };
  assert.deepEqual(await candidates(io), [
    { path: "/chosen/oats", source: "persisted" },
    { path: "/env/oats", source: "env" },
    { path: "/p1/oats", source: "path" },
    { path: "/p2/oats", source: "path" },
    { path: "/npmg/bin/oats", source: "npm-global" },
    { path: "/login/oats", source: "login-shell" },
  ]);
});

test("candidates: relative and empty entries are dropped (absolute executables only)", async () => {
  const io = {
    persisted: () => "relative/oats",
    env: { OATS_DESKTOP_OATS_BIN: "", PATH: "" },
    npmGlobalBin: () => null,
    loginShellWhich: () => undefined,
  };
  assert.deepEqual(await candidates(io), []);
});

test("discover: expensive sources are LAZY and at-most-once — never invoked when an earlier candidate wins (review 53a20c7)", async () => {
  let npmCalls = 0, shellCalls = 0;
  const io = {
    persisted: () => "/chosen/oats",
    env: { PATH: "" },
    isExecutableFile: () => true,
    canonicalize: (p) => p,
    npmGlobalBin: () => { npmCalls++; return "/npmg/bin"; },
    loginShellWhich: () => { shellCalls++; return "/login/oats"; },
  };
  const r = await discover(io, async () => ({ stdout: JSON.stringify(PROBE()) }));
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/chosen/oats");
  assert.equal(npmCalls, 0, "npm helper never runs when the persisted candidate wins");
  assert.equal(shellCalls, 0, "login-shell helper never runs when the persisted candidate wins");
  // full-failure sweep: each expensive source runs exactly once
  const io2 = {
    env: { PATH: "" },
    isExecutableFile: () => false,
    npmGlobalBin: () => { npmCalls++; return "/npmg/bin"; },
    loginShellWhich: () => { shellCalls++; return "/login/oats"; },
  };
  await discover(io2, async () => ({ stdout: "" }));
  assert.equal(npmCalls, 1, "npm helper invoked exactly once on a full sweep");
  assert.equal(shellCalls, 1, "login-shell helper invoked exactly once on a full sweep");
});

test("discover: a probe that REJECTS is never accepted, even with plausible stdout beforehand (review 53a20c7)", async () => {
  // The server's probeBin rejects on ANY execFile error (nonzero exit,
  // timeout) — discover must record the rejection, not accept the payload.
  const io = {
    persisted: () => "/liar/oats",
    env: { PATH: "" },
    isExecutableFile: () => true,
    canonicalize: (p) => p,
  };
  const probe = async () => { const e = new Error("exit 1 (printed probe then failed)"); throw e; };
  const r = await discover(io, probe);
  assert.equal(r.ok, false);
  assert.match(r.tried[0].reason, /probe failed/);
});

test("discover: first ACCEPTABLE candidate wins — earlier rejects are recorded diagnostics", async () => {
  const io = {
    persisted: () => "/old/oats",                       // probes as 0.20 → rejected
    env: { PATH: "/good" },                            // /good/oats → accepted
    isExecutableFile: () => true,
    canonicalize: (p) => p,
  };
  const probe = async (path) => ({
    stdout: JSON.stringify(path === "/old/oats" ? PROBE("0.21.0") : PROBE("0.26.0")),
  });
  const r = await discover(io, probe);
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/good/oats");
  assert.equal(r.source, "path");
  assert.equal(r.version, "0.26.0");
});

test("discover: full failure returns per-candidate stable diagnostics", async () => {
  const io = {
    persisted: () => "/gone/oats",
    env: { OATS_DESKTOP_OATS_BIN: "/broken/oats", PATH: "/incompat" },
    isExecutableFile: (p) => p !== "/gone/oats",        // persisted: not executable
    canonicalize: (p) => p,
  };
  const probe = async (path) => {
    if (path === "/broken/oats") throw new Error("ENOENT spawn");
    return { stdout: JSON.stringify(PROBE("0.21.5")) }; // incompatible
  };
  const r = await discover(io, probe);
  assert.equal(r.ok, false);
  assert.equal(r.tried.length, 3);
  assert.match(r.tried[0].reason, /not an executable/);
  assert.match(r.tried[1].reason, /probe failed/);
  assert.match(r.tried[2].reason, /outside/);
  assert.equal(r.tried[2].version, "0.21.5", "rejected version surfaces for the degradation card");
  assert.equal(Object.hasOwn(r.tried[2], "newerApi"), false, "below the floor is not a newer API");
});

test("acceptProbe: `newerApi` only for a refusal whose sole failure is an integer desktopApi above this client's", () => {
  const TABLE = [
    ["desktop API 2", { ...PROBE("0.69.3"), desktopApi: 2 }, true],
    ["desktop API 7, above the bound too", { ...PROBE("0.70.0"), desktopApi: 7 }, true],
    ["desktop API 0", { ...PROBE("0.69.3"), desktopApi: 0 }, false],
    ["desktop API missing", { ...PROBE("0.69.3"), desktopApi: undefined }, false],
    ["desktop API as text", { ...PROBE("0.69.3"), desktopApi: "2" }, false],
    ["desktop API 2.5", { ...PROBE("0.69.3"), desktopApi: 2.5 }, false],
    ["desktop API 2, not the oats CLI", { ...PROBE("0.69.3"), desktopApi: 2, name: "@other/pkg" }, false],
    ["desktop API 2, another schema", { ...PROBE("0.69.3"), desktopApi: 2, schemaVersion: 2 }, false],
    ["a version above the bound alone (accepted)", PROBE("0.70.0"), false],
    ["below the floor", PROBE("0.25.9"), false],
  ];
  for (const [name, payload, newer] of TABLE) {
    const r = acceptProbe(payload, "0.69.17");
    if (newer) { assert.equal(r.ok, false, name); assert.equal(r.newerApi, true, name); }
    else assert.equal(Object.hasOwn(r, "newerApi"), false, name);
  }
  assert.equal(Object.hasOwn(acceptProbe(PROBE("0.70.0"), "0.69.17"), "above"), false, "the old flag is gone: a version is never refused for being above");
});

test("discover: an accepted CLI above the bound carries aboveTested and testedThrough; a newer API's refusal carries newerApi on its diagnostics entry", async () => {
  const io = (versions) => ({ persisted: () => null, env: { PATH: Object.keys(versions).map((p) => p.replace(/\/oats$/, "")).join(delimiter) },
    isExecutableFile: () => true, canonicalize: (p) => p, testedVersion: "0.69.17" });
  const payloads = { "/api2/oats": { ...PROBE("0.69.1"), desktopApi: 2 }, "/pre/oats": PROBE("0.70.0-rc.1"), "/above/oats": PROBE("0.70.1") };
  const r = await locatorDiscover(io(payloads), async (path) => ({ stdout: JSON.stringify(payloads[path]) }));
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/above/oats");
  assert.equal(r.aboveTested, true);
  assert.equal(r.testedThrough, "0.69");
  const refused = await locatorDiscover(io({ "/api2/oats": 1, "/pre/oats": 1 }), async (path) => ({ stdout: JSON.stringify(payloads[path]) }));
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.tried.map((t) => [t.path, t.newerApi]), [["/api2/oats", true], ["/pre/oats", undefined]]);
  const inside = await locatorDiscover({ ...io({ "/in/oats": 1 }) }, async () => ({ stdout: JSON.stringify(PROBE("0.69.25")) }));
  assert.equal(inside.ok, true);
  assert.equal(Object.hasOwn(inside, "aboveTested"), false, "inside the bound the record is as before");
  assert.equal(Object.hasOwn(inside, "testedThrough"), false);
});

test("discover: symlinked duplicates canonicalize and probe once", async () => {
  let probes = 0;
  const io = {
    persisted: () => "/usr/local/bin/oats",             // symlink → /real/oats
    env: { PATH: "/real" },
    isExecutableFile: () => true,
    canonicalize: () => "/real/oats",
  };
  const probe = async () => { probes++; return { stdout: JSON.stringify(PROBE()) }; };
  const r = await discover(io, probe);
  assert.equal(r.ok, true);
  assert.equal(r.bin, "/real/oats", "canonical absolute path is what the adapter execs");
  assert.equal(probes, 1, "identical realpath probed once");
});

test(`DESKTOP_API is ${1} (bump requires a contract revision)`, () => {
  assert.equal(DESKTOP_API, 1);
});

/* ── spawn-time relations capability gate (review f921f7d) ── */

test("supportsRelations: older accepted v1 CLIs are NOT relation-capable", async () => {
  const { supportsRelations, RELATIONS_MIN } = await import("../../client/cli-locator.mjs");
  const min = RELATIONS_MIN.join(".");
  assert.equal(supportsRelations("0.18.0"), false, "pre-relations v1 release");
  assert.equal(supportsRelations("0.18.2"), false, "pre-relations v1 release");
  assert.equal(supportsRelations(min), true, "first relation-capable release");
  assert.equal(supportsRelations("0.18.9"), true);
  assert.equal(supportsRelations(`${min}-rc.1`), false, "prereleases never qualify");
  assert.equal(supportsRelations("garbage"), false);
  assert.equal(supportsRelations(undefined), false);
});

test("relationSupportError: related spawns fail closed on old v1 CLIs, plain spawns unaffected", async () => {
  const { relationSupportError, RELATIONS_MIN } = await import("../../client/cli-locator.mjs");
  const oldCli = { ok: true, version: "0.18.0" };
  const newCli = { ok: true, version: RELATIONS_MIN.join(".") };
  // an older v1 CLI ignores unknown spawn options and reports success —
  // sending relation flags to it would silently create an UNRELATED instance
  const err = relationSupportError(oldCli, { relation: "child", relativeTo: "coord-1" });
  assert.ok(err instanceof Error, "related spawn on an old v1 CLI must throw, not degrade silently");
  assert.equal(err.code, "cli-no-relations", "stable code for the spawn form");
  assert.ok(relationSupportError(oldCli, { relativeTo: "coord-1" }), "anchor alone also gates");
  assert.equal(relationSupportError(oldCli, {}), null, "plain spawns keep working on the full v1 range");
  // explicit "unrelated" is the DEFAULT, not a related spawn: the adapter
  // normalizes it to absence and forwards no flags, so it must not be gated
  // on old v1 CLIs (review 9425d6a)
  assert.equal(relationSupportError(oldCli, { relation: "unrelated" }), null,
    "explicit unrelated is a plain spawn on any accepted v1 CLI");
  assert.equal(relationSupportError(oldCli, { relation: "" }), null, "empty relation is a plain spawn");
  assert.ok(relationSupportError(oldCli, { relation: "unrelated", relativeTo: "x" }),
    "a supplied anchor still gates even with relation=unrelated (adapter rejects the pair)");
  assert.equal(relationSupportError(newCli, { relation: "sibling", relativeTo: "x" }), null,
    "relation-capable CLI passes");
});

test("relations floor also covers --relative-root: the last pre-addition releases are NOT relation-capable (review cbd5bb3)", async () => {
  const { supportsRelations, relationSupportError, RELATIONS_MIN } = await import("../../client/cli-locator.mjs");
  // 0.18.5 is the last released CLI predating BOTH the relation flags and
  // the --relative-root qualifier (it shipped from a branch WITHOUT the
  // feature); older v1 CLIs ignore unknown spawn options, so an accepted
  // pre-addition CLI would silently discard the qualifier and could link
  // the wrong same-named anchor.
  for (const v of ["0.18.3", "0.18.4", "0.18.5"]) {
    assert.equal(supportsRelations(v), false, `${v} predates the qualifier — must not receive relation flags`);
    const err = relationSupportError({ ok: true, version: v }, { relation: "child", relativeTo: "x" });
    assert.ok(err && err.code === "cli-no-relations", `${v} fails closed before any relation/qualifier flag is emitted`);
  }
  assert.equal(supportsRelations(RELATIONS_MIN.join(".")), true, "the floor release itself is capable");
});

test("requireRemoteSupport: fails closed on the probe's advertisement, never on inference", () => {
  const cli = { ok: true, bin: "/x/oats", version: "0.22.2", runtimes: ["pi", "claude", "codex"], remote: ["spawn", "retire", "status", "session"] };
  assert.doesNotThrow(() => requireRemoteSupport(cli, "spawn"));
  assert.throws(() => requireRemoteSupport({ ...cli, remote: undefined }, "spawn"), (e) => e.code === "unsupported-remote-operation" && /remote spawn/.test(e.message));
  assert.throws(() => requireRemoteSupport({ ...cli, remote: ["spawn"] }, "session"), /remote session/);
  assert.throws(() => requireRemoteSupport(undefined, "spawn"), /unsupported|does not (route|support)/);
  assert.throws(() => requireRemoteSupport({ ...cli, remote: "spawn" }, "spawn"), /remote spawn/, "a string is not an advertisement");
});

test("discovery retains remote routing capabilities for terminal preflight", async () => {
  const io = { persisted: () => "/bin/oats", env: {}, isExecutableFile: () => true };
  const cli = await discover(io, async () => ({ stdout: JSON.stringify({ ...PROBE(), scheduleApi: 2, remote: ["spawn", "session"] }) }));
  assert.deepEqual(cli.remote, ["spawn", "session"]);
  assert.equal(cli.scheduleApi, 2);
});

test("discovery retains capabilityShowApi 1 only (the capability-show gate's integer), never another value", async () => {
  const io = { persisted: () => "/bin/oats", env: {}, isExecutableFile: () => true };
  const found = async extra => discover(io, async () => ({ stdout: JSON.stringify({ ...PROBE(), features: ["capability-show"], ...extra }) }));
  assert.equal((await found({ capabilityShowApi: 1 })).capabilityShowApi, 1);
  for (const value of [2, "1", true, null]) assert.equal("capabilityShowApi" in await found({ capabilityShowApi: value }), false, String(value));
  assert.equal("capabilityShowApi" in await found({}), false);
});

test("discovery retains readerApi 1 only (the warm reader's gate, #1630), never another value", async () => {
  const io = { persisted: () => "/bin/oats", env: {}, isExecutableFile: () => true };
  const found = async extra => discover(io, async () => ({ stdout: JSON.stringify({ ...PROBE(), features: ["warm-reader"], ...extra }) }));
  assert.equal((await found({ readerApi: 1 })).readerApi, 1);
  for (const value of [2, "1", true, null]) assert.equal("readerApi" in await found({ readerApi: value }), false, String(value));
  assert.equal("readerApi" in await found({}), false);
});

test("cliRecord: the record made from an accepted payload and its path is what discover answers for them", async () => {
  const io = { persisted: () => "/bin/oats", env: {}, isExecutableFile: () => true };
  const payloads = {
    "the bare probe": PROBE(),
    "every field its gate reads": { ...PROBE(), runtimes: ["pi", "claude"], harnesses: ["pi", "claude", "codex"], sessionBackends: ["tmux"], launchOptions: ["yolo"], scheduleApi: 2, operationsApi: 2,
      lifecycleApi: 1, readinessApi: 2, spawnPreviewApi: 2, spawnApplyApi: 1, eventsApi: 2, scheduleHistoryApi: 3, workspaceApi: 2, automationsApi: 1, capabilityShowApi: 1, readerApi: 1,
      features: ["workspace-v2", "harness-names", "waiting-on-you"], remote: ["roster", "spawn"] },
    "the older schedule API": { ...PROBE(), scheduleApi: 1, features: [] },
    "every field in a form no gate reads": { ...PROBE(), runtimes: "pi", harnesses: "claude", sessionBackends: "tmux", launchOptions: null, scheduleApi: 3, operationsApi: 1, lifecycleApi: 2, readinessApi: 1,
      spawnPreviewApi: 1, spawnApplyApi: 2, eventsApi: 1, scheduleHistoryApi: 2, workspaceApi: 1, automationsApi: "1", capabilityShowApi: 2, readerApi: 2, features: "workspace-v2", remote: "roster", extra: { kept: false } },
  };
  for (const [what, payload] of Object.entries(payloads)) {
    const stdout = JSON.stringify(payload);
    const found = await discover(io, async () => ({ stdout }));
    assert.equal(found.ok, true, what);
    // What a client that probes one known kernel does: read the answer, accept it, make the record.
    const read = Object.freeze(parseProbeStdout(stdout));
    assert.equal(accept(read).ok, true, what);
    const record = cliRecord(read, { bin: "/bin/oats", source: found.source });
    assert.deepEqual(record, found, what);
    assert.equal(JSON.stringify(record), JSON.stringify(found), `${what}: the same keys in the same order`);
  }
  // A form no gate reads leaves nothing but the four fields every record has.
  assert.deepEqual(cliRecord(payloads["every field in a form no gate reads"], { bin: "/bin/oats", source: "persisted" }), { ok: true, bin: "/bin/oats", source: "persisted", version: "0.26.0" });
  // The lists are the payload's own, as discover always answered them: the record copies none.
  const full = payloads["every field its gate reads"];
  assert.equal(cliRecord(full, { bin: "/bin/oats", source: "persisted" }).features, full.features);
});

// #1879 acceptance 1 (Locator), for two Desktop versions so the bound cannot be hard-coded: a Desktop X.Y.Z
// accepts X.Y.0 and X.Y.99 with no notice, X.(Y+1).0 and (X+1).0.0 flagged above its tested bound, and refuses
// X.(Y+1).0-rc.1 (a prerelease), desktopApi 2, and a CLI below the floor.
for (const desktop of ["0.69.18", "1.4.2"]) {
  test(`acceptance (locator): a Desktop of ${desktop} — its own minor without a notice, a later minor or major above its tested bound, the refusals as before`, () => {
    const [x, y] = desktop.split(".").map(Number);
    const through = `${x}.${y}`;
    for (const v of [`${x}.${y}.0`, `${x}.${y}.99`]) assert.deepEqual(acceptProbe(PROBE(v), desktop), { ok: true }, v);
    for (const v of [`${x}.${y + 1}.0`, `${x + 1}.0.0`]) assert.deepEqual(acceptProbe(PROBE(v), desktop), { ok: true, aboveTested: true, testedThrough: through }, v);
    const pre = acceptProbe(PROBE(`${x}.${y + 1}.0-rc.1`), desktop);
    assert.equal(pre.ok, false); assert.match(pre.reason, /prerelease/);
    const api = acceptProbe({ ...PROBE(`${x}.${y}.0`), desktopApi: 2 }, desktop);
    assert.equal(api.ok, false); assert.equal(api.newerApi, true);
    const below = acceptProbe(PROBE("0.25.9"), desktop);
    assert.equal(below.ok, false); assert.match(below.reason, /outside >=0\.26\.0/);
  });
}

test("acceptance (locator): a CLI below the Desktop's own minor but at or above the floor is accepted with no notice", () => {
  assert.deepEqual(acceptProbe(PROBE("0.60.0"), "0.69.18"), { ok: true });
  assert.deepEqual(acceptProbe(PROBE("0.69.25"), "0.69.18"), { ok: true }, "a later patch of the same minor is inside the bound");
});
