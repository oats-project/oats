// A5: the spawn argv has no shell and carries `--backend bb`; a soul not in the list, and names
// with a space, a slash, an upper-case letter or a leading dash, are refused before any process
// starts; the task file is 0600 and gone after the call, on success and on failure.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codes, Oats, Processes } from "../../kernel/index.js";
import { installFakeOats, type FakeOats } from "../support/fake-oats.js";

let fake: FakeOats;
let processes: Processes;
let oats: Oats;
const SOULS = ["oats-developer", "oats.okf/knowledge-harvester"];
const context = () => ({ knownSouls: SOULS, tempDir: fake.tempDir });
const leftInTemp = async () => (existsSync(fake.tempDir) ? readdir(fake.tempDir) : []);

beforeEach(async () => {
  fake = await installFakeOats();
  processes = new Processes();
  oats = new Oats({ bin: fake.bin, cwd: fake.deployment, processes });
});
afterEach(async () => {
  await processes.killAll();
  await fake.remove();
});

describe("A5 spawn", () => {
  it("previews with an argv array that carries --backend bb, the name as one element and the task as a file", async () => {
    const task = "Fix the flaky CI job.\n$(touch /tmp/should-not-exist) ; rm -rf ~ `id` \"quoted\" --yolo\n";
    const preview = await oats.spawnPreview({ soul: "oats-developer", name: "flaky-ci-2-developer", task }, context());
    expect(preview.ok).toBe(true);
    const [call] = await fake.calls();
    expect(call?.argv).toEqual(["spawn", "oats-developer", "--backend", "bb", "--name", "flaky-ci-2-developer", "--task-file", call?.taskFile?.path, "--preview", "--json"]);
    // No shell read the task: it arrived byte for byte, in the file.
    expect(call?.taskFile?.text).toBe(task);
    expect(call?.taskFile?.mode).toBe("600");
    expect(call?.taskFile?.path.startsWith(fake.tempDir)).toBe(true);
    expect(existsSync(call!.taskFile!.path)).toBe(false);
    if (!preview.ok) return;
    expect(preview.value.revision).toMatch(/^[0-9a-f]{24}$/);
    expect(preview.value.summary.launch).toBe("pi · github-copilot/claude-fable-5.1 (local-default preference)");
    expect(preview.value.summary.teams).toEqual(["oats (default)"]);
    expect(preview.value.summary.modules).toContain("oats.aweb 1.43.0");
    expect(preview.value.summary.warnings).toEqual(["the bb server at http://127.0.0.1:38886 runs bb-app 0.50.1; the capability was tested up to 0.50.1"]);
    expect(preview.value.summary.problems).toEqual([]);
  });

  it("applies a previewed decision with the idempotency key", async () => {
    const preview = await oats.spawnPreview({ soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix it." }, context());
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const spawned = await oats.spawn({ soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix it.", key: "spawn-1f0c9a7e", revision: preview.value.revision }, context());
    expect(spawned).toEqual({ ok: true, value: { instance: "flaky-ci-2-developer", threadId: "thr_ci2" } });
    const calls = await fake.calls();
    expect(calls.map((call) => call.verb)).toEqual(["spawn --preview", "spawn"]);
    const apply = calls[1]!;
    expect(apply.argv).toEqual([
      "spawn", "oats-developer", "--backend", "bb", "--name", "flaky-ci-2-developer", "--task-file", apply.taskFile?.path,
      "--expect-decision", preview.value.revision, "--idempotency-key", "spawn-1f0c9a7e", "--json",
    ]);
    expect(apply.argv).not.toContain("--preview");
    // A file of its own for each process, 0600, gone afterwards.
    expect(apply.taskFile).toMatchObject({ mode: "600", text: "Fix it." });
    expect(apply.taskFile?.path.startsWith(fake.tempDir)).toBe(true);
    expect(await leftInTemp()).toEqual([]);
  });

  it("refuses a soul that is not in the list before any process starts", async () => {
    for (const soul of ["no-such-soul", "--help", "oats-developer --yolo", ""]) {
      const preview = await oats.spawnPreview({ soul, name: "x-developer", task: "t" }, context());
      expect(preview.ok === false && preview.error.code, soul).toBe(codes.invalidInput);
      const spawned = await oats.spawn({ soul, name: "x-developer", task: "t", key: "spawn-1f0c9a7e", revision: "c557d8ec9a272ba1c1739dc3" }, context());
      expect(spawned.ok === false && spawned.error.code, soul).toBe(codes.invalidInput);
    }
    expect(await fake.calls()).toEqual([]);
    expect(await leftInTemp()).toEqual([]);
  });

  it("refuses a name with a space, a slash, an upper-case letter or a leading dash before any process starts", async () => {
    for (const name of ["two words", "a/b", "../escape", "Upper", "-leading", "--preview", "", "a".repeat(64), "name\nnewline", "x;id"]) {
      const preview = await oats.spawnPreview({ soul: "oats-developer", name, task: "t" }, context());
      expect(preview.ok === false && preview.error.code, name).toBe(codes.invalidInput);
      const spawned = await oats.spawn({ soul: "oats-developer", name, task: "t", key: "spawn-1f0c9a7e", revision: "c557d8ec9a272ba1c1739dc3" }, context());
      expect(spawned.ok === false && spawned.error.code, name).toBe(codes.invalidInput);
    }
    expect(await fake.calls()).toEqual([]);
    expect(await leftInTemp()).toEqual([]);
  });

  it("refuses a key or a revision that is not the kernel's shape before any process starts", async () => {
    const bad = await oats.spawn({ soul: "oats-developer", name: "x-developer", task: "t", key: "--force", revision: "c557d8ec9a272ba1c1739dc3" }, context());
    expect(bad.ok === false && bad.error.code).toBe(codes.invalidInput);
    const worse = await oats.spawn({ soul: "oats-developer", name: "x-developer", task: "t", key: "spawn-1f0c9a7e", revision: "--no-launch" }, context());
    expect(worse.ok === false && worse.error.code).toBe(codes.invalidInput);
    expect(await fake.calls()).toEqual([]);
  });

  it("removes the task file when the kernel refuses the spawn, and answers the kernel's code and message", async () => {
    const refused = { schemaVersion: 1, ok: false, error: { code: "E_INSTANCE_NAME_TAKEN", message: 'instance name "flaky-ci-developer" is taken', details: { instance: "flaky-ci-developer" } } };
    await fake.behave({ spawn: { stdout: JSON.stringify(refused) } });
    const spawned = await oats.spawn({ soul: "oats-developer", name: "flaky-ci-developer", task: "again", key: "spawn-1f0c9a7e", revision: "c557d8ec9a272ba1c1739dc3" }, context());
    expect(spawned).toEqual({ ok: false, error: { code: "E_INSTANCE_NAME_TAKEN", message: 'instance name "flaky-ci-developer" is taken' } });
    const calls = await fake.calls();
    expect(calls.map((call) => call.verb)).toEqual(["spawn"]);
    expect(calls[0]?.taskFile).toMatchObject({ mode: "600", text: "again" });
    expect(existsSync(calls[0]!.taskFile!.path)).toBe(false);
    expect(await leftInTemp()).toEqual([]);
  });

  it("removes the task file when oats fails with no answer", async () => {
    await fake.behave({ spawn: { stdout: "", stderr: "oats: crashed\n", exit: 2 } });
    const spawned = await oats.spawn({ soul: "oats-developer", name: "x-developer", task: "t", key: "spawn-1f0c9a7e", revision: "c557d8ec9a272ba1c1739dc3" }, context());
    expect(spawned.ok === false && spawned.error.code).toBe(codes.failed);
    expect((await fake.calls()).map((call) => call.verb)).toEqual(["spawn"]);
    expect(await leftInTemp()).toEqual([]);
  });

  it("removes the task file when the spawn is cut off by its time limit", async () => {
    await fake.behave({ "spawn --preview": { sleepMs: 60_000 } });
    const slow = new Oats({ bin: fake.bin, cwd: fake.deployment, processes, timeouts: { preview: 300 } });
    const preview = await slow.spawnPreview({ soul: "oats-developer", name: "x-developer", task: "t" }, context());
    expect(preview.ok === false && preview.error.code).toBe(codes.timeout);
    expect(await leftInTemp()).toEqual([]);
  });
});
