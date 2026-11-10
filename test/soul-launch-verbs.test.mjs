// `oats soul launch set|remove` (feature soul-launch, awebai/oats#990): the supported writer of
// oats-local.yaml `souls.launch`, and the one function that decides which of its keys name no soul
// (lib/launch-preference.mjs launchKeysUnmatched, awebai/oats#989), from the description of a read of
// the workspace (lib/instance-resolution.mjs soulsOffered).
//
// Three layers: the function over described reads and over real discoveries (an in-memory remote); the
// verb in process over a file and such a discovery; the CLI over the one-repo deployment and a package.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selfIdentity } from "../lib/worktree-hooks.mjs";
import YAML from "yaml";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { KEY, OID, REF, detailed, soulFile, world } from "./helpers/memory-workspace.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";
import { parseConfigData } from "../lib/config-data.mjs";
import { discoverWorkspace } from "../lib/workspace.mjs";
import { discoverOrStandalone, soulsOffered } from "../lib/instance-resolution.mjs";
import { launchKeysUnmatched } from "../lib/launch-preference.mjs";
import { editLocal, localLock } from "../lib/local-edit.mjs";
import { soulLaunch, soulLaunchValue } from "../lib/soul-launch-verbs.mjs";
import { teamsAdd } from "../lib/teams-verbs.mjs";

const LOCAL = "oats-local.yaml";
const at = (key) => `${LOCAL}#/souls/launch/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/* ───────────────────────────── the function, over described reads ─────── */

const read = ({ keys = [], all = null, bare = null, packages = {} } = {}) => ({ keys, unread: { all, bare, packages } });
const decide = (launch, offered) => launchKeysUnmatched({ local: { souls: { launch } }, offered });
const keysOf = (rows) => rows.map((r) => r.key);

test("unmatched or unchecked, one case per row of the table; \"*\" is in neither", () => {
  const launch = { "*": "fast", reviewer: "private", ghost: "private", "acme.pkg/keeper": "private", "acme.pkg/gone": { harness: "claude" }, "other.pkg/x": "none", "platform/reviewer": "private" };
  const offered = ["reviewer", "acme.pkg/keeper"];
  // Everything read: a key that is the key of an offered soul matches; every other one is unmatched,
  // `<member>/<soul>` and a key under a package that is locked and read among them.
  const all = decide(launch, read({ keys: offered }));
  assert.deepEqual(keysOf(all.unmatched), ["acme.pkg/gone", "ghost", "other.pkg/x", "platform/reviewer"]);
  assert.deepEqual(all.unchecked, []);
  assert.deepEqual(all.unmatched[0], { key: "acme.pkg/gone", at: at("acme.pkg/gone"), value: { harness: "claude", model: null }, suggestions: [] });
  assert.deepEqual(all.unmatched[1], { key: "ghost", at: at("ghost"), value: "private", suggestions: [] });
  // A member unconfirmed, or a member's or an external soul skipped: every bare key is unchecked.
  for (const bare of ["member-unconfirmed", "soul-unread"]) {
    const r = decide(launch, read({ keys: offered, bare }));
    assert.deepEqual(r.unchecked, [{ key: "ghost", at: at("ghost"), value: "private", reason: bare }]);
    assert.deepEqual(keysOf(r.unmatched), ["acme.pkg/gone", "other.pkg/x", "platform/reviewer"], "a qualified key is not a bare one: still unmatched");
  }
  // A package declared and not locked, or locked with a soul skipped: `<that package>/…` is unchecked.
  for (const why of ["package-unlocked", "package-soul-unread"]) {
    const r = decide(launch, read({ keys: offered, packages: { "acme.pkg": why } }));
    assert.deepEqual(r.unchecked, [{ key: "acme.pkg/gone", at: at("acme.pkg/gone"), value: { harness: "claude", model: null }, reason: why }]);
    assert.deepEqual(keysOf(r.unmatched), ["ghost", "other.pkg/x", "platform/reviewer"]);
  }
  // The standalone view of an unreadable host: every key that matches nothing is unchecked.
  const alone = decide(launch, read({ keys: ["reviewer"], all: "standalone" }));
  assert.deepEqual(alone.unmatched, []);
  assert.deepEqual(keysOf(alone.unchecked), ["acme.pkg/gone", "acme.pkg/keeper", "ghost", "other.pkg/x", "platform/reviewer"]);
  assert.ok(alone.unchecked.every((u) => u.reason === "standalone"));
  // "*" alone: nothing to say, whatever was read.
  for (const offeredRead of [read(), read({ all: "standalone" }), read({ bare: "soul-unread" })]) assert.deepEqual(decide({ "*": "fast" }, offeredRead), { unmatched: [], unchecked: [] });
  assert.deepEqual(launchKeysUnmatched({ local: {}, offered: read() }), { unmatched: [], unchecked: [] });
});

test("suggestions: the same bare name first, then bare names within two edits by distance then code point; at most three", () => {
  const offered = read({ keys: ["reviewer", "example.pkg/reviewer", "zeta.pkg/reviewer", "reviewers", "previewer", "revue", "planner"] });
  const s = (key) => decide({ [key]: "none" }, offered).unmatched[0].suggestions;
  // Three keys share the bare name: they fill the list, by code point.
  assert.deepEqual(s("example.okf/reviewer"), ["example.pkg/reviewer", "reviewer", "zeta.pkg/reviewer"]);
  // No key has the bare name: distance 1 (by code point), then distance 2.
  assert.deepEqual(decide({ reviewr: "none" }, read({ keys: ["reviewer", "previewer", "b.pkg/reviewer", "reviews", "planner"] })).unmatched[0].suggestions, ["b.pkg/reviewer", "reviewer", "reviews"]);
  assert.deepEqual(decide({ reviewr: "none" }, read({ keys: ["previewer", "reviewer", "planner"] })).unmatched[0].suggestions, ["reviewer", "previewer"]);
  // `<member>/<soul>` can never match (a member's soul is keyed by its bare name): it suggests that name.
  assert.deepEqual(decide({ "platform/planner": "none" }, offered).unmatched[0].suggestions, ["planner"]);
  // Nothing within two edits.
  assert.deepEqual(s("quartermaster"), []);
});

/* ───────────────────────────── the description, from real discoveries ─── */

const LAUNCH = { "*": "fast", ghost: "private", "acme.pkg/gone": "private", "new.pkg/x": "private" };
const told = async (w, launch = LAUNCH, local = {}) => {
  const d = await w.discover();
  const r = launchKeysUnmatched({ local: { ...local, souls: { ...(local.souls ?? {}), launch } }, offered: soulsOffered(d) });
  return { unmatched: keysOf(r.unmatched), unchecked: Object.fromEntries(r.unchecked.map((u) => [u.key, u.reason])), offered: soulsOffered(d), problems: d.problems };
};

test("a read of the workspace: the offered soul keys, a soul in souls.disabled among them", async () => {
  const r = await told(world());
  assert.deepEqual(r.offered, { keys: ["acme.pkg/keeper", "builder", "planner", "reviewer"], unread: { all: null, bare: null, packages: {} } });
  assert.deepEqual([r.unmatched, r.unchecked], [["acme.pkg/gone", "ghost", "new.pkg/x"], {}], "all read: a key under a locked, read package and a package the workspace does not declare are unmatched");
  // souls.disabled is not consulted: the key of a soul not run on this machine still matches.
  const disabled = await told(world(), { builder: "private", "acme.pkg/keeper": "private" }, { souls: { disabled: ["builder", "acme.pkg/keeper"] } });
  assert.deepEqual([disabled.unmatched, disabled.unchecked], [[], {}]);
});

test("what was not read leaves its keys unchecked: an unconfirmed member, a skipped member or external soul, an unlocked package, a skipped package soul", async () => {
  // A member the workspace lists and cannot confirm (no backlink): every bare key.
  const unconfirmed = await told(world((repos) => { delete repos.platform.files["oats-membership.yaml"]; }));
  assert.deepEqual([unconfirmed.unmatched, unconfirmed.unchecked], [["acme.pkg/gone", "new.pkg/x"], { ghost: "member-unconfirmed" }]);
  // A member's soul.yaml that is invalid, or cannot be read, or a souls/ listing that failed: every bare key.
  const skips = {
    invalid: (repos) => { repos.platform.files["souls/ghost/soul.yaml"] = { schemaVersion: 2, name: "Not A Slug" }; },
    unread: (repos) => { repos.platform.files["souls/ghost/soul.yaml"] = soulFile("ghost"); repos.platform.faults = { read: { "souls/ghost/soul.yaml": detailed("E_REMOTE_UNREADABLE", "cannot read souls/ghost/soul.yaml", { reason: "network" }) } }; },
    unlisted: (repos) => { repos.platform.faults = { list: { souls: detailed("E_REMOTE_UNREADABLE", "cannot list souls", { reason: "network" }) } }; },
  };
  for (const [name, edit] of Object.entries(skips)) {
    const r = await told(world(edit));
    assert.deepEqual([r.unmatched, r.unchecked], [["acme.pkg/gone", "new.pkg/x"], { ghost: "soul-unread" }], name);
    // What discovery records is no part of its problems rows: they keep their fields.
    for (const p of r.problems) assert.deepEqual(Object.keys(p).sort(), ["code", "message", "path", "repoKey"], name);
  }
  // A second declaration of a soul's name is not a missing soul: the first is listed under that name.
  const twice = await told(world((repos) => { repos.platform.files["souls/builder-copy/soul.yaml"] = soulFile("builder"); }));
  assert.deepEqual(twice.unchecked, {});
  // An external soul that cannot be read: every bare key.
  const external = await told(world((repos, workspace) => { repos.experts = { files: {} }; workspace.external = [{ source: `${REF("experts")}@${OID("9")}`, soul: "souls/auditor" }]; }));
  assert.deepEqual([external.unmatched, external.unchecked], [["acme.pkg/gone", "new.pkg/x"], { ghost: "soul-unread" }]);
  // A package the workspace declares and the lock does not hold: `<that package>/…`, and no other key.
  const unlocked = await told(world((repos, workspace) => { workspace.packages["new.pkg"] = "v2.0.0"; }));
  assert.deepEqual([unlocked.unmatched, unlocked.unchecked], [["acme.pkg/gone", "ghost"], { "new.pkg/x": "package-unlocked" }]);
  const noLock = world(); noLock.lock = null;
  const none = await (async () => { const d = await discoverWorkspace(REF("agents"), { remote: noLock.remote, lock: null }); return launchKeysUnmatched({ local: { souls: { launch: LAUNCH } }, offered: soulsOffered(d) }); })();
  assert.deepEqual([keysOf(none.unmatched), Object.fromEntries(none.unchecked.map((u) => [u.key, u.reason]))], [["ghost", "new.pkg/x"], { "acme.pkg/gone": "package-unlocked" }], "no lock at all: every declared package is unlocked");
  // A locked package with a soul that could not be read or is invalid: `<that package>/…`.
  for (const edit of [
    (repos) => { repos.pkg.files["oats-package/souls/keeper/soul.yaml"] = { schemaVersion: 2, name: "Not A Slug" }; },
    (repos) => { repos.pkg.faults = { read: { "oats-package/souls/keeper/soul.yaml": detailed("E_REMOTE_UNREADABLE", "cannot read the package soul", { reason: "network" }) } }; },
    (repos, workspace, lock) => { delete lock.packages["acme.pkg"].url; },
  ]) {
    const r = await told(world(edit));
    assert.deepEqual([r.unmatched, r.unchecked], [["ghost", "new.pkg/x"], { "acme.pkg/gone": "package-soul-unread" }]);
  }
  // A package locked at an older version than the workspace now pins is read: the lock is what this machine offers.
  const older = await told(world((repos, workspace) => { workspace.packages["acme.pkg"] = "v3.0.0"; }));
  assert.deepEqual([older.unmatched, older.unchecked, older.offered.keys.includes("acme.pkg/keeper")], [["acme.pkg/gone", "ghost", "new.pkg/x"], {}, true]);
});

test("the standalone views: every key is unchecked when the host cannot be read; an explicit standalone: is the configured view", async () => {
  const w = world((repos) => { repos.agents.unreadable = true; });
  const launch = { "*": "fast", ghost: "private", builder: "private", "acme.pkg/keeper": "private" };
  const tell = (d) => { const r = launchKeysUnmatched({ local: { souls: { launch } }, offered: soulsOffered(d) }); return [keysOf(r.unmatched), Object.fromEntries(r.unchecked.map((u) => [u.key, u.reason]))]; };
  // `workspace:` names a member whose host this access context cannot read.
  const fallback = await discoverOrStandalone({ workspace: REF("platform") }, { lock: w.lock, remote: w.remote });
  assert.deepEqual([fallback.standalone, fallback.standaloneReason], [true, "unreadable-host"]);
  assert.deepEqual(tell(fallback), [[], { "acme.pkg/keeper": "standalone", ghost: "standalone" }], "builder is offered and matches; nothing else can be checked");
  // `standalone:` asks for the repository's own view: its souls are the offered souls, and its own row is
  // no unconfirmed member. A key that names none of them is unmatched.
  const explicit = await discoverOrStandalone({ standalone: REF("platform") }, { lock: w.lock, remote: w.remote });
  assert.deepEqual([explicit.standalone, explicit.standaloneReason], [true, "explicit"]);
  assert.deepEqual(soulsOffered(explicit), { keys: ["builder", "reviewer"], unread: { all: null, bare: null, packages: {} } });
  assert.deepEqual(tell(explicit), [["acme.pkg/keeper", "ghost"], {}]);
  // That view's own skipped soul still leaves a bare key unchecked.
  const broken = world((repos) => { repos.platform.files["souls/ghost/soul.yaml"] = { schemaVersion: 2, name: "Not A Slug" }; });
  assert.deepEqual(tell(await discoverOrStandalone({ standalone: REF("platform") }, { lock: null, remote: broken.remote })), [["acme.pkg/keeper"], { ghost: "soul-unread" }]);
});

/* ───────────────────────────── the verb, in process ───────────────────── */

const HEAD = "schemaVersion: 2\nworkspace: git:github.com/acme/agents\nlaunch-configs:\n  private: { harness: claude }\n  fast: { harness: pi }\n";
function fileOf(t, text, head = HEAD) {
  const dir = mkdtempSync(join(tmpdir(), "oats-soul-launch-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localPath = join(dir, LOCAL);
  writeFileSync(localPath, head + text);
  return { dir, localPath, ctx: { deployment: dir, localPath }, text: () => readFileSync(localPath, "utf8"),
    // The kernel reader's value (as plain objects: it builds them without a prototype).
    value: () => JSON.parse(JSON.stringify(parseConfigData(readFileSync(localPath, "utf8"), { origin: { kind: "local", path: localPath } }).value)) };
}
const set = (fx, w, name, value, plan = false) => soulLaunch(fx.ctx, { action: "set", name, value, plan }, { readSouls: w.discover });
const remove = (fx, w, name, plan = false) => soulLaunch(fx.ctx, { action: "remove", name, plan }, { readSouls: w.discover });
const unreachable = { discover: async () => { throw detailed("E_REMOTE_UNREADABLE", "cannot read the workspace host", { reason: "network" }); } };
/** `fn` rejects with `code`, and the file is byte for byte what it was. */
async function refusedUnchanged(fx, fn, code, check = () => {}) {
  const before = fx.text();
  await assert.rejects(fn, (e) => { assert.equal(e.code, code, e.message); check(e); return true; });
  assert.equal(fx.text(), before, `${code}: nothing was written`);
}

test("the flags of set: one of --launch-config and --harness, --model only with --harness", () => {
  assert.equal(soulLaunchValue({ launchConfig: "private" }), "private");
  assert.equal(soulLaunchValue({ launchConfig: "none" }), "none");
  assert.deepEqual(soulLaunchValue({ harness: "claude" }), { harness: "claude" });
  assert.deepEqual(soulLaunchValue({ harness: "codex", model: "o4" }), { harness: "codex", model: "o4" });
  for (const flags of [{}, { model: "o4" }, { launchConfig: "private", harness: "pi" }, { launchConfig: "private", model: "o4" }, { harness: "emacs" }, { harness: "claude", model: "-x" }, { harness: "claude", model: "a b" }]) {
    assert.throws(() => soulLaunchValue(flags), (e) => e.code === "E_BAD_ARGS", JSON.stringify(flags));
  }
});

test("set writes the soul's key and answers soulLaunchApi 1; the same value again writes nothing", async (t) => {
  const fx = fileOf(t, ""), w = world();
  const a = await set(fx, w, "builder", "private");
  assert.deepEqual({ ...a, launch: null }, { soulLaunchApi: 1, action: "set", plan: false, key: "builder", souls: ["platform/builder"], level: fx.dir, file: fx.localPath, before: null, after: "private", changed: true, launch: null, unmatched: [], unread: null });
  assert.deepEqual([a.launch.from, a.launch.at, a.launch.effective.launchConfig, a.launch.effective.harness, a.launch.declared], ["local", at("builder"), "private", "claude", null]);
  assert.deepEqual(fx.value().souls, { launch: { builder: "private" } });
  assert.equal(fx.text(), `${HEAD}souls:\n  launch:\n    builder: private\n`, "`souls:` was absent: the entry is all that is added");
  // The same value: nothing written, changed false, the same answer otherwise.
  const bytes = fx.text();
  const again = await set(fx, w, "builder", "private");
  assert.deepEqual([again.changed, again.before, again.after, fx.text() === bytes], [false, "private", "private", true]);
  // Another value: before and after say it; an inline preference is { harness, model }, model null when absent.
  const inline = await set(fx, w, "builder", { harness: "codex" });
  assert.deepEqual([inline.before, inline.after, inline.changed], ["private", { harness: "codex", model: null }, true]);
  assert.deepEqual([inline.launch.from, inline.launch.effective.harness, inline.launch.effective.launchConfig], ["local", "codex", null]);
  const model = await set(fx, w, "builder", { harness: "claude", model: "claude-opus-5-5" });
  assert.deepEqual([model.before, model.after], [{ harness: "codex", model: null }, { harness: "claude", model: "claude-opus-5-5" }]);
  assert.deepEqual(fx.value().souls.launch.builder, { harness: "claude", model: "claude-opus-5-5" });
  assert.equal((await set(fx, w, "builder", { harness: "claude", model: "claude-opus-5-5" })).changed, false);
  // `none` asks for the bare harness: it is written as the name it is, and needs no declaration.
  assert.deepEqual((await set(fx, w, "builder", "none")).after, "none");
});

test("the shapes a file can have: souls absent, only disabled, launch or souls in flow form, no trailing newline", async (t) => {
  const w = world();
  const shapes = {
    "souls absent": ["", { launch: { "*": "fast", "acme.pkg/keeper": "private" } }],
    "only disabled": ["souls:\n  disabled:\n    - builder\n", { disabled: ["builder"], launch: { "*": "fast", "acme.pkg/keeper": "private" } }],
    "launch in flow form": ["souls:\n  launch: { \"*\": private }\n", { launch: { "*": "fast", "acme.pkg/keeper": "private" } }],
    "souls in flow form": ["souls: { disabled: [builder], launch: { \"*\": private } }\n", { disabled: ["builder"], launch: { "*": "fast", "acme.pkg/keeper": "private" } }],
    "no trailing newline": ["souls:\n  launch:\n    reviewer: none", { launch: { reviewer: "none", "*": "fast", "acme.pkg/keeper": "private" } }],
  };
  for (const [name, [text, souls]] of Object.entries(shapes)) {
    const fx = fileOf(t, text);
    const star = await set(fx, w, "*", "fast");
    // "*" is the machine default: it names no soul, and it is written so the kernel's reader reads back `*`.
    assert.deepEqual([star.key, star.souls, star.launch, star.unread, star.unmatched], ["*", null, null, null, []], name);
    assert.ok(Object.hasOwn(fx.value().souls.launch, "*"), `${name}: the key reads back as *`);
    const pkg = await set(fx, w, "keeper", "private");
    assert.deepEqual([pkg.key, pkg.souls, pkg.launch.at], ["acme.pkg/keeper", ["acme.pkg/keeper"], at("acme.pkg/keeper")], name);
    assert.deepEqual(fx.value().souls, souls, name);
    assert.ok(fx.text().endsWith("\n"), name);
  }
});

test("the rest of the file: a sibling's comment and a long value byte for byte, the order of the other keys and entries, each entry's own quoting", async (t) => {
  const long = `    LONG: ${"a value well past eighty columns ".repeat(4)}that a folding writer would wrap`;
  const body = [
    "# this machine",
    "clones:",
    "  github.com/acme/platform: /srv/checkouts/platform   # where the clone is",
    "souls:",
    "  launch:",
    "    \"*\": fast                # the default here",
    "    'acme.pkg/keeper': private   # the keeper runs on the private account",
    "    reviewer: { harness: codex }",
    "  disabled: [planner]          # not on this machine",
    "settings:",
    "  acme.tool:",
    long,
    "defaultTeam: mine",
    "",
  ].join("\n");
  const fx = fileOf(t, body), w = world();
  await set(fx, w, "builder", "private");
  const out = fx.text();
  // The library normalises the spacing before an inline comment and pads a flow collection; values and comments stay.
  assert.equal(out, HEAD + [
    "# this machine",
    "clones:",
    "  github.com/acme/platform: /srv/checkouts/platform # where the clone is",
    "souls:",
    "  launch:",
    "    \"*\": fast # the default here",
    "    'acme.pkg/keeper': private # the keeper runs on the private account",
    "    reviewer: { harness: codex }",
    "    builder: private",
    "  disabled: [ planner ] # not on this machine",
    "settings:",
    "  acme.tool:",
    long,
    "defaultTeam: mine",
    "",
  ].join("\n"));
  assert.ok(out.includes(`${long}\n`), "the long value is on its one line");
  assert.deepEqual(Object.keys(fx.value()), ["schemaVersion", "workspace", "launch-configs", "clones", "souls", "settings", "defaultTeam"], "the order of the file's keys");
  assert.deepEqual(Object.keys(fx.value().souls.launch), ["*", "acme.pkg/keeper", "reviewer", "builder"], "the order of the other entries, the new one last");
  // A changed entry keeps its place, its quoting and its comment; removing one moves no other.
  await set(fx, w, "keeper", "fast");
  await set(fx, w, "*", "private");
  await remove(fx, w, "platform/reviewer");
  assert.equal(fx.text(), out.replace("\"*\": fast #", "\"*\": private #").replace("'acme.pkg/keeper': private #", "'acme.pkg/keeper': fast #").replace("    reviewer: { harness: codex }\n", ""));
  assert.deepEqual(fx.value().souls.launch, { "*": "private", "acme.pkg/keeper": "fast", builder: "private" });
});

test("remove deletes one entry; a map left empty goes with it; no such entry is E_LAUNCH_PREFERENCE_UNKNOWN", async (t) => {
  const fx = fileOf(t, "souls:\n  launch:\n    \"*\": fast\n    builder: private\n"), w = world();
  const a = await remove(fx, w, "builder");
  assert.deepEqual({ ...a, launch: null }, { soulLaunchApi: 1, action: "remove", plan: false, key: "builder", souls: ["platform/builder"], level: fx.dir, file: fx.localPath, before: "private", after: null, changed: true, launch: null, unmatched: [], unread: null });
  // After a remove the answer shows what the soul falls through to.
  assert.deepEqual([a.launch.from, a.launch.at, a.launch.effective.launchConfig], ["local-default", at("*"), "fast"]);
  assert.deepEqual(fx.value().souls, { launch: { "*": "fast" } });
  // A soul with no entry, named as a soul or by a key the file does not have: refused, never "done".
  for (const name of ["builder", "platform/builder", "planner"]) {
    await refusedUnchanged(fx, () => remove(fx, w, name), "E_LAUNCH_PREFERENCE_UNKNOWN", (e) => { assert.deepEqual(e.details, { key: name.split("/").pop(), keys: ["*"] }); assert.match(e.message, /nothing was written/); });
  }
  // The last entry: souls.launch goes, then souls.
  const last = await remove(fx, w, "*");
  assert.deepEqual([last.key, last.before, last.after, last.souls, last.launch, last.unmatched], ["*", "fast", null, null, null, []]);
  assert.deepEqual([Object.hasOwn(fx.value(), "souls"), fx.text()], [false, HEAD]);
  // "*" with no entry needs no read of the workspace to be refused.
  await refusedUnchanged(fx, () => remove(fx, unreachable, "*"), "E_LAUNCH_PREFERENCE_UNKNOWN", (e) => assert.deepEqual(e.details, { key: "*", keys: [] }));
  // `souls` is kept while it holds something else.
  const kept = fileOf(t, "souls:\n  disabled: [planner]\n  launch:\n    builder: private\n");
  await remove(kept, w, "builder");
  assert.deepEqual(kept.value().souls, { disabled: ["planner"] });
});

test("unmatched in the answer: the keys that name no soul, before and after the remove of one", async (t) => {
  const fx = fileOf(t, "souls:\n  launch:\n    \"*\": fast\n    acme.okf/keeper: private\n    bilder: { harness: codex, model: o4 }\n    platform/reviewer: none\n"), w = world();
  const rows = [
    { key: "acme.okf/keeper", at: at("acme.okf/keeper"), value: "private", suggestions: ["acme.pkg/keeper"] },
    { key: "bilder", at: at("bilder"), value: { harness: "codex", model: "o4" }, suggestions: ["builder"] },
    { key: "platform/reviewer", at: at("platform/reviewer"), value: "none", suggestions: ["reviewer"] },
  ];
  // The remedy's first step: pin the soul the key was meant for. The old keys are still reported.
  const pinned = await set(fx, w, "acme.pkg/keeper", "private");
  assert.deepEqual(pinned.unmatched, rows);
  // Then remove each key by its exact text; the list shrinks to [], which means no spawn is refused for it.
  const one = await remove(fx, w, "acme.okf/keeper");
  assert.deepEqual([one.key, one.souls, one.launch, one.before, one.unread], ["acme.okf/keeper", [], null, "private", null], "a key that names no soul: souls [] and no launch");
  assert.deepEqual(one.unmatched, rows.slice(1));
  // `platform/reviewer` is the exact text of a key and also a name of the soul keyed `reviewer`: the present key goes.
  const two = await remove(fx, w, "platform/reviewer");
  assert.deepEqual([two.key, two.souls, two.unmatched], ["platform/reviewer", [], rows.slice(1, 2)]);
  assert.deepEqual((await remove(fx, w, "bilder")).unmatched, []);
  assert.deepEqual(fx.value().souls.launch, { "*": "fast", "acme.pkg/keeper": "private" });
  // An unchecked key is not in the answer: only what the kernel established.
  const broken = world((repos) => { repos.platform.files["souls/ghost/soul.yaml"] = { schemaVersion: 2, name: "Not A Slug" }; });
  const unchecked = fileOf(t, "souls:\n  launch:\n    bilder: private\n");
  assert.deepEqual((await set(unchecked, broken, "planner", "fast")).unmatched, []);
});

test("remove by the exact text of a key reads the file first and goes on when the workspace cannot be read: unread", async (t) => {
  const fx = fileOf(t, "souls:\n  launch:\n    acme.okf/keeper: private\n    x: fast\n    \"*\": fast\n");
  // A bare `x` is a key of the file, and the only soul of that name here is a package's: the present key goes.
  const w = world((repos, workspace, lock) => { repos.pkg.files["oats-package/souls/x/soul.yaml"] = soulFile("x"); lock.packages["acme.pkg"].souls.push({ name: "x", path: "souls/x", digest: `sha256-${"0".repeat(64)}` }); });
  const x = await remove(fx, w, "x");
  assert.deepEqual([x.key, x.souls, x.launch, x.changed], ["x", [], null, true]);
  assert.deepEqual(Object.keys(fx.value().souls.launch), ["acme.okf/keeper", "*"]);
  // The workspace unreachable: the removal goes on, and the answer says it knows nothing about souls.
  const a = await remove(fx, unreachable, "acme.okf/keeper");
  assert.deepEqual(a, { soulLaunchApi: 1, action: "remove", plan: false, key: "acme.okf/keeper", souls: null, level: fx.dir, file: fx.localPath, before: "private", after: null, changed: true, launch: null, unmatched: null,
    unread: { code: "E_REMOTE_UNREADABLE", message: "cannot read the workspace host" } });
  assert.deepEqual(fx.value().souls.launch, { "*": "fast" });
  const star = await remove(fx, unreachable, "*");
  assert.deepEqual([star.key, star.souls, star.launch, star.unmatched, star.unread.code, Object.hasOwn(fx.value(), "souls")], ["*", null, null, null, "E_REMOTE_UNREADABLE", false]);
  // Every other form needs the read, and its own error is the answer: nothing is written.
  const other = fileOf(t, "souls:\n  launch:\n    builder: private\n");
  for (const run of [() => set(other, unreachable, "builder", "fast"), () => set(other, unreachable, "*", "fast"), () => remove(other, unreachable, "platform/builder")]) {
    await refusedUnchanged(other, run, "E_REMOTE_UNREADABLE");
  }
  // In no other answer is any of the three null for that reason: read, they are a list, a report and a list.
  const read1 = await remove(other, world(), "builder");
  assert.deepEqual([read1.unread, Array.isArray(read1.souls), read1.launch !== null, Array.isArray(read1.unmatched)], [null, true, true, true]);
  // A defect of the read is no "could not be read": it is thrown.
  const defect = fileOf(t, "souls:\n  launch:\n    builder: private\n");
  await refusedUnchanged(defect, () => remove(defect, { discover: async () => { throw new TypeError("a defect"); } }, "builder"), undefined);
});

test("two members offer the same bare name: the key is the bare name, the entry applies to both, and souls lists both", async (t) => {
  const fx = fileOf(t, ""), w = world();
  // A bare name that is two souls names neither.
  await refusedUnchanged(fx, () => set(fx, w, "reviewer", "private"), "E_SOUL_AMBIGUOUS", (e) => assert.deepEqual(e.details.qualified, ["agents/reviewer", "platform/reviewer"]));
  await refusedUnchanged(fx, () => set(fx, w, "nobody", "private"), "E_SOUL_UNKNOWN");
  const a = await set(fx, w, "platform/reviewer", "private");
  assert.deepEqual([a.key, a.souls], ["reviewer", ["agents/reviewer", "platform/reviewer"]]);
  assert.deepEqual(fx.value().souls.launch, { reviewer: "private" });
  // Naming the other one is the same entry.
  assert.equal((await set(fx, w, "agents/reviewer", "private")).changed, false);
  // By its exact text the key is found in the file: both souls again.
  const gone = await remove(fx, w, "reviewer");
  assert.deepEqual([gone.key, gone.souls, gone.launch.from], ["reviewer", ["agents/reviewer", "platform/reviewer"], "host"]);
});

test("a soul listed in souls.disabled: set and remove work on it", async (t) => {
  const fx = fileOf(t, "souls:\n  disabled: [builder, acme.pkg/keeper]\n"), w = world();
  assert.deepEqual([(await set(fx, w, "builder", "private")).souls, (await set(fx, w, "acme.pkg/keeper", "fast")).souls], [["platform/builder"], ["acme.pkg/keeper"]]);
  assert.deepEqual(fx.value().souls, { disabled: ["builder", "acme.pkg/keeper"], launch: { builder: "private", "acme.pkg/keeper": "fast" } });
  assert.deepEqual([(await remove(fx, w, "builder")).unmatched, (await remove(fx, w, "keeper")).key], [[], "acme.pkg/keeper"]);
  assert.deepEqual(fx.value().souls, { disabled: ["builder", "acme.pkg/keeper"] });
});

test("every refusal comes before a byte of the file changes", async (t) => {
  const fx = fileOf(t, "souls:\n  launch:\n    builder: private   # pinned\n"), w = world();
  // A launch configuration this file does not declare: the fact a spawn would report, said before the file holds it.
  await refusedUnchanged(fx, () => set(fx, w, "planner", "personal"), "E_LAUNCH_CONFIG_UNKNOWN", (e) => { assert.deepEqual(e.details, { name: "personal", from: "local", at: at("planner") }); assert.match(e.message, /nothing was written/); });
  await refusedUnchanged(fx, () => set(fx, w, "*", "personal"), "E_LAUNCH_CONFIG_UNKNOWN", (e) => assert.deepEqual(e.details, { name: "personal", from: "local-default", at: at("*") }));
  await refusedUnchanged(fx, () => set(fx, w, "nobody", "private"), "E_SOUL_UNKNOWN");
  await refusedUnchanged(fx, () => remove(fx, w, "nobody"), "E_SOUL_UNKNOWN");
  await refusedUnchanged(fx, () => remove(fx, w, "planner"), "E_LAUNCH_PREFERENCE_UNKNOWN", (e) => assert.deepEqual(e.details, { key: "planner", keys: ["builder"] }));
  // The lock held by another process: E_LOCAL_BUSY, the holder's lock untouched.
  const lock = localLock(fx.dir);
  mkdirSync(dirname(lock), { recursive: true });
  const held = JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" }) + "\n";
  writeFileSync(lock, held);
  await refusedUnchanged(fx, () => set(fx, w, "planner", "fast"), "E_LOCAL_BUSY", (e) => { assert.deepEqual(e.details, { path: fx.localPath, lock }); assert.match(e.message, /nothing was written/); });
  assert.equal(readFileSync(lock, "utf8"), held);
  rmSync(lock);
  // A file the edit would leave invalid (a key the local schema does not know): refused, with where.
  const invalid = fileOf(t, "bogus: 1\n");
  await refusedUnchanged(invalid, () => set(invalid, w, "planner", "fast"), "E_WORKSPACE_SCHEMA", (e) => { assert.match(e.message, /would be invalid .*nothing was written/); assert.ok(e.details.problems.some((p) => p.path === "/bogus")); });
  // A file that is not YAML.
  const garbled = fileOf(t, "souls: [unclosed\n");
  await refusedUnchanged(garbled, () => set(garbled, w, "planner", "fast"), "E_WORKSPACE_SCHEMA");
});

test("--plan runs every check and writes nothing: the apply's answer but plan, no lock, never E_LOCAL_BUSY", async (t) => {
  const fx = fileOf(t, "souls:\n  launch:\n    acme.okf/keeper: private\n    builder: private\n"), w = world();
  const before = fx.text();
  const plans = [
    [() => set(fx, w, "planner", "fast", true), () => set(fx, w, "planner", "fast")],
    [() => remove(fx, w, "acme.okf/keeper", true), () => remove(fx, w, "acme.okf/keeper")],
    [() => remove(fx, w, "builder", true), () => remove(fx, w, "builder")],
  ];
  for (const [plan, apply] of plans) {
    const text = fx.text();
    const planned = await plan();
    assert.equal(fx.text(), text, "the plan wrote nothing");
    assert.equal(existsSync(join(fx.dir, ".agents")), false, "not even the lock's directory");
    const applied = await apply();
    assert.deepEqual(planned, { ...applied, plan: true });
    assert.equal(planned.changed, true);
    rmSync(join(fx.dir, ".agents"), { recursive: true, force: true });
  }
  assert.notEqual(fx.text(), before);
  // A state that refuses the apply refuses the plan with the same code.
  await refusedUnchanged(fx, () => remove(fx, w, "builder", true), "E_LAUNCH_PREFERENCE_UNKNOWN");
  await refusedUnchanged(fx, () => set(fx, w, "planner", "personal", true), "E_LAUNCH_CONFIG_UNKNOWN");
  await refusedUnchanged(fx, () => set(fx, w, "nobody", "fast", true), "E_SOUL_UNKNOWN");
  // A plan takes no lock, so one held elsewhere does not refuse it.
  const lock = localLock(fx.dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" }) + "\n");
  const held = fx.text();
  assert.equal((await set(fx, w, "builder", "fast", true)).plan, true);
  assert.equal(fx.text(), held);
});

test("the edit works from the file as it is now, and shares the lock of `oats teams`: neither writer drops the other's change", async (t) => {
  const WORKSPACE = { schemaVersion: 2, name: "acme", teams: {}, localTeams: true };
  const fx = fileOf(t, "souls:\n  launch:\n    builder: private\n"), w = world();
  const teamsCtx = () => ({ ...fx.ctx, local: fx.value(), workspace: WORKSPACE, workspaceKey: KEY("agents") });
  // A `teams` write lands while this command reads the workspace (after its own first look at the file).
  const during = { discover: async () => { teamsAdd(teamsCtx(), "mine", { team: "mine:me.example" }); return w.discover(); } };
  await set(fx, during, "planner", "fast");
  assert.deepEqual([fx.value().teams, fx.value().defaultTeam, fx.value().souls.launch], [{ mine: { team: "mine:me.example" } }, "mine", { builder: "private", planner: "fast" }]);
  // And the other way: a `teams` verb holding a snapshot from before a soul launch write keeps that write.
  const stale = teamsCtx();
  await remove(fx, w, "builder");
  teamsAdd(stale, "other", { team: "other:me.example" });
  assert.deepEqual([Object.keys(fx.value().teams), fx.value().souls.launch], [["mine", "other"], { planner: "fast" }]);
  // An entry removed under a `remove` that had found it by its exact text is refused on the file as it is.
  const racing = { discover: async () => { await remove(fx, w, "planner"); return w.discover(); } };
  await assert.rejects(() => remove(fx, racing, "planner"), (e) => e.code === "E_LAUNCH_PREFERENCE_UNKNOWN" && e.details.key === "planner" && e.details.keys.length === 0);
  assert.equal(Object.hasOwn(fx.value(), "souls"), false);
  // One lock for both: held by a teams writer or a soul launch writer, the other answers E_LOCAL_BUSY on it.
  const lock = localLock(fx.dir);
  assert.equal(lock, join(fx.dir, ".agents", "locks", "local.lock"));
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "oats soul launch set" }) + "\n");
  assert.throws(() => teamsAdd(teamsCtx(), "third", { team: "third:me.example" }), (e) => e.code === "E_LOCAL_BUSY" && e.details.lock === lock);
  await assert.rejects(() => set(fx, w, "planner", "fast"), (e) => e.code === "E_LOCAL_BUSY" && e.details.lock === lock);
});

test("the shared edit path: a file that changes between the read and the rename is edited again on the new content, then E_LOCAL_CHANGED", (t) => {
  const fx = fileOf(t, "");
  // Another writer (one that does not take the lock) lands once, between this edit's read and its rename.
  let calls = 0;
  const once = editLocal(fx.ctx, { verb: "a test" }, ({ doc, local }) => {
    if (++calls === 1) writeFileSync(fx.localPath, `${fx.text()}defaultTeam: theirs\n`);
    doc.set("clones", doc.createNode({ "github.com/acme/x": `/srv/x-${local.defaultTeam ?? "none"}` }));
    return {};
  });
  assert.deepEqual([calls, once.changed, fx.value().defaultTeam, fx.value().clones], [2, true, "theirs", { "github.com/acme/x": "/srv/x-theirs" }], "their change is kept and this edit saw it");
  // One that lands on every attempt: refused, and the file is theirs, never a mix.
  let n = 0;
  assert.throws(() => editLocal(fx.ctx, { verb: "a test" }, ({ doc }) => { writeFileSync(fx.localPath, `${HEAD}defaultTeam: theirs-${++n}\n`); doc.set("defaultTeam", "mine"); return {}; }),
    (e) => e.code === "E_LOCAL_CHANGED" && e.details.path === fx.localPath && /nothing was written/.test(e.message));
  assert.deepEqual([n, fx.text()], [5, `${HEAD}defaultTeam: theirs-5\n`]);
  assert.equal(existsSync(localLock(fx.dir)), false, "the lock is released");
  // The caller's own check refuses the rewritten value before it is written.
  const text = fx.text();
  assert.throws(() => editLocal(fx.ctx, { verb: "a test" }, ({ doc }) => { doc.set("defaultTeam", "mine"); return { check: (next) => { throw detailed("E_WORKSPACE_SCHEMA", `refused ${next.defaultTeam}`, {}); } }; }), /refused mine/);
  assert.equal(fx.text(), text);
});

/* ───────────────────────────── the CLI ────────────────────────────────── */

const OPUS = { harness: "claude", model: "claude-opus-5-5" };
function deployment(t, { local = {}, souls, workspace = {} } = {}) {
  return v2Deployment({ t, name: "acme", workspace, souls: souls ?? { dev: {}, writer: { soul: { launch: OPUS } }, runner: {} },
    local: { "launch-configs": { private: { harness: "claude", model: "claude-opus-5-5" }, fast: { harness: "pi" } }, ...local } });
}
/** The one envelope of a `--json` answer: stdout is exactly one compact JSON object. */
function envelope(r) {
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), `stdout is one compact JSON object: ${r.stdout}`);
  return doc;
}
const ok = (r, what) => { const j = envelope(r); assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const refused = (r, code, what) => { const j = envelope(r); assert.equal(j.ok, false, `${what}: ${r.stdout}`); assert.notEqual(r.status, 0, what); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };
const localOf = (fx) => readFileSync(join(fx.dep, LOCAL), "utf8");
const launchOf = (fx) => YAML.parse(localOf(fx)).souls?.launch;

test("oats soul launch set|remove: the answer, and the next spawn preview agrees with it", (t) => {
  const fx = deployment(t, { local: { souls: { launch: { "*": "fast" } } } });
  const file = join(fx.dep, LOCAL);
  const a = ok(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "private", "--json"]), "set");
  assert.deepEqual(a, { soulLaunchApi: 1, action: "set", plan: false, key: "dev", souls: ["ws/dev"], level: fx.dep, file, before: null, after: "private", changed: true,
    launch: { declared: null, effective: { harness: "claude", model: "claude-opus-5-5", launchConfig: "private" }, from: "local", at: at("dev"), problem: null }, unmatched: [], unread: null });
  assert.deepEqual(launchOf(fx), { "*": "fast", dev: "private" });
  // After set: the spawn preview is decided by the entry, with the value set.
  const pinned = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview");
  assert.deepEqual(pinned.launch, a.launch);
  assert.deepEqual([pinned.launch.from, pinned.harness, pinned.launchConfig], ["local", "claude", "private"]);
  // An inline preference, by --harness and --model.
  const inline = ok(fx.cli(["soul", "launch", "set", "ws/dev", "--harness", "codex", "--model", "o4", "--json"]), "set --harness");
  assert.deepEqual([inline.before, inline.after, inline.launch.effective, inline.launch.from], ["private", { harness: "codex", model: "o4" }, { harness: "codex", model: "o4", launchConfig: null }, "local"]);
  assert.deepEqual(ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview").launch, inline.launch);
  assert.deepEqual(launchOf(fx).dev, { harness: "codex", model: "o4" });
  // `none`: the bare harness, the host default's.
  assert.deepEqual(ok(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "none", "--json"]), "set none").after, "none");
  // After remove: the fall-through, equal to the answer's launch.
  const gone = ok(fx.cli(["soul", "launch", "remove", "dev", "--json"]), "remove");
  assert.deepEqual({ ...gone, launch: null }, { soulLaunchApi: 1, action: "remove", plan: false, key: "dev", souls: ["ws/dev"], level: fx.dep, file, before: "none", after: null, changed: true, launch: null, unmatched: [], unread: null });
  assert.deepEqual(gone.launch, { declared: null, effective: { harness: "pi", model: null, launchConfig: "fast" }, from: "local-default", at: at("*"), problem: null });
  assert.deepEqual(ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview").launch, gone.launch);
  // The machine default, and what falls through below it: a soul's own launch.
  const star = ok(fx.cli(["soul", "launch", "remove", "*", "--json"]), "remove *");
  assert.deepEqual([star.key, star.souls, star.launch, star.before, star.unmatched], ["*", null, null, "fast", []]);
  assert.equal(YAML.parse(localOf(fx)).souls, undefined);
  const set = ok(fx.cli(["soul", "launch", "set", "*", "--harness", "codex", "--json"]), "set *");
  assert.deepEqual([set.key, set.souls, set.launch, set.after], ["*", null, null, { harness: "codex", model: null }]);
  const writer = ok(fx.cli(["soul", "launch", "set", "writer", "--launch-config", "fast", "--plan", "--json"]), "plan");
  assert.deepEqual([writer.plan, writer.changed, writer.launch.declared, writer.launch.from, writer.launch.effective.launchConfig], [true, true, OPUS, "local", "fast"]);
  assert.deepEqual(launchOf(fx), { "*": { harness: "codex" } }, "--plan wrote nothing");
  assert.equal(ok(fx.cli(["spawn", "writer", "--preview", "--json"]), "preview").launch.from, "local-default");
  // A harness that is not installed is not refused: the entry is the operator's statement, and the answer says what a spawn would refuse.
  rmSync(join(fx.base, "runtime-stub", "codex"));
  const absent = ok(fx.cli(["soul", "launch", "set", "runner", "--harness", "codex", "--json"], { env: { PATH: `${join(fx.base, "runtime-stub")}:/usr/bin:/bin` } }), "set an absent harness");
  assert.deepEqual([absent.changed, absent.launch.problem?.code], [true, "E_HARNESS_UNAVAILABLE"]);
});

test("oats soul launch: argument refusals, each one envelope, none writing", (t) => {
  const fx = deployment(t, { local: { souls: { launch: { dev: "private" } } } });
  const before = localOf(fx);
  const run = (...argv) => fx.cli(["soul", "launch", ...argv, "--json"]);
  // A value flag with no value is refused, never read as absent.
  for (const argv of [["set", "dev", "--launch-config", "--plan"], ["set", "dev", "--harness"], ["set", "dev", "--harness", "claude", "--model"], ["set", "dev", "--launch-config="]]) {
    assert.match(refused(run(...argv), "E_BAD_ARGS", argv.join(" ")).message, /needs a value/);
  }
  // At every occurrence, and a value flag is taken once: the first reading would drop the second.
  for (const argv of [["set", "dev", "--harness", "codex", "--harness"], ["set", "dev", "--harness", "codex", "--harness", "--plan"], ["set", "dev", "--launch-config", "fast", "--launch-config"], ["remove", "dev", "--dir", fx.dep, "--dir"]]) {
    assert.match(refused(run(...argv), "E_BAD_ARGS", argv.join(" ")).message, /needs a value/);
  }
  for (const argv of [["set", "dev", "--harness", "codex", "--harness", "pi"], ["set", "dev", "--harness", "codex", "--harness", "pi", "--plan"], ["set", "dev", "--harness", "codex", "--model", "a", "--model", "b"]]) {
    assert.match(refused(run(...argv), "E_BAD_ARGS", argv.join(" ")).message, /^oats soul launch set takes --(harness|model) once/);
  }
  // One name: a second one is refused, never dropped (`remove dev writer` would remove dev alone).
  for (const argv of [["remove", "dev", "writer"], ["remove", "dev", "writer", "--plan"], ["set", "dev", "writer", "--launch-config", "fast"], ["set", "dev", "--launch-config", "fast", "writer", "--plan"]]) {
    assert.match(refused(run(...argv), "E_BAD_ARGS", argv.join(" ")).message, /takes one soul( or key)?, and got 2: "dev", "writer"/);
  }
  assert.equal(localOf(fx), before, "no argument refusal wrote anything");
  refused(run("set", "dev", "--launch-config", "fast", "--harness", "pi"), "E_BAD_ARGS", "both");
  refused(run("set", "dev"), "E_BAD_ARGS", "neither");
  refused(run("set", "dev", "--model", "o4"), "E_BAD_ARGS", "--model alone");
  refused(run("set", "dev", "--launch-config", "fast", "--model", "o4"), "E_BAD_ARGS", "--model with --launch-config");
  refused(run("set", "dev", "--harness", "emacs"), "E_BAD_ARGS", "an unknown harness");
  refused(run("set"), "E_BAD_ARGS", "no soul");
  refused(run("remove"), "E_BAD_ARGS", "no soul");
  // The forms and flags it does not take: refused, never ignored.
  refused(run(), "E_USAGE", "no action");
  refused(run("list"), "E_USAGE", "no list verb");
  for (const flag of [["--home", fx.dep], ["--soul", "dev"], ["--agents-root", fx.root], ["--force"]]) {
    assert.deepEqual(refused(run("remove", "dev", ...flag), "E_USAGE", flag[0]).details, { flag: flag[0] });
    assert.deepEqual(refused(run("set", "dev", "--launch-config", "fast", ...flag), "E_USAGE", flag[0]).details, { flag: flag[0] });
  }
  assert.deepEqual(refused(run("remove", "dev", "--launch-config", "fast"), "E_USAGE", "a set flag on remove").details, { flag: "--launch-config" });
  // An edit reads the workspace live: --max-age is refused on both forms, with and without --plan.
  for (const argv of [["set", "dev", "--launch-config", "fast"], ["set", "dev", "--launch-config", "fast", "--plan"], ["remove", "dev"], ["remove", "dev", "--plan"]]) {
    const e = refused(run(...argv, "--max-age", "60"), "E_BAD_ARGS", `${argv.join(" ")} --max-age`);
    assert.ok(e.message.startsWith(`--max-age is not accepted by \`oats soul launch ${argv[0]}\``), e.message);
  }
  // `oats soul teams` is a read and keeps the flag.
  assert.ok(ok(fx.cli(["soul", "teams", "dev", "--max-age", "60", "--json"]), "soul teams --max-age").observation);
  // The refusals of the edit itself.
  assert.deepEqual(refused(run("set", "dev", "--launch-config", "personal"), "E_LAUNCH_CONFIG_UNKNOWN", "an undeclared configuration").details, { name: "personal", from: "local", at: at("dev") });
  refused(run("set", "nobody", "--launch-config", "fast"), "E_SOUL_UNKNOWN", "an unknown soul");
  assert.deepEqual(refused(run("remove", "runner"), "E_LAUNCH_PREFERENCE_UNKNOWN", "no entry").details, { key: "runner", keys: ["dev"] });
  refused(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "fast", "--dir", join(fx.base, "home"), "--json"]), "E_LOCAL_MISSING", "no deployment at --dir");
  assert.equal(localOf(fx), before, "no refusal wrote anything");
  // --help executes nothing, on either form.
  for (const argv of [["soul", "launch", "set", "runner", "--launch-config", "fast", "--help"], ["soul", "launch", "remove", "dev", "--help"], ["soul", "launch", "--help"]]) {
    const r = fx.cli(argv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage:\n {2}oats soul teams .*\n(.*\n)* {2}oats soul launch set <soul>\|'\*' /);
    assert.match(r.stdout, / {2}oats soul launch remove <soul>\|'\*'\|<exact key> /);
  }
  assert.equal(localOf(fx), before, "--help wrote nothing");
  // The feature is advertised.
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("soul-launch"));
});

test("a local file written as JSON is edited as JSON: set, remove and plan, by both verbs' shared path", (t) => {
  const fx = deployment(t, { workspace: { localTeams: true } });
  const file = join(fx.dep, LOCAL);
  // The kernel reader takes a file that opens with `{` as strict JSON: the same deployment, in that syntax.
  const asJson = (value) => `${JSON.stringify(value)}\n`;
  const base = { ...YAML.parse(localOf(fx)), souls: { launch: { dev: "none" } } };
  writeFileSync(file, asJson(base));
  const strict = () => JSON.parse(localOf(fx));
  // A plan: the answer of the edit, and not a byte written.
  const plan = ok(fx.cli(["soul", "launch", "set", "dev", "--harness", "codex", "--plan", "--json"]), "plan on a JSON file");
  assert.deepEqual([plan.plan, plan.changed, plan.before, plan.after], [true, true, "none", { harness: "codex", model: null }]);
  assert.equal(localOf(fx), asJson(base), "--plan wrote nothing");
  // Applied: strict JSON still, the one entry changed and every other value as it was.
  const set = ok(fx.cli(["soul", "launch", "set", "dev", "--harness", "codex", "--json"]), "set on a JSON file");
  assert.deepEqual([set.changed, set.after, set.launch.effective.harness, set.launch.from], [true, { harness: "codex", model: null }, "codex", "local"]);
  assert.deepEqual(strict(), { ...base, souls: { launch: { dev: { harness: "codex" } } } });
  assert.equal(ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "the kernel reads what was written").launch.from, "local");
  const pkg = ok(fx.cli(["soul", "launch", "set", "*", "--launch-config", "fast", "--json"]), "a new key in a JSON file");
  assert.equal(pkg.after, "fast");
  assert.deepEqual(strict().souls.launch, { dev: { harness: "codex" }, "*": "fast" });
  ok(fx.cli(["soul", "launch", "remove", "*", "--json"]), "remove on a JSON file");
  const gone = ok(fx.cli(["soul", "launch", "remove", "dev", "--json"]), "remove the last entry");
  assert.deepEqual([gone.before, gone.after], [{ harness: "codex", model: null }, null]);
  const rest = { ...base }; delete rest.souls;
  assert.deepEqual(strict(), rest, "the emptied souls.launch and souls are gone, and nothing else");
  // The other writer of the file goes through the same path.
  ok(fx.cli(["teams", "add", "desk", "--team", "local:desk.example", "--no-default", "--json"]), "teams add on a JSON file");
  assert.deepEqual(strict().teams?.desk, { team: "local:desk.example" });
  const { teams: _teams, defaultTeam: _defaultTeam, ...others } = strict();
  assert.deepEqual(others, rest, "and it changed nothing else");
  assert.equal(localOf(fx), `${JSON.stringify(strict(), null, 2)}\n`, "written as two-space JSON");
  // What a JSON file has, it keeps: the order of its keys (names an object would sort first among them)
  // and the absence of a final newline. Its indentation becomes two spaces.
  const ordered = `{"workspace": ${JSON.stringify(base.workspace)},\n    "launch-configs": {"zeta": {"harness": "pi"}, "10": {"harness": "pi"}, "alpha": {"harness": "claude"}, "9": {"harness": "pi"}},\n "souls": {"launch": {"writer": "zeta", "2": "10", "dev": "none"}}, "schemaVersion": 2}`;
  writeFileSync(file, ordered);
  ok(fx.cli(["soul", "launch", "set", "runner", "--launch-config", "9", "--json"]), "set on a JSON file with its own key order");
  assert.equal(localOf(fx), [
    "{", `  "workspace": ${JSON.stringify(base.workspace)},`,
    `  "launch-configs": {`, `    "zeta": {`, `      "harness": "pi"`, "    },", `    "10": {`, `      "harness": "pi"`, "    },", `    "alpha": {`, `      "harness": "claude"`, "    },", `    "9": {`, `      "harness": "pi"`, "    }", "  },",
    `  "souls": {`, `    "launch": {`, `      "writer": "zeta",`, `      "2": "10",`, `      "dev": "none",`, `      "runner": "9"`, "    }", "  },",
    `  "schemaVersion": 2`, "}"].join("\n"), "the keys in the file's order, the new entry last, and still no final newline");
  ok(fx.cli(["teams", "add", "desk", "--team", "local:desk.example", "--no-default", "--json"]), "teams add keeps them too");
  // (Read from the text: an object parsed from it would list "9" and "10" first.)
  const keysAt = (depth) => localOf(fx).split("\n").map((line) => new RegExp(`^ {${depth}}"([^"]+)":`).exec(line)?.[1]).filter(Boolean);
  assert.deepEqual([keysAt(2), keysAt(4).slice(0, 4), localOf(fx).endsWith("}")], [["workspace", "launch-configs", "souls", "schemaVersion", "teams"], ["zeta", "10", "alpha", "9"], true]);
});

test("text the kernel would not decode is never written: the rewrite is refused as E_WORKSPACE_SCHEMA", (t) => {
  const fx = fileOf(t, "");
  const text = fx.text();
  // An edit that leaves the document with an alias: valid YAML, and not the kernel's portable syntax.
  const aliased = ({ doc }) => { const node = doc.createNode({ harness: "pi" }); node.anchor = "a"; doc.setIn(["souls", "launch", "dev"], node); doc.setIn(["souls", "launch", "*"], doc.createAlias(node)); return {}; };
  for (const plan of [false, true]) {
    assert.throws(() => editLocal(fx.ctx, { verb: "a test", plan }, aliased), (e) => {
      assert.equal(e.code, "E_WORKSPACE_SCHEMA");
      assert.match(e.message, /^the rewritten oats-local\.yaml would be invalid \(\/: the kernel would not decode it: .*\); nothing was written$/);
      assert.deepEqual(Object.keys(e.details), ["problems"]);
      return true;
    });
    assert.equal(fx.text(), text, "refused before the rename: the file's bytes are what they were");
    assert.deepEqual(readdirSync(fx.dir).filter((n) => n !== ".agents"), [LOCAL], "and no temporary file is left beside it");
  }
});

test("oats soul launch finds the deployment as oats soul teams does: from it, a nested directory, an instance home, and --dir", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-1" });
  const places = [[fx.dep, []], [fx.root, []], [home, []], [fx.base, ["--dir", fx.dep]], [fx.base, ["--dir", home]]];
  for (const [i, [cwd, extra]] of places.entries()) {
    const value = i % 2 ? "fast" : "private";
    const a = ok(fx.cli(["soul", "launch", "set", "runner", "--launch-config", value, ...extra, "--json"], { cwd }), `set from ${cwd}`);
    assert.deepEqual([a.level, a.file, a.after, a.changed], [fx.dep, join(fx.dep, LOCAL), value, true]);
    assert.deepEqual(ok(fx.cli(["soul", "teams", "runner", ...extra, "--json"], { cwd }), "soul teams").soul, "runner");
  }
  assert.deepEqual(launchOf(fx), { runner: "private" });
});

test("oats soul launch in text mode: what was done and where, what the next spawn selects, and each key that still names no soul", (t) => {
  const fx = deployment(t, { local: { souls: { launch: { "acme.okf/dev": "private", runer: "fast" } } } });
  const text = (...argv) => { const r = fx.cli(["soul", "launch", ...argv]); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trimEnd().split("\n"); };
  const where = (line) => line.replace(/ in \S+/, " in FILE").replace(/ from \S+oats-local\.yaml$/, " from FILE");
  const set = text("set", "dev", "--launch-config", "private");
  assert.equal(set.length, 4, set.join("\n"));
  assert.match(set[0], /^Set souls\.launch "dev" to launch configuration private in \S*oats-local\.yaml$/);
  assert.equal(set[1], `The next spawn of ws/dev selects claude with model claude-opus-5-5 (launch configuration private), from ${at("dev")}`);
  assert.equal(set[2], "souls.launch \"acme.okf/dev\" is the key of no soul this workspace offers (nearest: dev): oats soul launch remove acme.okf/dev");
  assert.equal(set[3], "souls.launch \"runer\" is the key of no soul this workspace offers (nearest: runner): oats soul launch remove runer");
  assert.match(text("set", "dev", "--launch-config", "private")[0], /^souls\.launch "dev" is already launch configuration private in \S+: nothing to change$/);
  assert.match(text("set", "dev", "--harness", "codex", "--model", "o4", "--plan")[0], /^Would set souls\.launch "dev" to codex with model o4 in \S+ \(it was launch configuration private\); nothing was written$/);
  const removed = text("remove", "acme.okf/dev");
  assert.deepEqual([where(removed[0]), removed[1], removed.length], ["Removed souls.launch \"acme.okf/dev\" (launch configuration private) from FILE", "\"acme.okf/dev\" is the key of no soul this workspace offers", 3]);
  const star = text("set", "*", "--launch-config", "none");
  assert.deepEqual([where(star[0]), star[1]], ["Set souls.launch \"*\" to none (the bare harness) in FILE", "\"*\" is the launch of every soul without an entry of its own"]);
  assert.equal(text("remove", "runer").length, 2, "no key names no soul any more: nothing to add");
  assert.deepEqual(launchOf(fx), { dev: "private", "*": "none" });
  // A refusal in text mode: the message on stderr, a nonzero exit, nothing on stdout.
  const r = fx.cli(["soul", "launch", "remove", "runner"]);
  assert.deepEqual([r.status, r.stdout], [1, ""]);
  assert.match(r.stderr, /^oats: oats-local\.yaml souls\.launch has no entry "runner" \(it has "\*", "dev"\); nothing was written\n$/);
});

test("a package soul is pinned by its qualified key; a bare key under it and a wrong package are reported; the workspace unreachable leaves only remove by exact text", (t) => {
  const pkg = packageRepo({ souls: { keeper: {} } });
  t.after(pkg.cleanup); // registered before anything else is built, so a fixture that fails to build leaves no package behind
  const fx = deployment(t, {});
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], packages: { "acme.pkg": `${pkg.ref}@v1.0.0` }, teams: { global: { description: "Fixture team" } }, defaults: { knowledge: "none", messaging: "none", tasks: "none" } } } });
  ok(fx.cli(["sync", "--json"]), "sync");
  const a = ok(fx.cli(["soul", "launch", "set", "keeper", "--launch-config", "private", "--json"]), "set a package soul by its bare name");
  assert.deepEqual([a.key, a.souls, a.launch.from, a.launch.at, a.launch.effective.launchConfig], ["acme.pkg/keeper", ["acme.pkg/keeper"], "local", at("acme.pkg/keeper"), "private"]);
  assert.match(localOf(fx), /\n {4}acme\.pkg\/keeper: private\n/);
  assert.deepEqual(ok(fx.cli(["spawn", "acme.pkg/keeper", "--preview", "--json"]), "preview").launch, a.launch);
  // Keys written by hand that name no soul: the wrong package, and a member-qualified name.
  writeFileSync(join(fx.dep, LOCAL), localOf(fx).replace("    acme.pkg/keeper: private\n", "    acme.pkg/keeper: private\n    acme.okf/keeper: private\n    ws/dev: fast\n"));
  const rows = [
    { key: "acme.okf/keeper", at: at("acme.okf/keeper"), value: "private", suggestions: ["acme.pkg/keeper"] },
    { key: "ws/dev", at: at("ws/dev"), value: "fast", suggestions: ["dev"] },
  ];
  assert.deepEqual(ok(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "fast", "--plan", "--json"]), "plan").unmatched, rows);
  // The workspace cannot be read (its remote is gone): set and a remove by soul name answer the read's own
  // error; a remove by the exact text of a key goes on and says so.
  const text = localOf(fx);
  const elsewhere = `${fx.repo}.gone`;
  writeFileSync(join(fx.dep, LOCAL), text.replace(fx.ref, `file://${elsewhere}`));
  const before = localOf(fx);
  const failure = refused(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "fast", "--json"]), "E_REMOTE_UNREADABLE", "set, unreachable");
  refused(fx.cli(["soul", "launch", "remove", "keeper", "--json"]), "E_REMOTE_UNREADABLE", "remove by soul name, unreachable");
  assert.equal(localOf(fx), before);
  const gone = ok(fx.cli(["soul", "launch", "remove", "acme.okf/keeper", "--json"]), "remove by exact text, unreachable");
  assert.deepEqual({ ...gone, unread: null }, { soulLaunchApi: 1, action: "remove", plan: false, key: "acme.okf/keeper", souls: null, level: fx.dep, file: join(fx.dep, LOCAL), before: "private", after: null, changed: true, launch: null, unmatched: null, unread: null });
  assert.deepEqual([gone.unread.code, gone.unread.message], ["E_REMOTE_UNREADABLE", failure.message]);
  assert.deepEqual(Object.keys(launchOf(fx)), ["acme.pkg/keeper", "ws/dev"]);
  const said = fx.cli(["soul", "launch", "remove", "ws/dev"]);
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stdout, /^Removed souls\.launch "ws\/dev" \(launch configuration fast\) from \S+\nThe workspace's souls could not be read \(E_REMOTE_UNREADABLE: .*\), so this says nothing about which soul the key applied to or which keys still match none\n$/);
});

test("what a read skipped survives the read cache: a bare key stays unchecked on the second read of the same commit", (t) => {
  const fx = deployment(t, { local: { souls: { launch: { ghost: "private" } } } });
  const plan = () => ok(fx.cli(["soul", "launch", "set", "dev", "--launch-config", "fast", "--plan", "--json"]), "plan");
  assert.deepEqual(plan().unmatched.map((u) => u.key), ["ghost"], "everything read: the key names no soul");
  // A soul.yaml the member carries and discovery skips: a bare key may be that soul's.
  fx.commit({ "souls/ghost/soul.yaml": "schemaVersion: 2\nname: Not A Slug\n", "souls/ghost/AGENTS.md": "# ghost\n" });
  assert.deepEqual(plan().unmatched, [], "the first read of that commit computes it");
  const parsed = join(fx.env.OATS_REMOTE_CACHE, ".parsed");
  assert.ok(existsSync(parsed) && readdirSync(parsed).some((d) => readdirSync(join(parsed, d)).length > 0), "the parsed cache holds the member's enumeration");
  assert.deepEqual(plan().unmatched, [], "the second read of it comes from the cache, with what was skipped");
  // The soul repaired: read, and the key is again one that names no soul... of that name there is one now.
  fx.commit({ "souls/ghost/soul.yaml": { yaml: { schemaVersion: 2, name: "ghost", description: "ghost soul.", work: "directory" } } });
  const repaired = plan();
  assert.deepEqual([repaired.unmatched, repaired.souls], [[], ["ws/dev"]]);
});
