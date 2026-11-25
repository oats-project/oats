// Feature launch-choices (KP-14, oats-project/oats#2122): provider-declared launch choices. A session
// provider declares the names it takes (`sessionProviders.<name>.launchChoices`); `--launch-choice
// <name>=<value>` on spawn, start and restart gives a value; the kernel knows no choice's meaning,
// checks only that the home's provider declares the name, records it, and hands the provider
// `choices` in the planned launch and the launch input. A choice is refused or reaches the launch,
// never dropped, and no answer a client reads carries one. The provider is the fake one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_FEATURES, LAUNCH_CHOICES_FEATURE } from "../lib/kernel-features.mjs";
import { LAUNCH_CHOICES_MAX, launchChoicesOfFlags, resolveLaunchChoices } from "../lib/launch-choices.mjs";
import { rosterGroups, writeServers } from "../lib/servers.mjs";
import { sessionProvidersOf } from "../lib/session-providers.mjs";
import { FAKE_CAPABILITY, fakeManifest, fakeProvider, providerDeployment, sessionsOf } from "./helpers/session-provider-fixture.mjs";

const DECLARED = { "reasoning-level": { description: "How hard the model thinks before it answers" }, "service-tier": { description: "Which service tier the provider asks for" } };
/** The fake provider, declaring two launch choices (and `check`, so the planned launch is recorded). */
const withChoices = (launchChoices = DECLARED) => fakeManifest({ fake: { ...fakeProvider({ check: true }), launchChoices } });
const deployment = (t) => providerDeployment(t, { manifest: withChoices() });
const spawnCli = (fx, name, extra = [], backend = ["--backend", "fake"]) => fx.cli(["spawn", "dev", "--name", name, ...backend, "--launch-config", "claude", "--json", ...extra]).json();
const sessionCli = (fx, home, verb, extra = []) => fx.cli(["session", verb, "--home", home, "--json", ...extra]).json();
const choice = (name, value) => ["--launch-choice", `${name}=${value}`];
const recipeOf = (home) => JSON.parse(readFileSync(join(home, "instance.json"), "utf8")).launch;
/** What the provider was handed, by verb: the planned launch's choices and the launch input's (null: no key). */
const handed = (fx) => fx.verbs().filter((c) => c.verb === "check" || c.verb === "launch").map((c) => [c.verb, (c.verb === "check" ? c.request.input.launch : c.request.input).choices ?? null]);
const acted = (fx) => fx.verbs().map((c) => c.verb).filter((v) => v !== "inspect" && v !== "inspectMany");
// Values no other text of an answer holds, so a leak is found by its text.
const HIGH = "zz-high-9", FAST = "zz-fast-9";

test("the feature is announced; launchOptions is the kernel's own list, untouched", (t) => {
  assert.equal(LAUNCH_CHOICES_FEATURE, "launch-choices");
  assert.ok(KERNEL_FEATURES.includes("launch-choices"));
  const fx = deployment(t);
  const probe = fx.cli(["version", "--json"]).json();
  assert.ok(probe.features.includes("launch-choices"));
  assert.deepEqual(probe.launchOptions, ["yolo"]);
});

test("a manifest declares launch choices by name, each with a one-line description of safe text; anything else is a malformed provider", () => {
  const base = { commands: { run: "bin/session.mjs" } };
  const provider = (launchChoices) => ({ ...base, sessionProviders: { bb: { commands: { launch: "run", inspect: "run", input: "run", stop: "run" }, harnesses: ["pi"], ...(launchChoices === undefined ? {} : { launchChoices }) } } });
  assert.deepEqual(sessionProvidersOf(provider(DECLARED)).providers.bb.launchChoices, DECLARED);
  assert.deepEqual(sessionProvidersOf(provider(undefined)).providers.bb.launchChoices, {}, "none declared: none taken");
  assert.deepEqual(sessionProvidersOf(provider({})).providers.bb.launchChoices, {});
  const eight = Object.fromEntries(Array.from({ length: LAUNCH_CHOICES_MAX }, (_, i) => [`c${i}`, { description: "x" }]));
  assert.equal(Object.keys(sessionProvidersOf(provider(eight)).providers.bb.launchChoices).length, 8);
  const refused = [
    [{ ...eight, ninth: { description: "x" } }, "/sessionProviders/bb/launchChoices"],
    [["reasoning-level"], "/sessionProviders/bb/launchChoices"],
    ["reasoning-level", "/sessionProviders/bb/launchChoices"],
    [{ "Reasoning": { description: "x" } }, "/sessionProviders/bb/launchChoices/Reasoning"],
    [{ "9level": { description: "x" } }, "/sessionProviders/bb/launchChoices/9level"],
    [{ ["a".repeat(41)]: { description: "x" } }, `/sessionProviders/bb/launchChoices/${"a".repeat(41)}`],
    [{ level: {} }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: "text" }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "" } }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "x".repeat(201) } }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "two\nlines" } }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "an \u001b[31mescape" } }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "a bidi \u202e override" } }, "/sessionProviders/bb/launchChoices/level"],
    [{ level: { description: "x", values: ["low", "high"] } }, "/sessionProviders/bb/launchChoices/level"],
  ];
  for (const [launchChoices, pointer] of refused) {
    const { providers, problems } = sessionProvidersOf(provider(launchChoices));
    assert.deepEqual([Object.keys(providers), problems.map((p) => p.pointer)], [[], [pointer]], JSON.stringify(launchChoices));
  }
  // The schema says the same of a description (docs/capability-manifest.schema.json).
  const schema = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8")).properties.sessionProviders.additionalProperties.properties.launchChoices;
  assert.deepEqual([schema.maxProperties, schema.propertyNames.pattern, schema.additionalProperties.additionalProperties, schema.additionalProperties.required], [8, "^[a-z][a-z0-9-]{0,39}$", false, ["description"]]);
  const said = schema.additionalProperties.properties.description, pattern = new RegExp(said.pattern, "u");
  assert.deepEqual([said.minLength, said.maxLength], [1, 200]);
  for (const text of ["How hard the model thinks", "ünïcödé is text"]) assert.equal(pattern.test(text), true, text);
  for (const text of ["two\nlines", "an \u001b[31mescape", "a bidi \u202e override", "an isolate \u2066 mark", "a hidden \u200b space", "a tag \u{E0041} character"]) assert.equal(pattern.test(text), false, JSON.stringify(text));
  // The schema and the kernel refuse the same texts: none of these makes a provider the schema passes and the kernel does not.
  for (const text of ["two\nlines", "a bidi \u202e override", "a tag \u{E0041} character", "a hidden \u200b space"]) assert.equal(Object.keys(sessionProvidersOf(provider({ level: { description: text } })).providers).length, 0, JSON.stringify(text));
});

test("the flag's grammar: <name>=<value>, each name once, at most eight; the rule that resolves one launch's choices refuses and never drops", () => {
  assert.equal(launchChoicesOfFlags([]), undefined);
  assert.deepEqual(launchChoicesOfFlags(["reasoning-level=high", "service-tier=fast_2"]), { "reasoning-level": "high", "service-tier": "fast_2" });
  for (const given of ["level", "=high", "level=", "Level=high", "level=High", "level=a b", "level=a=b", "level=" + "x".repeat(41), "9l=x", "level=é", true]) {
    assert.throws(() => launchChoicesOfFlags([given]), (e) => e.code === "E_BAD_ARGS" && /--launch-choice takes <name>=<value>/.test(e.message), String(given));
  }
  assert.throws(() => launchChoicesOfFlags(["level=a", "level=b"]), (e) => e.code === "E_BAD_ARGS" && e.message === "--launch-choice names level twice");
  assert.throws(() => launchChoicesOfFlags(Array.from({ length: 9 }, (_, i) => `c${i}=x`)), (e) => e.code === "E_BAD_ARGS" && /at most 8 choices/.test(e.message));
  const rule = (how) => resolveLaunchChoices({ who: "seat", backend: "fake", capability: "acme.fake", nothing: "nothing was started", declared: DECLARED, ...how });
  // In the provider's order of declaration, whatever the order given; `default` clears and goes nowhere.
  assert.deepEqual(rule({ given: { "service-tier": "fast", "reasoning-level": "high" } }), { "reasoning-level": "high", "service-tier": "fast" });
  assert.deepEqual(Object.keys(rule({ given: { "service-tier": "fast", "reasoning-level": "high" } })), ["reasoning-level", "service-tier"]);
  assert.deepEqual(rule({ recorded: { "reasoning-level": "high", "service-tier": "fast" }, given: { "reasoning-level": "default" } }), { "service-tier": "fast" });
  assert.deepEqual(rule({ recorded: { "reasoning-level": "high" }, given: { "reasoning-level": "low" } }), { "reasoning-level": "low" });
  assert.deepEqual(rule({ recorded: { "reasoning-level": "high" } }), { "reasoning-level": "high" });
  assert.deepEqual(rule({ given: { "reasoning-level": "default", "never-declared": "default" } }), {}, "a clear of a name that is not recorded, or not declared, clears nothing and is no error");
  assert.deepEqual(rule({}), {});
});

test("a spawn's choices reach the provider's check and its launch, are recorded, and are reused by a plain restart and start; a flag replaces one and `default` clears it", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  // None given: no `choices` key anywhere.
  const bare = spawnCli(fx, "bare");
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.deepEqual(handed(fx), [["check", null], ["launch", null]]);
  assert.equal(Object.hasOwn(recipeOf(bare.result.home), "choices"), false);

  fx.clearCalls();
  const spawned = spawnCli(fx, "seat", [...choice("service-tier", FAST), ...choice("reasoning-level", HIGH)]);
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home, both = { "reasoning-level": HIGH, "service-tier": FAST };
  assert.deepEqual(handed(fx), [["check", both], ["launch", both]], "the planned launch first, then the launch input: the same choices");
  assert.deepEqual(recipeOf(home).choices, both, "recorded in the home's launch recipe");
  // The check's `launch` carries them beside what it carried; nothing else moved.
  assert.deepEqual(Object.keys(fx.verbs("check")[0].request.input.launch), ["harness", "yolo", "args", "choices", "sandbox", "trees", "protected"]);

  // A plain restart, and a plain start of the stopped home: the recorded choices again.
  fx.clearCalls();
  assert.equal(sessionCli(fx, home, "restart").ok, true);
  assert.deepEqual(handed(fx), [["check", both], ["launch", both]]);
  // A flag replaces that name's value and keeps the other.
  fx.clearCalls();
  const lowered = sessionCli(fx, home, "restart", choice("reasoning-level", "low"));
  assert.equal(lowered.ok, true, JSON.stringify(lowered));
  const low = { "reasoning-level": "low", "service-tier": FAST };
  assert.deepEqual([handed(fx), recipeOf(home).choices], [[["check", low], ["launch", low]], low]);
  // `default` clears one: it is not recorded and never reaches the provider.
  fx.clearCalls();
  const cleared = sessionCli(fx, home, "restart", choice("reasoning-level", "default"));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.deepEqual([handed(fx), recipeOf(home).choices], [[["check", { "service-tier": FAST }], ["launch", { "service-tier": FAST }]], { "service-tier": FAST }]);
  assert.equal(JSON.stringify(fx.verbs()).includes('"default"'), false, "the reserved value went to no provider call");
  // The last one cleared: no key is left, in the calls or in the record.
  fx.clearCalls();
  assert.equal(sessionCli(fx, home, "restart", choice("service-tier", "default")).ok, true);
  assert.deepEqual(handed(fx), [["check", null], ["launch", null]]);
  assert.equal(Object.hasOwn(recipeOf(home), "choices"), false);
  // A start of the stopped home with a choice records it, as a spawn does.
  const plan = fx.cli(["instance", "stop", "seat", "--plan", "--json"]).json();
  assert.equal(fx.cli(["instance", "stop", "seat", "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", "stop-seat-1", "--json"]).json().ok, true);
  fx.clearCalls();
  assert.equal(sessionCli(fx, home, "start", choice("reasoning-level", HIGH)).ok, true);
  assert.deepEqual([handed(fx), recipeOf(home).choices], [[["check", { "reasoning-level": HIGH }], ["launch", { "reasoning-level": HIGH }]], { "reasoning-level": HIGH }]);
  // A spawn that launches nothing still records its choices, for the start that follows.
  const later = spawnCli(fx, "later", [...choice("reasoning-level", HIGH), "--no-launch"]);
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.deepEqual(recipeOf(later.result.home).choices, { "reasoning-level": HIGH });
  // A spawn's `default` chooses nothing.
  fx.clearCalls();
  const none = spawnCli(fx, "none", choice("reasoning-level", "default"));
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.deepEqual([handed(fx), Object.hasOwn(recipeOf(none.result.home), "choices")], [[["check", null], ["launch", null]], false]);
});

test("REFUSE, NEVER DROP: a name the provider does not declare, a tmux home, a malformed flag and --resume are E_BAD_ARGS before anything is created, stopped or started", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const homeOf = (name) => join(fx.root, "dev", "instances", name);
  const refusedAs = (answer, pattern) => { assert.deepEqual([answer.ok, answer.error.code], [false, "E_BAD_ARGS"], JSON.stringify(answer)); assert.match(answer.error.message, pattern); };

  // 1. A spawn with a name the provider does not declare: no home, no provider call, no hook.
  refusedAs(spawnCli(fx, "never", choice("temperature", "hot")), /^this spawn cannot take --launch-choice temperature=hot: acme\.fake's session provider fake declares no launch choice temperature \(it declares reasoning-level, service-tier\); nothing was created$/);
  assert.deepEqual([existsSync(homeOf("never")), fx.verbs(), fx.hooks()], [false, [], []]);
  // Its preview is refused the same way.
  const previewed = fx.cli(["spawn", "dev", "--name", "never", "--backend", "fake", "--launch-config", "claude", "--preview", "--json", ...choice("temperature", "hot")]).json();
  refusedAs(previewed, /declares no launch choice temperature/);
  // One declared and one not: the whole spawn is refused, the declared one is not launched alone.
  refusedAs(spawnCli(fx, "never", [...choice("reasoning-level", HIGH), ...choice("temperature", "hot")]), /declares no launch choice temperature/);
  assert.equal(existsSync(homeOf("never")), false);

  // 2. A tmux spawn: refused with tmux's own sentence; a tmux spawn's `default` chooses nothing and is no error.
  refusedAs(spawnCli(fx, "term", choice("reasoning-level", HIGH), []), /^this spawn cannot take --launch-choice reasoning-level=zz-high-9: the tmux backend takes no launch choices yet; for pi, the model's own `:level` sets its thinking; nothing was created$/);
  assert.equal(existsSync(homeOf("term")), false);

  // 3. A malformed flag, a name twice, a flag with no value: refused by the command line itself.
  for (const [extra, pattern] of [[["--launch-choice", "reasoning-level"], /--launch-choice takes <name>=<value>/], [["--launch-choice", "reasoning-level=High"], /--launch-choice takes <name>=<value>/], [[...choice("reasoning-level", "a"), ...choice("reasoning-level", "b")], /names reasoning-level twice/], [["--launch-choice"], /--launch-choice takes <name>=<value>/]]) {
    refusedAs(spawnCli(fx, "never", extra), pattern);
    assert.equal(existsSync(homeOf("never")), false, extra.join(" "));
  }

  // 4. A restart with a name that is not declared: the session that runs still runs; nothing was asked of the provider.
  const spawned = spawnCli(fx, "seat", choice("reasoning-level", HIGH));
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home;
  const running = () => [...sessionsOf(fx.events())].filter(([, s]) => s.running).map(([thread]) => thread);
  const before = running();
  fx.clearCalls();
  refusedAs(sessionCli(fx, home, "restart", choice("temperature", "hot")), /^seat cannot take --launch-choice temperature=hot: acme\.fake's session provider fake declares no launch choice temperature \(it declares reasoning-level, service-tier\); nothing was stopped or started$/);
  assert.deepEqual([acted(fx), running(), recipeOf(home).choices], [[], before, { "reasoning-level": HIGH }], "no check, no stop, no launch; the record did not move");
  for (const extra of [["--launch-choice", "x"], [...choice("service-tier", "a"), ...choice("service-tier", "b")]]) {
    refusedAs(sessionCli(fx, home, "restart", extra), /--launch-choice/);
    assert.deepEqual(acted(fx), []);
  }
  // --resume runs the recorded launch as it is: no choice goes with it.
  refusedAs(sessionCli(fx, home, "start", ["--resume", ...choice("reasoning-level", "low")]), /--resume runs the launch this home recorded; it cannot be combined with --launch-choice/);
  assert.deepEqual(acted(fx), []);
});

test("a tmux HOME takes no launch choice at a start or a restart: refused before anything is planned, stopped or started, a home from before recipes included", (t) => {
  const fx = deployment(t);
  // A tmux home that was never launched: nothing of a terminal is needed to refuse.
  const made = spawnCli(fx, "term", ["--no-launch"], []);
  assert.equal(made.ok, true, JSON.stringify(made));
  const home = made.result.home, record = join(home, "instance.json"), before = readFileSync(record, "utf8");
  assert.equal(JSON.parse(before).backend ?? "tmux", "tmux");
  const sentence = `term cannot take --launch-choice reasoning-level=${HIGH}: the tmux backend takes no launch choices yet; for pi, the model's own \`:level\` sets its thinking; nothing was stopped or started`;
  for (const verb of ["start", "restart"]) {
    const refused = sessionCli(fx, home, verb, choice("reasoning-level", HIGH));
    assert.deepEqual([refused.ok, refused.error.code, refused.error.message], [false, "E_BAD_ARGS", sentence], `${verb}: ${JSON.stringify(refused)}`);
  }
  assert.equal(readFileSync(record, "utf8"), before, "the record did not move");
  // A home from before recipes (it records a command and no recipe) plans nothing at a start: refused all the same,
  // never started on its recorded command without the choice.
  const legacy = JSON.parse(before);
  delete legacy.launch;
  writeFileSync(record, JSON.stringify(legacy, null, 2));
  for (const verb of ["start", "restart"]) {
    const refused = sessionCli(fx, home, verb, choice("reasoning-level", HIGH));
    assert.deepEqual([refused.ok, refused.error.code, refused.error.message], [false, "E_BAD_ARGS", sentence], `${verb}, no recipe: ${JSON.stringify(refused)}`);
  }
  // With another launch flag beside it, the same.
  assert.equal(sessionCli(fx, home, "start", [...choice("reasoning-level", HIGH), "--model", "opus"]).error.code, "E_BAD_ARGS");
});

test("a spawn's decision binds its launch choices, with no key for them: an apply with other choices is stale, and a replay of its key with others is a conflict", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const preview = (extra) => fx.cli(["spawn", "dev", "--name", "bound", "--backend", "fake", "--launch-config", "claude", "--preview", "--json", ...extra]).json();
  const none = preview([]), high = preview(choice("reasoning-level", HIGH)), low = preview(choice("reasoning-level", "low")), cleared = preview(choice("reasoning-level", "default"));
  for (const p of [none, high, low, cleared]) assert.equal(p.ok, true, JSON.stringify(p).slice(0, 400));
  // The decision's keys are the ones it had: the choices are in its revision only.
  assert.deepEqual(Object.keys(high.result.decision).sort(), Object.keys(none.result.decision).sort());
  assert.deepEqual(Object.keys(high.result.decision.effective).sort(), Object.keys(none.result.decision.effective).sort());
  assert.equal(JSON.stringify(high.result).includes(HIGH), false, "and the preview's answer holds no choice");
  const [r0, rHigh, rLow] = [none, high, low].map((p) => p.result.decision.revision);
  assert.equal(new Set([r0, rHigh, rLow]).size, 3, "each set of choices is its own decision");
  assert.equal(cleared.result.decision.revision, r0, "`default` chooses nothing: the decision of a spawn with no choice");
  assert.equal(preview(choice("reasoning-level", HIGH)).result.decision.revision, rHigh, "stable");
  const apply = (revision, extra, key = "k".repeat(64)) => fx.cli(["spawn", "dev", "--name", "bound", "--backend", "fake", "--launch-config", "claude", "--expect-decision", revision, "--idempotency-key", key, "--json", ...extra]).json();
  // The previewed decision with other choices, or with none: stale, nothing created.
  for (const extra of [choice("reasoning-level", "low"), []]) {
    const stale = apply(rHigh, extra);
    assert.deepEqual([stale.ok, stale.error.code], [false, "E_DECISION_STALE"], JSON.stringify(stale).slice(0, 400));
  }
  assert.equal(existsSync(join(fx.root, "dev", "instances", "bound")), false);
  // Applied as previewed.
  const applied = apply(rHigh, choice("reasoning-level", HIGH));
  assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 400));
  assert.deepEqual(recipeOf(applied.result.home).choices, { "reasoning-level": HIGH });
  // The same key again, as it was: the replay. With other choices, or none: a conflict, never answered as taken.
  assert.equal(apply(rHigh, choice("reasoning-level", HIGH)).result.replayed, true);
  for (const [extra, given] of [[choice("reasoning-level", "low"), "reasoning-level=low"], [[], "none"], [[...choice("reasoning-level", HIGH), ...choice("service-tier", FAST)], `reasoning-level=${HIGH}, service-tier=${FAST}`]]) {
    const conflict = apply(rHigh, extra);
    assert.deepEqual([conflict.ok, conflict.error.code], [false, "E_IDEMPOTENCY_CONFLICT"], JSON.stringify(conflict).slice(0, 400));
    assert.equal(conflict.error.message, `idempotency key ${"k".repeat(64)} confirmed bound with other launch choices than this spawn gives (${given}); a key binds one confirmed decision`);
  }
  assert.deepEqual(recipeOf(applied.result.home).choices, { "reasoning-level": HIGH }, "the home is as it was spawned");
  // A replay is held to what the key CONFIRMED, never to the home's choices now: after a restart
  // that changed the choice, and one that cleared it, the same replay is still the replay.
  const home = applied.result.home;
  for (const then of ["low", "default"]) {
    assert.equal(sessionCli(fx, home, "restart", choice("reasoning-level", then)).ok, true);
    const again = apply(rHigh, choice("reasoning-level", HIGH));
    assert.deepEqual([again.ok, again.result?.replayed], [true, true], `after reasoning-level=${then}: ${JSON.stringify(again).slice(0, 400)}`);
    assert.equal(apply(rHigh, choice("reasoning-level", "low")).error.code, "E_IDEMPOTENCY_CONFLICT", "and the choice the home has now is still not what the key confirmed");
  }
  // The other way round: a spawn confirmed with no choice, a start that then adds one, and its replay.
  const plainPreview = fx.cli(["spawn", "dev", "--name", "unbound", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).json();
  const plainApply = (extra) => fx.cli(["spawn", "dev", "--name", "unbound", "--backend", "fake", "--launch-config", "claude", "--expect-decision", plainPreview.result.decision.revision, "--idempotency-key", "p".repeat(64), "--json", ...extra]).json();
  const unbound = plainApply([]);
  assert.equal(unbound.ok, true, JSON.stringify(unbound).slice(0, 400));
  assert.equal(plainApply([]).result.replayed, true, "a decision with no choice replays as it always did");
  assert.equal(sessionCli(fx, unbound.result.home, "restart", choice("reasoning-level", HIGH)).ok, true);
  assert.equal(plainApply([]).result.replayed, true);
  assert.equal(plainApply(choice("reasoning-level", HIGH)).error.code, "E_IDEMPOTENCY_CONFLICT");
  // A tmux spawn's decision (no provider, no choice) replays too: the recorded decision makes its own revision again.
  const termPreview = fx.cli(["spawn", "dev", "--name", "termkey", "--launch-config", "claude", "--no-launch", "--preview", "--json"]).json();
  const termApply = () => fx.cli(["spawn", "dev", "--name", "termkey", "--launch-config", "claude", "--no-launch", "--expect-decision", termPreview.result.decision.revision, "--idempotency-key", "t".repeat(64), "--json"]).json();
  assert.equal(termApply().ok, true);
  assert.equal(termApply().result.replayed, true);
});

test("a recorded choice the provider no longer declares refuses a plain start and restart, naming the way to clear it; cleared, the home starts", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const spawned = spawnCli(fx, "seat", [...choice("reasoning-level", HIGH), ...choice("service-tier", FAST)]);
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home;
  // A release of the provider that dropped one name: the home's copy of the capability moves to it
  // (as `oats instance upgrade` moves it), and the kernel's own copy with it.
  const manifest = join(home, ".oats", "modules", FAKE_CAPABILITY, "oats.json");
  const moved = JSON.parse(readFileSync(manifest, "utf8"));
  delete moved.sessionProviders.fake.launchChoices["service-tier"];
  writeFileSync(manifest, JSON.stringify(moved, null, 2));
  fx.recordComposition(home);
  const running = () => [...sessionsOf(fx.events())].filter(([, s]) => s.running).map(([thread]) => thread);
  const before = running();
  fx.clearCalls();
  const refused = sessionCli(fx, home, "restart");
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BAD_ARGS"], JSON.stringify(refused));
  assert.equal(refused.error.message, `seat records the launch choice service-tier=${FAST}, and acme.fake's session provider fake no longer declares it (it declares reasoning-level). Clear it with --launch-choice service-tier=default; nothing was stopped or started`);
  assert.deepEqual([acted(fx), running()], [[], before], "never started without it, and nothing was stopped");
  // The launch's preview says it too, as a failed check, and starts nothing.
  const previewed = fx.cli(["launch-config", "preview", "--home", home, "--json"]).json();
  assert.deepEqual([previewed.ok, previewed.result.ok, previewed.result.preflight.filter((c) => !c.ok).map((c) => [c.check, c.code])], [true, false, [["launch-choices", "E_BAD_ARGS"]]], JSON.stringify(previewed).slice(0, 600));
  assert.match(previewed.result.preflight.find((c) => c.check === "launch-choices").detail, /Clear it with --launch-choice service-tier=default/);
  // The flag for another name does not clear it either.
  assert.equal(sessionCli(fx, home, "restart", choice("reasoning-level", "low")).error.code, "E_BAD_ARGS");
  assert.deepEqual(acted(fx), []);
  // Cleared as the refusal says: the restart goes, with the choice that is still declared.
  const cleared = sessionCli(fx, home, "restart", choice("service-tier", "default"));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.deepEqual([handed(fx), recipeOf(home).choices], [[["check", { "reasoning-level": HIGH }], ["launch", { "reasoning-level": HIGH }]], { "reasoning-level": HIGH }]);
});

test("a home's record that holds a launch choice this kernel cannot read is refused, never started without it", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const spawned = spawnCli(fx, "seat", choice("reasoning-level", HIGH));
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home, record = join(home, "instance.json");
  const sound = readFileSync(record, "utf8");
  for (const choices of [{ "reasoning-level": "High Value" }, { "Reasoning": "high" }, { "reasoning-level": 3 }, { "reasoning-level": "default" }, ["reasoning-level=high"], "high"]) {
    const meta = JSON.parse(sound);
    meta.launch.choices = choices;
    writeFileSync(record, JSON.stringify(meta, null, 2));
    fx.clearCalls();
    const refused = sessionCli(fx, home, "restart");
    assert.equal(refused.ok, false, JSON.stringify(choices));
    assert.deepEqual(acted(fx).filter((v) => v === "stop" || v === "launch"), [], `nothing was stopped or launched for ${JSON.stringify(choices)}`);
  }
  writeFileSync(record, sound);
  assert.equal(sessionCli(fx, home, "restart").ok, true);
});

test("NO LEAK: a recorded choice is in no answer a client reads: the spawn's, the start's and the restart's answers, the status row, session inspect, inspect --home, the launch preview, the events, the remote roster row", async (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const plain = spawnCli(fx, "quiet");
  const spawned = spawnCli(fx, "seat", [...choice("reasoning-level", HIGH), ...choice("service-tier", FAST)]);
  assert.deepEqual([spawned.ok, plain.ok], [true, true], JSON.stringify([plain, spawned]).slice(0, 900));
  const home = spawned.result.home;
  assert.deepEqual(recipeOf(home).choices, { "reasoning-level": HIGH, "service-tier": FAST }, "fixture premise: it is recorded");
  const clean = (what, text) => { for (const word of [HIGH, FAST, '"choices"', "reasoning-level", "service-tier"]) assert.equal(String(text).includes(word), false, `${what} holds ${word}`); };
  // The keys of every object of an answer, by path with the instance's name and home taken out: the shape a client reads.
  const shape = (value, name) => {
    const keys = [];
    const walk = (v, at) => { if (Array.isArray(v)) v.forEach((x) => walk(x, `${at}[]`)); else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) { keys.push(`${at}.${k}`); walk(v[k], `${at}.${k}`); } };
    walk(value, "");
    return [...new Set(keys)].map((k) => k.replaceAll(name, "<name>")).sort();
  };
  // The spawn's answer: its text, and its keys are those of a spawn with no choice (the recipe's among them).
  clean("the spawn's answer", JSON.stringify(spawned));
  assert.deepEqual(Object.keys(spawned.result.launch).sort(), Object.keys(plain.result.launch).sort(), "the recipe's keys are unchanged");
  assert.deepEqual(shape(spawned.result, "seat"), shape(plain.result, "quiet"));
  // A restart's and a start's answers.
  const restarted = sessionCli(fx, home, "restart"), plainRestarted = sessionCli(fx, plain.result.home, "restart");
  assert.equal(restarted.ok && plainRestarted.ok, true, JSON.stringify(restarted));
  clean("the restart's answer", JSON.stringify(restarted));
  assert.deepEqual(shape(restarted.result, "seat"), shape(plainRestarted.result, "quiet"));
  const withFlag = sessionCli(fx, home, "restart", choice("reasoning-level", HIGH));
  clean("a restart's answer with the flag given", JSON.stringify(withFlag));
  assert.deepEqual(shape(withFlag.result, "seat"), shape(plainRestarted.result, "quiet"));
  // The status row.
  const status = fx.cli(["status", "--json"]);
  clean("oats status --json", status.stdout);
  const rows = JSON.parse(status.stdout).agents.flatMap((a) => a.instances);
  const row = rows.find((r) => r.instance === "seat"), plainRow = rows.find((r) => r.instance === "quiet");
  assert.deepEqual(Object.keys(row.launch).sort(), Object.keys(plainRow.launch).sort(), "the row's recipe keys are unchanged");
  assert.deepEqual(shape(row, "seat"), shape(plainRow, "quiet"));
  clean("oats status", fx.cli(["status"]).stdout);
  // session inspect, inspect --home, the launch's preview, the events.
  clean("oats session inspect", fx.cli(["session", "inspect", "--home", home, "--json"]).stdout);
  clean("oats inspect --home", fx.cli(["inspect", "--home", home, "--json"]).stdout);
  clean("oats launch-config preview", fx.cli(["launch-config", "preview", "--home", home, "--json"]).stdout);
  clean("oats instance events", fx.cli(["instance", "events", "seat", "--json"]).stdout);
  clean("oats readiness", fx.cli(["readiness", "--home", home, "--json"]).stdout);
  // The remote roster row: what a client of another machine is relayed of this host's status.
  const saved = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = join(fx.base, "h");
  t.after(() => { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; });
  writeServers({ build: { sshHost: "build-host", workspace: fx.dep } });
  const relayed = await rosterGroups({ server: "build", io: { execFileAsync: async () => status.stdout, serverId: `build-${Date.now()}` } });
  assert.ok(relayed.groups[0].instances.some((r) => r.instance === "seat"), "fixture premise: the row is relayed");
  clean("the remote roster", JSON.stringify(relayed));
});
