// bb.server entry: the settings, the RPC contract, one cached snapshot for all clients and the
// realtime invalidation. It runs no process: every `oats` runs in the host entry (host.ts), on the
// machine that holds the homes, and the server never sends an argv.
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals, REALTIME_CHANGED, rpcContract, type snapshot as snapshotSchema } from "./contract.js";
import { withSoulCounts } from "./kernel/pages.js";
import { codes, type KernelError } from "./kernel/result.js";
import type { Agent, Capability, Machine, Soul, Team } from "./model/types.js";

export { rpcContract } from "./contract.js";

/** The slow poll, while at least one client is connected. */
export const POLL_MS = 15_000;
/** Never more than one `oats status` in this many milliseconds. */
export const MIN_INTERVAL_MS = 5_000;
/** How long the answers behind the four pages are reused. */
const PAGE_TTL_MS = 30_000;
/** A client that asked for the snapshot this recently counts as connected, beside the watched reads. */
const CLIENT_SEEN_MS = 45_000;
/**
 * Host-call limits. The kernel's own limit (kernel/index.ts) must answer first, so that a slow
 * `oats` is the typed OATS_TIMEOUT and not a lost call. For a verb the host contract marks
 * `experimental_retryable`, bb cancels the call and sends it once more at HALF this limit: so `read`
 * and `preview` are more than twice the kernel's 20 s and 45 s. The acts are not retryable.
 */
export const HOST_TIMEOUT = { read: 45_000, preview: 100_000, act: 125_000, long: 26 * 60_000 } as const;

type Snapshot = z.infer<typeof snapshotSchema>;
type Target = { hostId: string; deployment: string; machine: string };
type Failure = { ok: false; code: string; message: string };
type Answer<Value> = { ok: true; value: Value } | { ok: false; error: KernelError };

const hostRow = z.looseObject({ id: z.string(), name: z.string().nullish() });
const projectRow = z.looseObject({
  sources: z.array(z.looseObject({ hostId: z.string().nullish(), path: z.string().nullish() })).nullish(),
});

const lastSegment = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The kernel's (or the plugin's) code behind each refusal built here, for the handlers that act on one. */
const refusedWith = new WeakMap<object, string>();

/** A kernel refusal or a failed `oats`, as the RPC refusal the app shows: the code, then the message, unchanged. */
function refusal(error: KernelError): experimental_PluginRpcRefusal {
  const refused = new experimental_PluginRpcRefusal({
    code: error.code === codes.invalidInput ? "invalid" : "conflict",
    message: error.code === codes.invalidInput ? error.message : `${error.code}: ${error.message}`,
  });
  refusedWith.set(refused, error.code);
  return refused;
}
const invalid = (message: string) => new experimental_PluginRpcRefusal({ code: "invalid", message });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    deployment: {
      type: "string",
      label: "OATS deployment directory",
      description: "The directory that holds oats-local.yaml. Empty: found from the bb projects on the machine.",
      default: "",
    },
    oatsBin: {
      type: "string",
      label: "Path to oats",
      description: "An absolute path to the oats command. Empty: oats on the machine's PATH.",
      default: "",
    },
    host: {
      type: "string",
      label: "Machine",
      description: "The bb machine (its name or id) that holds the OATS homes. Empty: this server's only machine.",
      default: "",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const lifetime = new AbortController();

  let target: Target | null = null;
  /** Counts the settings changes, so that a discovery that read the old settings is not kept. */
  let settingsGeneration = 0;
  let watchAsserted = false;
  let cached: Snapshot | null = null;
  let comparable = "";
  let lastStart = 0;
  let running: Promise<Snapshot> | null = null;
  let queued: Promise<Snapshot> | null = null;
  let watchers = 0;
  let clientSeenAt = 0;
  const pages = new Map<string, { at: number; value: Promise<unknown> }>();
  /** key -> the decision a spawn with that key applies, so that a retry replays it. */
  const spawns = new Map<string, { soul: string; name: string; revision: string }>();

  // ---- where `oats` runs ----

  const fail = (code: string, message: string): Failure => ({ ok: false, code, message });

  async function findTarget(signal: AbortSignal): Promise<Target | Failure> {
    const values = await settings.get();
    const hosts = z.array(hostRow).parse(await bb.sdk.hosts.list({ signal }));
    const names = hosts.map((row) => row.name ?? row.id).join(", ");
    let chosen: z.infer<typeof hostRow> | undefined;
    if (values.host !== "") {
      chosen = hosts.find((row) => row.id === values.host) ?? hosts.find((row) => row.name === values.host);
      if (!chosen) {
        return fail(codes.hostNotFound, `The machine "${values.host}" in the OATS plugin's settings is not one of this bb server's machines (${names || "none"}).`);
      }
    } else if (hosts.length === 1) {
      chosen = hosts[0];
    } else if (hosts.length === 0) {
      return fail(codes.noHost, "No machine is connected to this bb server, so the OATS plugin has nowhere to run oats.");
    } else {
      return fail(codes.chooseHost, `This bb server has ${hosts.length} machines (${names}). Choose the one that holds the OATS homes: set "Machine" in the OATS plugin's settings.`);
    }
    if (!chosen) return fail(codes.noHost, "No machine is connected to this bb server, so the OATS plugin has nowhere to run oats.");
    const hostId = chosen.id;
    const roots: string[] = [];
    if (values.deployment === "") {
      for (const project of z.array(projectRow).parse(await bb.sdk.projects.list({ signal }))) {
        for (const source of project.sources ?? []) {
          if (source.hostId === hostId && source.path && !roots.includes(source.path)) roots.push(source.path);
        }
      }
    }
    const found = await host.call("discover", { deployment: values.deployment, roots }, { hostId, signal, timeoutMs: HOST_TIMEOUT.read });
    if (found.deployment === null) {
      return fail(
        codes.noDeployment,
        values.deployment === ""
          ? `No OATS deployment found on ${found.machine}: no bb project there is in a directory that holds oats-local.yaml. Set the deployment directory in the OATS plugin's settings.`
          : `No OATS deployment found on ${found.machine}: ${values.deployment} holds no oats-local.yaml. Correct the deployment directory in the OATS plugin's settings.`,
      );
    }
    return { hostId, deployment: found.deployment, machine: found.machine };
  }

  async function base(signal: AbortSignal): Promise<{ target: Target; input: { deployment: string; oatsBin: string } } | Failure> {
    let at = target;
    if (at === null) {
      const generation = settingsGeneration;
      const found = await findTarget(signal);
      if ("ok" in found) return found;
      at = found;
      // Kept only if the settings it was found with are still the settings.
      if (generation === settingsGeneration) {
        target = found;
        watchAsserted = false;
      }
    }
    return { target: at, input: { deployment: at.deployment, oatsBin: (await settings.get()).oatsBin } };
  }

  /** The watch dies with the host worker: it is asserted again whenever it may be gone. */
  async function assertWatch(at: Target): Promise<void> {
    if (watchAsserted) return;
    try {
      const answer = await host.call("watch", { deployment: at.deployment }, { hostId: at.hostId, signal: lifetime.signal, timeoutMs: HOST_TIMEOUT.read });
      watchAsserted = answer.watching !== null && target === at;
    } catch (error) {
      bb.log.warn(`the watch on ${at.deployment} could not be started (the ${POLL_MS / 1000} s poll carries changes): ${String((error as Error).message)}`);
    }
  }

  // ---- the one cached snapshot ----

  async function read(): Promise<Snapshot> {
    lastStart = Date.now();
    const at = new Date(lastStart).toISOString();
    let next: Snapshot;
    try {
      const where = await base(lifetime.signal);
      if ("ok" in where) {
        next = { ...where, at };
      } else {
        const answer = await host.call("status", where.input, { hostId: where.target.hostId, signal: lifetime.signal, timeoutMs: HOST_TIMEOUT.read });
        if (answer.ok) {
          const workspace = answer.value.workspace ? lastSegment(answer.value.workspace) : lastSegment(where.target.deployment);
          next = { ok: true, at, deployment: { root: where.target.deployment, workspace, machine: where.target.machine }, agents: answer.value.agents };
          void assertWatch(where.target);
        } else {
          const message =
            answer.error.code === codes.notFound
              ? `oats was not found on ${where.target.machine}: install OATS there, or set the path to oats in the OATS plugin's settings. (${answer.error.message})`
              : answer.error.message;
          next = { ok: false, at, code: answer.error.code, message };
          // The deployment may have moved or gone: look for it again at the next read.
          target = null;
        }
      }
    } catch (error) {
      next = { ok: false, at, code: codes.hostUnreachable, message: `The machine that runs oats did not answer: ${String((error as Error).message)}` };
      target = null;
    }
    const key = JSON.stringify({ ...next, at: null });
    const changed = key !== comparable;
    cached = next;
    comparable = key;
    if (changed && !lifetime.signal.aborted) bb.realtime.publish(REALTIME_CHANGED, { at });
    return next;
  }

  /**
   * The next read that starts from now on: after the one in flight, and never sooner than
   * MIN_INTERVAL_MS after the last one started. Callers asking meanwhile share it.
   */
  function reread(): Promise<Snapshot> {
    if (queued) return queued;
    const next = (async () => {
      if (running) await running;
      await sleep(Math.max(0, lastStart + MIN_INTERVAL_MS - Date.now()), lifetime.signal);
      queued = null;
      const mine = read();
      running = mine;
      try {
        return await mine;
      } finally {
        if (running === mine) running = null;
      }
    })();
    queued = next;
    return next;
  }
  const rereadSoon = () => {
    if (!lifetime.signal.aborted) void reread();
  };

  /** The cached snapshot; before the first one, the read in flight, or one started now. */
  async function current(): Promise<Snapshot> {
    return cached ?? (await (running ?? reread()));
  }

  /** The agent the kernel's snapshot names; an instance it does not name is refused. */
  async function agentOf(instance: string): Promise<Agent> {
    const now = await current();
    if (!now.ok) throw refusal({ code: now.code, message: now.message });
    const found = now.agents.find((agent) => agent.instance === instance);
    if (!found) throw invalid(`"${instance}" is not an agent of this OATS deployment's current snapshot`);
    return found;
  }

  // ---- calls to the host entry ----

  type Verb = Exclude<keyof typeof hostContract, "discover" | "watch">;
  type Extra<Method extends Verb> = Omit<z.input<(typeof hostContract)[Method]["input"]>, "deployment" | "oatsBin">;
  type Value<Method extends Verb> = Extract<z.output<(typeof hostContract)[Method]["output"]>, { ok: true }>["value"];

  /** Runs one verb on the machine; a kernel refusal, a failed `oats` and an unreachable machine are RPC refusals. */
  async function call<Method extends Verb>(method: Method, extra: Extra<Method>, timeoutMs: number, signal: AbortSignal): Promise<Value<Method>> {
    let where: Awaited<ReturnType<typeof base>>;
    let answer: Answer<unknown> | null = null;
    try {
      // Finding the machine and the deployment asks bb and the host daemon too: the same refusal.
      where = await base(signal);
      if (!("ok" in where)) {
        const input = { ...where.input, ...extra } as z.input<(typeof hostContract)[Method]["input"]>;
        answer = (await host.call(method, input, { hostId: where.target.hostId, signal, timeoutMs })) as Answer<unknown>;
      }
    } catch (error) {
      throw refusal({ code: codes.hostUnreachable, message: `The machine that runs oats did not answer: ${String((error as Error).message)}` });
    }
    if ("ok" in where) throw refusal({ code: where.code, message: where.message });
    if (answer === null) throw refusal({ code: codes.hostUnreachable, message: "The machine that runs oats did not answer." });
    if (!answer.ok) throw refusal(answer.error);
    return answer.value as Value<Method>;
  }

  /** One answer per page for all clients, reused for PAGE_TTL_MS; a failed read is not kept. */
  function page<Value>(name: string, load: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    const hit = pages.get(name);
    if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.value as Promise<Value>;
    const value = load(lifetime.signal);
    pages.set(name, { at: Date.now(), value });
    value.catch(() => {
      if (pages.get(name)?.value === value) pages.delete(name);
    });
    return value;
  }
  const souls = (): Promise<Soul[]> => page("souls", async (signal) => (await call("souls", {}, HOST_TIMEOUT.read, signal)).souls);

  /** The thread an act left the agent in: the kernel's answer, else the row of the next snapshot. */
  async function threadOf(instance: string, named: string | null, act: string): Promise<string> {
    if (named !== null) return named;
    const next = await reread();
    const row = next.ok ? next.agents.find((agent) => agent.instance === instance) : undefined;
    if (row?.threadId) return row.threadId;
    throw refusal({ code: codes.noThread, message: `${act} ${instance}, but the kernel named no bb thread for it` });
  }

  // ---- the RPC contract ----

  bb.rpc.register(rpcContract, {
    async snapshot() {
      clientSeenAt = Date.now();
      // A snapshot nobody refreshed for a while is given as it is, and read again behind it.
      if (cached && Date.now() - lastStart > POLL_MS) rereadSoon();
      return current();
    },
    async refresh() {
      clientSeenAt = Date.now();
      pages.clear();
      return { at: (await reread()).at };
    },
    async souls() {
      return { souls: await souls() };
    },
    async capabilities() {
      const capabilities = await page<Capability[]>("capabilities", async (signal) =>
        withSoulCounts((await call("capabilities", {}, HOST_TIMEOUT.read, signal)).capabilities, await souls()),
      );
      return { capabilities };
    },
    async teams() {
      const teams = await page<Team[]>("teams", async (signal) => (await call("teams", {}, HOST_TIMEOUT.read, signal)).teams);
      return { teams };
    },
    async machines() {
      const machines = await page<Machine[]>("machines", async (signal) => {
        const registered = (await call("servers", {}, HOST_TIMEOUT.read, signal)).machines;
        const here: Machine[] = target ? [{ id: target.machine, route: null, isThisMachine: true, note: target.deployment }] : [];
        return [...here, ...registered];
      });
      return { machines };
    },

    async spawnPreview({ soul, name, task }, context) {
      if (!(await souls()).some((row) => row.name === soul)) throw invalid(`"${soul}" is not a soul \`oats souls\` lists for this deployment`);
      const { summary } = await call("spawnPreview", { soul, name, task }, HOST_TIMEOUT.preview, context.experimental_signal);
      return { summary };
    },
    async spawn({ soul, name, task, key }) {
      if (!(await souls()).some((row) => row.name === soul)) throw invalid(`"${soul}" is not a soul \`oats souls\` lists for this deployment`);
      let decision = spawns.get(key);
      if (decision && (decision.soul !== soul || decision.name !== name)) throw invalid("this key already belongs to another spawn: a new spawn needs a new key");
      if (!decision) {
        // The kernel binds an idempotency key to the decision it confirms: read that decision first.
        const preview = await call("spawnPreview", { soul, name, task }, HOST_TIMEOUT.preview, lifetime.signal);
        decision = { soul, name, revision: preview.revision };
        if (spawns.size >= 200) spawns.delete(spawns.keys().next().value as string);
        spawns.set(key, decision);
      }
      // An act is not ended by its caller going away: only by the plugin's own end.
      let spawned: Value<"spawn">;
      try {
        spawned = await call("spawn", { soul, name, task, key, revision: decision.revision }, HOST_TIMEOUT.long, lifetime.signal);
      } catch (error) {
        // The decision moved and the kernel created nothing: there is nothing to replay under this
        // key, so the next call with it reads the decision again instead of sending the stale one.
        if (error instanceof Error && refusedWith.get(error) === "E_DECISION_STALE") spawns.delete(key);
        throw error;
      } finally {
        rereadSoon();
      }
      return { instance: spawned.instance, threadId: await threadOf(spawned.instance, spawned.threadId, "Spawned") };
    },

    async stopPlan({ instance }, context) {
      await agentOf(instance);
      return call("stopPlan", { instance }, HOST_TIMEOUT.read, context.experimental_signal);
    },
    async stopApply({ instance, revision, key }) {
      await agentOf(instance);
      try {
        await call("stopApply", { instance, revision, key }, HOST_TIMEOUT.act, lifetime.signal);
      } finally {
        rereadSoon();
      }
      return { ok: true as const };
    },
    async start({ instance }) {
      const agent = await agentOf(instance);
      let started: Value<"start">;
      try {
        started = await call("start", { home: agent.home }, HOST_TIMEOUT.act, lifetime.signal);
      } finally {
        rereadSoon();
      }
      return { threadId: await threadOf(instance, started.threadId, "Started") };
    },
    async restart({ instance }) {
      const agent = await agentOf(instance);
      let started: Value<"restart">;
      try {
        started = await call("restart", { home: agent.home }, HOST_TIMEOUT.act, lifetime.signal);
      } finally {
        rereadSoon();
      }
      return { threadId: await threadOf(instance, started.threadId, "Restarted") };
    },
    async retirePlan({ instance }, context) {
      await agentOf(instance);
      return call("retirePlan", { instance }, HOST_TIMEOUT.read, context.experimental_signal);
    },
    async retireApply({ instance, revision, key }) {
      await agentOf(instance);
      try {
        await call("retireApply", { instance, revision, key }, HOST_TIMEOUT.long, lifetime.signal);
      } finally {
        rereadSoon();
      }
      return { ok: true as const };
    },
  });

  // A client that reads `snapshot` with a watched query counts as connected until it leaves.
  bb.rpc.experimental_whileWatched("snapshot", (_read, signal) => {
    watchers += 1;
    signal.addEventListener("abort", () => (watchers -= 1), { once: true });
  });

  // ---- what makes the snapshot stale ----

  const offChanged = host.experimental_onSignal("changed", ({ hostId, payload }) => {
    if (target && hostId !== target.hostId) return;
    if (payload.reason !== "changed") watchAsserted = false; // a watcher error or a rescan: assert the watch again
    rereadSoon();
  });
  const offWorkerExit = host.experimental_onWorkerExit(() => {
    watchAsserted = false;
    rereadSoon();
  });
  bb.events.on("thread.created", rereadSoon);
  bb.events.on("thread.deleted", rereadSoon);
  settings.onChange(() => {
    settingsGeneration += 1;
    target = null;
    watchAsserted = false;
    pages.clear();
    rereadSoon();
  });

  bb.background.service("snapshot", {
    async start(signal) {
      // Every start (a load, a reload, a bb restart) may have lost the host worker and its watch.
      watchAsserted = false;
      rereadSoon();
      while (!signal.aborted && !lifetime.signal.aborted) {
        await sleep(POLL_MS, AbortSignal.any([signal, lifetime.signal]));
        const connected = watchers > 0 || Date.now() - clientSeenAt < CLIENT_SEEN_MS;
        if (connected && !signal.aborted) rereadSoon();
      }
    },
  });

  bb.onDispose(() => {
    lifetime.abort();
    offChanged();
    offWorkerExit();
  });
}
