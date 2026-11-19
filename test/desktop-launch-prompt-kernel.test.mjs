// The Desktop's launch-prompt readers on the REAL kernel (OATS 0.52.0; docs/desktop-cli-api.md § "Launch
// prompt results" and § "Start and restart"). Nothing here is a hand-written kernel shape: the results come
// from the kernel's own controller (lib/launch-prompts.mjs `createLaunchPromptController`) over a fake
// transport that shows the repository's captured Claude screens (test/helpers/dev-channel-screens.mjs), the
// rows are the data the controller hands its audit, and the refusal is the error
// lib/launch-preference.mjs `launchConfigAmbiguous` builds. Each is then read the way the Desktop reads it
// (packages/client/launch-prompt-outcome.mjs, spawn-preview-cli.mjs, spawn-messages.mjs, and the Activity
// reader in packages/desktop/renderer/instance-events-data.mjs).
//
// Two shapes are composed here as lib/core.mjs composes them, because core does not export the functions:
// the details of E_SPAWN_INCOMPLETE (`retainedPromptError`) and the record of a start where Claude ignored
// the flag (`channelsUnavailable`). The kernel's own tests pin those; this file reads lib/ and edits nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLaunchPromptController } from "../lib/launch-prompts.mjs";
import { DEV_CHANNEL_ENTRIES, FLAG_IGNORED_ENTRIES } from "../lib/launch-prompt-fixtures.mjs";
import { launchConfigAmbiguous } from "../lib/launch-preference.mjs";
import { FLAG_IGNORED_WARNING, DEV_CHANNEL_STATEMENT } from "../lib/core.mjs";
import { raw296, trustPrompts, flagIgnored } from "./helpers/dev-channel-screens.mjs";
import { launchPromptOutcome, launchPromptDiffered, differedLines, retainedSpawnDetails, retainedSpawnMessage, retainedStartMessage,
  launchFlagIgnored, flagIgnoredFact, flagIgnoredNotice, LAUNCH_INSPECTION } from "../packages/client/launch-prompt-outcome.mjs";
import { displayLine } from "../packages/client/display-text.mjs";
import { cliSpawnPreview } from "../packages/client/spawn-preview-cli.mjs";
import { spawnApplyReason } from "../packages/client/spawn-apply-contract.mjs";
import { spawnProblem } from "../packages/client/spawn-messages.mjs";
import { spawnText } from "../packages/desktop/renderer/spawn-words.mjs";
import { eventsData } from "../packages/desktop/renderer/instance-events-data.mjs";

const ENTRY = DEV_CHANNEL_ENTRIES[0].id, NOTICE = FLAG_IGNORED_ENTRIES[0].id;
const NAME = "dev-a";
const pane = { socket: "/private/test.sock", windowId: "@4", paneId: "%7", pid: "42" };
const trust = trustPrompts["frame-02-trust-selected.txt"];
const KEPT = "Its session was kept. Refresh status, then open its terminal to read what it shows. Do not start it again before that.";
const SUBMITTED = "A launch-prompt answer was submitted; this does not confirm readiness.";

/** The kernel's controller over a fake transport. `screen(captures)` is what the pane shows before an Enter,
 * `afterEnter(captures)` after it; time moves only by the controller's own sleeps. */
function launch(t, { screen, afterEnter = () => "", retained = true }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-desktop-launch-prompt-")));
  const home = join(base, "home");
  mkdirSync(home);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const io = { time: 0, captures: 0, sends: [], audits: [], show: screen };
  const transport = {
    snapshot: (target) => ({ ...target, width: 194, height: 50, text: io.show(++io.captures) }),
    send: (_target, key) => { io.sends.push(key); io.show = afterEnter; return { status: "submitted" }; },
  };
  const controller = createLaunchPromptController({ home, startId: "start-desktop-test", claudeVersion: "2.1.296", claudeVersionSource: "executable-path", transport,
    audit: (data) => { io.audits.push(data); return { ok: true, row: { at: "2026-10-11T00:00:00.000Z", kind: "launch-prompt", incarnation: "test-incarnation", data: { ...data } },
      results: [{ path: join(home, ".oats-events.jsonl"), ok: true }] }; },
    retainFrame: () => ({ ok: retained }), now: () => io.time, sleep: (ms) => { io.time += ms; } });
  return { result: controller.observeNew(pane), io, home };
}
/** The details of E_SPAWN_INCOMPLETE for a kept outcome, as lib/core.mjs `retainedPromptError` composes them. */
const details = (home, launchPrompts) => ({ retained: true, unconfirmed: true, instance: NAME, home, launched: "unknown", target: { backend: "tmux", ...pane }, parentLineageCommitted: false, launchPrompts });
/** The controller's audit data as rows of an events answer, read by the Activity reader. */
function activity(audits) {
  // The answer's own identity is inert; the row's data is the kernel's, its real home included (not read).
  const home = `/inert/ws/agents/dev/instances/${NAME}`;
  const birth = "2026-10-10T00:00:00.000Z", selector = { instance: NAME, agent: "dev", agentsRoot: "/inert/ws/agents", server: null };
  const target = { workspace: "ws", context: "/inert/ws", selector, home, incarnation: birth };
  const events = audits.map((data, n) => ({ eventsApi: 2, instance: NAME, home, incarnation: birth, producer: "kernel", kind: "launch-prompt", at: `2026-10-11T00:00:0${n}.000Z`, data }));
  const last = events.at(-1);
  const out = eventsData({ eventsApi: 2, instance: NAME, home, incarnation: birth, count: events.length, returned: events.length, truncated: false,
    integrity: { unreadableRows: 0, foreignRows: 0, sources: [{ path: "home", status: "ok", bytes: 1024 }, { path: "workspace", status: "ok", bytes: 1024 }] },
    events, lastEvent: { kind: last.kind, at: last.at, producer: last.producer, incarnation: last.incarnation }, waitingOnYou: null, waitingClaims: [], notes: [] }, target);
  assert.ok(out, "the Activity reader reads the kernel's rows");
  return out.events.map((row) => row.data);
}

test("a blocked result of the kernel's controller (a folder-trust prompt) reads with what differed, twice the same", (t) => {
  const { result, io, home } = launch(t, { screen: () => trust });
  assert.equal(result.status, "blocked"); assert.equal(result.reason, "blocked: unexpected prompt");
  assert.deepEqual(io.sends, []);
  const d = result.differed.firstDifference;
  assert.equal(result.differed.nearest, ENTRY); assert.ok(d.expected.length <= 40 && d.found.length <= 40 && d.expected !== d.found);

  const outcome = launchPromptOutcome(result);
  assert.deepEqual(outcome, { status: "blocked", answers: [], reason: "blocked: unexpected prompt",
    receipt: [{ ok: true, results: [{ path: join(home, ".oats-events.jsonl"), ok: true }] }],
    differed: { nearest: ENTRY, index: d.index, expected: displayLine(d.expected), found: displayLine(d.found) } });
  // The server projects, then main and the renderer project again.
  assert.deepEqual(launchPromptOutcome(outcome), outcome);
  assert.deepEqual(launchPromptOutcome(JSON.parse(JSON.stringify(outcome))), outcome);
  assert.deepEqual(launchPromptDiffered(result.differed), outcome.differed);
  const lines = differedLines(outcome.differed);
  assert.deepEqual(lines.lines.map((line) => [line.leadIn, line.text ?? line.note]), [["OATS expected:", outcome.differed.expected ?? "(no visible text)"], ["The terminal showed:", outcome.differed.found ?? "(no visible text)"]]);
  assert.equal(lines.detail, `Nearest entry ${ENTRY}, first difference at ${d.index}`);

  const kept = retainedSpawnDetails(details(home, result));
  assert.deepEqual(kept.launchPrompts, outcome); assert.equal(kept.instance, NAME); assert.equal(kept.home, home);
  assert.equal(retainedStartMessage(NAME, kept), `OATS could not confirm that ${NAME} finished starting: blocked: unexpected prompt. ${KEPT}`);
  assert.match(retainedSpawnMessage(kept), new RegExp(`^${NAME} was retained: blocked: unexpected prompt\\. Inspect its existing pane`));

  // The row the kernel writes for it, in Activity: the version, and the same difference.
  assert.deepEqual(activity(io.audits), [{ status: "blocked", reason: "blocked: unexpected prompt", claudeVersion: "2.1.296", differed: outcome.differed }]);
});

test("an Enter whose completion the kernel did not see: blocked, `blocked: observation timeout`, the Enter in answers; the Desktop says an answer was submitted", (t) => {
  const { result, io, home } = launch(t, { screen: () => raw296, afterEnter: () => "" });
  assert.deepEqual(io.sends, ["Enter"]); assert.equal(io.time, 30000);
  assert.equal(result.status, "blocked"); assert.equal(result.reason, "blocked: observation timeout");
  assert.deepEqual(result.answers, [{ class: "awebDevelopmentChannel", signatureId: ENTRY, status: "submitted" }]);

  const kept = retainedSpawnDetails(details(home, result));
  assert.equal(kept.launchPrompts.status, "blocked"); assert.equal(kept.launchPrompts.reason, "blocked: observation timeout");
  assert.deepEqual(kept.launchPrompts.answers, result.answers);
  assert.equal(retainedStartMessage(NAME, kept), `OATS could not confirm that ${NAME} finished starting: blocked: observation timeout. ${SUBMITTED} ${KEPT}`);
  assert.match(retainedSpawnMessage(kept), new RegExp(`^${NAME} was retained: blocked: observation timeout\\. ${SUBMITTED.replace(/[.;]/g, "\\$&")}`));
  // Its rows: the answer names the confirmation OATS recognised; the last row is the outcome.
  const rows = activity(io.audits);
  assert.deepEqual(rows.map((row) => row.status), ["attempted", "submitted", "blocked"]);
  assert.equal(rows[1].signatureId, ENTRY); assert.equal(rows[2].reason, "blocked: observation timeout");
  for (const row of rows) assert.equal(row.claudeVersion, "2.1.296");
});

test("every reason the kernel writes when its own evidence is not kept is in the Desktop's set", (t) => {
  // A prompt OATS does not confirm; a screen that never settles, before any Enter and after one; the
  // confirmation still there after the Enter; and a launch that otherwise completed.
  const spinner = (n) => `SYNTHETIC spinner ${n}\n`, session = "SYNTHETIC session ready\n> \n";
  const cases = [
    [{ screen: () => trust, retained: false }, "blocked: unexpected prompt; private launch evidence retention failed"],
    [{ screen: spinner, retained: false }, "blocked: observation timeout; private launch evidence retention failed"],
    // After the Enter: a session that goes blank before it has been clean for the kernel's 2 s, to the bound.
    [{ screen: () => raw296, afterEnter: (n) => (n % 5 === 0 ? "" : session), retained: false }, "blocked: observation timeout; private launch evidence retention failed"],
    [{ screen: () => raw296, afterEnter: () => raw296, retained: false }, "blocked: repeated or unsupported prompt; private launch evidence retention failed"],
    [{ screen: () => raw296, afterEnter: () => session, retained: false }, "private launch evidence retention failed"],
  ];
  for (const [options, reason] of cases) {
    const { result, home } = launch(t, options);
    assert.equal(result.reason, reason);
    const outcome = launchPromptOutcome(result);
    assert.equal(outcome.reason, reason); assert.notEqual(outcome.reason, LAUNCH_INSPECTION);
    assert.equal(outcome.status, result.status);
    assert.ok(retainedStartMessage(NAME, retainedSpawnDetails(details(home, result))).includes(`finished starting: ${reason}.`));
  }
});

test("a start where Claude ignored the flag: the kernel's record and its own warning give the notice, the warning whole", (t) => {
  const { result, io, home } = launch(t, { screen: (n) => flagIgnored.replace(/Retrying in \d+s/, `Retrying in ${n}s`) });
  assert.equal(result.status, "flag-ignored"); assert.equal(result.reason, "channels-unavailable"); assert.equal(result.signatureId, NOTICE);
  assert.deepEqual(io.sends, []);
  // The start's answer: `launchPrompts` as lib/core.mjs `channelsUnavailable` records it, and the kernel's
  // sentence in place of its statement among `warnings` (`flagIgnoredWarnings`).
  const answer = { instance: NAME, home, warnings: ["a launch hook's own warning", FLAG_IGNORED_WARNING],
    launchPrompts: { status: "flag-ignored", reason: "channels-unavailable", signatureId: result.signatureId, startId: "start-desktop-test", at: "2026-10-11T00:00:00.000Z" } };
  // The kernel's two fixed strings pass the display filter whole: nothing of them is withheld or folded.
  assert.equal(displayLine(FLAG_IGNORED_WARNING), FLAG_IGNORED_WARNING); assert.equal(displayLine(DEV_CHANNEL_STATEMENT), DEV_CHANNEL_STATEMENT);
  assert.deepEqual(launchFlagIgnored(answer), { reason: "channels-unavailable", warnings: answer.warnings, omitted: 0 });
  // A launched spawn's answer carries the same two fields (0.52.0): `spawnInstanceAsync` in lib/core.mjs
  // composes it from the same `channelsUnavailable` and `flagIgnoredWarnings`, with no export for it, so the
  // shape above stands for both. The Desktop's spawn receipt carries the reader's fact through its decoder:
  // the kernel's own words are a fact the decoder accepts as it is.
  assert.deepEqual(flagIgnoredFact(launchFlagIgnored(answer)), launchFlagIgnored(answer));
  assert.deepEqual(flagIgnoredNotice(NAME, launchFlagIgnored(answer)), {
    headline: `${NAME} started. Claude Code reported that channels are not available and ignored the channel option, so mail and chat will not wake this instance.`,
    detail: `OATS says:\na launch hook's own warning\n${FLAG_IGNORED_WARNING}` });
  // The kernel appends its own sentence last (`flagIgnoredWarnings`), and the cut is by position: warnings that
  // fill the bound before it leave it out first. The fact is not lost, because the headline says it from the
  // status and the reason; what a person does not see then is the kernel's advice on what to check, and the last
  // line says that something was left out. The Desktop neither keeps the last warning nor looks for this one.
  const hook = (letter) => `a launch hook's long warning ${letter.repeat(2000)}`;
  const filled = { ...answer, warnings: [hook("a"), hook("b"), FLAG_IGNORED_WARNING] };
  assert.deepEqual(launchFlagIgnored(filled), { reason: "channels-unavailable", warnings: [hook("a"), hook("b")], omitted: 1 });
  const cut = flagIgnoredNotice(NAME, launchFlagIgnored(filled));
  assert.equal(cut.headline, `${NAME} started. Claude Code reported that channels are not available and ignored the channel option, so mail and chat will not wake this instance.`);
  assert.equal(cut.detail, `OATS says:\n${hook("a")}\n${hook("b")}\n1 more not shown.`);
  assert.equal(cut.detail.includes(FLAG_IGNORED_WARNING), false);
  // Seven of the kernel's own sentence fit the bound on the total; the eighth does not.
  assert.equal(launchFlagIgnored({ ...answer, warnings: Array(8).fill(FLAG_IGNORED_WARNING) }).warnings.length, Math.floor(4096 / FLAG_IGNORED_WARNING.length));
  // The kernel's two sentences are not looked for: with any other status, or none, they give no fact and no notice.
  for (const launchPrompts of [undefined, { status: "not-engaged", startId: "s", at: "t" }, { status: "completed", answers: [], reason: "recognized launch boundary", receipt: [] }])
    assert.equal(launchFlagIgnored({ ...answer, launchPrompts, warnings: [DEV_CHANNEL_STATEMENT, FLAG_IGNORED_WARNING] }), null);
  // The controller's own result is not the start's answer: a kept-session reader that met it reads it as unknown.
  assert.equal(launchPromptOutcome(result).status, "unknown");
  // Its one row in Activity: the notice is the screen OATS recognised.
  assert.deepEqual(activity(io.audits), [{ status: "flag-ignored", reason: "channels-unavailable", claudeVersion: "2.1.296", signatureId: NOTICE }]);
});

test("no module that makes or shows the notice holds the kernel's words: no run of eight consecutive words of its two sentences", () => {
  // The Desktop shows the kernel's warnings and matches none by its words, so its code needs none of them. The
  // check reads the kernel's own constants, so it follows the kernel's wording by itself.
  // Measured when this was written: the longest run the Desktop shares with the kernel's flag-ignored sentence is
  // six words, in the headline's "mail and chat will not wake". A failure here is a copy that got in, or a new
  // sentence of the Desktop or of the kernel that came too close.
  const RUN = 8;
  const words = (text) => text.split(/\s+/).filter(Boolean);
  const runs = (sentence, n = RUN) => { const w = words(sentence); return Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) => w.slice(i, i + n).join(" ")); };
  /** The runs of `sentence` that `text` holds, however the text breaks its lines, in code or in a comment
   * (a comment's line markers are not words). */
  const held = (text, sentence) => {
    const flat = words(text.replace(/^[ \t]*(?:\/\/+|\/\*+|\*+\/?)[ \t]?/gm, "")).join(" ");
    return runs(sentence).filter((run) => flat.includes(run));
  };
  const sentences = { FLAG_IGNORED_WARNING, DEV_CHANNEL_STATEMENT };
  // The reader, the receipt that carries its fact, and the three places that show the notice.
  const sources = ["../packages/client/launch-prompt-outcome.mjs", "../packages/client/spawn-apply-contract.mjs", "../packages/desktop/renderer/start-instance.mjs",
    "../packages/desktop/renderer/spawn-dialog.mjs", "../packages/desktop/renderer/spawn-jobs.mjs"];
  for (const [name, sentence] of Object.entries(sentences)) {
    assert.ok(runs(sentence).length >= 20, `${name}: long enough to be split into runs`);
    for (const path of sources) assert.deepEqual(held(readFileSync(new URL(path, import.meta.url), "utf8"), sentence), [], `${path} holds words of ${name}`);
  }
  // The check itself: it reports a text that holds a whole sentence, and one that holds eight consecutive words
  // of it, also across a line break in code or in a comment; seven are not a run. Without this a mistake in the
  // splitting passes for ever.
  for (const [name, sentence] of Object.entries(sentences)) {
    assert.deepEqual(held(`const WARNING = ${JSON.stringify(sentence)};`, sentence), runs(sentence), `${name}: whole`);
    const w = words(sentence), eight = w.slice(4, 4 + RUN).join(" ");
    assert.deepEqual(held(`  if (w === "${eight}") return true;`, sentence), [eight], `${name}: eight words`);
    const first = w.slice(4, 8).join(" "), rest = w.slice(8, 4 + RUN).join(" ");
    for (const broken of [`\`${first}\n    ${rest}\``, `  // ${first}\n  // ${rest}`, `/** ${first}\n * ${rest} */`, `   * ${first}\n   * ${rest}`])
      assert.deepEqual(held(broken, sentence), [eight], `${name}: across a line break: ${JSON.stringify(broken)}`);
    assert.deepEqual(held(w.slice(4, 4 + RUN - 1).join(" "), sentence), [], `${name}: seven words`);
    assert.deepEqual(held(w.slice(4, 4 + RUN).reverse().join(" "), sentence), [], `${name}: the same words in another order`);
  }
});

test("the kernel's own E_LAUNCH_CONFIG_AMBIGUOUS reads as the Desktop's sentence at a preview and at the apply's re-read", async () => {
  const SENTENCE = "This machine has more than one launch configuration for this soul’s harness, and none is the default. Choose one under Launch configuration in Advanced.";
  const choice = { selection: {}, preference: null };
  const several = (count) => Object.fromEntries([...Array.from({ length: count }, (_, n) => [`claude-${String(n).padStart(2, "0")}`, { harness: "claude" }]), ["pi-only", { harness: "pi" }]]);
  for (const count of [2, 40]) {
    const error = launchConfigAmbiguous({ launchConfigs: several(count), harness: "claude", config: null, choice });
    assert.equal(error.code, "E_LAUNCH_CONFIG_AMBIGUOUS"); assert.equal(error.details.configurations.length, count);
    // The CLI's envelope for it, through the exec owner of the Desktop's preview.
    const envelope = { schemaVersion: 1, ok: false, error: { code: error.code, message: error.message, details: error.details } };
    const cli = { ok: true, bin: "/installed/oats", spawnPreviewApi: 2, features: ["spawn-preview-2"] };
    const target = { workspace: "ws", context: "/inert/ws", selector: { soul: "dev", agentsRoot: "/inert/ws/agents" } };
    const execs = [];
    const read = await cliSpawnPreview(cli, { target, choices: {} }, { exec: (bin, argv, _options, done) => { execs.push([bin, argv]); done(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify(envelope)); } });
    assert.equal(execs.length, 1, "the envelope went through the preview's exec owner");
    assert.deepEqual(execs[0], ["/installed/oats", ["spawn", "dev", "--dir", "/inert/ws", "--agents-root", "/inert/ws/agents", "--preview", "--json"]]);
    assert.equal(read.ok, false);
    const reason = read.error;
    // The exec owner keeps the kernel's shape: the code, the message, and of `details` the `fix` alone.
    assert.deepEqual(reason, { code: "E_LAUNCH_CONFIG_AMBIGUOUS", message: error.message, details: { fix: error.details.fix } });
    // The kernel names at most ten configurations, so its message stays within the readers' bounds.
    assert.ok(error.message.length <= 1024, String(error.message.length));
    for (const stage of ["preview", "spawn"]) {
      const problem = spawnProblem(reason, stage);
      assert.equal(spawnText(problem, stage), SENTENCE);
      assert.equal(problem.detail, `E_LAUNCH_CONFIG_AMBIGUOUS · ${error.message}`);
    }
    // The apply's re-read keeps the code with the Desktop's fixed message.
    assert.equal(spawnText(spawnProblem(spawnApplyReason(error.code, error.message), "spawn"), "spawn"), SENTENCE);
  }
  // A choice of the bare harness, or one configuration, is not this refusal.
  assert.equal(launchConfigAmbiguous({ launchConfigs: several(1), harness: "claude", config: null, choice }), null);
  assert.equal(launchConfigAmbiguous({ launchConfigs: several(3), harness: "claude", config: null, choice: { selection: { launchConfig: "none" }, preference: null } }), null);
});
