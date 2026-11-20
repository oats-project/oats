// CLI adapter (packages/client/cli-adapter.mjs) — Desktop CLI API v1
// mutation path: envelope parsing, argv allowlist, 0600 task tempfiles,
// fixed harvest cwd, and resolve-never-reject domain results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, existsSync } from "node:fs";
import {
  parseEnvelope, spawnArgv, writeTaskFile, cliSpawn, cliCapability,
} from "../../client/cli-adapter.mjs";

const OK = (result) => JSON.stringify({ schemaVersion: 1, ok: true, result });
const ERR = (code, message) => JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } });

function fakeExec(handler) {
  return (bin, argv, opts, cb) => {
    const r = handler(bin, argv, opts);
    process.nextTick(() => cb(r.err || null, r.stdout ?? ""));
  };
}

test("parseEnvelope: accepts exactly the two contract shapes, rejects contamination", () => {
  assert.ok(parseEnvelope(OK({ instance: "dev-1" })));
  assert.ok(parseEnvelope(ERR("E_UNKNOWN_AGENT", "nope")));
  assert.equal(parseEnvelope("Spawning...\n" + OK({})), null, "progress prose on stdout is contamination");
  assert.equal(parseEnvelope(JSON.stringify({ ok: true, result: {} })), null, "missing schemaVersion");
  assert.equal(parseEnvelope(JSON.stringify({ schemaVersion: 1, ok: true })), null, "ok without result");
  assert.equal(parseEnvelope(JSON.stringify({ schemaVersion: 1, ok: false })), null, "failure without error");
  assert.equal(parseEnvelope(""), null);
});

test("spawnArgv: allowlisted args only — unknown renderer keys are dropped, never forwarded", () => {
  const argv = spawnArgv("dev", "/ws", "/tmp/t/TASK.md", {
    purpose: "fix", repo: "/r", work: "worktree", harness: "pi", harnessFlag: "--harness", model: "opus",
    parent: "evil-1",             // NOT allowlisted (operator-origin spawns only)
    "--task": "injection",        // junk keys dropped
    branch: "sneaky",             // not in the v1 allowlist
  });
  assert.deepEqual(argv, [
    "spawn", "dev", "--dir", "/ws", "--task-file", "/tmp/t/TASK.md",
    "--purpose", "fix", "--repo", "/r", "--work", "worktree",
    "--harness", "pi", "--model", "opus", "--json",
  ]);
  assert.ok(!argv.includes("evil-1") && !argv.includes("sneaky") && !argv.includes("injection"));
});

test("spawnArgv: native Codex reaches the CLI in the kernel's own flag; an unnamed flag is refused, never guessed", () => {
  assert.deepEqual(spawnArgv("dev", "/ws", "/t/TASK.md", { harness: "codex", harnessFlag: "--harness" }),
    ["spawn", "dev", "--dir", "/ws", "--task-file", "/t/TASK.md", "--harness", "codex", "--json"]);
  assert.deepEqual(spawnArgv("dev", "/ws", "/t/TASK.md", { harness: "codex", harnessFlag: "--runtime" }),
    ["spawn", "dev", "--dir", "/ws", "--task-file", "/t/TASK.md", "--runtime", "codex", "--json"], "a released kernel (no feature harness)");
  for (const harnessFlag of [undefined, "--model", "--harness=x"]) assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", { harness: "codex", harnessFlag }), /harness flag/);
  assert.deepEqual(spawnArgv("dev", "/ws", "/t/TASK.md", { runtime: "codex", harnessFlag: "--harness" }),
    ["spawn", "dev", "--dir", "/ws", "--task-file", "/t/TASK.md", "--json"], "the old key is not an input any more");
});

test("spawnArgv: option-shaped values are REJECTED, never forwarded (review 53a20c7)", () => {
  // The CLI parser scans raw argv with includes()/indexOf() — an
  // option-shaped VALUE would inject a real non-allowlisted token.
  for (const opts of [
    { purpose: "--no-launch" },
    { repo: "--task-file" },
    { model: "-x" },
    { work: "--json" },          // also fails the enum
    { harness: "claude; rm", harnessFlag: "--harness" },   // fails the enum
    { purpose: "a b" },          // fails the slug
  ]) {
    assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", opts), /invalid/, JSON.stringify(opts));
  }
  assert.throws(() => spawnArgv("--evil", "/ws", "/t/TASK.md", {}), /invalid agent name/);
});

test("cliSpawn: option-shaped values resolve as E_BAD_ARGS envelopes (never reach the CLI)", async () => {
  let execCalled = false;
  const exec = fakeExec(() => { execCalled = true; return { stdout: OK({}) }; });
  const env = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", purpose: "--no-launch" }, { exec });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_BAD_ARGS");
  assert.equal(execCalled, false, "the CLI is never invoked with a rejected value");
});

test("writeTaskFile: file is 0600 from creation and cleanup removes the private dir", () => {
  const { file, cleanup } = writeTaskFile("secret task\n");
  try {
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `task file mode ${mode.toString(8)} must be 600`);
    assert.equal(readFileSync(file, "utf8"), "secret task\n");
  } finally { cleanup(); }
  assert.ok(!existsSync(file), "cleanup removed the tempdir");
});

test("writeTaskFile: mode is set at open (wx + 0600), not chmod-after", () => {
  // Injected io proves the flags/mode reach openSync — a chmod-after
  // implementation has a readable window and fails this.
  let opened = null;
  const io = {
    mkdtempSync: () => "/fake-tmp",
    openSync: (path, flags, mode) => { opened = { path, flags, mode }; return 7; },
    writeSync: (_fd, text) => Buffer.byteLength(text),
    closeSync: () => {},
    rmSync: () => {},
    tmpdir: () => "/fake",
  };
  writeTaskFile("x", io).cleanup();
  assert.equal(opened.flags, "wx", "create-exclusive");
  assert.equal(opened.mode, 0o600, "owner-only at open");
});


test("cliSpawn: success envelope resolves with result; task file cleaned up after", async () => {
  let seen = null;
  const exec = fakeExec((bin, argv, opts) => {
    seen = { bin, argv, opts };
    const taskFile = argv[argv.indexOf("--task-file") + 1];
    assert.ok(existsSync(taskFile), "task file exists while the CLI runs");
    assert.equal(readFileSync(taskFile, "utf8"), "do the thing");
    return { stdout: OK({ instance: "dev-x1", agent: "dev", home: "/h", work: "worktree", branch: "b", launched: true, warnings: [], tmux: { session: "pi-agents", window: "dev-x1" } }) };
  });
  const env = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", task: "do the thing", purpose: "x1" }, { exec });
  assert.equal(env.ok, true);
  assert.equal(env.result.instance, "dev-x1");
  assert.equal(seen.bin, "/abs/oats", "discovered absolute binary");
  assert.equal(seen.opts.shell, false, "never a shell");
  assert.equal(seen.opts.cwd, "/ws");
  const taskFile = seen.argv[seen.argv.indexOf("--task-file") + 1];
  assert.ok(!existsSync(taskFile), "task tempfile removed after the call");
});

test("cliSpawn: CLI failure envelope resolves (never rejects) with the stable code", async () => {
  const exec = fakeExec(() => ({ err: Object.assign(new Error("exit 1"), { code: 1 }), stdout: ERR("E_UNKNOWN_AGENT", 'unknown agent "nope"') }));
  const env = await cliSpawn("/abs/oats", { agent: "nope", workspaceDir: "/ws", task: "" }, { exec });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_UNKNOWN_AGENT");
});

test("cliSpawn: contaminated stdout resolves with E_CLI_PROTOCOL; timeout with E_CLI_TIMEOUT", async () => {
  const contaminated = fakeExec(() => ({ stdout: "Spawning dev...\n" + OK({}) }));
  let env = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws" }, { exec: contaminated });
  assert.equal(env.error.code, "E_CLI_PROTOCOL");
  const timedOut = fakeExec(() => ({ err: Object.assign(new Error("timeout"), { killed: true }), stdout: "" }));
  env = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws" }, { exec: timedOut });
  assert.equal(env.error.code, "E_CLI_TIMEOUT");
});

test("cliSpawn: an agent literally named __TASKFILE__ cannot collide with the placeholder (review 0b83988)", async () => {
  let seen = null;
  const exec = fakeExec((bin, argv) => { seen = argv; return { stdout: OK({ instance: "x" }) }; });
  await cliSpawn("/abs/oats", { agent: "__TASKFILE__", workspaceDir: "/ws", task: "t" }, { exec });
  assert.equal(seen[1], "__TASKFILE__", "agent name slot untouched");
  const tf = seen[seen.indexOf("--task-file") + 1];
  assert.notEqual(tf, "__TASKFILE__", "the --task-file slot got the real temp path");
  assert.ok(tf.includes("oats-desktop-task-"), `task file is the mkdtemp path (${tf})`);
});

test("provider operation runs with an explicit home", async () => {
  let seen = null;
  const exec = fakeExec((bin, argv, opts) => {
    seen = { bin, argv, opts };
    return { stdout: OK({ harvest: "skipped", reason: "no pending notes" }) };
  });
  const env = await cliCapability("/abs/oats", { action: "run", home: "/homes/dev-1", localCwd: "/homes/dev-1", operation: "knowledge:harvest" }, { exec });
  assert.equal(env.ok, true);
  assert.equal(env.result.harvest, "skipped");
  assert.deepEqual(seen.argv, ["operation", "run", "knowledge:harvest", "--home", "/homes/dev-1", "--json"]);
  assert.equal(seen.opts.cwd, "/homes/dev-1", "cwd is the resolved instance home");
  assert.equal(seen.opts.shell, false);
});

/* ── spawn-time agent relations (feature/agent-relations) ── */

test("spawnArgv: relation + relativeTo pass through as a validated pair", () => {
  const argv = spawnArgv("dev", "/ws", "/t/TASK.md", { relation: "child", relativeTo: "coordinator-1" });
  assert.deepEqual(argv, [
    "spawn", "dev", "--dir", "/ws", "--task-file", "/t/TASK.md",
    "--relation", "child", "--relative-to", "coordinator-1", "--json",
  ]);
  for (const relation of ["sibling", "parent"]) {
    const a = spawnArgv("dev", "/ws", "/t/TASK.md", { relation, relativeTo: "x-1" });
    assert.ok(a.includes("--relation") && a.includes(relation) && a.includes("--relative-to"));
  }
});

test("spawnArgv: 'unrelated' (or absent) forwards NO relation flags", () => {
  for (const opts of [{}, { relation: "unrelated" }, { relation: "" }, { relation: undefined }]) {
    const argv = spawnArgv("dev", "/ws", "/t/TASK.md", opts);
    assert.ok(!argv.includes("--relation") && !argv.includes("--relative-to"), JSON.stringify(opts));
  }
});

test("spawnArgv: relation/relativeTo must travel together; hostile values rejected", () => {
  assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", { relation: "child" }), /requires --relative-to/);
  assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", { relativeTo: "x-1" }), /requires a relation/);
  for (const opts of [
    { relation: "--json", relativeTo: "x" },       // option-shaped / not in enum
    { relation: "boss", relativeTo: "x" },         // unknown relation
    { relation: "child", relativeTo: "--evil" },   // option-shaped instance
    { relation: "child", relativeTo: "a b" },      // not an instance slug
  ]) {
    assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", opts), /invalid/, JSON.stringify(opts));
  }
});

test("cliSpawn: relation pair reaches the CLI argv; bad pairs resolve E_BAD_ARGS without exec", async () => {
  let seen = null;
  const exec = (bin, argv, o, cb) => { seen = argv; cb(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "dev-1" } })); };
  const io = { exec, mkdtempSync: () => "/t", openSync: () => 3, writeSync: (_fd, text) => Buffer.byteLength(text), closeSync: () => {}, rmSync: () => {}, tmpdir: () => "/tmp" };
  const env = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", relation: "parent", relativeTo: "worker-2" }, io);
  assert.equal(env.ok, true);
  assert.ok(seen.includes("--relation") && seen.includes("parent") && seen.includes("--relative-to") && seen.includes("worker-2"));

  seen = null;
  const bad = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", relation: "child" }, io);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "E_BAD_ARGS");
  assert.equal(seen, null, "invalid relation pair never reaches the CLI");
});

test("spawnArgv: relativeRoot rides with the relation pair as --relative-root; alone it is rejected", () => {
  const argv = spawnArgv("dev", "/ws", "/t/TASK.md",
    { relation: "child", relativeTo: "coord-1", relativeRoot: "/ws1/agents" });
  const at = argv.indexOf("--relative-root");
  assert.ok(at > 0, "--relative-root forwarded");
  assert.equal(argv[at + 1], "/ws1/agents");
  // pair without root still valid (root is optional on the wire)
  assert.ok(!spawnArgv("dev", "/ws", "/t/TASK.md", { relation: "child", relativeTo: "x" }).includes("--relative-root"));
  // root alone is meaningless — rejected like an unpaired relative-to
  assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", { relativeRoot: "/ws1/agents" }),
    /--relative-root requires/, "root without the relation pair rejected");
  // option-shaped root rejected
  assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md",
    { relation: "child", relativeTo: "x", relativeRoot: "--evil" }), /invalid/);
});

test("spawnArgv: a registered server routes the spawn and drops --dir (the remote workspace comes from the registration)", () => {
  const argv = spawnArgv("dev", "/ws", "/tmp/task.md", { server: "build" });
  assert.equal(argv.includes("--dir"), false);
  assert.deepEqual(argv.slice(argv.indexOf("--server"), argv.indexOf("--server") + 2), ["--server", "build"]);
  assert.throws(() => spawnArgv("dev", "/ws", "/tmp/task.md", { server: "Bad Id" }), /invalid server value/);
});

test("spawnArgv forwards explicit yolo booleans, including false", () => {
  assert.ok(spawnArgv("dev", "/ws", "/t", { yolo: true }).includes("--yolo"));
  assert.ok(spawnArgv("dev", "/ws", "/t", { yolo: false }).includes("--no-yolo"));
  assert.throws(() => spawnArgv("dev", "/ws", "/t", { yolo: "false" }), /boolean/);
});

test("cliSpawn on a server: an empty opening instruction sends no --task-file (the routed spawn refuses an empty one); a written one does", async () => {
  const seen = [];
  const exec = (_bin, argv, _opts, done) => { seen.push(argv); done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "dev-1" } })); };
  for (const task of ["", "   ", undefined]) {
    await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/local", task, server: "build", purpose: "x1" }, { exec });
    assert.equal(seen.at(-1).includes("--task-file"), false, JSON.stringify(task));
    assert.deepEqual(seen.at(-1).slice(0, 2), ["spawn", "dev"]);
    assert.ok(seen.at(-1).includes("--server"));
  }
  await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/local", task: "do it", server: "build" }, { exec });
  assert.ok(seen.at(-1).includes("--task-file"));
  await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", task: "" }, { exec });
  assert.ok(seen.at(-1).includes("--task-file"), "a local spawn keeps its (empty) task file, as before");
});

// Session providers (spec C1): `--backend` values come from the kernel, never a fixed list.
test("A5: --backend bb is accepted when the kernel lists bb, refused otherwise", async () => {
  const argv = spawnArgv("dev", "/ws", "/t/TASK.md", { backend: "bb", backends: ["tmux", "bb"] });
  assert.deepEqual(argv.slice(argv.indexOf("--backend"), argv.indexOf("--backend") + 2), ["--backend", "bb"]);
  for (const backends of [undefined, ["tmux"], [], null, "bb", ["tmux", "bbb"]]) {
    assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", { backend: "bb", backends }), e => e.code === "E_BAD_ARGS" && /invalid backend value/.test(e.message), JSON.stringify(backends));
  }
  // The list is never an argument, and cliSpawn resolves the refusal without running the CLI.
  assert.ok(!argv.includes("tmux") && !argv.some(a => String(a).includes("backends")));
  const refused = await cliSpawn("/abs/oats", { agent: "dev", workspaceDir: "/ws", task: "t", backend: "bb", backends: ["tmux"] }, { exec: () => assert.fail("never runs") });
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BAD_ARGS"]);
});

test("spawnArgv: tmux as before with no list or one that names it; a listed value must still be a backend's name, never option-shaped, never herdr", () => {
  for (const backends of [undefined, ["tmux"], ["tmux", "bb"]]) assert.ok(spawnArgv("dev", "/ws", "/t", { backend: "tmux", backends }).includes("--backend"), JSON.stringify(backends));
  assert.throws(() => spawnArgv("dev", "/ws", "/t", { backend: "tmux", backends: ["bb"] }), /invalid backend value/, "a kernel that does not list tmux");
  for (const backend of ["--json", "-bb", "BB", "b b", "bb;rm", "a".repeat(41), "herdr", "session-provider", "bb\n"]) {
    assert.throws(() => spawnArgv("dev", "/ws", "/t", { backend, backends: ["tmux", backend] }), /invalid backend value/, JSON.stringify(backend));
  }
  assert.ok(!spawnArgv("dev", "/ws", "/t", { backends: ["tmux", "bb"] }).includes("--backend"), "no backend chosen: no flag");
});
