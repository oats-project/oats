import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scheduleModule = new URL("../lib/schedule.mjs", import.meta.url).href;
const hooksModule = new URL("../lib/worktree-hooks.mjs", import.meta.url).href;
const prelude = `
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import { join } from "node:path";
  import { syncBuiltinESMExports } from "node:module";
  import * as S from ${JSON.stringify(scheduleModule)};
  import { selfIdentity } from ${JSON.stringify(hooksModule)};
  const dir = S.hostScheduleDir(), path = join(dir, "registry.json");
  // The registry lock as its holder writes it (lib/claim.mjs): this process's record, here by hand
  // so that each step of taking it can be held open.
  const claimRecord = () => JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "the host schedule registry" }) + "\\n";
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oats-registry-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "host"), dir = join(home, "schedules"), path = join(dir, "registry.json");
  return { root, home, dir, path, env: { ...process.env, OATS_HOME_DIR: home } };
}
function run(f, source, timeout = 5000) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + source], {
    env: f.env, encoding: "utf8", timeout, killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, `isolated reader must finish without waiting for registry.lock: ${result.error?.message}\n${result.stderr}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
function seed(f, extra = {}) {
  mkdirSync(f.dir, { recursive: true });
  const value = { version: 1, tickIntervalSec: 120, workspaces: ["/fixture/workspace"], ...extra };
  writeFileSync(f.path, JSON.stringify(value) + "\n");
  return value;
}

test("registry reads of absent state create no home, schedule directory, registry or lock", (t) => {
  const f = fixture(t);
  run(f, `
    assert.equal(fs.existsSync(process.env.OATS_HOME_DIR), false);
    const reg = S.readRegistry();
    assert.deepEqual(reg.workspaces, []);
    assert.equal(Object.hasOwn(reg, "maxConcurrent"), false);
    assert.equal(Object.hasOwn(reg, "triggersMaxConcurrent"), false);
    assert.equal(fs.existsSync(process.env.OATS_HOME_DIR), false, "read must not create any scheduler storage");
  `);
});

test("legacy registry reads project implicit one without migrating disk or changing independent caps", (t) => {
  const f = fixture(t);
  const result = run(f, `
    fs.mkdirSync(dir, { recursive: true });
    for (const caps of [
      {}, { maxConcurrent: 1 }, { capsVersion: 1, maxConcurrent: 1 },
      { maxConcurrent: 7 }, { capsVersion: 2, maxConcurrent: 1 },
    ]) {
      const stored = { version: 1, workspaces: ["/fixture/workspace"], tickIntervalSec: 120, triggersMaxConcurrent: 3, extension: { keep: true }, ...caps };
      const text = JSON.stringify(stored) + "\\n";
      fs.writeFileSync(path, text);
      const before = fs.statSync(path);
      const actual = S.readRegistry();
      const implicitOne = (caps.capsVersion ?? 1) < 2 && caps.maxConcurrent === 1;
      assert.equal(actual.maxConcurrent, implicitOne ? undefined : caps.maxConcurrent);
      assert.equal(Object.hasOwn(actual, "maxConcurrent"), !implicitOne && Object.hasOwn(caps, "maxConcurrent"));
      assert.equal(actual.triggersMaxConcurrent, 3);
      assert.equal(actual.tickIntervalSec, 120);
      assert.deepEqual(actual.workspaces, stored.workspaces);
      assert.deepEqual(actual.extension, { keep: true });
      assert.equal(fs.readFileSync(path, "utf8"), text, "projection must not persist migration");
      const after = fs.statSync(path);
      assert.equal(after.ino, before.ino, "read must not atomically rewrite even equivalent bytes");
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.deepEqual(fs.readdirSync(dir), ["registry.json"]);
    }
  `);
  assert.equal(result.stderr, "", "pure reads emit no repeated migration notice");
});

test("present invalid schedule caps refuse with a field and supported CLI correction", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    for (const maxConcurrent of [0, -1, 1.5, null, "2", false, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      const text = JSON.stringify({ version: 1, capsVersion: 2, workspaces: [], maxConcurrent });
      fs.writeFileSync(path, text);
      assert.throws(() => S.readRegistry(), (e) => {
        assert.equal(e.code, "E_SCHEDULE_INVALID");
        assert.equal(e.field, "maxConcurrent");
        assert.match(e.message, /schedule host install/);
        assert.match(e.message, /--max-concurrent/);
        return true;
      }, "invalid stored cap must not become the default: " + JSON.stringify(maxConcurrent));
      assert.equal(fs.readFileSync(path, "utf8"), text, "refusal is read-only");
    }
  `);
});

test("a raw old-writer one after capsVersion two stays explicit because provenance is unknowable", (t) => {
  const f = fixture(t);
  run(f, `
    S.writeRegistry({ version: 1, capsVersion: 2, workspaces: [], maxConcurrent: 7 });
    const oldWriterSnapshot = JSON.parse(fs.readFileSync(path, "utf8"));
    oldWriterSnapshot.maxConcurrent = 1;
    S.writeRegistry(oldWriterSnapshot);
    const text = fs.readFileSync(path, "utf8");
    assert.equal(S.readRegistry().maxConcurrent, 1);
    assert.equal(fs.readFileSync(path, "utf8"), text);
  `);
});

test("registry readers report corrupt and nonregular state instead of inventing a healthy default", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, '{"version":');
    assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /valid JSON/.test(e.message));
    assert.equal(fs.readFileSync(path, "utf8"), '{"version":');
    fs.rmSync(path);
    fs.mkdirSync(path);
    assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /regular file/.test(e.message));
    fs.rmSync(path, { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ version: 1, workspaces: [], triggersMaxConcurrent: 0 }));
    assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "triggersMaxConcurrent");
  `);
});

// A real second process keeps the writer windows open until each isolated
// reader finishes. There is deliberately no E_SCHEDULER_BUSY retry wrapper.
// The windows are the steps of a writer's lock (lib/claim.mjs): its private file
// written, the lock linked beside it, the lock held alone, a lock whose record
// does not parse, and the lock released.
for (const phase of ["private-file", "linked", "held", "unparseable", "released"]) {
  test(`registry reader remains lock-free during writer ${phase} window`, async (t) => {
    const f = fixture(t), expected = seed(f, { capsVersion: 2, maxConcurrent: 7, triggersMaxConcurrent: 2 });
    const writer = spawn(process.execPath, ["--input-type=module", "-e", prelude + `
      const lock = join(dir, "registry.lock"), mine = lock + ".tmp-" + process.pid + "-" + "a".repeat(32);
      const phase = ${JSON.stringify(phase)};
      if (phase === "unparseable") fs.writeFileSync(lock, '{"pid":');
      else {
        fs.writeFileSync(mine, claimRecord(), { mode: 0o600 });
        if (phase !== "private-file") fs.linkSync(mine, lock);
        if (["held", "released"].includes(phase)) fs.unlinkSync(mine);
        if (phase === "released") fs.unlinkSync(lock);
      }
      process.send("ready");
      process.once("message", () => { fs.rmSync(mine, { force: true }); fs.rmSync(lock, { force: true }); process.disconnect(); });
    `], { env: f.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    writer.stderr.on("data", (data) => { stderr += data; });
    const exit = once(writer, "exit");
    const watchdog = setTimeout(() => writer.kill("SIGKILL"), 8000);
    t.after(async () => {
      clearTimeout(watchdog);
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
      await exit;
    });
    const ready = await Promise.race([
      once(writer, "message"),
      exit.then(() => { throw new Error(`writer exited before ready: ${stderr}`); }),
    ]);
    assert.equal(ready[0], "ready");
    run(f, `assert.deepEqual(S.readRegistry(), ${JSON.stringify(expected)});`, 1500);
    assert.equal(readFileSync(f.path, "utf8"), JSON.stringify(expected) + "\n");
    writer.send("done");
    assert.deepEqual(await exit, [0, null], stderr);
  });
}

test("registry reader accepts a coherent new snapshot when an atomic writer replaces it between stat and open", (t) => {
  const f = fixture(t);
  seed(f, { capsVersion: 2, maxConcurrent: 7, extension: { generation: "old" } });
  run(f, `
    const next = { version: 1, capsVersion: 2, tickIntervalSec: 120, maxConcurrent: 9, triggersMaxConcurrent: 4, workspaces: ["/new/workspace"], extension: { generation: "new" } };
    const pending = path + ".next";
    fs.writeFileSync(pending, JSON.stringify(next));
    const open = fs.openSync;
    let replaced = false;
    fs.openSync = function (target, ...args) {
      if (target === path && !replaced) {
        replaced = true;
        fs.renameSync(pending, path);
      }
      return open.call(this, target, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(S.readRegistry(), next, "an atomic replacement is a complete valid snapshot, not corrupt state");
      assert.equal(replaced, true, "fixture crossed the registry stat/open boundary");
    } finally { fs.openSync = open; syncBuiltinESMExports(); }
  `);
});

test("registry reader keeps its complete old descriptor snapshot when replacement follows open", (t) => {
  const f = fixture(t);
  const previous = seed(f, { capsVersion: 2, maxConcurrent: 7, extension: { generation: "old" } });
  run(f, `
    const next = { version: 1, capsVersion: 2, tickIntervalSec: 120, maxConcurrent: 9, triggersMaxConcurrent: 4, workspaces: ["/new/workspace"], extension: { generation: "new" } };
    const pending = path + ".next";
    fs.writeFileSync(pending, JSON.stringify(next));
    const open = fs.openSync;
    let replaced = false;
    fs.openSync = function (target, ...args) {
      const fd = open.call(this, target, ...args);
      if (target === path && !replaced) {
        replaced = true;
        fs.renameSync(pending, path);
      }
      return fd;
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(S.readRegistry(), ${JSON.stringify(previous)});
      assert.equal(replaced, true);
    } finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.deepEqual(S.readRegistry(), next);
  `);
});

test("raw registry writer persists supplied values without cap projection or implicit locking", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    const held = claimRecord();
    fs.writeFileSync(join(dir, "registry.lock"), held);
    const raw = { version: 1, maxConcurrent: 1, workspaces: [], extension: { exact: true } };
    S.writeRegistry(raw);
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), raw);
    assert.equal(fs.readFileSync(join(dir, "registry.lock"), "utf8"), held);
  `);
});

test("registry snapshot safety refuses an existing symlink without following or changing its target", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    const target = join(dir, "target.json");
    const text = JSON.stringify({ version: 1, capsVersion: 2, workspaces: [], maxConcurrent: 7 });
    fs.writeFileSync(target, text);
    fs.symlinkSync(target, path);
    assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /regular file/.test(e.message));
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["registry.json", "target.json"]);
  `);
});

test("registry snapshot safety refuses a symlink swapped in at open with NOFOLLOW", (t) => {
  const f = fixture(t);
  seed(f, { capsVersion: 2, maxConcurrent: 7 });
  run(f, `
    const target = join(dir, "target.json");
    const text = JSON.stringify({ version: 1, capsVersion: 2, workspaces: [], maxConcurrent: 9 });
    fs.writeFileSync(target, text);
    const open = fs.openSync;
    let swapped = false;
    fs.openSync = function (name, flags, ...args) {
      if (name === path && !swapped) {
        swapped = true;
        assert.notEqual(fs.constants.O_NOFOLLOW, undefined);
        assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0, "atomic replacement must preserve no-follow open");
        fs.unlinkSync(path);
        fs.symlinkSync(target, path);
      }
      return open.call(this, name, flags, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /cannot be read safely/.test(e.message));
      assert.equal(swapped, true);
    } finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["registry.json", "target.json"]);
  `);
});

test("registry snapshot safety enforces the byte budget before and after atomic replacement", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    const tooLarge = JSON.stringify({ version: 1, capsVersion: 2, workspaces: [], padding: "x".repeat(S.SCHEDULE_FILE_BUDGET) });
    fs.writeFileSync(path, tooLarge);
    assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_STATE_OVERSIZE");
    assert.equal(fs.readFileSync(path, "utf8"), tooLarge);
    fs.writeFileSync(path, JSON.stringify({ version: 1, capsVersion: 2, workspaces: [] }));
    const pending = path + ".next";
    fs.writeFileSync(pending, tooLarge);
    const open = fs.openSync;
    let replaced = false;
    fs.openSync = function (name, ...args) {
      if (name === path && !replaced) {
        replaced = true;
        fs.renameSync(pending, path);
      }
      return open.call(this, name, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /past budget/.test(e.message));
      assert.equal(replaced, true);
    } finally { fs.openSync = open; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(path, "utf8"), tooLarge);
    assert.deepEqual(fs.readdirSync(dir), ["registry.json"]);
  `);
});

test("registry snapshot safety reports an actual read failure without changing disk or leaking its descriptor", (t) => {
  const f = fixture(t);
  seed(f, { capsVersion: 2, maxConcurrent: 7 });
  run(f, `
    const text = fs.readFileSync(path, "utf8"), before = fs.statSync(path);
    const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
    let registryFd, injected = false, closed = false;
    fs.openSync = function (name, ...args) {
      const fd = open.call(this, name, ...args);
      if (name === path) registryFd = fd;
      return fd;
    };
    fs.readSync = function (fd, ...args) {
      if (fd === registryFd) {
        injected = true;
        throw Object.assign(new Error("EACCES: injected permission failure"), { code: "EACCES" });
      }
      return read.call(this, fd, ...args);
    };
    fs.closeSync = function (fd) {
      if (fd === registryFd) closed = true;
      return close.call(this, fd);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && /EACCES/.test(e.message));
      assert.equal(injected, true);
      assert.equal(closed, true, "failed read must close the opened registry descriptor");
    } finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(path, "utf8"), text);
    assert.equal(fs.statSync(path).ino, before.ino);
    assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(dir), ["registry.json"]);
  `);
});

test("registry snapshot safety rejects null and array JSON as invalid registry shapes", (t) => {
  const f = fixture(t);
  run(f, `
    fs.mkdirSync(dir, { recursive: true });
    for (const text of ["null", "[]", '[{"version":1,"workspaces":[]}]']) {
      fs.writeFileSync(path, text);
      assert.throws(() => S.readRegistry(), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "file" && /registry object/.test(e.message));
      assert.equal(fs.readFileSync(path, "utf8"), text);
      assert.deepEqual(fs.readdirSync(dir), ["registry.json"]);
    }
  `);
});
