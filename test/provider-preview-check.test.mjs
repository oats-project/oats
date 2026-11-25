// A preview asks a session provider what the launch will ask it: its `check`, with the launch
// that is planned, so a spawn or a launch the provider would refuse does not read clean in its
// preview (found by the bb provider's pre-release run: a preview of a spawn with no full-mode
// default read complete, and the spawn was then refused E_BACKEND_SANDBOXED_MODE).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { stopInstanceSession } from "../lib/core.mjs";
import { writeLock } from "../lib/packages.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { git } from "./helpers/v2-deployment.mjs";
import { FAKE_CAPABILITY, fakeFiles, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";
import { previewWarningsOf } from "../packages/client/capability-warnings-contract.mjs";

const CHECKED = fakeManifest({ fake: fakeProvider({ check: true }) });
const REFUSES = { check: { result: { status: "unavailable", problems: [{ code: "E_BACKEND_SANDBOXED_MODE", message: "this provider launches only in full mode, and this launch would be sandboxed" }] } } };

/** A deployment whose `dev` soul takes the fake provider FROM A PACKAGE: what a preview can ask,
 *  its tree being in the deployment's module store and not only in a spawned home. */
function packagedProvider(t) {
  const base = `oats-package/capabilities/${FAKE_CAPABILITY}`;
  const files = { "oats-package/oats-package.json": { json: { package: "acme.pkg", version: "1.0.0", capabilities: [`capabilities/${FAKE_CAPABILITY}`] } },
    [`${base}/oats.json`]: { json: { capability: FAKE_CAPABILITY, version: "1.0.0", description: "A fake session backend, packaged", ...CHECKED } },
    ...Object.fromEntries(Object.entries(fakeFiles()).map(([name, text]) => [`${base}/${name}`, text])) };
  const fx = providerDeployment(t, { files, souls: { dev: { soul: { capabilities: { "oats.core": "off", [FAKE_CAPABILITY]: { from: "package" } } } } } });
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { "acme.pkg": `git:${fx.key}@main` } } } });
  writeLock(fx.dep, { lockfileVersion: 3, packages: { "acme.pkg": { source: `git:${fx.key}@main`, url: fx.ref, path: "oats-package", version: "1.0.0", commit: git(fx.member, "rev-parse", "HEAD"), integrity: contentDigest(join(fx.member, "oats-package")), capabilities: [FAKE_CAPABILITY] } } });
  return fx;
}
const preview = (fx, extra = [], env = {}) => fx.cli(["spawn", "dev", "--name", "seat", "--backend", "fake", "--launch-config", "claude", "--preview", "--json", ...extra], { env });
const homeOf = (fx) => join(fx.root, "dev", "instances", "seat");
const nothingCreated = (fx) => {
  assert.equal(existsSync(homeOf(fx)), false, "no home");
  assert.equal(existsSync(join(dirname(homeOf(fx)), ".oats-retirement")), false, "nor the kernel's directory beside it");
};

test("a spawn preview on a session provider asks the provider's check with the planned launch: a refusal fails the preview with the apply's code and creates nothing; a ready provider previews clean", (t) => {
  const fx = packagedProvider(t);
  // Ready: the preview is as it was, and the provider was asked once, with what the apply will hand it.
  const clean = preview(fx);
  assert.equal(clean.status, 0, clean.stderr);
  const doc = clean.json();
  assert.deepEqual([doc.ok, doc.result.preflight.status, doc.result.warnings ?? null], [true, "complete", null], JSON.stringify(doc).slice(0, 600));
  const asked = fx.verbs("check");
  assert.equal(asked.length, 1);
  const { home, soul, launch } = asked[0].request.input;
  assert.deepEqual([home, soul], [doc.result.home, null], "the planned home, which does not exist yet");
  assert.deepEqual([launch.harness, launch.yolo, launch.trees, launch.protected], ["claude", doc.result.yolo ?? null, [join(doc.result.home, "work")], [join(dirname(doc.result.home), ".oats-retirement")]]);
  assert.ok(launch.sandbox && Array.isArray(launch.sandbox.write), "and the allowances, as the launch input carries them");
  assert.deepEqual([asked[0].instance, asked[0].backend, asked[0].event, asked[0].capability], ["seat", "fake", "session", FAKE_CAPABILITY], "with a provider call's environment");
  assert.deepEqual(fx.hooks(), [], "no hook ran");
  nothingCreated(fx);

  // Refused: the apply's own code, exit 1, nothing created.
  fx.control(REFUSES);
  fx.clearCalls();
  const refused = preview(fx);
  assert.equal(refused.status, 1);
  const error = refused.json();
  assert.deepEqual([error.ok, error.error.code], [false, "E_BACKEND_SANDBOXED_MODE"], JSON.stringify(error));
  assert.match(error.error.message, /seat would not be launched: acme\.fake's session provider fake is not ready \(unavailable\): E_BACKEND_SANDBOXED_MODE: this provider launches only in full mode.*nothing was created/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["check"]);
  nothingCreated(fx);
  // The preview a person reads fails the same way.
  const text = fx.cli(["spawn", "dev", "--name", "seat", "--backend", "fake", "--launch-config", "claude", "--preview"]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /this provider launches only in full mode/);

  // And the apply is refused with that code, as before: the preview said what it would do.
  const applied = fx.cli(["spawn", "dev", "--name", "seat", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([applied.ok, applied.error.code], [false, "E_BACKEND_SANDBOXED_MODE"], JSON.stringify(applied));
  assert.equal(existsSync(homeOf(fx)), false, "the refused spawn was undone");
});

test("the check a spawn preview asks is the check the spawn asks: the same input, and the same environment (settings, soul, level, backend), for a home that is not there yet", (t) => {
  const fx = packagedProvider(t);
  const told = (c) => ({ input: c.request.input, settings: c.settings, soul: c.soul, soulId: c.soulId, level: c.level, instance: c.instance, backend: c.backend, event: c.event, capability: c.capability, cwd: c.cwd });
  const previewed = fx.cli(["spawn", "dev", "--name", "twin", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]);
  assert.equal(previewed.status, 0, previewed.stdout);
  const atPreview = told(fx.verbs("check")[0]);
  fx.clearCalls();
  const applied = fx.cli(["spawn", "dev", "--name", "twin", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const atApply = told(fx.verbs("check")[0]);
  // (`cwd`: the root of the file system for both; the script is the package's tree for the one, the kernel's copy for the other.)
  assert.deepEqual(atPreview, atApply);
  assert.deepEqual([atPreview.level, atPreview.soul.startsWith(join(fx.root, "dev", "souls") + "/")], [applied.result.home, true], "the level is the home, and the soul its commit's directory, never a preview's temporary copy");
});

test("a provider that cannot be asked fails the preview E_BACKEND_NOT_READY, as it fails the apply; one that outlasts the preview's budget leaves the preflight a timeout", (t) => {
  const fx = packagedProvider(t);
  for (const [control, said] of [[{ check: { exit: 3 } }, /the check command exited 3/], [{ check: { raw: "not json" } }, /its readiness could not be read/]]) {
    fx.control(control);
    const failed = preview(fx);
    assert.equal(failed.status, 1);
    assert.deepEqual([failed.json().ok, failed.json().error.code], [false, "E_BACKEND_NOT_READY"], failed.stdout);
    assert.match(failed.json().error.message, said);
    nothingCreated(fx);
  }
  // Slower than what is left of the budget: the preview answers, and says its preflight did not finish.
  fx.control({ check: { sleepMs: 20000 } });
  const slow = preview(fx, [], { OATS_PREVIEW_PREFLIGHT_BUDGET_MS: "1500" });
  assert.equal(slow.status, 0, slow.stderr);
  assert.deepEqual([slow.json().ok, slow.json().result.preflight.status, slow.json().result.preflight.budgetMs], [true, "timeout", 1500]);
  assert.ok(slow.json().result.preflight.elapsedMs >= 1500 && slow.json().result.preflight.elapsedMs < 15000, "the check was ended at the budget");
  nothingCreated(fx);
  // Slower than a check's OWN limit, with budget to spare: the apply would refuse it, and so does the preview.
  const overLimit = preview(fx, [], { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "1000" });
  assert.equal(overLimit.status, 1);
  assert.deepEqual([overLimit.json().ok, overLimit.json().error.code], [false, "E_BACKEND_NOT_READY"], overLimit.stdout);
  assert.match(overLimit.json().error.message, /did not answer check within 1 s and was killed/);
});

test("a preview that cannot ask says so and goes on: a provider in a member module, which runs only from a spawned home; a provider with no check is not asked; a spawn that launches nothing asks nothing", (t) => {
  // A member module: the provider declares a check, and the preview cannot run it.
  const member = providerDeployment(t, { manifest: CHECKED });
  member.control(REFUSES);
  const told = preview(member);
  assert.equal(told.status, 0, told.stderr);
  assert.deepEqual(told.json().result.warnings, ["acme.fake's session provider fake was not asked whether it can take this launch (a provider in a member module runs only from a spawned home): the spawn asks it before any hook runs, and refuses what it refuses"]);
  assert.equal(told.json().result.preflight.status, "complete");
  assert.deepEqual(member.verbs(), []);

  // A provider that declares no check has nothing to be asked: nothing is said of it.
  const unchecked = providerDeployment(t);
  const plain = preview(unchecked);
  assert.deepEqual([plain.status, (plain.json().result.warnings ?? []).filter((w) => /was not asked/.test(w)), unchecked.verbs()], [0, [], []]);

  // Nothing to ask: nothing is asked, and nothing is said of it.
  const fx = packagedProvider(t);
  fx.control(REFUSES);
  const tmux = fx.cli(["spawn", "dev", "--name", "seat", "--launch-config", "claude", "--preview", "--json"]);
  const unasked = (r) => [r.status, (r.json().result.warnings ?? []).filter((w) => /was not asked/.test(w))];
  assert.deepEqual(unasked(tmux), [0, []], "a tmux launch asks no provider");
  assert.deepEqual(unasked(preview(fx, ["--no-launch"])), [0, []], "a spawn that launches nothing asks nothing");
  assert.deepEqual(fx.verbs(), []);
});

test("a launch preview of a provider home asks the check a start will ask: a refusal is a failed backend check and the preview is not ok; nothing is stopped, started or created", async (t) => {
  const fx = providerDeployment(t, { manifest: CHECKED });
  const { home } = await fx.launch("seat");
  await fx.inEnv(() => stopInstanceSession(home, {}));
  const launchPreview = () => fx.cli(["launch-config", "preview", "--home", home, "--json"]);
  const before = readdirSync(join(dirname(home), ".oats-retirement")).sort();
  fx.clearCalls();
  const clean = launchPreview().json();
  assert.deepEqual([clean.ok, clean.result.ok, clean.result.preflight.filter((c) => !c.ok)], [true, true, []], JSON.stringify(clean).slice(0, 600));
  const asked = fx.verbs("check");
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].request.input.home, asked[0].request.input.launch.harness, asked[0].request.input.launch.trees], [home, "claude", [join(home, "work")]]);
  assert.ok(asked[0].request.input.launch.sandbox, "the allowances, or why there are none, as a start hands them");

  fx.control(REFUSES);
  fx.clearCalls();
  const refused = launchPreview().json();
  assert.deepEqual([refused.ok, refused.result.ok], [true, false], JSON.stringify(refused).slice(0, 600));
  const failed = refused.result.preflight.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => [c.check, c.code]), [["backend", "E_BACKEND_SANDBOXED_MODE"]]);
  assert.match(failed[0].detail, /this provider launches only in full mode/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["check"], "nothing was stopped or launched");
  assert.deepEqual(readdirSync(join(dirname(home), ".oats-retirement")).sort(), before);
  // The start it previews is refused with that code.
  const started = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.deepEqual([started.ok, started.error.code], [false, "E_BACKEND_SANDBOXED_MODE"], JSON.stringify(started));
});

test("a launch preview refuses what the start refuses of the allowances' paths: an events directory reached through a link is a failed backend check, and the provider is not asked", async (t) => {
  // A messaging provider, whose host makes the events directory one of the paths a sandbox may write.
  const fx = providerDeployment(t, { manifest: CHECKED,
    capabilities: { "acme.msg": { manifest: { layer: "messaging", settings: { server: { default: "" } }, sandboxDomains: [{ setting: "server" }] }, files: {} } },
    souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, "acme.msg": { from: "here" } }, messaging: { server: "https://app.example.org/x" } } } } });
  const { home } = await fx.launch("seat");
  await fx.inEnv(() => stopInstanceSession(home, {}));
  // (A command that reads the workspace brings it to this host: what a start then resolves the allowances from.)
  assert.equal(fx.cli(["spawn", "dev", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).status, 0);
  const events = join(realpathSync(fx.dep), ".agents", "events");
  rmSync(events, { recursive: true, force: true });
  mkdirSync(join(fx.dep, "elsewhere"));
  mkdirSync(join(fx.dep, ".agents"), { recursive: true });
  symlinkSync(join(fx.dep, "elsewhere"), events);
  fx.clearCalls();
  const previewed = fx.cli(["launch-config", "preview", "--home", home, "--json"]).json();
  assert.deepEqual([previewed.ok, previewed.result.ok, previewed.result.preflight.filter((c) => !c.ok).map((c) => [c.check, c.code])], [true, false, [["backend", "E_BACKEND_SANDBOX_HOST"]]], JSON.stringify(previewed).slice(0, 600));
  assert.deepEqual([fx.verbs(), readdirSync(join(fx.dep, "elsewhere"))], [[], []], "nothing was asked, and nothing made through the link");
  const started = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.deepEqual([started.ok, started.error.code], [false, "E_BACKEND_SANDBOX_HOST"], JSON.stringify(started));
});

// Feature launch-model-and-check-warnings (test/provider-launch-model.test.mjs has the spawn's, the
// start's and the restart's side).
const WARNS = [{ code: "session-provider-pi-model-unchecked", message: "the model's provider is not one this check can resolve: it is checked at the launch" }, { code: "second", message: "a second thing" }];
const relayed = (w) => `acme.fake's session provider fake (check) warns ${w.code}: ${w.message}`;

test("a spawn preview's check is handed the model the spawn names and no model key when it names none; a refusal on the model fails the preview, as the spawn", (t) => {
  const fx = packagedProvider(t);
  const bare = preview(fx);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(Object.hasOwn(fx.verbs("check")[0].request.input.launch, "model"), false, "none named: no key, never null or an empty string");
  assert.equal(bare.json().result.model, null);
  fx.clearCalls();
  const named = preview(fx, ["--model", "opus"]);
  assert.equal(named.status, 0, named.stderr);
  const { launch } = fx.verbs("check")[0].request.input;
  assert.equal(launch.model, named.json().result.model, "the model the preview answers, which the spawn launches with");
  assert.ok(typeof launch.model === "string" && launch.model.length > 0);
  // The spawn it previews asks with the same model.
  fx.clearCalls();
  const spawned = fx.cli(["spawn", "dev", "--name", "seat", "--backend", "fake", "--launch-config", "claude", "--model", "opus", "--json"]).json();
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  assert.deepEqual([fx.verbs("check")[0].request.input.launch.model, fx.verbs("launch")[0].request.input.model], [launch.model, launch.model]);

  // A provider that cannot resolve it refuses in the preview, with the spawn's code; nothing is created.
  fx.control({ check: { refuseModel: launch.model } });
  fx.clearCalls();
  const refused = fx.cli(["spawn", "dev", "--name", "other", "--backend", "fake", "--launch-config", "claude", "--model", "opus", "--preview", "--json"]);
  assert.equal(refused.status, 1);
  assert.deepEqual([refused.json().ok, refused.json().error.code], [false, "E_BACKEND_LAUNCH_ARG"], refused.stdout);
  assert.match(refused.json().error.message, /other would not be launched: .*cannot resolve the model .*; nothing was created$/);
  assert.equal(existsSync(join(fx.root, "dev", "instances", "other")), false);
  // With no model named it has nothing to refuse.
  assert.equal(fx.cli(["spawn", "dev", "--name", "other", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).status, 0);
});

test("a ready check's warnings are in the spawn preview's warnings, verbatim and tagged, as strings a client shows; a launch preview has them too", async (t) => {
  const fx = packagedProvider(t);
  fx.control({ check: { result: { status: "ready", problems: [], warnings: WARNS } } });
  const previewed = preview(fx);
  assert.equal(previewed.status, 0, previewed.stderr);
  const doc = previewed.json();
  assert.deepEqual([doc.ok, doc.result.preflight.status], [true, "complete"]);
  assert.deepEqual(doc.result.warnings, WARNS.map(relayed));
  // An older reader: the clients' reader of a preview's warnings (which drops an entry that is no
  // string) keeps each, with its text.
  assert.deepEqual(previewWarningsOf(doc.result.warnings), WARNS.map(relayed));
  nothingCreated(fx);
  // The preview a person reads prints them.
  const text = fx.cli(["spawn", "dev", "--name", "seat", "--backend", "fake", "--launch-config", "claude", "--preview"]);
  assert.equal(text.status, 0, text.stderr);
  for (const w of WARNS) assert.ok(`${text.stdout}${text.stderr}`.includes(relayed(w)), text.stdout);

  // A launch's preview (of a stopped home) says what its start will say.
  const { home } = await fx.launch("seat");
  await fx.inEnv(() => stopInstanceSession(home, {}));
  const launch = fx.cli(["launch-config", "preview", "--home", home, "--json"]).json();
  assert.deepEqual([launch.ok, launch.result.ok], [true, true], JSON.stringify(launch).slice(0, 600));
  assert.deepEqual(launch.result.warnings.filter((w) => w.includes("(check) warns")), WARNS.map(relayed));
  const started = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.deepEqual(started.result.warnings.filter((w) => w.includes("(check) warns")), WARNS.map(relayed));
});
