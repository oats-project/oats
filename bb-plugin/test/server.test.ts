// The server entry on bb's fake plugin host, with the real host entry behind it (bb's host-entry
// harness) and the fake `oats` behind that: the whole backend, from an RPC to a process and back.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost, makeHostResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostContract, REALTIME_CHANGED } from "../contract.js";
import { createHostEntry } from "../host.js";
import { codes, timeouts } from "../kernel/index.js";
import plugin, { HOST_TIMEOUT, MIN_INTERVAL_MS } from "../server.js";
import { FIXTURES, installFakeOats, type FakeOats } from "./support/fake-oats.js";

let fake: FakeOats;
let hostEntry: ReturnType<typeof experimental_createHostEntryHarness<any, any>>;
let server: FakePluginHost;
let hosts: ReturnType<typeof makeHostResponse>[];
let projects: unknown[];

const rpc = <Value = any>(method: string, input: unknown = null) => server.harness.callRpc(method, input) as Promise<Value>;
const verbs = async () => (await fake.calls()).map((call) => call.verb);
const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
  );

async function load(settings: Record<string, string> = {}) {
  server = createFakePluginHost({
    pluginId: "oats",
    settings: { oatsBin: fake.bin, ...settings },
    sdk: {
      hosts: { list: async () => hosts },
      projects: { list: async () => projects },
    } as never,
    experimental_callHostRpc: (call) => hostEntry.experimental_call(call.method, call.input as never, { signal: call.signal }),
  });
  await plugin(server.bb);
}

beforeEach(async () => {
  fake = await installFakeOats();
  await mkdir(join(fake.deployment, ".agents", "events"), { recursive: true });
  hostEntry = experimental_createHostEntryHarness(createHostEntry(), {
    experimental_paths: { dataDir: join(fake.deployment, "data"), tempDir: fake.tempDir },
    experimental_watch: () => ({ dispose: async () => undefined }),
  });
  hosts = [makeHostResponse({ id: "host_falcon", name: "falcon" })];
  projects = [{ id: "proj_release", sources: [{ hostId: "host_falcon", path: join(fake.deployment, "agents", "oats-maintainer", "instances", "release-070-maintainer") }] }];
  await load();
});
afterEach(async () => {
  await server.harness.dispose();
  await hostEntry.experimental_dispose();
  await fake.remove();
});

describe("snapshot", () => {
  it("answers the deployment and its agents, read once for every client", async () => {
    const first = await rpc("snapshot");
    expect(first.ok).toBe(true);
    expect(first.deployment.root).toBe(fake.deployment);
    expect(first.deployment.workspace).toBe("oats");
    expect(first.deployment.machine).toBeTypeOf("string");
    expect(first.agents).toHaveLength(8);
    const again = await Promise.all([rpc("snapshot"), rpc("snapshot"), rpc("snapshot")]);
    expect(again.every((snapshot) => snapshot.at === first.at)).toBe(true);
    expect(await verbs()).toEqual(["status"]);
    expect(server.harness.realtimeSignals).toEqual([{ channel: REALTIME_CHANGED, payload: { at: first.at } }]);
    // The watch on the event log was asserted on the machine that holds the homes.
    await expect.poll(() => server.harness.experimental_hostRpcCalls.map((call) => call.method)).toEqual(["discover", "status", "watch"]);
    expect(server.harness.experimental_hostRpcCalls.every((call) => call.hostId === "host_falcon")).toBe(true);
  });

  it("rereads on refresh, never sooner than the floor, and publishes only a change", async () => {
    const first = await rpc("snapshot");
    const started = Date.now();
    const [one, two] = await Promise.all([rpc("refresh"), rpc("refresh")]);
    expect(Date.now() - Date.parse(first.at)).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(one).toEqual(two); // two callers, one read
    expect(Date.parse(one.at) - Date.parse(first.at)).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50);
    expect(Date.now() - started).toBeLessThan(MIN_INTERVAL_MS + 3_000);
    expect(await verbs()).toEqual(["status", "status"]);
    expect(server.harness.realtimeSignals).toHaveLength(1); // the same agents: nothing to invalidate
    expect((await rpc("snapshot")).at).toBe(one.at);
  }, 20_000);

  it("rereads when the host entry signals a change, and publishes it", async () => {
    await rpc("snapshot");
    await fake.behave({ status: { stdout: JSON.stringify({ root: "/abs/deployment", agents: [] }) } });
    await server.harness.experimental_emitHostSignal("host_falcon", "changed", { reason: "changed" });
    await expect.poll(() => server.harness.realtimeSignals.length, { timeout: MIN_INTERVAL_MS + 4_000 }).toBe(2);
    const next = await rpc("snapshot");
    expect(next.agents).toEqual([]);
    expect(server.harness.realtimeSignals[1]).toEqual({ channel: REALTIME_CHANGED, payload: { at: next.at } });
  }, 20_000);

  it("rereads when bb creates or deletes a thread", async () => {
    await rpc("snapshot");
    await server.harness.emitThreadEvent("thread.created", { thread: { id: "thr_new" } } as never);
    await expect.poll(async () => (await verbs()).length, { timeout: MIN_INTERVAL_MS + 4_000 }).toBe(2);
  }, 20_000);

  it("shares the read in flight with a snapshot call that arrives before the first answer", async () => {
    await fake.behave({ status: { sleepMs: 700 } });
    const service = server.harness.runService("snapshot");
    await expect.poll(async () => (await verbs()).length).toBe(1);
    const started = Date.now();
    expect((await rpc("snapshot")).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(MIN_INTERVAL_MS - 1_000);
    expect(await verbs()).toEqual(["status"]);
    service.controller.abort();
    await service.done;
  });

  it("says in one line that oats is missing, and keeps answering", async () => {
    await server.harness.setSettings({ oatsBin: join(fake.deployment, "no-oats-here") });
    const snapshot = await rpc("snapshot");
    expect(snapshot.ok).toBe(false);
    expect(snapshot.code).toBe(codes.notFound);
    expect(snapshot.message.split("\n")[0]).toMatch(/^oats was not found on .+: install OATS there, or set the path to oats in the OATS plugin's settings\./);
  });

  it("says that no deployment was found when no project is inside one", async () => {
    await server.harness.dispose();
    projects = [{ id: "proj_other", sources: [{ hostId: "host_falcon", path: "/tmp" }] }];
    await load();
    const snapshot = await rpc("snapshot");
    expect(snapshot).toMatchObject({ ok: false, code: codes.noDeployment });
    expect(snapshot.message).toMatch(/^No OATS deployment found on /);
    expect(await verbs()).toEqual([]);
  });

  it("takes the deployment setting instead of the projects", async () => {
    await server.harness.dispose();
    projects = [];
    await load({ deployment: fake.deployment });
    expect((await rpc("snapshot")).ok).toBe(true);
    await server.harness.dispose();
    await load({ deployment: join(fake.deployment, "agents") });
    expect(await rpc("snapshot")).toMatchObject({ ok: false, code: codes.noDeployment });
  });

  it("does not keep a deployment found with settings that changed meanwhile", async () => {
    await server.harness.dispose();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await load();
    server.harness.sdk.stub("hosts.list", (async () => {
      await held; // the discovery is in flight, with the settings as they were
      return hosts;
    }) as never);
    const first = rpc("snapshot");
    await expect.poll(() => server.harness.sdk.callsTo("hosts.list").length).toBe(1);
    await server.harness.setSettings({ deployment: join(fake.deployment, "agents") }); // holds no oats-local.yaml
    server.harness.sdk.stub("hosts.list", (async () => hosts) as never);
    release();
    await first;
    // The next read looks for the deployment again, with the new setting, instead of using the old one.
    await expect.poll(async () => (await rpc("snapshot")).code, { timeout: MIN_INTERVAL_MS + 4_000 }).toBe(codes.noDeployment);
  }, 20_000);

  it("asks to choose a machine when the server has several and none is set", async () => {
    await server.harness.dispose();
    hosts = [makeHostResponse({ id: "host_falcon", name: "falcon" }), makeHostResponse({ id: "host_kite", name: "kite" })];
    await load();
    const snapshot = await rpc("snapshot");
    expect(snapshot).toMatchObject({ ok: false, code: codes.chooseHost });
    expect(snapshot.message).toContain("falcon, kite");
    await server.harness.dispose();
    await load({ host: "falcon" });
    expect((await rpc("snapshot")).ok).toBe(true);
    await server.harness.dispose();
    await load({ host: "osprey" });
    expect(await rpc("snapshot")).toMatchObject({ ok: false, code: codes.hostNotFound });
  });

  it("answers the kernel's code and message when oats refuses", async () => {
    await fake.behave({ status: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_CONFIG_BROKEN", message: "oats-local.yaml cannot be read" } }) } });
    expect(await rpc("snapshot")).toMatchObject({ ok: false, code: "E_CONFIG_BROKEN", message: "oats-local.yaml cannot be read" });
  });
});

describe("the pages", () => {
  it("answers souls, capabilities with their number of souls, teams and machines", async () => {
    const { souls } = await rpc("souls");
    expect(souls).toHaveLength(10);
    // Every agent of the snapshot is an agent of exactly one soul of the page.
    for (const agent of (await rpc("snapshot")).agents) {
      expect(souls.filter((soul: { agent: string }) => soul.agent === agent.soul), agent.soul).toHaveLength(1);
    }
    const { capabilities } = await rpc("capabilities");
    expect(capabilities.find((row: { id: string }) => row.id === "oats.core").souls).toBeGreaterThan(1);
    const { teams } = await rpc("teams");
    expect(teams[0]).toEqual({ label: "oats", team: "default:oats.aweb.ai", isDefault: true });
    await rpc("snapshot");
    const { machines } = await rpc("machines");
    expect(machines.map((machine: { id: string; isThisMachine: boolean }) => [machine.id, machine.isThisMachine])).toEqual([
      [(await rpc("snapshot")).deployment.machine, true],
      ["devbox-oats", false],
      ["build", false],
    ]);
    // One `oats souls` served the souls page and the capability counts.
    expect((await verbs()).filter((verb) => verb === "souls")).toHaveLength(1);
  });

  it("refuses, and does not crash, when the machine cannot be asked where the deployment is", async () => {
    await server.harness.dispose();
    await hostEntry.experimental_dispose(); // every host call now fails
    await load();
    const refused = await refusalOf(rpc("souls"));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/^HOST_UNREACHABLE: The machine that runs oats did not answer: /);
    expect(await rpc("snapshot")).toMatchObject({ ok: false, code: codes.hostUnreachable });
  });

  it("refuses with the kernel's code and message when a page's verb fails, and reads again next time", async () => {
    await fake.behave({ teams: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_WORKSPACE_SCHEMA", message: "oats-workspace.yaml: teams must be a mapping" } }) } });
    expect(await refusalOf(rpc("teams"))).toEqual({ code: "conflict", message: "E_WORKSPACE_SCHEMA: oats-workspace.yaml: teams must be a mapping" });
    await fake.behave({});
    expect((await rpc("teams")).teams).toHaveLength(2);
  });
});

describe("acts", () => {
  it("spawns through a preview and an apply bound to its decision, and answers the thread", async () => {
    const spawned = await rpc("spawn", { soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix the flaky CI job.", key: "spawn-1f0c9a7e" });
    expect(spawned).toEqual({ instance: "flaky-ci-2-developer", threadId: "thr_ci2" });
    const calls = await fake.calls();
    expect(calls.map((call) => call.verb).filter((verb) => verb !== "status")).toEqual(["souls", "spawn --preview", "spawn"]);
    const apply = calls.find((call) => call.verb === "spawn")!;
    expect(apply.argv).toContain("--backend");
    expect(apply.argv[apply.argv.indexOf("--idempotency-key") + 1]).toBe("spawn-1f0c9a7e");
    expect(apply.argv[apply.argv.indexOf("--expect-decision") + 1]).toMatch(/^[0-9a-f]{24}$/);
  });

  it("replays a spawn asked again with the same key, with no second preview, and refuses the key for another spawn", async () => {
    const input = { soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix the flaky CI job.", key: "spawn-1f0c9a7e" };
    await rpc("spawn", input);
    await rpc("spawn", input);
    const calls = (await fake.calls()).filter((call) => call.verb.startsWith("spawn"));
    expect(calls.map((call) => call.verb)).toEqual(["spawn --preview", "spawn", "spawn"]);
    expect(calls[2]!.argv.slice(8)).toEqual(calls[1]!.argv.slice(8));
    expect(await refusalOf(rpc("spawn", { ...input, name: "another-developer" }))).toMatchObject({ code: "invalid" });
  });

  it("reads the decision again after the kernel refused a stale one, under the same key", async () => {
    const input = { soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix the flaky CI job.", key: "spawn-1f0c9a7e" };
    await fake.behave({ spawn: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_DECISION_STALE", message: "the decision moved", details: {} } }) } });
    expect(await refusalOf(rpc("spawn", input))).toEqual({ code: "conflict", message: "E_DECISION_STALE: the decision moved" });
    // The decision the kernel would confirm now is another one.
    const preview = JSON.parse(await readFile(join(FIXTURES, "spawn-preview.json"), "utf8"));
    preview.result.decision.revision = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await fake.behave({ "spawn --preview": { stdout: JSON.stringify(preview) } });
    expect(await rpc("spawn", input)).toEqual({ instance: "flaky-ci-2-developer", threadId: "thr_ci2" });
    const calls = (await fake.calls()).filter((call) => call.verb.startsWith("spawn"));
    expect(calls.map((call) => call.verb)).toEqual(["spawn --preview", "spawn", "spawn --preview", "spawn"]);
    expect(calls[3]!.argv[calls[3]!.argv.indexOf("--expect-decision") + 1]).toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls[1]!.argv[calls[1]!.argv.indexOf("--expect-decision") + 1]).not.toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("keeps the decision for a retry when the spawn failed another way", async () => {
    const input = { soul: "oats-developer", name: "flaky-ci-2-developer", task: "Fix the flaky CI job.", key: "spawn-1f0c9a7e" };
    await fake.behave({ spawn: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_SPAWN_INCOMPLETE", message: "launched, not confirmed" } }) } });
    expect(await refusalOf(rpc("spawn", input))).toMatchObject({ code: "conflict" });
    await fake.behave({});
    await rpc("spawn", input);
    expect((await fake.calls()).filter((call) => call.verb.startsWith("spawn")).map((call) => call.verb)).toEqual(["spawn --preview", "spawn", "spawn"]);
  });

  it("refuses a soul that is not listed and a name that is no instance name, with no spawn process", async () => {
    expect(await refusalOf(rpc("spawn", { soul: "no-such-soul", name: "x-developer", task: "t", key: "spawn-1f0c9a7e" }))).toMatchObject({ code: "invalid" });
    expect(await refusalOf(rpc("spawnPreview", { soul: "no-such-soul", name: "x-developer", task: "t" }))).toMatchObject({ code: "invalid" });
    for (const name of ["two words", "a/b", "Upper", "-leading"]) {
      await expect(rpc("spawn", { soul: "oats-developer", name, task: "t", key: "spawn-1f0c9a7e" })).rejects.toThrow();
    }
    await expect(rpc("spawn", { soul: "oats-developer", name: "x-developer", task: "t", key: "spawn-1f0c9a7e", flag: "--yolo" })).rejects.toThrow();
    expect((await verbs()).filter((verb) => verb.startsWith("spawn"))).toEqual([]);
  });

  it("shows a kernel refusal of a spawn with its code and message", async () => {
    await fake.behave({ "spawn --preview": { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "--backend must be tmux" } }) } });
    expect(await refusalOf(rpc("spawn", { soul: "oats-developer", name: "x-developer", task: "t", key: "spawn-1f0c9a7e" }))).toEqual({ code: "conflict", message: "E_BAD_ARGS: --backend must be tmux" });
    expect(await refusalOf(rpc("spawnPreview", { soul: "oats-developer", name: "x-developer", task: "t" }))).toEqual({ code: "conflict", message: "E_BAD_ARGS: --backend must be tmux" });
  });

  it("stops with the plan's revision, and shows the kernel's refusal of a stale one unchanged", async () => {
    const plan = await rpc("stopPlan", { instance: "redesign-ui-lead" });
    expect(plan.revision).toBe("9c1f2e3d4b5a69788796a5b4");
    expect(plan.lines[0]).toMatch(/^Stop redesign-ui-lead/);
    expect(await rpc("stopApply", { instance: "redesign-ui-lead", revision: plan.revision, key: "stop-7f3a9c2e41b8" })).toEqual({ ok: true });
    await fake.behave({ "instance stop --apply": { file: "stop-apply-stale.json" } });
    expect(await refusalOf(rpc("stopApply", { instance: "redesign-ui-lead", revision: plan.revision, key: "stop-0000aaaa1111" }))).toEqual({
      code: "conflict",
      message: "E_PLAN_STALE: the stop plan for redesign-ui-lead changed since revision 9c1f2e3d4b5a69788796a5b4 was read; read the plan again and confirm it",
    });
  });

  it("acts only on an instance of the current snapshot, and takes the home from it", async () => {
    for (const method of ["stopPlan", "start", "restart", "retirePlan"]) {
      expect(await refusalOf(rpc(method, { instance: "not-in-the-snapshot" })), method).toMatchObject({ code: "invalid" });
    }
    expect(await refusalOf(rpc("stopApply", { instance: "not-in-the-snapshot", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" }))).toMatchObject({ code: "invalid" });
    expect(await refusalOf(rpc("retireApply", { instance: "not-in-the-snapshot", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" }))).toMatchObject({ code: "invalid" });
    await expect(rpc("start", { instance: "weekly-digest-helper", home: "/somewhere/else" })).rejects.toThrow();
    expect(await verbs()).toEqual(["status"]);

    expect(await rpc("start", { instance: "weekly-digest-helper" })).toEqual({ threadId: "thr_digest2" });
    expect(await rpc("restart", { instance: "weekly-digest-helper" })).toEqual({ threadId: "thr_digest2" });
    const sessions = (await fake.calls()).filter((call) => call.verb.startsWith("session"));
    expect(sessions.map((call) => call.argv)).toEqual([
      ["session", "start", "--home", "/abs/deployment/agents/oats-expert/instances/weekly-digest-helper", "--json"],
      ["session", "restart", "--home", "/abs/deployment/agents/oats-expert/instances/weekly-digest-helper", "--json"],
    ]);
  });

  it("takes the thread from the next snapshot when a start's answer names none", async () => {
    await rpc("snapshot");
    await fake.behave({ "session start": { stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "weekly-digest-helper", backend: "bb", warnings: [] } }) } });
    expect(await rpc("start", { instance: "weekly-digest-helper" })).toEqual({ threadId: "thr_digest" });
  }, 20_000);

  it("refuses with a code of its own, never a kernel code, when no thread is named anywhere", async () => {
    const roster = JSON.parse(await readFile(join(FIXTURES, "status.json"), "utf8"));
    for (const group of roster.agents) for (const instance of group.instances) if (instance.instance === "weekly-digest-helper") delete instance.session;
    await fake.behave({
      status: { stdout: JSON.stringify(roster) },
      "session start": { stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "weekly-digest-helper", backend: "bb", warnings: [] } }) },
    });
    expect(await refusalOf(rpc("start", { instance: "weekly-digest-helper" }))).toEqual({
      code: "conflict",
      message: "NO_THREAD_NAMED: Started weekly-digest-helper, but the kernel named no bb thread for it",
    });
  }, 20_000);

  it("retires through the plan and its guarded apply", async () => {
    const plan = await rpc("retirePlan", { instance: "weekly-digest-helper" });
    expect(plan.revision).toBe("4e5f6a7b8c9d0e1f2a3b4c5d");
    expect(plan.lines[0]).toMatch(/^Removed: the home of weekly-digest-helper/);
    expect(await rpc("retireApply", { instance: "weekly-digest-helper", revision: plan.revision, key: "retire-2b9d4e6f8a1c" })).toEqual({ ok: true });
    const retire = (await fake.calls()).find((call) => call.verb === "retire")!;
    expect(retire.argv).toEqual(["retire", "weekly-digest-helper", "--plan-revision", "4e5f6a7b8c9d0e1f2a3b4c5d", "--idempotency-key", "retire-2b9d4e6f8a1c", "--json"]);
  });

  it("rereads the snapshot after an act", async () => {
    await rpc("snapshot");
    await rpc("stopApply", { instance: "redesign-ui-lead", revision: "9c1f2e3d4b5a69788796a5b4", key: "stop-7f3a9c2e41b8" });
    await expect.poll(async () => (await verbs()).filter((verb) => verb === "status").length, { timeout: MIN_INTERVAL_MS + 4_000 }).toBe(2);
  }, 20_000);
});

describe("the host-call limits", () => {
  it("leave the kernel's own limit reachable before bb retries a retryable call at half the transport timeout", () => {
    expect(HOST_TIMEOUT.read / 2).toBeGreaterThan(timeouts.read);
    expect(HOST_TIMEOUT.preview / 2).toBeGreaterThan(timeouts.preview);
    // Not retryable: the kernel's limit only has to come first.
    expect(HOST_TIMEOUT.act).toBeGreaterThan(timeouts.act);
    expect(HOST_TIMEOUT.long).toBeGreaterThan(timeouts.long);
    expect(HOST_TIMEOUT.long).toBeLessThanOrEqual(30 * 60_000); // bb's cap for a host call
    // Which verbs bb retries, and so which limit each needs.
    const retryable = Object.entries(hostContract).filter(([, method]) => "experimental_retryable" in method && method.experimental_retryable).map(([name]) => name);
    expect(retryable.sort()).toEqual(["capabilities", "discover", "servers", "souls", "spawnPreview", "status", "stopPlan", "teams"]);
  });
});

describe("the slow poll", () => {
  it("runs only while a client watches the snapshot", async () => {
    const service = server.harness.runService("snapshot");
    await expect.poll(async () => (await verbs()).length).toBe(1); // the read at the service's start
    const unwatch = server.harness.experimental_watchRpc("snapshot", { input: null });
    await expect.poll(async () => (await verbs()).length, { timeout: 20_000, interval: 250 }).toBe(2);
    unwatch();
    service.controller.abort();
    await service.done;
  }, 30_000);
});
