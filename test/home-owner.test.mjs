// The kernel acts on a home only as the home's owner (docs/trust-model.md, rule 3).
//
// A lifecycle command runs what a home contains: its hooks, its harness, the Git of its
// repositories. Run as another user, and above all as root, it would hand that user's authority
// to whoever can write the home. So every verb that takes a home's claim (start, resume, stop,
// retire, upgrade) is refused before the claim is written when the effective user does not own
// the home, and root is refused like anyone else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuseHomeOfAnotherUser } from "../lib/home-owner.mjs";
import { claimHomeFor, releaseHomeClaim } from "../lib/core.mjs";
import { BEFORE_EFFECT_CODES } from "../lib/errors.mjs";

const ownedBy = (uid) => () => ({ uid });

test("the owner is not refused, whoever it is", () => {
  for (const uid of [0, 501, 20001]) assert.equal(refuseHomeOfAnotherUser("retire", "dev-1", "/homes/dev-1", { euid: uid, stat: ownedBy(uid) }), undefined);
});

test("another user is refused with the owner, the user and the fix", () => {
  assert.throws(() => refuseHomeOfAnotherUser("retire", "dev-1", "/homes/dev-1", { euid: 501, stat: ownedBy(20001) }), (e) => {
    assert.equal(e.code, "E_HOME_NOT_OWNED");
    assert.deepEqual(e.details, { instance: "dev-1", home: "/homes/dev-1", owner: 20001, user: 501 });
    assert.match(e.message, /^Nothing was done: /);
    assert.match(e.message, /\/homes\/dev-1 belongs to uid 20001/);
    assert.match(e.message, /this retire of dev-1 runs as uid 501\b/);
    assert.match(e.message, /Run the same command as that user, with that user's HOME: sudo -H -u '#20001' oats retire …$/);
    return true;
  });
});

test("the fix names the command as it is typed, for every verb that takes a claim", () => {
  const typed = { start: "session start", resume: "session start --resume", stop: "instance stop", retire: "retire", upgrade: "instance upgrade" };
  for (const [verb, command] of Object.entries(typed)) {
    assert.throws(() => refuseHomeOfAnotherUser(verb, "dev-1", "/homes/dev-1", { euid: 501, stat: ownedBy(20001) }), (e) => e.message.endsWith(`sudo -H -u '#20001' oats ${command} …`), verb);
  }
});

test("root is refused like any other user, and told so", () => {
  assert.throws(() => refuseHomeOfAnotherUser("start", "dev-1", "/homes/dev-1", { euid: 0, stat: ownedBy(20001) }), (e) => {
    assert.equal(e.code, "E_HOME_NOT_OWNED");
    assert.match(e.message, /runs as uid 0 \(root\)/);
    assert.match(e.message, /root is no exception/);
    return true;
  });
});

test("where there are no user ids, or the home cannot be read, the verb's own refusals answer", () => {
  assert.equal(refuseHomeOfAnotherUser("stop", "dev-1", "/homes/dev-1", { euid: null, stat: ownedBy(1) }), undefined);
  assert.equal(refuseHomeOfAnotherUser("stop", "dev-1", "/homes/dev-1", { euid: 501, stat: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), undefined);
});

test("the refusal is one a stop and a retire answer only before any effect", () => {
  for (const verb of ["instance stop", "retire"]) assert.ok(BEFORE_EFFECT_CODES[verb].includes("E_HOME_NOT_OWNED"), verb);
});

test("a home of this user gives its claim to every verb", (t) => {
  // The claim is written beside the home, in its instances directory.
  const base = mkdtempSync(join(tmpdir(), "oats-home-owner-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "instances", "dev-1");
  mkdirSync(home, { recursive: true });
  for (const verb of ["start", "resume", "stop", "retire", "upgrade"]) releaseHomeClaim(claimHomeFor(verb, "dev-1", home));
});

// A real home of another user, with no mock: the system's root directory, as any user but its owner.
const euid = process.geteuid?.();
const foreign = euid !== undefined && statSync("/").uid !== euid;
test("no verb takes the claim of a home of another user, and nothing is written", { skip: foreign ? false : "this user owns /, or the platform has no user ids" }, () => {
  const before = readdirSync("/").sort();
  for (const verb of ["start", "resume", "stop", "retire", "upgrade"]) {
    assert.throws(() => claimHomeFor(verb, "dev-1", "/"), (e) => e.code === "E_HOME_NOT_OWNED" && e.details.owner === statSync("/").uid && e.details.user === euid, verb);
  }
  assert.deepEqual(readdirSync("/").sort(), before);
});
