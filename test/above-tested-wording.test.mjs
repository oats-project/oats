// #1879 acceptance 7 (one wording): `oats update`'s line on a minor or major jump (lib/pi-bridge.mjs
// desktopFirstLine) carries the Desktop's held-back sentence (packages/client/above-tested-notice.mjs
// heldBackSentence) for the same target version, word for word, so the person reads one message, not two that
// differ. The kernel imports nothing of its clients, so the sentence is written in both places; this test is
// what holds them equal. It may import both: it is neither.
import test from "node:test";
import assert from "node:assert/strict";
import { desktopFirstLine, planCliUpdate, LAST_HARD_CEILING_DESKTOP } from "../lib/pi-bridge.mjs";
import { heldBackSentence, aboveTestedNotice } from "../packages/client/above-tested-notice.mjs";

// The core as decided on #1879, spelled here independently of both producers.
const PINNED = (version) => `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${version}.`;

test("the client's held-back sentence is the pinned core, naming the version to install", () => {
  for (const version of ["0.70.0", "0.70.3", "1.0.0"]) assert.equal(heldBackSentence(version), PINNED(version));
});

test("oats update's minor-jump line contains the client builder's core sentence for the same target version", () => {
  for (const [installed, target] of [["0.69.17", "0.70.0"], ["0.69.18", "0.70.2"], ["0.69.18", "1.0.0"], ["0.70.4", "0.72.1"]]) {
    const line = desktopFirstLine(planCliUpdate(installed, target));
    assert.equal(typeof line, "string", `${installed} → ${target}`);
    assert.ok(line.includes(heldBackSentence(target)), `${installed} → ${target}: ${line}`);
    // The older Desktop that refuses the CLI is said after the core, never in its place.
    assert.ok(line.indexOf(heldBackSentence(target)) < line.indexOf(LAST_HARD_CEILING_DESKTOP), line);
  }
  // Within a minor there is no line, so there is nothing to keep equal.
  assert.equal(desktopFirstLine(planCliUpdate("0.70.0", "0.70.4")), null);
});

test("the Desktop's notice carries the same core after its why", () => {
  const notice = aboveTestedNotice({ cliVersion: "0.70.2", testedThrough: "0.69" });
  assert.equal(notice, `This Desktop was tested with oats CLIs up to 0.69; the installed CLI is 0.70.2. ${PINNED("0.70.2")}`);
});
