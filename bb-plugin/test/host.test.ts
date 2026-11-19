// The host entry through bb's own harness: the same validation, cancellation and lifecycle
// boundaries as the daemon's worker. A6: a child still running when `dispose` is called is killed
// with its process group.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostEntry } from "../host.js";
import { codes } from "../kernel/index.js";
import { alive, gone, installFakeOats, type Call, type FakeOats } from "./support/fake-oats.js";

let fake: FakeOats;
let watches: { rootPath: string; listener: ExperimentalHostWatchListener; disposed: boolean }[];
let harness: ReturnType<typeof makeHarness>;

function makeHarness() {
  return experimental_createHostEntryHarness(createHostEntry(), {
    experimental_paths: { dataDir: join(fake.deployment, "data"), tempDir: fake.tempDir },
    experimental_watch: (options, listener) => {
      const watch = { rootPath: options.rootPath, listener, disposed: false };
      watches.push(watch);
      return { dispose: async () => void (watch.disposed = true) };
    },
  });
}
const base = () => ({ deployment: fake.deployment, oatsBin: fake.bin });

async function waitForCalls(count: number): Promise<Call[]> {
  for (let tries = 0; tries < 400; tries += 1) {
    const calls = await fake.calls();
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the fake oats was not called ${count} time(s)`);
}

beforeEach(async () => {
  fake = await installFakeOats();
  watches = [];
  harness = makeHarness();
});
afterEach(async () => {
  await harness.experimental_dispose();
  await fake.remove();
});

describe("A6 dispose", () => {
  it("kills an oats that is still running, with the child it started", async () => {
    await fake.behave({ status: { sleepMs: 600_000, grandchild: true } });
    const pending = harness.experimental_call("status", base()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const [call] = await waitForCalls(1);
    expect(call?.grandchild).toBeTypeOf("number");
    expect(await alive(call!.pid)).toBe(true);
    expect(await alive(call!.grandchild!)).toBe(true);

    await harness.experimental_dispose();

    await gone([call!.pid, call!.grandchild!]);
    // The call ended too: either the harness rejected it, or the entry answered that it was stopped.
    const settled = await pending;
    if ("value" in settled) expect(settled.value).toMatchObject({ ok: false, error: { code: codes.aborted } });
  });

  it("kills the group of every call in flight, not only the first", async () => {
    await fake.behave({ "*": { sleepMs: 600_000, grandchild: true } });
    const pending = [
      harness.experimental_call("status", base()),
      harness.experimental_call("souls", base()),
      harness.experimental_call("stopPlan", { ...base(), instance: "redesign-ui-lead" }),
    ].map((call) => call.catch((error: unknown) => error));
    const calls = await waitForCalls(3);
    await harness.experimental_dispose();
    await gone(calls.flatMap((call) => [call.pid, call.grandchild!]));
    await Promise.all(pending);
  });

  it("kills the group when the call's own signal aborts", async () => {
    await fake.behave({ status: { sleepMs: 600_000, grandchild: true } });
    const controller = new AbortController();
    const pending = harness.experimental_call("status", base(), { signal: controller.signal }).catch((error: unknown) => error);
    const [call] = await waitForCalls(1);
    controller.abort();
    await gone([call!.pid, call!.grandchild!]);
    await pending;
  });

  it("leaves alone what an oats that finished by itself started", async () => {
    await fake.behave({ status: { grandchild: true } });
    const status = await harness.experimental_call("status", base());
    expect(status.ok).toBe(true);
    const [call] = await fake.calls();
    expect(await alive(call!.grandchild!)).toBe(true);
    process.kill(call!.grandchild!, "SIGKILL");
    await gone([call!.grandchild!]);
  });
});

describe("the host verbs", () => {
  it("runs each read verb in the deployment and answers the plugin's rows", async () => {
    const status = await harness.experimental_call("status", base());
    expect(status.ok && status.value.agents).toHaveLength(8);
    const souls = await harness.experimental_call("souls", base());
    expect(souls.ok && souls.value.souls.length).toBe(9);
    const capabilities = await harness.experimental_call("capabilities", base());
    expect(capabilities.ok && capabilities.value.capabilities.length).toBeGreaterThan(3);
    const teams = await harness.experimental_call("teams", base());
    expect(teams.ok && teams.value.teams.map((team) => team.label)).toEqual(["oats", "docs"]);
    const servers = await harness.experimental_call("servers", base());
    expect(servers.ok && servers.value.machines.map((machine) => machine.id)).toEqual(["devbox-oats", "build"]);
    const calls = await fake.calls();
    expect(calls.map((call) => call.verb)).toEqual(["status", "souls", "capabilities", "teams", "server list"]);
    expect(new Set(calls.map((call) => call.cwd))).toEqual(new Set([fake.deployment]));
  });

  it("A5: spawn checks the soul against `oats souls` and starts no spawn for one that is not listed", async () => {
    const refused = await harness.experimental_call("spawn", { ...base(), soul: "no-such-soul", name: "x-developer", task: "t", key: "spawn-1f0c9a7e", revision: null });
    expect(refused).toMatchObject({ ok: false, error: { code: codes.invalidInput } });
    const preview = await harness.experimental_call("spawnPreview", { ...base(), soul: "no-such-soul", name: "x-developer", task: "t" });
    expect(preview).toMatchObject({ ok: false, error: { code: codes.invalidInput } });
    // The list was read once and reused; nothing else ran.
    expect((await fake.calls()).map((call) => call.verb)).toEqual(["souls"]);
  });

  it("A5: a name that is no instance name is refused at the contract, before any process starts", async () => {
    for (const name of ["two words", "a/b", "Upper", "-leading"]) {
      await expect(harness.experimental_call("spawn", { ...base(), soul: "oats-developer", name, task: "t", key: "spawn-1f0c9a7e", revision: null })).rejects.toThrow();
      await expect(harness.experimental_call("spawnPreview", { ...base(), soul: "oats-developer", name, task: "t" })).rejects.toThrow();
      await expect(harness.experimental_call("stopPlan", { ...base(), instance: name })).rejects.toThrow();
    }
    expect(await fake.calls()).toEqual([]);
  });

  it("A5: spawn runs souls, the preview and the apply, with the task in a 0600 file of the worker's temporary directory", async () => {
    const spawned = await harness.experimental_call("spawn", { ...base(), soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix it.", key: "spawn-1f0c9a7e", revision: null });
    expect(spawned).toMatchObject({ ok: true, value: { instance: "flaky-ci-2-developer", threadId: "thr_ci2" } });
    const calls = await fake.calls();
    expect(calls.map((call) => call.verb)).toEqual(["souls", "spawn --preview", "spawn"]);
    expect(calls[2]?.taskFile).toMatchObject({ mode: "600", text: "Fix it." });
    expect(calls[2]?.taskFile?.path.startsWith(fake.tempDir)).toBe(true);
    expect(calls[2]?.argv.slice(0, 6)).toEqual(["spawn", "oats-developer", "--backend", "bb", "--name", "flaky-ci-2-developer"]);
  });

  it("answers the plan and the kernel's refusal of a stale apply", async () => {
    const plan = await harness.experimental_call("stopPlan", { ...base(), instance: "redesign-ui-lead" });
    expect(plan.ok && plan.value.revision).toBe("9c1f2e3d4b5a69788796a5b4");
    await fake.behave({ "instance stop --apply": { file: "stop-apply-stale.json" } });
    const applied = await harness.experimental_call("stopApply", { ...base(), instance: "redesign-ui-lead", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" });
    expect(applied).toMatchObject({ ok: false, error: { code: "E_PLAN_STALE" } });
  });

  it("refuses a relative deployment or oats path without running anything", async () => {
    expect(await harness.experimental_call("status", { deployment: "relative", oatsBin: "" })).toMatchObject({ ok: false, error: { code: codes.invalidInput } });
    expect(await harness.experimental_call("status", { deployment: fake.deployment, oatsBin: "./oats" })).toMatchObject({ ok: false, error: { code: codes.invalidInput } });
    expect(await fake.calls()).toEqual([]);
  });

  it("says that oats is missing when the binary is not there", async () => {
    const status = await harness.experimental_call("status", { deployment: fake.deployment, oatsBin: join(fake.deployment, "gone") });
    expect(status).toMatchObject({ ok: false, error: { code: codes.notFound } });
  });
});

describe("discover", () => {
  it("walks up from a project's root to the directory that holds oats-local.yaml", async () => {
    const home = join(fake.deployment, "agents", "dev", "instances", "dev-1");
    await mkdir(home, { recursive: true });
    const found = await harness.experimental_call("discover", { deployment: "", roots: ["/nowhere/at/all", "relative", home] });
    expect(found).toEqual({ deployment: fake.deployment, machine: hostname() });
  });

  it("answers none when no project is inside a deployment", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "bb-plugin-oats-none-"));
    try {
      expect(await harness.experimental_call("discover", { deployment: "", roots: [elsewhere] })).toEqual({ deployment: null, machine: hostname() });
      expect(await harness.experimental_call("discover", { deployment: "", roots: [] })).toEqual({ deployment: null, machine: hostname() });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("takes the setting as it is, when it holds oats-local.yaml", async () => {
    expect(await harness.experimental_call("discover", { deployment: fake.deployment, roots: [] })).toEqual({ deployment: fake.deployment, machine: hostname() });
    expect(await harness.experimental_call("discover", { deployment: join(fake.deployment, "agents"), roots: [fake.deployment] })).toEqual({ deployment: null, machine: hostname() });
    expect(await harness.experimental_call("discover", { deployment: "relative", roots: [] })).toEqual({ deployment: null, machine: hostname() });
  });
});

describe("watch", () => {
  const events = () => join(fake.deployment, ".agents", "events");

  it("watches the deployment's event log once and signals each batch", async () => {
    await mkdir(events(), { recursive: true });
    expect(await harness.experimental_call("watch", { deployment: fake.deployment })).toEqual({ watching: events() });
    expect(await harness.experimental_call("watch", { deployment: fake.deployment })).toEqual({ watching: events() });
    expect(watches.map((watch) => watch.rootPath)).toEqual([events()]);
    await watches[0]!.listener({ kind: "changed", changes: [{ path: join(events(), "dev--dev-1.jsonl"), type: "update" }] });
    await watches[0]!.listener({ kind: "rescan-required" });
    expect(harness.experimental_getSignals()).toEqual([
      { signal: "changed", payload: { reason: "changed" } },
      { signal: "changed", payload: { reason: "rescan-required" } },
    ]);
  });

  it("answers null while the deployment has no event log, and watches once it has", async () => {
    expect(await harness.experimental_call("watch", { deployment: fake.deployment })).toEqual({ watching: null });
    expect(watches).toEqual([]);
    await mkdir(events(), { recursive: true });
    await writeFile(join(events(), "dev--dev-1.jsonl"), "{}\n");
    expect(await harness.experimental_call("watch", { deployment: fake.deployment })).toEqual({ watching: events() });
    expect(watches).toHaveLength(1);
  });

  it("watches again after the daemon's watcher fails", async () => {
    await mkdir(events(), { recursive: true });
    await harness.experimental_call("watch", { deployment: fake.deployment });
    await watches[0]!.listener({ kind: "watch-error", message: "inotify limit" });
    expect(watches[0]!.disposed).toBe(true);
    expect(harness.experimental_getSignals()).toEqual([{ signal: "changed", payload: { reason: "watch-error" } }]);
    await harness.experimental_call("watch", { deployment: fake.deployment });
    expect(watches).toHaveLength(2);
  });

  it("does not leave two subscriptions when two calls race", async () => {
    await mkdir(events(), { recursive: true });
    await Promise.all([1, 2, 3].map(() => harness.experimental_call("watch", { deployment: fake.deployment })));
    expect(watches).toHaveLength(1);
  });
});
