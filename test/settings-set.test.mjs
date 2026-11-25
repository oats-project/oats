// Feature settings-set (oats-project/oats#2122, KP-17): `oats settings set <capability> <key> <value>` and
// `oats settings unset <capability> <key>` record one host setting in the deployment's own oats-local.yaml,
// through the kernel's one writer (lib/local-edit.mjs) and the resolver's own checks, without a hand edit.
// An operator's command: refused inside an instance by each piece of evidence, never for a credential-shaped
// key, local only. Its trace is a private, bounded file. Real CLI runs in real deployments.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { fakeFiles, fakeManifest, providerDeployment } from "./helpers/session-provider-fixture.mjs";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";
import { loadLocal } from "../lib/workspace.mjs";
import { TRACE_MAX_LINES, appendSettingsTrace, credentialShaped, settingValueOf, settingsTracePath, traceValue } from "../lib/settings-set.mjs";

const CAP = "acme.bb";
/** A capability shaped as oats.bb's settings are: a hostOnly choice, a hostOnly number, a default, a committedOnly key. */
const MANIFEST = { settings: {
  trust: { hostOnly: true, values: ["single-user", "container"], description: "who may reach the server" },
  hostDaemonPort: { hostOnly: true, description: "a port, written as a number" },
  version: { default: "0.50.1", description: "a version, as text" },
  list: { committedOnly: true, description: "the same for every deployment" },
  flag: { values: [true, false], description: "a declared boolean" },
  apiToken: { description: "a credential-shaped key a manifest should not have declared" },
} };
const NO_INSTANCE = { OATS_INSTANCE: undefined, OATS_INSTANCE_HOME: undefined, OATS_HOME: undefined, PI_AGENT_INSTANCE: undefined, PI_AGENT_HOME: undefined };
function deployment(t, opts = {}) {
  const fx = v2Deployment({ t, souls: { dev: { soul: { capabilities: { [CAP]: { from: "here" } } } } }, capabilities: { [CAP]: { manifest: MANIFEST } }, ...opts });
  fx.local = join(fx.dep, "oats-local.yaml");
  fx.text = () => readFileSync(fx.local, "utf8");
  fx.settings = (args, { env = {}, cwd } = {}) => fx.cli(["settings", ...args, "--json"], { env: { ...NO_INSTANCE, ...env }, ...(cwd ? { cwd } : {}) }).json();
  fx.ok = (args, more) => { const r = fx.settings(args, more); assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };
  fx.refused = (args, code, more) => { const before = fx.text(); const r = fx.settings(args, more); assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error.code, code, JSON.stringify(r)); assert.equal(fx.text(), before, "a refusal writes nothing"); return r.error; };
  fx.trace = () => (existsSync(settingsTracePath(fx.dep)) ? readFileSync(settingsTracePath(fx.dep), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return fx;
}

test("the kernel lists the feature", () => {
  assert.ok(KERNEL_FEATURES.includes("settings-set"));
});

test("set and unset: the answer's fields, the file, and what the resolver then gives", (t) => {
  const fx = deployment(t);
  // A first set: the file held nothing, so previous is null.
  assert.deepEqual(fx.ok(["set", CAP, "trust", "single-user"]), { capability: CAP, key: "trust", previous: null, value: "single-user", effective: "single-user", changed: true, file: fx.local });
  // The same value again: nothing written, changed false.
  const before = fx.text();
  assert.deepEqual(fx.ok(["set", CAP, "trust", "single-user"]), { capability: CAP, key: "trust", previous: "single-user", value: "single-user", effective: "single-user", changed: false, file: fx.local });
  assert.equal(fx.text(), before);
  // Another value: previous is the FILE's former value.
  assert.deepEqual(fx.ok(["set", CAP, "trust", "container"]), { capability: CAP, key: "trust", previous: "single-user", value: "container", effective: "container", changed: true, file: fx.local });
  // A key with a manifest default: previous is null (never the default), effective the file's value, and after an unset the default.
  assert.deepEqual(fx.ok(["set", CAP, "version", "0.51.0"]), { capability: CAP, key: "version", previous: null, value: "0.51.0", effective: "0.51.0", changed: true, file: fx.local });
  assert.deepEqual(fx.ok(["unset", CAP, "version"]), { capability: CAP, key: "version", previous: "0.51.0", value: null, effective: "0.50.1", changed: true, file: fx.local });
  // Unset of a key the file does not set: succeeds, writes nothing, changed false.
  const held = fx.text();
  assert.deepEqual(fx.ok(["unset", CAP, "version"]), { capability: CAP, key: "version", previous: null, value: null, effective: "0.50.1", changed: false, file: fx.local });
  assert.deepEqual(fx.ok(["unset", CAP, "hostDaemonPort"]), { capability: CAP, key: "hostDaemonPort", previous: null, value: null, effective: null, changed: false, file: fx.local });
  assert.equal(fx.text(), held);
  // The resolver reads what was written: the soul's preview shows the setting with its host origin.
  const preview = fx.cli(["spawn", "dev", "--name", "p", "--preview", "--json"], { env: NO_INSTANCE }).json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.match(JSON.stringify(preview.result), /"trust":"container"/);
  // The last unset of a capability's keys leaves no empty mapping behind.
  fx.ok(["unset", CAP, "trust"]);
  assert.doesNotMatch(fx.text(), /settings/);
});

test("a value's type: a declared value as declared, a string default as text, a whole number or true/false as a hand edit reads it", (t) => {
  const fx = deployment(t);
  assert.equal(fx.ok(["set", CAP, "hostDaemonPort", "38890"]).value, 38890, "a port is stored as a number");
  assert.equal(fx.ok(["set", CAP, "flag", "true"]).value, true, "a declared boolean is stored as declared");
  assert.equal(fx.ok(["set", CAP, "version", "1"]).value, "1", "a key whose default is text stays text");
  assert.match(fx.text(), /hostDaemonPort: 38890\n/);
  assert.match(fx.text(), /version: "1"\n/);
  const sources = [{ manifest: MANIFEST }];
  assert.equal(settingValueOf("1.0", sources, "hostDaemonPort"), "1.0", "a decimal is text");
  assert.equal(settingValueOf("007", sources, "hostDaemonPort"), "007", "a number a hand edit would not read as one is text");
  assert.equal(settingValueOf("-3", sources, "hostDaemonPort"), -3);
  assert.equal(settingValueOf("container", sources, "trust"), "container");
  for (const bad of ["", "two\nlines", "a\u202Eb", "x".repeat(1025), undefined, 7]) assert.throws(() => settingValueOf(bad, sources, "trust"), { code: "E_BAD_ARGS" }, JSON.stringify(bad));
});

test("a value set by the command is read as a hand-written one is: a port a number, a version text, a trust its declared value", (t) => {
  // The three keys as oats.bb declares them: a port with no default (its reader takes a number only), a
  // version whose default is text, a trust with declared values.
  const fx = deployment(t);
  assert.deepEqual([fx.ok(["set", CAP, "hostDaemonPort", "38890"]).value, fx.ok(["set", CAP, "version", "0.50.1"]).value, fx.ok(["set", CAP, "trust", "single-user"]).value], [38890, "0.50.1", "single-user"]);
  const byCommand = { ...loadLocal(fx.dep).local.settings[CAP] };
  assert.deepEqual(byCommand, { hostDaemonPort: 38890, version: "0.50.1", trust: "single-user" });
  assert.equal(typeof byCommand.hostDaemonPort, "number");
  const head = fx.text().split("\nsettings:")[0];
  writeFileSync(fx.local, `${head}\nsettings:\n  ${CAP}:\n    hostDaemonPort: 38890\n    version: 0.50.1\n    trust: single-user\n`);
  assert.deepEqual({ ...loadLocal(fx.dep).local.settings[CAP] }, byCommand, "the same file a person would write by hand");
});

test("refused, nothing written: an undeclared key, a value outside the declared ones, a committedOnly key, an unknown capability, --server", (t) => {
  const fx = deployment(t);
  const undeclared = fx.refused(["set", CAP, "nokey", "x"], "E_BAD_ARGS");
  assert.match(undeclared.message, /declares no setting "nokey": its settings are apiToken, flag, hostDaemonPort, list, trust, version/);
  fx.refused(["unset", CAP, "nokey"], "E_BAD_ARGS");
  const value = fx.refused(["set", CAP, "trust", "everyone"], "E_WORKSPACE_SCHEMA");
  assert.equal(value.details.reason, "setting-value", "the resolver's own refusal of a value");
  const committed = fx.refused(["set", CAP, "list", "x"], "E_WORKSPACE_SCHEMA");
  assert.equal(committed.details.reason, "committed-only-key", "the resolver's own refusal of a committedOnly key in the host layer");
  fx.refused(["set", "acme.nope", "trust", "single-user"], "E_CAPABILITY_UNKNOWN");
  for (const key of ["a.b", "", "-x", "k".repeat(129)]) fx.refused(["set", CAP, key, "x"], "E_BAD_ARGS");
  const routed = fx.refused(["set", CAP, "trust", "single-user", "--server", "build"], "E_BAD_ARGS");
  assert.match(routed.message, /--server is not accepted/);
  for (const words of [["set", CAP, "trust"], ["unset", CAP], ["set", CAP, "trust", "a", "b"], ["unset", CAP, "trust", "x"]]) assert.equal(fx.settings(words).ok, false, words.join(" "));
  assert.equal(fx.settings(["show", CAP]).error.code, "E_USAGE");
  assert.deepEqual(fx.trace(), [], "a refusal leaves no trace");
});

test("never a secret: a credential-shaped key is refused before anything is read, set or unset", (t) => {
  const fx = deployment(t);
  // Declared by the manifest, and still refused: the name is the rule.
  const refused = fx.refused(["set", CAP, "apiToken", "hunter2"], "E_BAD_ARGS");
  assert.equal(refused.details.reason, "credential-key");
  assert.match(refused.message, /never records a secret/);
  assert.match(refused.message, /the capability's own setup command .* or in the host's secret store, never in oats-local\.yaml/);
  assert.doesNotMatch(JSON.stringify(refused), /hunter2/, "the value is never repeated");
  fx.refused(["unset", CAP, "apiToken"], "E_BAD_ARGS");
  // Before the catalog is read: an unknown capability with such a key answers the secret refusal.
  assert.equal(fx.refused(["set", "acme.nope", "password", "x"], "E_BAD_ARGS").details.reason, "credential-key");
  for (const key of ["secret", "clientSecret", "token", "tokens", "authToken", "auth", "password", "passwd", "passphrase", "credential", "credentials", "api_key", "apiKey", "API-KEY", "apikey", "privateKeyPath", "private_key", "PRIVATEKEY"]) assert.ok(credentialShaped(key), key);
  for (const key of ["trust", "hostDaemonPort", "author", "authority", "tokenizer", "keyboard", "apiVersion", "privateMode", "passage"]) assert.equal(credentialShaped(key), null, key);
});

test("operator only: each piece of evidence alone refuses, with the evidence and the way out, and the same run from the deployment succeeds", (t) => {
  const fx = deployment(t);
  const spawned = fx.cli(["spawn", "dev", "--name", "agent", "--no-launch", "--json"], { env: NO_INSTANCE }).json();
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home;
  const args = ["set", CAP, "trust", "single-user"];
  const GUARD = /a guard against an agent changing a host setting by accident, not a security boundary; nothing was written/;
  // 1. Each instance variable alone, from the deployment's own directory.
  for (const [name, value] of [["OATS_INSTANCE", "agent"], ["OATS_HOME", home], ["PI_AGENT_INSTANCE", "agent"], ["PI_AGENT_HOME", home], ["OATS_INSTANCE_HOME", join(fx.base, "no-such-home")]]) {
    const e = fx.refused(args, "E_SETTINGS_OPERATOR_ONLY", { env: { [name]: value } });
    assert.deepEqual(e.details, { evidence: "environment", variable: name }, name);
    assert.ok(e.message.includes(`this process's environment carries ${name}, an instance's variable`), e.message);
    assert.ok(e.message.includes(`run it from a shell outside any home, without the instance's variables, e.g. \`cd ${fx.dep} && oats settings set …\``), e.message);
    assert.match(e.message, /--dir does not lift this/);
    assert.match(e.message, GUARD);
  }
  // 2. OATS_INSTANCE_HOME naming a real home: the home and its instance are named.
  const named = fx.refused(args, "E_SETTINGS_OPERATOR_ONLY", { env: { OATS_INSTANCE_HOME: home } });
  assert.deepEqual(named.details, { evidence: "environment", variable: "OATS_INSTANCE_HOME", home, instance: "agent" });
  assert.ok(named.message.includes(`OATS_INSTANCE_HOME, which names the home of agent (${home})`), named.message);
  // 3. A person-shaped run: no instance variable, the working directory inside a home (its work tree too).
  mkdirSync(join(home, "work", "deep"), { recursive: true });
  for (const cwd of [home, join(home, "work", "deep")]) {
    const e = fx.refused(args, "E_SETTINGS_OPERATOR_ONLY", { cwd });
    assert.equal(e.details.evidence, "cwd");
    assert.equal(e.details.instance, "agent");
    assert.ok(e.message.includes(`this shell's working directory is inside the home of agent (`), e.message);
    assert.ok(e.message.includes("so it reads as that agent's: run it from outside any home, e.g. `cd "), e.message);
    assert.match(e.message, GUARD);
    // --dir says which deployment, not who is asking.
    assert.equal(fx.refused([...args, "--dir", fx.dep], "E_SETTINGS_OPERATOR_ONLY", { cwd }).details.evidence, "cwd");
  }
  // 4. Unset is an operator's too.
  fx.refused(["unset", CAP, "trust"], "E_SETTINGS_OPERATOR_ONLY", { env: { OATS_INSTANCE: "agent" } });
  // 5. The same run from the deployment's directory, with no instance variable: it succeeds.
  assert.equal(fx.ok(args).changed, true);
  assert.equal(fx.ok(["set", CAP, "trust", "container"], { cwd: fx.dep }).changed, true);
});

test("a YAML file keeps its comments, its other entries and their order, line by line", (t) => {
  const fx = deployment(t);
  const ref = fx.text().match(/^workspace: .*$/m)[0];
  const original = `# This machine's deployment\nschemaVersion: 2\n${ref} # where the workspace lives\n\n# Host settings, by capability\nsettings:\n  # another capability's\n  acme.other:\n    zeta: last # stays last\n    alpha: 1\n  ${CAP}:\n    # how this host is reached\n    hostDaemonPort: 38887 # the default port\n    version: "0.50.1"\nlaunch-configs:\n  claude: { harness: claude } # a flow mapping\n\n# The end\n`;
  writeFileSync(fx.local, original);
  const lines = (text) => text.split("\n");
  // Set a new key: one line added, at the end of the capability's mapping, every other line as it was.
  fx.ok(["set", CAP, "trust", "single-user"]);
  let now = lines(fx.text());
  const added = now.indexOf("    trust: single-user");
  assert.ok(added > 0, fx.text());
  assert.deepEqual([...now.slice(0, added), ...now.slice(added + 1)], lines(original), "every other line is the file's own");
  assert.equal(added, now.indexOf('    version: "0.50.1"') + 1, "after the capability's last key");
  // Change an existing key: that line alone changes, its comment kept.
  fx.ok(["set", CAP, "hostDaemonPort", "38890"]);
  now = lines(fx.text());
  assert.ok(now.includes("    hostDaemonPort: 38890 # the default port"), fx.text());
  // Unset both: the file is the original again, apart from nothing.
  fx.ok(["unset", CAP, "trust"]);
  fx.ok(["set", CAP, "hostDaemonPort", "38887"]);
  assert.equal(fx.text(), original);
  // Unset the capability's last keys: its mapping carries a person's comment, so it stays, empty, with
  // the comment; every other line is the file's own, the other capability's in order.
  fx.ok(["unset", CAP, "hostDaemonPort"]);
  fx.ok(["unset", CAP, "version"]);
  assert.deepEqual(lines(fx.text()), lines(original).flatMap((l) => (/hostDaemonPort/.test(l) ? ["    {}"] : /version: "0\.50\.1"/.test(l) ? [] : [l])));
  assert.ok(fx.text().indexOf("zeta: last") < fx.text().indexOf("alpha: 1"), "the other capability's order");
});

test("an unset that empties a mapping keeps a person's comments: the mapping stays when one is attached, and goes when none is", (t) => {
  const fx = deployment(t);
  const head = fx.text();
  const unset = (tail) => { writeFileSync(fx.local, head + tail); assert.equal(fx.ok(["unset", CAP, "trust"]).changed, true); return fx.text().slice(head.length); };
  // `settings:` is the file's last key, with a comment above it and one after it: both stay.
  const above = unset(`# Host settings: hand-written notes\nsettings:\n  ${CAP}:\n    trust: container\n# end note\n`);
  assert.match(above, /# Host settings: hand-written notes\n/);
  assert.match(above, /# end note\n/);
  assert.doesNotMatch(above, /trust/);
  // A comment inside the capability's mapping, and one above the capability: they stay, and the file still reads.
  const inside = unset(`settings:\n  # above the capability\n  ${CAP}:\n    trust: container\n    # a note inside\n  acme.other:\n    z: 1\n`);
  assert.match(inside, /# above the capability\n/);
  assert.match(inside, /# a note inside\n/);
  assert.deepEqual({ ...loadLocal(fx.dep).local.settings["acme.other"] }, { z: 1 });
  assert.deepEqual({ ...loadLocal(fx.dep).local.settings[CAP] }, {}, "the commented mapping stays, empty");
  assert.equal(inside, `settings:\n  # above the capability\n  ${CAP}:\n    {}\n    # a note inside\n  acme.other:\n    z: 1\n`);
  // A later set fills the mapping that stayed, as a block: one key a line, the comments where they were.
  assert.equal(fx.ok(["set", CAP, "trust", "single-user"]).changed, true);
  assert.equal(fx.text().slice(head.length), `settings:\n  # above the capability\n  ${CAP}:\n    trust: single-user\n    # a note inside\n  acme.other:\n    z: 1\n`);
  // The same for a settings mapping that stayed empty, and for one a person wrote as {}.
  unset(`# Host settings: hand-written notes\nsettings:\n  ${CAP}:\n    trust: container\n`);
  fx.ok(["set", CAP, "trust", "single-user"]);
  assert.equal(fx.text().slice(head.length), `# Host settings: hand-written notes\nsettings:\n  ${CAP}:\n    trust: single-user\n`);
  writeFileSync(fx.local, `${head}settings: {}\n`);
  fx.ok(["set", CAP, "trust", "single-user"]);
  assert.equal(fx.text().slice(head.length), `settings:\n  ${CAP}:\n    trust: single-user\n`);
  // A mapping a person wrote in flow style, with entries, stays in flow style.
  writeFileSync(fx.local, `${head}settings: { acme.other: { z: 1 } }\n`);
  fx.ok(["set", CAP, "trust", "single-user"]);
  assert.equal(fx.text().slice(head.length), `settings: { acme.other: { z: 1 }, ${CAP}: { trust: single-user } }\n`);
  // No comment anywhere: the emptied mappings go, and a comment on the removed key's own line goes with it.
  assert.equal(unset(`settings:\n  ${CAP}:\n    trust: container # beside the key\n`), "");
});

test("a set to the value the file holds, and an unset of a key it does not set, leave the file untouched: bytes, time and trace", (t) => {
  const fx = deployment(t);
  const ref = fx.text().match(/^workspace: .*$/m)[0];
  // A file the writer would re-render (three spaces before a comment, a comment beside a mapping's key).
  const original = `schemaVersion: 2\n${ref}\nsettings:\n  ${CAP}: # beside the mapping's key\n    trust: single-user   # three spaces before\n`;
  writeFileSync(fx.local, original);
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(fx.local, old, old);
  const stat = () => { const s = statSync(fx.local); return [s.mtimeMs, s.ino, s.size]; };
  const before = stat();
  assert.deepEqual(fx.ok(["set", CAP, "trust", "single-user"]), { capability: CAP, key: "trust", previous: "single-user", value: "single-user", effective: "single-user", changed: false, file: fx.local });
  assert.deepEqual(fx.ok(["unset", CAP, "version"]), { capability: CAP, key: "version", previous: null, value: null, effective: "0.50.1", changed: false, file: fx.local });
  assert.equal(fx.text(), original, "not a byte changed, so not re-rendered");
  assert.deepEqual(stat(), before, "the same file, its modification time as it was: no write, no rename");
  assert.deepEqual(fx.trace(), [], "no trace line");
  assert.equal(existsSync(settingsTracePath(fx.dep)), false);
});

test("what the kernel's writer re-renders of a YAML file: spacing before a comment and a comment beside a mapping's own key, never its words or its entries", (t) => {
  // lib/local-edit.mjs writes the YAML library's rendering of the edited document: not a byte copy.
  const fx = deployment(t);
  const ref = fx.text().match(/^workspace: .*$/m)[0];
  writeFileSync(fx.local, `schemaVersion: 2\n${ref}\nsettings:\n  acme.other: # beside the mapping's key\n    zeta: last   # three spaces before\n# The end\n`);
  fx.ok(["set", CAP, "trust", "single-user"]);
  assert.equal(fx.text(), `schemaVersion: 2\n${ref}\nsettings:\n  acme.other:\n    # beside the mapping's key\n    zeta: last # three spaces before\n  ${CAP}:\n    trust: single-user\n\n# The end\n`);
});

test("a file written as JSON stays JSON, and a file the kernel cannot decode is refused", (t) => {
  const fx = deployment(t);
  const workspace = fx.text().match(/^workspace: (.*)$/m)[1];
  writeFileSync(fx.local, `{"schemaVersion":2,"workspace":${JSON.stringify(workspace)},"settings":{"acme.other":{"zeta":"last","alpha":1}}}\n`);
  assert.equal(fx.ok(["set", CAP, "trust", "single-user"]).changed, true);
  const written = fx.text();
  assert.deepEqual(JSON.parse(written), { schemaVersion: 2, workspace, settings: { "acme.other": { zeta: "last", alpha: 1 }, [CAP]: { trust: "single-user" } } });
  assert.equal(written, `{\n  "schemaVersion": 2,\n  "workspace": ${JSON.stringify(workspace)},\n  "settings": {\n    "acme.other": {\n      "zeta": "last",\n      "alpha": 1\n    },\n    "${CAP}": {\n      "trust": "single-user"\n    }\n  }\n}\n`, "JSON, two spaces, the keys in the file's order, its final newline");
  assert.deepEqual(fx.ok(["unset", CAP, "trust"]), { capability: CAP, key: "trust", previous: "single-user", value: null, effective: null, changed: true, file: fx.local });
  assert.deepEqual(JSON.parse(fx.text()), { schemaVersion: 2, workspace, settings: { "acme.other": { zeta: "last", alpha: 1 } } });
  // A file the kernel's reader refuses: nothing is written.
  writeFileSync(fx.local, `schemaVersion: 2\nworkspace: ${workspace}\nsettings: [unclosed\n`);
  const e = fx.refused(["set", CAP, "trust", "single-user"], "E_WORKSPACE_SCHEMA");
  assert.ok(e.message.length > 0);
});

test("the trace: one line per changed write, private, bounded, every text made safe, and never a failed set", (t) => {
  const fx = deployment(t);
  fx.ok(["set", CAP, "trust", "single-user"]);
  fx.ok(["set", CAP, "trust", "single-user"]); // unchanged: no line
  fx.ok(["set", CAP, "trust", "container"]);
  fx.ok(["unset", CAP, "trust"]);
  fx.ok(["unset", CAP, "trust"]); // nothing to unset: no line
  const rows = fx.trace();
  assert.deepEqual(rows.map(({ at, ...row }) => row), [
    { verb: "set", capability: CAP, key: "trust", previous: null, value: "single-user" },
    { verb: "set", capability: CAP, key: "trust", previous: "single-user", value: "container" },
    { verb: "unset", capability: CAP, key: "trust", previous: "container", value: null },
  ]);
  for (const row of rows) assert.ok(!Number.isNaN(Date.parse(row.at)) && Object.keys(row).join() === "at,verb,capability,key,previous,value", JSON.stringify(row));
  const path = settingsTracePath(fx.dep);
  assert.equal(path, join(fx.dep, ".agents", "events", "settings.jsonl"));
  assert.equal(statSync(path).mode & 0o777, 0o600, "private to its user");
  // Bounded: past TRACE_MAX_LINES the oldest lines are dropped, and the file stays private.
  writeFileSync(path, Array.from({ length: TRACE_MAX_LINES }, (_, i) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", verb: "set", capability: CAP, key: "trust", previous: null, value: `old-${i}` })).join("\n") + "\n");
  fx.ok(["set", CAP, "trust", "single-user"]);
  const bounded = fx.trace();
  assert.equal(bounded.length, TRACE_MAX_LINES);
  assert.deepEqual([bounded[0].value, bounded.at(-2).value, bounded.at(-1).value], ["old-1", `old-${TRACE_MAX_LINES - 1}`, "single-user"]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Every text bounded and safe: a value the file held by hand, long or with a refused character, is cut and replaced.
  assert.equal(traceValue("a\u202Eb\nc"), "a\uFFFDb\uFFFDc");
  assert.equal([...traceValue("x".repeat(900))].length, 500);
  assert.equal(traceValue({ nested: ["by hand"] }), '{"nested":["by hand"]}');
  assert.deepEqual([traceValue(null), traceValue(7), traceValue(false)], [null, 7, false]);
  // Never through a link, and never a failed set: the write is done, the answer warns.
  const elsewhere = join(fx.base, "operator-file");
  writeFileSync(elsewhere, "the operator's own\n");
  rmSync(path);
  symlinkSync(elsewhere, path);
  const warned = fx.ok(["set", CAP, "trust", "container"]);
  assert.equal(warned.changed, true);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /the change was written, and its line in .*settings\.jsonl was not: the trace is a symbolic link/);
  assert.equal(readFileSync(elsewhere, "utf8"), "the operator's own\n", "nothing is written through the link");
  assert.match(fx.text(), /trust: container/);
  assert.throws(() => appendSettingsTrace(fx.dep, { at: "x", verb: "set", capability: CAP, key: "trust", previous: null, value: "v" }), /symbolic link/);
});

test("a session provider's trust: refused until a person's answer is recorded, then not", (t) => {
  // The fake provider, made to refuse as oats.bb's does while settings.trust is not one of its values.
  const wrapper = `import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const text = readFileSync(0, "utf8"), req = JSON.parse(text);
const settings = JSON.parse(process.env.OATS_SETTINGS || "{}");
if (req.verb === "launch" && !["single-user", "container"].includes(settings.trust)) {
  process.stdout.write(JSON.stringify({ schemaVersion: req.schemaVersion, phase: req.phase, capability: req.capability, provider: req.provider, verb: req.verb, ok: false, error: { code: "E_BACKEND_TRUST", message: "settings.acme.fake.trust is not set" } }) + "\\n");
  process.exit(0);
}
const r = spawnSync(process.execPath, [fileURLToPath(new URL("./fake.mjs", import.meta.url)), ...process.argv.slice(2)], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
process.stdout.write(r.stdout);
process.exit(r.status ?? 1);
`;
  const manifest = { ...fakeManifest(), settings: { trust: { hostOnly: true, values: ["single-user", "container"], description: "who may reach the server" } } };
  const fx = providerDeployment(t, { manifest, capabilities: { "acme.fake": { manifest, files: { ...fakeFiles(), "bin/fake.mjs": fakeFiles()["bin/session.mjs"], "bin/session.mjs": wrapper } } } });
  const spawn = (name) => fx.cli(["spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", "--json"], { env: NO_INSTANCE }).json();
  const refused = spawn("before");
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(JSON.stringify(refused.error), /E_BACKEND_TRUST/);
  const set = fx.cli(["settings", "set", "acme.fake", "trust", "single-user", "--json"], { env: NO_INSTANCE }).json();
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual([set.result.previous, set.result.value, set.result.effective, set.result.changed], [null, "single-user", "single-user", true]);
  const launched = spawn("after");
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(JSON.parse(fx.verbs("launch").at(-1).settings).trust, "single-user", "the provider is handed the recorded answer");
});
