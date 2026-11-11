// Session resume (#1559), the parts that need no tmux: the exit marker in both forms, how a home's
// last session ended (sessionEnd), the resume selectors renderLaunchRecipe renders, the refusals of
// `session start --resume` before anything is read, and the sweep's machine lock, per-boot note and
// row mapping. The real-tmux sweep is test/session-resume-tmux.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLaunchCommand, parseLaunchCommand, renderLaunchCommand, renderLaunchRecipe, RESUME_NOTICE, startInstanceSession } from "../lib/core.mjs";
import { readStartExited, sessionEndOf } from "../lib/session-end.mjs";
import { acquireResumeLock, bootId, noteSweep, readBootNote, RESUME_LIMIT, resumeSessions, resumeStateDir, rowFromStart } from "../lib/session-resume.mjs";
import { homeKey, nextSeen, recordSeen, resumeEligible } from "../lib/session-seen.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { FRESH_REASON, NOT_SWEPT, OUTCOME, RESUME_WAITING, ROW_REASON, SESSION_END, SESSION_RESUME_FEATURE } from "../lib/session-resume-contract.mjs";
import { identityHolderState } from "../packages/record/lib/process-identity.mjs";
import { acquireHostRunLock, hostRunPlan } from "../lib/host-run.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), "oats-resume-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const write = (home, name, value) => writeFileSync(join(home, name), typeof value === "string" ? value : JSON.stringify(value));
/** OATS_HOME_DIR on a scratch directory for the length of one test. */
function oatsHome(t) {
  const dir = scratch(t), saved = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; });
  return dir;
}

test("the exit marker reads in both forms: the legacy start id on one line, and {startId, status}", (t) => {
  const home = scratch(t);
  assert.equal(readStartExited(home), null, "no marker");
  write(home, ".oats-start-exited", "abc-123\n");
  assert.deepEqual(readStartExited(home), { startId: "abc-123", status: null });
  write(home, ".oats-start-exited", '{"startId":"abc-123","status":0}\n');
  assert.deepEqual(readStartExited(home), { startId: "abc-123", status: 0 });
  write(home, ".oats-start-exited", '{"startId":"abc-123","status":137}\n');
  assert.deepEqual(readStartExited(home), { startId: "abc-123", status: 137 });
  for (const junk of ["", "two words\n", "{not json", '{"status":0}', '["abc"]']) {
    write(home, ".oats-start-exited", junk);
    assert.equal(readStartExited(home), null, JSON.stringify(junk));
  }
});

// The contract's names, pinned here once: every other test reads them from the module. A change is a
// contract change for both product sides (awebai/oats#1567).
test("the session-resume contract's names", () => {
  assert.equal(SESSION_RESUME_FEATURE, "session-resume");
  assert.deepEqual(SESSION_END, { LOST: "lost", STOPPED: "stopped", EXITED: "exited" });
  assert.deepEqual(FRESH_REASON, { NO_CONVERSATION: "no-conversation", NO_RECEIPTS: "no-receipts", RESUME_UNPROVEN: "resume-unproven" });
  assert.deepEqual(RESUME_WAITING, { RESUME_CONFIRMATION: "resume-confirmation" });
  assert.deepEqual(OUTCOME, { RESUMED: "resumed", FRESH: "fresh", ALREADY_RUNNING: "already-running", SKIPPED: "skipped", BLOCKED: "blocked", REFUSED: "refused" });
  assert.deepEqual(ROW_REASON, { UNKNOWN: "unknown", START_BUSY: "start-busy", NOT_LOST: "not-lost", NOT_SEEN_RECENTLY: "not-seen-recently", RESUME_CONFIRMATION: "resume-confirmation", LAUNCH_PROMPT: "launch-prompt", START_REFUSED: "start-refused", REFUSED_THIS_BOOT: "refused-this-boot", KEEPS_GETTING_LOST: "keeps-getting-lost", LIFECYCLE_BUSY: "lifecycle-busy" });
  assert.deepEqual(NOT_SWEPT, { NOT_OK: "not-ok", UNREADABLE: "unreadable" });
});

test("sessionEnd: the full table, legacy forms included", (t) => {
  const created = "2026-10-01T10:00:00.000Z", restarted = "2026-10-02T10:00:00.000Z";
  const meta = { startId: "s2", createdAt: created, restarts: [{ startedAt: restarted }] };
  const before = "2026-10-01T12:00:00.000Z", after = "2026-10-02T12:00:00.000Z";
  const rows = [
    ["a stop that names this start", { stop: { at: before, startId: "s2" } }, SESSION_END.STOPPED],
    ["a stop that names this start, beside its 143", { stop: { at: after, startId: "s2" }, exited: { startId: "s2", status: 143 } }, SESSION_END.STOPPED],
    ["a stop of an earlier start, the harness then ended on its own", { stop: { at: after, startId: "s1" }, exited: { startId: "s2", status: 0 } }, SESSION_END.EXITED],
    ["a stop of an earlier start, nothing else", { stop: { at: after, startId: "s1" } }, SESSION_END.LOST],
    ["a stop receipt without a start id, after this start", { stop: { at: after } }, SESSION_END.STOPPED],
    ["a stop receipt without a start id, before this start", { stop: { at: before } }, SESSION_END.LOST],
    ["a stop receipt whose start id is null, after this start", { stop: { at: after, startId: null } }, SESSION_END.STOPPED],
    ["exit status 0 (/exit)", { exited: { startId: "s2", status: 0 } }, SESSION_END.EXITED],
    ["exit status 1 (its own error)", { exited: { startId: "s2", status: 1 } }, SESSION_END.EXITED],
    ["exit status 127", { exited: { startId: "s2", status: 127 } }, SESSION_END.EXITED],
    ["exit status 128", { exited: { startId: "s2", status: 128 } }, SESSION_END.LOST],
    ["killed (137, an OOM kill of the harness alone)", { exited: { startId: "s2", status: 137 } }, SESSION_END.LOST],
    ["143 with no stop", { exited: { startId: "s2", status: 143 } }, SESSION_END.LOST],
    ["a marker of an earlier start", { exited: { startId: "s1", status: 0 } }, SESSION_END.LOST],
    ["the legacy marker naming this start", { exited: "s2\n" }, SESSION_END.EXITED],
    ["the legacy marker naming an earlier start", { exited: "s1\n" }, SESSION_END.LOST],
    ["neither file", {}, SESSION_END.LOST],
  ];
  for (const [what, files, want] of rows) {
    const home = scratch(t);
    if (files.stop) write(home, ".oats-stop.json", { instance: "x", stop: {}, retained: [], ...files.stop });
    if (files.exited) write(home, ".oats-start-exited", files.exited);
    assert.equal(sessionEndOf(home, meta), want, what);
  }
  // A home that records no start id (spawned before 0.69, never restarted): only a stop after its
  // createdAt names it; a legacy marker cannot.
  const legacy = { createdAt: created };
  for (const [what, files, want] of [
    ["no start id, no stop", { exited: "whatever\n" }, SESSION_END.LOST],
    ["no start id, a stop after createdAt", { stop: { at: before } }, SESSION_END.STOPPED],
    ["no start id, a stop before createdAt", { stop: { at: "2026-09-30T00:00:00.000Z" } }, SESSION_END.LOST],
    ["no start id, a stop that names a start", { stop: { at: before, startId: "s0" } }, SESSION_END.LOST],
  ]) {
    const home = scratch(t);
    if (files.stop) write(home, ".oats-stop.json", { instance: "x", ...files.stop });
    if (files.exited) write(home, ".oats-start-exited", files.exited);
    assert.equal(sessionEndOf(home, legacy), want, what);
  }
  // The current start's time is the last restart's, else createdAt.
  const spawned = scratch(t);
  write(spawned, ".oats-stop.json", { at: before });
  assert.equal(sessionEndOf(spawned, { startId: "s1", createdAt: created }), SESSION_END.STOPPED, "after createdAt, no restart");
  assert.equal(sessionEndOf(spawned, { startId: "s2", createdAt: created, restarts: [{ startedAt: restarted }] }), SESSION_END.LOST, "before the last restart");
});

test("renderLaunchRecipe: the resume selectors, byte for byte, `--` included; Codex has none", () => {
  const hooks = { launch: { claude: "--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace", pi: "--extension '/x/ext.ts'" }, env: { AWEB_DELIVERY: "channel" }, contributions: [] };
  const recipe = (harness) => ({ harness, executable: `/x/${harness}`, args: ["--setting", "a b"], env: { TOKEN: { fromEnv: "SRC" } }, model: "m-1", yolo: true, hooks });
  const resume = { sessionId: "0f8b6a2e-1111-4222-8333-944445555666", prompt: RESUME_NOTICE };
  assert.equal(RESUME_NOTICE, "OATS resumed this session after it was lost (the host restarted or its terminal server ended). Continue from where you were.");
  const env = `OATS_INSTANCE='n' OATS_INSTANCE_HOME='/h' AWEB_DELIVERY='channel' TOKEN="$OATS_LAUNCH_REF_TOKEN"`;
  const claude = renderLaunchRecipe(recipe("claude"), { home: "/h", instance: "n", resume });
  assert.equal(claude, `${env} '/x/claude' --dangerously-skip-permissions --model 'm-1' --resume '${resume.sessionId}' '--setting' 'a b' --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace -- '${RESUME_NOTICE}'`);
  assert.equal(renderLaunchRecipe(recipe("claude"), { home: "/h", instance: "n" }), `${env} '/x/claude' --dangerously-skip-permissions --model 'm-1' '--setting' 'a b' --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace -- '@TASK.md'`, "the ordinary rendering is unchanged");
  const pi = renderLaunchRecipe(recipe("pi"), { home: "/h", instance: "n", resume });
  assert.equal(pi, `${env} '/x/pi' --append-system-prompt '/h/AGENTS.md' --approve --name 'n' --model 'm-1' --session '${resume.sessionId}' '${RESUME_NOTICE}' '--setting' 'a b' --extension '/x/ext.ts'`);
  assert.equal(renderLaunchRecipe(recipe("pi"), { home: "/h", instance: "n" }), `${env} '/x/pi' --append-system-prompt '/h/AGENTS.md' --approve --name 'n' --model 'm-1' '@TASK.md' '--setting' 'a b' --extension '/x/ext.ts'`);
  // The notice is the last argument after `--` for Claude, the positional where @TASK.md stands for pi.
  const argv = (cmd) => describeLaunchCommand(cmd).argv;
  assert.deepEqual(argv(claude).slice(-2), ["--", RESUME_NOTICE]);
  assert.equal(argv(pi)[argv(pi).indexOf("--session") + 2], RESUME_NOTICE);
  for (const cmd of [claude, pi]) assert.equal(renderLaunchCommand(parseLaunchCommand(cmd).tokens), cmd, "the kernel's own parser round-trips it");
  assert.throws(() => renderLaunchRecipe(recipe("codex"), { home: "/h", instance: "n", resume }), /codex has no resume rendering/);
});

test("session start --resume with a launch choice, or as a restart, is refused before anything is read", () => {
  const home = "/nonexistent/oats-resume/home"; // a read would refuse otherwise (no instance.json)
  for (const [o, flag] of [[{ launchConfig: "x" }, "--launch-config"], [{ harness: "pi" }, "--harness"], [{ model: "m" }, "--model"], [{ yolo: true }, "--yolo"], [{ yolo: false }, "--no-yolo"], [{ reselectLaunch: true }, "--reselect-launch"]]) {
    assert.throws(() => startInstanceSession(home, { resume: true, ...o }), (e) => e.code === "E_BAD_ARGS" && e.message.includes(flag) && /nothing was read or started/.test(e.message), flag);
  }
  assert.throws(() => startInstanceSession(home, { resume: true, restart: true }), (e) => e.code === "E_BAD_ARGS");
});

test("bootId: Linux's boot id, macOS's boot time, else none", () => {
  assert.equal(bootId({ platform: "linux", read: () => "0f8b6a2e-1111\n" }), "0f8b6a2e-1111");
  assert.equal(bootId({ platform: "darwin", sysctl: () => "{ sec = 1761555000, usec = 123456 } Mon Oct 27 08:50:00 2026\n" }), "1761555000.123456");
  assert.equal(bootId({ platform: "win32" }), null);
  assert.equal(bootId({ platform: "linux", read: () => { throw new Error("EACCES"); } }), null);
});

test("bootId: macOS's boot time is read with the system's sysctl, never one the caller's PATH names", () => {
  const dir = mkdtempSync(join(tmpdir(), "oats-boot-sysctl-"));
  const sysctl = (where, sec) => { mkdirSync(where, { recursive: true }); writeFileSync(join(where, "sysctl"), `#!/bin/sh\necho "{ sec = ${sec}, usec = 7 } Mon Oct 27 08:50:00 2026"\n`, { mode: 0o755 }); };
  sysctl(join(dir, "system"), 42);
  sysctl(join(dir, "path"), 99);
  const saved = { PATH: process.env.PATH, dirs: process.env.OATS_TEST_SYSTEM_TOOL_DIRS };
  try {
    process.env.PATH = `${join(dir, "path")}:/usr/bin:/bin`;
    process.env.OATS_TEST_SYSTEM_TOOL_DIRS = join(dir, "system");
    assert.equal(bootId({ platform: "darwin" }), "42.7");
    process.env.OATS_TEST_SYSTEM_TOOL_DIRS = join(dir, "none");
    assert.equal(bootId({ platform: "darwin" }), null, "no sysctl in the system directories: no boot id, not the PATH's");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.dirs === undefined) delete process.env.OATS_TEST_SYSTEM_TOOL_DIRS; else process.env.OATS_TEST_SYSTEM_TOOL_DIRS = saved.dirs;
    rmSync(dir, { recursive: true, force: true });
  }
});

const KERNEL_BOOT = "e0a897ff-f23d-4a81-847d-671154dc5f43";
/** PID 1's `/proc/1/stat` line, started `start` clock ticks after the kernel's boot (field 22). */
const pid1Stat = (start, comm = "sh") => `1 (${comm}) S 0 1 1 0 -1 4194560 796 88 0 0 0 0 0 0 20 0 1 0 ${start} 2473984 358 18446744073709551615 187650185953280 187650186080492 281474719137136 0 0 0 0 0 65538 1 0 0 17 5 0 0 0 0 0 187650186144608 187650186150416 187650434920448 281474719141477 281474719141769 281474719141769 281474719141868 0\n`;
/** `/proc` as a Linux process reads it: the kernel's boot id and PID 1's stat (`stat` undefined:
 *  unreadable). */
const procOf = (stat, boot = KERNEL_BOOT) => (p) => {
  if (p === "/proc/sys/kernel/random/boot_id") return `${boot}\n`;
  if (p === "/proc/1/stat" && stat !== undefined) return stat;
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
};
/** What marks a container, one at a time: the file Docker writes, the file Podman writes, the
 *  variable Kubernetes sets. */
const CONTAINER_MARKERS = {
  docker: { exists: (p) => p === "/.dockerenv", env: {} },
  podman: { exists: (p) => p === "/run/.containerenv", env: {} },
  kubernetes: { exists: () => false, env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } },
};
const NO_MARKER = { exists: () => false, env: {} };
const linuxBoot = (stat, { boot, marker = NO_MARKER } = {}) => bootId({ platform: "linux", read: procOf(stat, boot), ...marker });
const containerBoot = (stat, boot) => linuxBoot(stat, { boot, marker: CONTAINER_MARKERS.docker });

test("bootId on a Linux host: the kernel's boot id and nothing else, whenever PID 1 started", () => {
  for (const start of [0, 2, 147, 999]) assert.equal(linuxBoot(pid1Stat(start, "systemd")), KERNEL_BOOT, `PID 1 started at tick ${start}`);
});

test("bootId in a PID namespace of its own on a host, with nothing marking a container: the host's boot", () => {
  // A harness runs a command in a sandbox that unshares PIDs: its PID 1 is the sandbox's, started
  // long after the kernel, and the command is on the host's boot all the same.
  for (const start of [1000, 30666820, 30667142]) assert.equal(linuxBoot(pid1Stat(start, "bwrap")), KERNEL_BOOT, `the sandbox's PID 1 started at tick ${start}`);
  // A variable that only resembles the one Kubernetes sets marks nothing; neither does an empty one.
  assert.equal(bootId({ platform: "linux", read: procOf(pid1Stat(30666820)), exists: () => false, env: { KUBERNETES_PORT: "tcp://10.96.0.1:443", KUBERNETES_SERVICE_HOST: "" } }), KERNEL_BOOT);
});

test("bootId agreement in a container: only the kernel UUID, across PID 1 restarts and every marker/environment permutation", () => {
  const first = containerBoot(pid1Stat(30666820)), second = containerBoot(pid1Stat(30667142));
  assert.equal(first, KERNEL_BOOT);
  assert.equal(containerBoot(pid1Stat(30666820)), first, "every process of one run reads the same");
  assert.equal(second, first, "a restart on the same kernel retains the boot identity");
  for (const marker of [NO_MARKER, ...Object.values(CONTAINER_MARKERS), { exists: () => true, env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } }]) {
    assert.equal(linuxBoot(pid1Stat(30666820), { marker }), KERNEL_BOOT);
    assert.equal(linuxBoot(pid1Stat(30667142), { marker }), KERNEL_BOOT);
  }
  assert.notEqual(containerBoot(pid1Stat(30666820), "0f8b6a2e-1111"), first);
  assert.equal(containerBoot(pid1Stat(0, "systemd")), KERNEL_BOOT);
  for (const comm of ["systemd", "tini -s", "a) S 0 (b", "docker-init"]) assert.equal(containerBoot(pid1Stat(30666820, comm)), first, comm);
  assert.equal(bootId({ platform: "linux", read: (p) => { assert.equal(p, "/proc/sys/kernel/random/boot_id"); return KERNEL_BOOT; }, exists: () => assert.fail("no marker lookup"), env: new Proxy({}, { get: () => assert.fail("no environment lookup") }) }), KERNEL_BOOT);
});

test("bootId on Linux without a start time of PID 1 to read: the kernel's boot id alone; without the boot id: none", () => {
  assert.equal(containerBoot(undefined), KERNEL_BOOT, "/proc/1/stat cannot be read");
  for (const stat of ["", "\n", "1 (sh) S 0 1 1\n", "no parenthesis at all", pid1Stat("x"), pid1Stat("-5"), pid1Stat("12.5")]) assert.equal(containerBoot(stat), KERNEL_BOOT, JSON.stringify(stat.slice(0, 40)));
  assert.equal(bootId({ platform: "linux", ...CONTAINER_MARKERS.docker, read: (p) => { if (p === "/proc/1/stat") return pid1Stat(30666820); throw new Error("EACCES"); } }), null, "PID 1's start alone is no boot");
  // On a host /proc/1/stat is not read at all.
  assert.equal(bootId({ platform: "linux", ...NO_MARKER, read: (p) => { if (p === "/proc/1/stat") throw new Error("read /proc/1/stat on a host"); return `${KERNEL_BOOT}\n`; } }), KERNEL_BOOT);
});

test("bootId on macOS reads the boot time and nothing under /proc", () => {
  assert.equal(bootId({ platform: "darwin", read: () => { throw new Error("read on macOS"); }, sysctl: () => "{ sec = 1761555000, usec = 123456 } Mon Oct 27 08:50:00 2026\n" }), "1761555000.123456");
});

test("the machine lock: one sweep at a time; the lock directory of an earlier kernel is refused as that, whatever its owner, and left as it is", (t) => {
  oatsHome(t);
  const lock = join(resumeStateDir(), "lock");
  const release = acquireResumeLock({ boot: "boot-1" });
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
  assert.throws(() => acquireResumeLock({ boot: "boot-1" }), (e) => e.code === "E_RESUME_BUSY" && e.message.includes(`pid ${process.pid}`));
  release();
  assert.equal(existsSync(lock), false, "released");
  const stuck = (e) => e.code === "E_RESUME_LOCK_STUCK" && e.message.includes(`remove the directory ${lock}`);
  for (const [what, owner] of [
    ["a dead pid", { pid: 2 ** 22 + 12345, bootId: "boot-1" }],
    ["a live pid, recorded in another boot", { pid: process.ppid, bootId: "boot-0" }],
    ["a live pid in this boot", { pid: process.ppid, bootId: "boot-1" }],
  ]) {
    mkdirSync(lock); writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
    assert.throws(() => acquireResumeLock({ boot: "boot-1" }), stuck, what);
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), JSON.stringify(owner), what);
    rmSync(lock, { recursive: true });
  }
  // No owner: the same, however long the directory has been there.
  mkdirSync(lock);
  assert.throws(() => acquireResumeLock({ boot: "boot-1" }), stuck);
  const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
  assert.throws(() => acquireResumeLock({ boot: "boot-1" }), stuck);
  assert.deepEqual(readdirSync(lock), []);
});

test("the per-boot note: refusals and each home's count of sweep starts, replaced in another boot, nothing kept without a boot id", (t) => {
  oatsHome(t);
  const a = { home: "/d/agents/s/instances/a", startId: "s1", code: "E_LAUNCH_ENV_MISSING", message: "m", at: "2026-10-27T10:00:00.000Z" };
  const b = "/d/agents/s/instances/b";
  noteSweep({ refusals: [a], launched: [b] }, "boot-1");
  assert.deepEqual(readBootNote("boot-1"), { bootId: "boot-1", refused: [a], resumes: { [b]: 1 } });
  assert.deepEqual(readBootNote("boot-2"), { bootId: "boot-2", refused: [], resumes: {} }, "another boot's note is no note");
  noteSweep({ refusals: [{ ...a, startId: "s2" }], launched: [b] }, "boot-1");
  noteSweep({ launched: [b, a.home] }, "boot-1");
  const note = readBootNote("boot-1");
  assert.deepEqual(note.refused.map((r) => r.startId), ["s2"], "a home's refusal is replaced");
  assert.deepEqual(note.resumes, { [b]: 3, [a.home]: 1 }, "each launch counts once more, by home");
  noteSweep({ launched: [b] }, "boot-2");
  assert.deepEqual(readBootNote("boot-2"), { bootId: "boot-2", refused: [], resumes: { [b]: 1 } }, "another boot's note is replaced whole");
  rmSync(resumeStateDir(), { recursive: true });
  noteSweep({ refusals: [a], launched: [b] }, null);
  assert.equal(existsSync(resumeStateDir()), false, "no boot id: nothing written");
});

test("--plan takes no lock and writes no note", async (t) => {
  oatsHome(t);
  const answer = await resumeSessions({ plan: true, boot: "boot-1", kernel: { execPath: process.execPath, bin: "/nonexistent" } });
  assert.deepEqual(answer, { schemaVersion: 1, plan: true, deployments: [], rows: [] });
  assert.equal(existsSync(resumeStateDir()), false);
  const held = acquireResumeLock({ boot: "boot-1" });
  t.after(held);
  assert.deepEqual((await resumeSessions({ plan: true, boot: "boot-1", kernel: {} })).rows, [], "a held lock does not stop a plan");
  await assert.rejects(resumeSessions({ boot: "boot-1", kernel: {} }), (e) => e.code === "E_RESUME_BUSY");
});

test("a start's answer maps to the sweep's row", () => {
  const row = { deployment: "/d", instance: "a", home: "/d/agents/s/instances/a", startId: "s1" };
  const id = { deployment: "/d", instance: "a", home: row.home };
  const ok = (result) => rowFromStart(row, { ok: true, result });
  const fail = (code, details) => rowFromStart(row, { ok: false, error: { code, message: `${code} message`, ...(details ? { details } : {}) } });
  assert.deepEqual(ok({ resume: { resumed: true, harness: "claude", sessionId: "x" }, warnings: [] }), { ...id, outcome: OUTCOME.RESUMED, sessionId: "x" });
  assert.deepEqual(ok({ resume: { resumed: true, harness: "claude", sessionId: "x" }, warnings: ["w channel-cache-unchecked"] }), { ...id, outcome: OUTCOME.RESUMED, sessionId: "x", warnings: ["w channel-cache-unchecked"] });
  assert.deepEqual(ok({ resume: { resumed: true, harness: "claude", sessionId: "x", waiting: RESUME_WAITING.RESUME_CONFIRMATION } }), { ...id, outcome: OUTCOME.BLOCKED, reason: ROW_REASON.RESUME_CONFIRMATION, sessionId: "x" });
  for (const reason of [FRESH_REASON.NO_CONVERSATION, FRESH_REASON.NO_RECEIPTS, FRESH_REASON.RESUME_UNPROVEN]) assert.deepEqual(ok({ resume: { resumed: false, reason, harness: "pi" } }), { ...id, outcome: OUTCOME.FRESH, reason });
  assert.deepEqual(fail("E_SPAWN_INCOMPLETE", { launchPrompts: { status: "blocked" } }), { ...id, outcome: OUTCOME.BLOCKED, reason: ROW_REASON.LAUNCH_PROMPT, code: "E_SPAWN_INCOMPLETE", launchPrompts: { status: "blocked" } });
  assert.deepEqual(fail("E_SESSION_START_BUSY"), { ...id, outcome: OUTCOME.SKIPPED, reason: ROW_REASON.START_BUSY, code: "E_SESSION_START_BUSY" });
  assert.deepEqual(fail("E_RESUME_NOT_LOST"), { ...id, outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_LOST, code: "E_RESUME_NOT_LOST" });
  assert.deepEqual(fail("E_SESSION_RUNNING"), { ...id, outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_LOST, code: "E_SESSION_RUNNING" });
  // A home OATS is stopping, upgrading or retiring (the start met its lifecycle claim, or its owed retire): skipped, with the code and the words.
  for (const code of ["E_INSTANCE_RETIRING", "E_LIFECYCLE_BUSY"]) assert.deepEqual(fail(code), { ...id, outcome: OUTCOME.SKIPPED, reason: ROW_REASON.LIFECYCLE_BUSY, code, message: `${code} message` });
  assert.deepEqual(fail("E_LAUNCH_LEGACY"), { ...id, outcome: OUTCOME.REFUSED, reason: ROW_REASON.START_REFUSED, code: "E_LAUNCH_LEGACY", message: "E_LAUNCH_LEGACY message" });
  assert.equal(rowFromStart(row, undefined).code, "E_SESSION_START_FAILED", "no answer");
});

// What the kernel has seen of a home (lib/session-seen.mjs): the record's transitions and the rule,
// both pure, over times and boots given here.
const H = "/d/agents/s/instances/a";
const T = (s) => Date.parse(`2026-10-27T${s}Z`);
const DAY = 24 * 60 * 60_000;
const running = (startId = "s1") => ({ home: H, startId, running: true, launched: true });
const lost = (startId = "s1") => ({ home: H, startId, running: false, launched: true });

test("the record of a home: a new start resets it, a running look is refreshed at most every 10 minutes in a boot, the loss is first seen once, unknown changes nothing, an unlisted home is dropped", () => {
  const first = nextSeen({}, [running()], { now: T("10:00:00.000"), boot: "A" });
  assert.deepEqual(first, { changed: true, homes: { [H]: { startId: "s1", lastSeenRunningAt: "2026-10-27T10:00:00.000Z", lastSeenRunningBoot: "A", firstNotRunningAt: null, firstNotRunningBoot: null, judgedBy: null } } });
  assert.equal(nextSeen(first.homes, [running()], { now: T("10:09:59.999"), boot: "A" }).changed, false, "under 10 minutes: no write");
  assert.equal(nextSeen(first.homes, [running()], { now: T("10:10:00.000"), boot: "A" }).homes[H].lastSeenRunningAt, "2026-10-27T10:10:00.000Z", "10 minutes: refreshed");
  assert.equal(nextSeen(first.homes, [running()], { now: T("10:01:00.000"), boot: "B" }).homes[H].lastSeenRunningBoot, "B", "another boot: refreshed");
  const loss = nextSeen(first.homes, [lost()], { now: T("11:00:00.000"), boot: "A" });
  assert.deepEqual([loss.changed, loss.homes[H].firstNotRunningAt, loss.homes[H].firstNotRunningBoot], [true, "2026-10-27T11:00:00.000Z", "A"]);
  assert.equal(nextSeen(loss.homes, [lost()], { now: T("12:00:00.000"), boot: "A" }).changed, false, "the loss is first seen once");
  assert.equal(nextSeen(loss.homes, [{ ...lost(), running: null }], { now: T("12:00:00.000"), boot: "A" }).changed, false, "unknown: unchanged");
  assert.equal(nextSeen({}, [lost()], { now: T("12:00:00.000"), boot: "A" }).changed, false, "a loss with no record of its start records nothing");
  assert.equal(nextSeen(first.homes, [lost("s0")], { now: T("12:00:00.000"), boot: "A" }).changed, false, "nor one of another start");
  const judged = { ...loss.homes[H], judgedBy: { at: "x", boot: "A", outcome: "resumed" } };
  assert.deepEqual(nextSeen({ [H]: judged }, [running("s2")], { now: T("12:00:00.000"), boot: "A" }).homes[H], { startId: "s2", lastSeenRunningAt: "2026-10-27T12:00:00.000Z", lastSeenRunningBoot: "A", firstNotRunningAt: null, firstNotRunningBoot: null, judgedBy: null }, "a new start resets the record, its judgement included");
  assert.deepEqual(nextSeen(first.homes, [], { now: T("12:00:00.000"), boot: "A" }), { homes: {}, changed: true }, "a home no longer listed is dropped");
});

test("a lost home is resumed only when seen running for its start, not judged, first seen lost under 24 h ago and, within one boot, lost under 24 h after its last running look", () => {
  const record = (o) => ({ startId: "s1", lastSeenRunningAt: null, lastSeenRunningBoot: "A", firstNotRunningAt: null, firstNotRunningBoot: "A", judgedBy: null, ...o });
  const at = (ms) => new Date(ms).toISOString();
  const yes = (r, now, what) => assert.deepEqual(resumeEligible(r, lost(), { now }), { eligible: true }, what);
  const no = (r, now, why, what) => { const a = resumeEligible(r, lost(), { now }); assert.equal(a.eligible, false, what); assert.match(a.why, why, what); };
  // An OOM kill at 02:00, a status at 02:01, the sweep at 09:00.
  yes(record({ lastSeenRunningAt: at(T("01:55:00.000")), firstNotRunningAt: at(T("02:01:00.000")) }), T("09:00:00.000"), "an OOM kill seen by a status, swept in the morning");
  // The laptop off two weeks: seen running in boot A, first seen lost in boot B when it opens.
  yes(record({ lastSeenRunningAt: at(T("18:00:00.000") - 14 * DAY), firstNotRunningAt: at(T("09:00:00.000")), firstNotRunningBoot: "B" }), T("09:00:05.000"), "across a reboot");
  // An overnight tmux crash, first seen lost at the morning open, in the same boot.
  yes(record({ lastSeenRunningAt: at(T("18:00:00.000") - DAY), firstNotRunningAt: at(T("08:00:00.000")) }), T("08:00:05.000"), "overnight, one boot");
  for (const outcome of ["resumed", "fresh", "blocked", "refused", "skipped"]) no(record({ lastSeenRunningAt: at(T("01:55:00.000")), firstNotRunningAt: at(T("02:01:00.000")), judgedBy: { at: at(T("02:02:00.000")), boot: "A", outcome } }), T("02:03:00.000"), /earlier sweep already answered/, `judged ${outcome}`);
  no(record({ lastSeenRunningAt: at(T("01:55:00.000")), firstNotRunningAt: at(T("02:01:00.000")) }), T("02:01:00.000") + DAY, /first seen .* 24 hours ago or more/, "first seen 24 h ago");
  yes(record({ lastSeenRunningAt: at(T("01:55:00.000")), firstNotRunningAt: at(T("02:01:00.000")) }), T("02:01:00.000") + DAY - 1, "first seen just under 24 h ago");
  no(record({ lastSeenRunningAt: at(T("02:00:00.000") - DAY), firstNotRunningAt: at(T("02:00:00.000")) }), T("02:01:00.000"), /24 hours or more before its loss/, "a long boot: last running look 24 h before the loss");
  no(record({ startId: "s0", lastSeenRunningAt: at(T("01:55:00.000")), firstNotRunningAt: at(T("02:01:00.000")) }), T("02:02:00.000"), /never saw it running for its current start/, "seen running for another start");
  no(undefined, T("02:02:00.000"), /never saw it running/, "no record");
  no(record({ firstNotRunningAt: at(T("02:01:00.000")) }), T("02:02:00.000"), /never saw it running/, "never seen running");
  no(record({ lastSeenRunningAt: at(T("01:55:00.000")) }), T("02:02:00.000"), /not seen it stop/, "its loss not recorded");
  // No boot id: the in-boot clause applies to every loss.
  no(record({ lastSeenRunningAt: at(T("18:00:00.000") - 14 * DAY), firstNotRunningAt: at(T("09:00:00.000")), lastSeenRunningBoot: null, firstNotRunningBoot: null }), T("09:00:05.000"), /24 hours or more before its loss/, "no boot id: two weeks off is not resumed");
});

test("a container restart on the same kernel carries its failure budget and uses pid/start to judge a previous lock", (t) => {
  oatsHome(t);
  const first = containerBoot(pid1Stat(30666820)), second = containerBoot(pid1Stat(30667142));
  // RESUME_LIMIT sweep starts of one home in the first run: the count the sweep refuses at.
  for (let n = 0; n < RESUME_LIMIT; n++) noteSweep({ launched: [H] }, first);
  assert.equal(readBootNote(first).resumes[H], RESUME_LIMIT);
  assert.deepEqual(readBootNote(second), { bootId: KERNEL_BOOT, refused: [], resumes: { [H]: RESUME_LIMIT } });
  const lock = join(resumeStateDir(), "lock");
  mkdirSync(resumeStateDir(), { recursive: true });
  const left = JSON.stringify({ bootId: first, pid: process.pid, processStart: processStartToken(process.pid), nonce: "a".repeat(32), at: "2026-10-27T09:00:00.000Z" }) + "\n";
  writeFileSync(lock, left);
  assert.throws(() => acquireResumeLock({ boot: first }), (e) => e.code === "E_RESUME_BUSY" && e.message.includes(`pid ${process.pid} holds it`));
  assert.equal(readFileSync(lock, "utf8"), left);
  assert.throws(() => acquireResumeLock({ boot: second }), (e) => e.code === "E_RESUME_BUSY", "a live holder is still held after restart/upgrade");
  assert.equal(readFileSync(lock, "utf8"), left);
  writeFileSync(lock, JSON.stringify({ ...JSON.parse(left), processStart: "proc:1" }));
  acquireResumeLock({ boot: second })();
  assert.equal(existsSync(lock), false, "taken over, and released");
  // Seen running in the first run, the container down for two weeks, first seen lost in the next.
  const at = (ms) => new Date(ms).toISOString();
  const record = { startId: "s1", lastSeenRunningAt: at(T("18:00:00.000") - 14 * DAY), lastSeenRunningBoot: first, firstNotRunningAt: at(T("09:00:00.000")), firstNotRunningBoot: second, judgedBy: null };
  assert.equal(resumeEligible(record, lost(), { now: T("09:00:05.000") }).eligible, false, "without a validated host-stop receipt the in-boot time guard carries across restart");
  assert.deepEqual(readBootNote("another-kernel-boot"), { bootId: "another-kernel-boot", refused: [], resumes: {} });
});

test("legacy qualified boot ids defer to a visible live holder across upgrades", (t) => {
  oatsHome(t);
  const lock = join(resumeStateDir(), "lock");
  mkdirSync(resumeStateDir(), { recursive: true });
  const own = processStartToken(process.pid);
  for (const [recorded, current] of [[`${KERNEL_BOOT}:123`, KERNEL_BOOT], [KERNEL_BOOT, `${KERNEL_BOOT}:456`], [`${KERNEL_BOOT}:123`, `${KERNEL_BOOT}:456`]]) {
    const left = JSON.stringify({ bootId: recorded, pid: process.pid, processStart: own, nonce: "a".repeat(32), at: "2026-10-27T09:00:00.000Z" });
    writeFileSync(lock, left);
    assert.throws(() => acquireResumeLock({ boot: current }), (e) => e.code === "E_RESUME_BUSY");
    assert.equal(readFileSync(lock, "utf8"), left);
    rmSync(lock);
  }
  const hostBoot = linuxBoot(pid1Stat(0, "systemd")), sandboxBoot = linuxBoot(pid1Stat(1234567, "bwrap"));
  const release = acquireResumeLock({ boot: hostBoot });
  try { assert.throws(() => acquireResumeLock({ boot: sandboxBoot }), (e) => e.code === "E_RESUME_BUSY", "the unchanged unmarked-sandbox boot string cannot itself mark this visible holder gone"); }
  finally { release(); }
  for (const state of ["alive", "unknown", "gone"]) {
    const holder = { bootId: `${KERNEL_BOOT}:123`, pid: process.pid, processStart: own };
    assert.equal(identityHolderState(holder, { boot: KERNEL_BOOT, liveness: () => ({ state }) }), state, "legacy qualification defers to process identity, including unreadable starts");
    assert.equal(identityHolderState(holder, { boot: "11111111-1111-4111-8111-111111111111", liveness: () => assert.fail("another kernel boot establishes death") }), "gone");
  }
});

test("a validated host-stop time excludes container downtime from only the in-boot gap", () => {
  const now = T("09:00:00.000"), runningAt = now - 30 * 60 * 60_000, stoppedAt = runningAt + 60_000;
  const record = { startId: "s1", lastSeenRunningAt: new Date(runningAt).toISOString(), lastSeenRunningBoot: KERNEL_BOOT, firstNotRunningAt: new Date(now).toISOString(), firstNotRunningBoot: KERNEL_BOOT, judgedBy: null };
  assert.deepEqual(resumeEligible(record, lost(), { now, hostStoppedAt: stoppedAt }), { eligible: true });
  for (const at of [null, NaN, now + 1]) assert.equal(resumeEligible(record, lost(), { now, hostStoppedAt: at }).eligible, false);
  assert.deepEqual(resumeEligible(record, lost(), { now, hostStoppedAt: runningAt - 1 }), { eligible: true }, "a validated current-start receipt may precede a running look during stop grace");
  assert.equal(resumeEligible({ ...record, judgedBy: { outcome: "refused" } }, lost(), { now, hostStoppedAt: stoppedAt }).eligible, false);
  assert.equal(resumeEligible(record, lost("other-start"), { now, hostStoppedAt: stoppedAt }).eligible, false);
  assert.equal(resumeEligible(record, lost(), { now: now + DAY, hostStoppedAt: stoppedAt }).eligible, false, "first observed loss age still applies");
});

test("host-stop timestamps must name the current start and fall within its observed lifetime", async (t) => {
  const { hostStoppedAt } = await import("../lib/session-end.mjs");
  assert.equal(typeof hostStoppedAt, "function", "validated timestamp reader required");
  const home = scratch(t), now = T("09:00:00.000"), startedAt = now - 31 * 60 * 60_000, at = now - 30 * 60 * 60_000;
  const meta = { startId: "s1", createdAt: new Date(startedAt).toISOString() };
  const receipt = { startId: "s1", resume: true, reason: "host-stop", at: new Date(at).toISOString() };
  write(home, ".oats-stop.json", receipt);
  assert.equal(hostStoppedAt(home, meta, { now }), at);
  for (const patch of [{ startId: "other" }, { at: "unknown" }, { at: new Date(now + 1).toISOString() }, { at: new Date(startedAt - 1).toISOString() }, { resume: false }, { reason: "other" }]) {
    write(home, ".oats-stop.json", { ...receipt, ...patch });
    assert.equal(hostStoppedAt(home, meta, { now }), null);
  }
});

test("a running look during stop grace does not invalidate a current-start host stop", () => {
  const stoppedAt = T("09:00:00.000"), now = stoppedAt + 30 * 60 * 60_000;
  const row = { ...lost(), home: H, launched: true, running: true };
  let homes = nextSeen({}, [row], { now: stoppedAt - 10 * 60_000, boot: KERNEL_BOOT }).homes;
  homes = nextSeen(homes, [row], { now: stoppedAt + 5000, boot: KERNEL_BOOT }).homes;
  homes = nextSeen(homes, [{ ...row, running: false }], { now, boot: KERNEL_BOOT }).homes;
  assert.equal(homes[H].lastSeenRunningAt, new Date(stoppedAt + 5000).toISOString());
  assert.deepEqual(resumeEligible(homes[H], row, { now, hostStoppedAt: stoppedAt }), { eligible: true });
});

test("a same-kernel startup after 30 hours restores clean stops and preserves blocked, refused and stale-receipt accounting", async (t) => {
  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "directory" } } } });
  const names = ["success", "blocked", "refused", "prior", "other-start", "other-start-short", "future", "status-after-stop", "status-after-stop-short"], homes = {};
  for (const name of names) {
    const { home } = await fx.spawn("dev", { name, harness: "claude" });
    const path = join(home, "instance.json"), meta = JSON.parse(readFileSync(path, "utf8"));
    const startId = `fixture-${name}`;
    writeFileSync(path, JSON.stringify({ ...meta, launched: true, startId }));
    homes[name] = { home, instance: name, startId, launched: true, running: true };
  }
  const stopped = Date.now() + 10 * 60_000, now = stopped + 30 * 60 * 60_000, boot = bootId();
  const prior = { home: homeKey(homes.prior.home), startId: homes.prior.startId, code: "E_PRIOR", message: "prior fixture refusal", at: new Date(stopped).toISOString() };
  await fx.inEnv(() => {
    recordSeen(join(fx.dep, "agents"), Object.values(homes), { now: stopped - 10 * 60_000, boot });
    // A listing during the stop's grace can refresh the running observation after its receipt.
    recordSeen(join(fx.dep, "agents"), Object.values(homes).map((r) => ({ ...r, running: r.instance === "status-after-stop" ? true : null })), { now: stopped + 5000, boot });
    recordSeen(join(fx.dep, "agents"), Object.values(homes).map((r) => ({ ...r, running: r.instance === "status-after-stop-short" ? true : null })), { now: now - 5000, boot });
    // A short ordinary loss with an other-start receipt still obeys the crash ceiling.
    recordSeen(join(fx.dep, "agents"), Object.values(homes).map((r) => r.instance === "other-start-short" ? { ...r, startId: "fixture-new-short" } : { ...r, running: null }), { now: now - 1000, boot });
    const short = homes["other-start-short"], path = join(short.home, "instance.json");
    short.startId = "fixture-new-short";
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), startId: short.startId }));
    for (let n = 0; n < RESUME_LIMIT; n++) noteSweep({ launched: Object.values(homes).map((r) => homeKey(r.home)) }, boot);
    noteSweep({ refusals: [prior] }, boot);
  });
  for (const [name, row] of Object.entries(homes)) {
    write(row.home, ".oats-stop.json", { startId: name.startsWith("other-start") ? "old-start" : row.startId, at: new Date(name === "future" ? now + 1 : name === "status-after-stop-short" ? now - 10_000 : stopped + 1).toISOString(), resume: true, reason: "host-stop" });
  }
  const realNow = Date.now, called = [];
  let answer;
  try {
    Date.now = () => now;
    answer = await fx.inEnv(() => resumeSessions({ deployment: fx.dep, boot, start: async (row) => {
      called.push(row.instance);
      if (["success", "status-after-stop", "status-after-stop-short"].includes(row.instance)) return { ok: true, result: { resume: { resumed: true, sessionId: "fixture-conversation" } } };
      if (row.instance === "blocked") return { ok: true, result: { resume: { resumed: true, waiting: "resume-confirmation" } } };
      if (row.instance === "refused") return { ok: false, error: { code: "E_FIXTURE", message: "fixture start refused" } };
      assert.fail(`an ineligible or already-refused home was started: ${row.instance}`);
    } }));
  } finally { Date.now = realNow; }
  const rows = Object.fromEntries(answer.rows.map((r) => [r.instance, r]));
  assert.deepEqual(called.sort(), ["blocked", "refused", "status-after-stop", "status-after-stop-short", "success"]);
  assert.equal(rows.success.outcome, OUTCOME.RESUMED);
  assert.equal(rows["status-after-stop"].outcome, OUTCOME.RESUMED);
  assert.equal(rows["status-after-stop-short"].outcome, OUTCOME.RESUMED);
  assert.equal(rows.blocked.outcome, OUTCOME.BLOCKED);
  assert.equal(rows.refused.code, "E_FIXTURE");
  assert.equal(rows.prior.reason, ROW_REASON.REFUSED_THIS_BOOT);
  assert.equal(rows["other-start"].reason, ROW_REASON.NOT_SEEN_RECENTLY);
  assert.equal(rows.future.reason, ROW_REASON.NOT_SEEN_RECENTLY);
  assert.equal(rows["other-start-short"].reason, ROW_REASON.KEEPS_GETTING_LOST);
  const note = await fx.inEnv(() => readBootNote(boot));
  for (const [name, row] of Object.entries(homes)) assert.equal(note.resumes[homeKey(row.home)], name === "blocked" ? RESUME_LIMIT + 1 : RESUME_LIMIT, name);
  assert.ok(note.refused.some((r) => r.home === homeKey(homes.refused.home) && r.startId === homes.refused.startId && r.code === "E_FIXTURE"));
  assert.ok(note.refused.some((r) => r.home === prior.home && r.code === "E_PRIOR"));
});

test("legacy qualified failure notes and loss records keep the same-kernel guards", (t) => {
  oatsHome(t);
  const oldBoot = `${KERNEL_BOOT}:30666820`;
  noteSweep({ launched: [H], refusals: [{ home: H, startId: "s1", code: "E_FIXTURE", message: "fixture refusal", at: "2026-10-27T09:00:00.000Z" }] }, oldBoot);
  const note = readBootNote(KERNEL_BOOT);
  assert.equal(note.resumes[H], 1);
  assert.equal(note.refused[0].code, "E_FIXTURE");
  const record = { startId: "s1", lastSeenRunningAt: new Date(T("09:00:00.000") - 2 * DAY).toISOString(), lastSeenRunningBoot: oldBoot, firstNotRunningAt: new Date(T("09:00:00.000")).toISOString(), firstNotRunningBoot: KERNEL_BOOT, judgedBy: null };
  assert.equal(resumeEligible(record, lost(), { now: T("09:00:05.000") }).eligible, false, "qualification changes do not bypass the in-boot time guard");
});

test("host run plan without a Kubernetes environment marker still sees a qualified visible holder", async (t) => {
  oatsHome(t);
  const release = acquireHostRunLock({ boot: `${KERNEL_BOOT}:813944` });
  try {
    const plan = await hostRunPlan({ boot: KERNEL_BOOT, env: {}, hostStatus: () => ({ installed: false, active: false }) });
    assert.deepEqual(plan.refusals.map((r) => [r.code, r.details.found]), [["E_HOST_RUN_BUSY", "running"]]);
    assert.throws(() => acquireHostRunLock({ boot: KERNEL_BOOT }), (e) => e.code === "E_HOST_RUN_BUSY");
  } finally { release(); }
});
