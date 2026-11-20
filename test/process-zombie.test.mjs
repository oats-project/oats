// A zombie (a process that exited or was killed and that its parent has not reaped) in the
// process-identity reader, lib/worktree-hooks.mjs (awebai/oats#870): gone for a holder
// (processLiveness), still the owner of its pid and start (processStart), and the start token is
// what released kernels wrote. Every test here runs on each reader this host has: /proc where
// there is procfs, and `ps`, forced through the test seam OATS_TEST_PROCESS_START_PS.
//
// A zombie is made for real, never simulated: a child of this process is killed and the test stays
// synchronous, so Node, which reaps its children from its event loop, cannot reap it before the
// assertions (test/helpers/host-fixture.mjs zombieSync). Each test prints what the host answered
// (`node --test` shows it as a diagnostic), so a run on another host is its own report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processLiveness, processStart, runPs, terminateRecordedGroup, verifiedAlive } from "../lib/worktree-hooks.mjs";
import { hostProcessState, zombieSync } from "./helpers/host-fixture.mjs";

const SEAM = "OATS_TEST_PROCESS_START_PS";
/** The readers of this host: `ps` everywhere (the seam's `1`), and /proc where it exists. */
const READERS = [...(existsSync("/proc/self/stat") ? ["proc"] : []), "ps"];
/** Run `fn` with the kernel reading starts through `reader` (`proc`, `ps`, or the absolute path of
 *  a file to run as `ps`). Synchronous, and the seam is put back before it returns. */
function reading(reader, fn) {
  const saved = process.env[SEAM];
  if (reader === "proc") delete process.env[SEAM]; else process.env[SEAM] = reader === "ps" ? "1" : reader;
  try { return fn(); }
  finally { if (saved === undefined) delete process.env[SEAM]; else process.env[SEAM] = saved; }
}
/** A file that runs as `ps` and answers the start alone, as `ps` was asked before there was a state
 *  column: the system `ps -o lstart= -p <pid>`, whatever columns it is asked for. */
function oneColumnPs(dir) {
  const file = join(dir, "ps-one-column");
  writeFileSync(file, '#!/bin/sh\nfor a in "$@"; do pid=$a; done\nexec ps -o lstart= -p "$pid"\n', { mode: 0o755 });
  return file;
}
/** A child of this process that sleeps until it is ended. */
function sleeper(t) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } });
  return child;
}
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""], { env: { PATH: process.env.PATH } }).pid;
/** What `ps` itself prints for the two columns the kernel asks for, in the kernel's environment. */
const psLine = (pid) => spawnSync("ps", ["-o", "lstart=", "-o", "stat=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).stdout.replace(/\n$/, "");

/** The start token as the released kernels read it: `readStart` of lib/worktree-hooks.mjs as it was
 *  before the state was read with it (0.52.0, awebai/oats#884), kept here word for word. Claims,
 *  tree records and markers written by those kernels name their holder by this token. */
function releasedStartToken(pid, reader) {
  if (reader === "proc") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    return `proc:${start}`;
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 10_000 });
  const out = String(r.stdout ?? "").trim();
  assert.ok(r.status === 0 && out, `the released reader's ps answered: ${JSON.stringify(r)}`);
  return `ps:${out}`;
}

test("the start token is byte for byte what released kernels wrote, proc:<ticks> from /proc and ps:<lstart> through ps, for a live process and for the same process once it is a zombie", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-ps-one-column-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = sleeper(t), oneColumn = oneColumnPs(dir);
  const released = {};
  for (const reader of READERS) {
    released[reader] = releasedStartToken(child.pid, reader);
    assert.match(released[reader], reader === "proc" ? /^proc:[0-9]+$/ : /^ps:\S.*\S$/, reader);
    assert.deepEqual(reading(reader, () => processStart(child.pid)), { state: "alive", token: released[reader] }, `${reader}: a live process`);
    assert.deepEqual(reading(reader, () => processStart(process.pid)), { state: "alive", token: releasedStartToken(process.pid, reader) }, `${reader}: this process`);
    // A live holder that a released kernel recorded is still that holder.
    assert.deepEqual(reading(reader, () => processLiveness({ pid: child.pid, processStart: released[reader] })), { state: "alive" }, `${reader}: recorded by a released kernel`);
    t.diagnostic(`${reader}: token of a live process: ${JSON.stringify(released[reader])}`);
  }
  // A `ps` that answers no state column gives the same bytes.
  assert.deepEqual(reading(oneColumn, () => processStart(child.pid)), { state: "alive", token: released.ps }, "a one-column ps: a live process");
  t.diagnostic(`ps -o lstart= -o stat= of a live process: ${JSON.stringify(psLine(child.pid))}`);
  // From here to the end nothing awaits: the killed child stays a zombie.
  const state = zombieSync(child.pid);
  t.diagnostic(`the host's state of the zombie: ${JSON.stringify(state)}; ps -o lstart= -o stat= of it: ${JSON.stringify(psLine(child.pid))}`);
  for (const reader of READERS) {
    assert.deepEqual(reading(reader, () => processStart(child.pid)), { state: "alive", token: released[reader], zombie: true }, `${reader}: a zombie's start is still read, and is the token it had`);
    assert.equal(releasedStartToken(child.pid, reader), released[reader], `${reader}: the released reader reads the same start of the zombie`);
  }
  // A state that cannot be read makes no zombie: the answer is what it was before the state was read.
  assert.deepEqual(reading(oneColumn, () => [processStart(child.pid), processLiveness({ pid: child.pid, processStart: released.ps })]), [{ state: "alive", token: released.ps }, { state: "alive" }], "a one-column ps: a zombie");
  t.diagnostic(`a zombie read through a ps that answers no state: ${JSON.stringify(reading(oneColumn, () => processLiveness({ pid: child.pid, processStart: released.ps })))} (what every reader answered before awebai/oats#870)`);
  assert.match(hostProcessState(child.pid) ?? "", /^Z/, "it was a zombie for every read above");
});

test("processStart and processLiveness on each reader: alive, gone, a reused pid, a zombie; a zombie is gone for a holder whatever start the record names, and still alive for identity", (t) => {
  const child = sleeper(t), dead = exitedPid();
  const tokens = Object.fromEntries(READERS.map((reader) => [reader, reading(reader, () => processStart(child.pid)).token]));
  for (const reader of READERS) reading(reader, () => {
    const token = tokens[reader], other = reader === "proc" ? "proc:1" : "ps:Thu Jan  1 00:00:00 1970";
    assert.deepEqual(processStart(child.pid), { state: "alive", token }, `${reader}: alive`);
    assert.deepEqual(processLiveness({ pid: child.pid, processStart: token }), { state: "alive" }, `${reader}: alive with the recorded start`);
    assert.deepEqual(processLiveness({ pid: child.pid, processStart: other }), { state: "gone" }, `${reader}: another start is a reused pid`);
    const unnamed = processLiveness({ pid: child.pid });
    assert.equal(unnamed.state, "unknown", `${reader}: a live pid and no recorded start cannot be compared`);
    assert.match(unnamed.reason, /names no start time/);
    assert.deepEqual([processStart(dead), processLiveness({ pid: dead, processStart: token })], [{ state: "gone" }, { state: "gone" }], `${reader}: an exited, reaped pid`);
    assert.deepEqual(processLiveness({ pid: 0, processStart: token }), { state: "gone" }, `${reader}: no pid`);
  });
  // From here to the end nothing awaits: the killed child stays a zombie.
  t.diagnostic(`the host's state of the zombie: ${JSON.stringify(zombieSync(child.pid))}`);
  for (const reader of READERS) reading(reader, () => {
    const token = tokens[reader], other = reader === "proc" ? "proc:1" : "ps:Thu Jan  1 00:00:00 1970";
    // Identity: it still holds its pid and its start.
    assert.deepEqual(processStart(child.pid), { state: "alive", token, zombie: true }, `${reader}: a zombie, for identity`);
    // A holder: it cannot act again.
    assert.deepEqual(processLiveness({ pid: child.pid, processStart: token }), { state: "gone", zombie: true }, `${reader}: a zombie with the recorded start`);
    assert.equal(verifiedAlive({ pid: child.pid, processStart: token }), false, reader);
    assert.equal(processLiveness({ pid: child.pid, processStart: other }).state, "gone", `${reader}: a zombie under a reused pid is gone, as any reused pid`);
    // Decided before the start is compared: a record that names no start is settled too.
    assert.deepEqual(processLiveness({ pid: child.pid }), { state: "gone", zombie: true }, `${reader}: a zombie and no recorded start`);
  });
  assert.match(hostProcessState(child.pid) ?? "", /^Z/, "it was a zombie for every read above");
});

/** A file that runs as `ps` and prints `line` whatever it is asked; it appends its arguments to `<dir>/calls`. */
function stubPs(dir, name, line) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(dir, "calls"))}\nprintf '%s\\n' ${JSON.stringify(line)}\n`, { mode: 0o755 });
  return file;
}

test("the state column of ps: only a state that begins with Z makes a zombie, and no state, readable or not, changes the start token", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-ps-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const START = "Thu Jan  1 00:00:00 2026", token = `ps:${START}`;
  const cases = [
    ["a zombie (procps, macOS)", `${START} Z`, true],
    ["a zombie in the foreground group (macOS)", `${START}     Z+`, true],
    ["a sleeping session leader", `${START} Ss`, false],
    ["a running process", `${START} R+`, false],
    ["a process with flags", `${START} S<l`, false],
    ["a state ps could not read", `${START} ?`, false],
    ["a state ps left as a dash", `${START} -`, false],
    ["a stub that answers the start alone", START, false],
    ["a stub that answers the start alone, padded", `${START}    `, false],
  ];
  for (const [what, line, zombie] of cases) {
    const ps = stubPs(dir, `ps-${cases.findIndex((c) => c[0] === what)}`, line);
    reading(ps, () => {
      assert.deepEqual(processStart(process.pid), { state: "alive", token, ...(zombie ? { zombie: true } : {}) }, what);
      assert.deepEqual(processLiveness({ pid: process.pid, processStart: token }), zombie ? { state: "gone", zombie: true } : { state: "alive" }, what);
    });
  }
  // One invocation reads both: the start reader runs `ps` once per read, with these arguments.
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(new Set(calls), new Set([`-o lstart= -o stat= -p ${process.pid}`]));
  assert.equal(calls.length, cases.length * 2, "one ps per read");
});

test("a zombie whose start cannot be read is unknown, never gone: what the reader answered before it read the state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-ps-unreadable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = sleeper(t);
  const token = reading("ps", () => processStart(child.pid)).token;
  writeFileSync(join(dir, "ps"), '#!/bin/sh\necho "ps: simulated failure" >&2\nexit 2\n', { mode: 0o755 });
  const reason = `ps -o lstart= -o stat= -p ${child.pid} answered exit 2: ps: simulated failure`;
  const unreadable = () => reading(join(dir, "ps"), () => [processStart(child.pid), processLiveness({ pid: child.pid, processStart: token })]);
  assert.deepEqual(unreadable(), [{ state: "unknown", reason }, { state: "unknown", reason }], "a live process");
  // From here to the end nothing awaits: the killed child stays a zombie.
  zombieSync(child.pid);
  assert.deepEqual(unreadable(), [{ state: "unknown", reason }, { state: "unknown", reason }], "a zombie");
  t.diagnostic(`a start that cannot be read answers: ${JSON.stringify(unreadable()[1])}`);
  assert.match(hostProcessState(child.pid) ?? "", /^Z/);
});

test("runPs: the columns asked for, without headers, in the fixed environment; a PATH only when it is given; a ps that fails or answers nothing is a reason", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-run-ps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, "seen");
  writeFileSync(join(dir, "ps"), `#!/bin/sh\nprintf 'ARGS=%s\\nPATH=%s\\nLC_ALL=%s\\nTZ=%s\\nSENTINEL=%s\\n' "$*" "$PATH" "$LC_ALL" "$TZ" "$OATS_SEAM_SENTINEL" > ${JSON.stringify(seen)}\nprintf '  1 one\\n  2 two\\n'\n`, { mode: 0o755 });
  writeFileSync(join(dir, "silent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, "failing"), '#!/bin/sh\necho "ps: no such column" >&2\nexit 1\n', { mode: 0o755 });
  process.env.OATS_SEAM_SENTINEL = "inherited";
  t.after(() => { delete process.env.OATS_SEAM_SENTINEL; });
  const ran = () => readFileSync(seen, "utf8");
  reading(join(dir, "ps"), () => {
    assert.deepEqual(runPs(["pid", "comm"], ["-ax"]), { out: "  1 one\n  2 two\n" }, "its stdout, as it was written");
    assert.equal(ran(), "ARGS=-o pid= -o comm= -ax\nPATH=/usr/bin:/bin:/usr/sbin:/sbin\nLC_ALL=C\nTZ=UTC\nSENTINEL=\n", "the fixed environment is the default");
    assert.deepEqual(runPs(["pid"], ["-p", "1"], { path: "/opt/fixture/bin:/usr/bin:/bin" }), { out: "  1 one\n  2 two\n" });
    assert.equal(ran(), "ARGS=-o pid= -p 1\nPATH=/opt/fixture/bin:/usr/bin:/bin\nLC_ALL=C\nTZ=UTC\nSENTINEL=\n", "a given PATH replaces the fixed one, and nothing else");
  });
  assert.deepEqual(reading(join(dir, "silent"), () => runPs(["pid"], ["-p", "1"])), { reason: "ps -o pid= -p 1 answered exit 0 with no output" });
  assert.deepEqual(reading(join(dir, "failing"), () => runPs(["nope"], ["-p", "1"])), { reason: "ps -o nope= -p 1 answered exit 1: ps: no such column" });
  assert.deepEqual(reading(join(dir, "missing"), () => runPs(["pid"], ["-p", "1"])), { reason: `the ps ${SEAM} names (${join(dir, "missing")}) could not be run (ENOENT)` });
  assert.deepEqual(reading("relative/ps", () => runPs(["pid"], ["-p", "1"])), { reason: `${SEAM} is "relative/ps", neither 1 nor an absolute path` });
});

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a recorded group whose leader is a zombie and that still has members is proven by its leader and its members are ended: never unverified, and foreign under another start", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-zombie-leader-"));
  // The leader starts one member in its own group and exits; this process, its parent, does not reap it.
  const leader = spawn("/bin/sh", ["-c", `sleep 60 & echo $! > ${JSON.stringify(join(dir, "member"))}; exit 0`], { detached: true, stdio: "ignore" });
  const pgid = leader.pid;
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  // From here to the end nothing awaits: the leader, which exits by itself, stays a zombie.
  t.diagnostic(`the host's state of the zombie leader: ${JSON.stringify(zombieSync(pgid, { signal: null }))}`);
  const member = Number(readFileSync(join(dir, "member"), "utf8"));
  assert.ok(Number.isSafeInteger(member) && alive(member), "the group has a live member");
  for (const reader of READERS) {
    const identity = reading(reader, () => processStart(pgid));
    assert.equal(identity.state, "alive", `${reader}: a zombie leader still proves whose group it is: ${JSON.stringify(identity)}`);
    assert.equal(identity.zombie, true, reader);
    // Another run's record: the group is not this record's, and is not signalled.
    assert.equal(reading(reader, () => terminateRecordedGroup({ hookPgid: pgid, hookStart: "proc:another-run" }, 500)), "foreign", reader);
    assert.equal(alive(member), true, `${reader}: a foreign group is not signalled`);
  }
  const reader = READERS[0];
  const hookStart = reading(reader, () => processStart(pgid)).token;
  const ended = reading(reader, () => terminateRecordedGroup({ hookPgid: pgid, hookStart }, 500));
  // The regression this pins: were a zombie leader "gone" for identity, the group would be
  // "unverified" and its member left running.
  assert.notEqual(ended, "unverified");
  const memberState = hostProcessState(member);
  assert.ok(memberState === null || memberState.startsWith("Z"), `its member was ended (its state: ${memberState})`);
  // Which answer it is depends on the host and is only reported: once the member is dead, whether
  // kill(-pgid, 0) still counts the unreaped leader itself as a member of its group (Linux does,
  // and answers "survived" about a group in which nothing but that zombie is left).
  t.diagnostic(`terminateRecordedGroup of a group whose leader is a zombie, read through ${reader}: ${JSON.stringify(ended)}`);
  t.diagnostic(`after it: the leader's state is ${JSON.stringify(hostProcessState(pgid))}, the member's is ${JSON.stringify(memberState)}, and kill(-pgid, 0) ${groupAlive(pgid) ? "still succeeds" : "finds no group"}`);
});
