// A7 and the other lifecycle verbs: stop (plan, apply), start, restart, retire (plan, apply).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codes, Oats, Processes } from "../../kernel/index.js";
import { FIXTURES, installFakeOats, type FakeOats } from "../support/fake-oats.js";

let fake: FakeOats;
let processes: Processes;
let oats: Oats;

beforeEach(async () => {
  fake = await installFakeOats();
  processes = new Processes();
  oats = new Oats({ bin: fake.bin, cwd: fake.deployment, processes });
});
afterEach(async () => {
  await processes.killAll();
  await fake.remove();
});

describe("stop", () => {
  it("reads the plan into its revision and the lines of the confirmation", async () => {
    const plan = await oats.stopPlan("redesign-ui-lead");
    expect(plan).toEqual({
      ok: true,
      value: {
        revision: "9c1f2e3d4b5a69788796a5b4",
        lines: [
          "Stop redesign-ui-lead (oats-product-expert): running, in the middle of a task, 2 changed and 1 untracked files in its work tree",
          "Stop its child desktop-mockups-developer (oats-desktop-developer): running, in the middle of a task, 2 changed and 1 untracked files in its work tree",
          "Stop its child harvest-knowledge-helper (knowledge-harvester): running",
          "Kept: every home, its work, its transcript and its launch settings. Start brings an agent back.",
        ],
      },
    });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["instance", "stop", "redesign-ui-lead", "--plan", "--json"]]);
  });

  it("applies with the plan's revision and the idempotency key", async () => {
    const applied = await oats.stopApply({ instance: "redesign-ui-lead", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" });
    expect(applied).toEqual({ ok: true, value: {} });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([
      ["instance", "stop", "redesign-ui-lead", "--apply", "--plan-revision", "9c1f2e3d4b5a69788796a5b4", "--idempotency-key", "stop-7f3a9c2e41b8", "--json"],
    ]);
  });

  it("A7: a revision the kernel refuses returns the kernel's code and message unchanged", async () => {
    await fake.behave({ "instance stop --apply": { file: "stop-apply-stale.json" } });
    const kernel = JSON.parse(await readFile(join(FIXTURES, "stop-apply-stale.json"), "utf8"));
    const applied = await oats.stopApply({ instance: "redesign-ui-lead", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" });
    expect(applied).toEqual({ ok: false, error: { code: "E_PLAN_STALE", message: kernel.error.message } });
    expect(kernel.error.code).toBe("E_PLAN_STALE");
  });

  it("answers the kernel's code for a session that would not stop", async () => {
    const receipt = JSON.parse(await readFile(join(FIXTURES, "stop-apply.json"), "utf8"));
    receipt.result.ok = false;
    receipt.result.results[2] = { instance: "redesign-ui-lead", home: "/h", ok: false, code: "E_SESSION_STOP_FAILED", message: "its harness was signalled (SIGTERM) and still runs", stillRunning: [4242] };
    await fake.behave({ "instance stop --apply": { stdout: JSON.stringify(receipt) } });
    const applied = await oats.stopApply({ instance: "redesign-ui-lead", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" });
    expect(applied).toEqual({ ok: false, error: { code: "E_SESSION_STOP_FAILED", message: "its harness was signalled (SIGTERM) and still runs" } });
  });

  it("refuses an instance, a revision or a key that is no argv element of its kind before any process starts", async () => {
    for (const instance of ["--plan", "Two Words", "a/b", ""]) {
      const plan = await oats.stopPlan(instance);
      expect(plan.ok === false && plan.error.code, instance).toBe(codes.invalidInput);
      const retire = await oats.retirePlan(instance);
      expect(retire.ok === false && retire.error.code, instance).toBe(codes.invalidInput);
    }
    const revision = await oats.stopApply({ instance: "dev-1", revision: "--no-recursive", key: "stop-7f3a9c2e41b8" });
    expect(revision.ok === false && revision.error.code).toBe(codes.invalidInput);
    const key = await oats.retireApply({ instance: "dev-1", revision: "9c1f2e3d4b5a69788796a5b4", key: "--force" });
    expect(key.ok === false && key.error.code).toBe(codes.invalidInput);
    const home = await oats.start("relative/home");
    expect(home.ok === false && home.error.code).toBe(codes.invalidInput);
    expect(await fake.calls()).toEqual([]);
  });
});

describe("start and restart", () => {
  const home = "/abs/deployment/agents/oats-expert/instances/weekly-digest-helper";
  it("starts the home the kernel named and answers the new thread", async () => {
    expect(await oats.start(home)).toEqual({ ok: true, value: { threadId: "thr_digest2" } });
    expect(await oats.restart(home)).toEqual({ ok: true, value: { threadId: "thr_digest2" } });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([
      ["session", "start", "--home", home, "--json"],
      ["session", "restart", "--home", home, "--json"],
    ]);
  });

  it("answers no thread when the kernel's answer names none", async () => {
    const answer = JSON.parse(await readFile(join(FIXTURES, "start.json"), "utf8"));
    delete answer.result.session;
    await fake.behave({ "session start": { stdout: JSON.stringify(answer) } });
    expect(await oats.start(home)).toEqual({ ok: true, value: { threadId: null } });
  });

  it("answers the kernel's refusal unchanged", async () => {
    await fake.behave({ "session start": { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_SESSION_RUNNING", message: "weekly-digest-helper already runs" } }) } });
    expect(await oats.start(home)).toEqual({ ok: false, error: { code: "E_SESSION_RUNNING", message: "weekly-digest-helper already runs" } });
  });
});

describe("retire", () => {
  it("reads the plan into what is removed and what is kept", async () => {
    const plan = await oats.retirePlan("weekly-digest-helper");
    expect(plan).toEqual({
      ok: true,
      value: {
        revision: "4e5f6a7b8c9d0e1f2a3b4c5d",
        lines: [
          "Removed: the home of weekly-digest-helper (/abs/deployment/agents/oats-expert/instances/weekly-digest-helper). Its session is not running.",
          "Kept: its work tree on branch agents/weekly-digest-helper, moved out of the home (0 changed and 1 untracked file in its work tree).",
          "Kept: its branch.",
          "Its child (digest-links-helper): stopped and kept.",
          "1 untracked file in the work tree is copied to the recovery directory before the home is removed",
        ],
      },
    });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["retire", "weekly-digest-helper", "--plan", "--json"]]);
  });

  it("says so when the kernel could not establish whether the session runs", async () => {
    const answer = JSON.parse(await readFile(join(FIXTURES, "retire-plan.json"), "utf8"));
    answer.result.facts.session = { state: "unestablished", present: null, backend: null, established: false, reason: "E_SESSION_UNAVAILABLE" };
    await fake.behave({ "retire --plan": { stdout: JSON.stringify(answer) } });
    const plan = await oats.retirePlan("weekly-digest-helper");
    expect(plan.ok && plan.value.lines[0]).toBe(
      "Removed: the home of weekly-digest-helper (/abs/deployment/agents/oats-expert/instances/weekly-digest-helper). Whether its session runs is not known; one that runs is stopped first.",
    );
    answer.result.facts.session = { state: "unknown", present: true, backend: "bb", established: true };
    await fake.behave({ "retire --plan": { stdout: JSON.stringify(answer) } });
    const running = await oats.retirePlan("weekly-digest-helper");
    expect(running.ok && running.value.lines[0]).toMatch(/Its session is running and is stopped first\.$/);
    // Established and observably gone: nothing to stop.
    answer.result.facts.session = { state: "absent", present: false, backend: "bb", established: true };
    await fake.behave({ "retire --plan": { stdout: JSON.stringify(answer) } });
    const absent = await oats.retirePlan("weekly-digest-helper");
    expect(absent.ok && absent.value.lines[0]).toMatch(/Its session is not running\.$/);
  });

  it("says for each extra tree what the kernel would do with it: keep, remove, or refuse the retire", async () => {
    const answer = JSON.parse(await readFile(join(FIXTURES, "retire-plan.json"), "utf8"));
    const tree = (name: string, disposition: string, reason: string | null) => ({
      path: `/h/.work-${name}`, repo: "/w/docs", branch: `agents/x-${name}`, detachedAt: null, disposition, movedTo: disposition === "retain" ? "/w/.agents/worktrees/docs/x" : null, reason,
    });
    answer.result.facts.extraWorktrees = [tree("a", "retain", "2 changed files"), tree("b", "remove", null), tree("c", "refuse", "its target exists"), tree("d", "quarantine", null)];
    await fake.behave({ "retire --plan": { stdout: JSON.stringify(answer) } });
    const plan = await oats.retirePlan("weekly-digest-helper");
    expect(plan.ok && plan.value.lines.filter((line) => line.includes("the extra tree"))).toEqual([
      "Kept: the extra tree /h/.work-a on branch agents/x-a, moved out of the home (2 changed files).",
      "Removed: the extra tree /h/.work-b on branch agents/x-b (it is clean; its branch is kept).",
      "Blocks the retire: the extra tree /h/.work-c on branch agents/x-c (its target exists). The kernel would refuse and keep the home.",
      "quarantine: the extra tree /h/.work-d on branch agents/x-d.",
    ]);
  });

  it("applies the plan: the first answer is the receipt itself, a replay is an envelope", async () => {
    const apply = { instance: "weekly-digest-helper", revision: "4e5f6a7b8c9d0e1f2a3b4c5d", key: "retire-2b9d4e6f8a1c" };
    expect(await oats.retireApply(apply)).toEqual({ ok: true, value: {} });
    const receipt = JSON.parse(await readFile(join(FIXTURES, "retire-apply.json"), "utf8"));
    await fake.behave({ retire: { stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: { ...receipt, replayed: true } }) } });
    expect(await oats.retireApply(apply)).toEqual({ ok: true, value: {} });
    expect((await fake.calls())[0]?.argv).toEqual(["retire", "weekly-digest-helper", "--plan-revision", "4e5f6a7b8c9d0e1f2a3b4c5d", "--idempotency-key", "retire-2b9d4e6f8a1c", "--json"]);
  });

  it("answers the kernel's refusal unchanged", async () => {
    await fake.behave({ retire: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_CHILDREN_RUNNING", message: "1 child still runs: digest-links-helper", details: {} } }) } });
    const applied = await oats.retireApply({ instance: "weekly-digest-helper", revision: "4e5f6a7b8c9d0e1f2a3b4c5d", key: "retire-2b9d4e6f8a1c" });
    expect(applied).toEqual({ ok: false, error: { code: "E_CHILDREN_RUNNING", message: "1 child still runs: digest-links-helper" } });
  });
});
