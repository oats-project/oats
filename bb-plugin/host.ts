// bb.host entry: runs in bb's host daemon, on the machine that holds the OATS homes. It runs `oats`
// and watches the deployment's event log for changes; nothing else. Only this entry sees the
// user's login-shell PATH and can target that machine (evidence B1).
//
// bb reaps no child of a plugin on reload or stop (B1): every `oats` runs in its own process group
// with the call's signal, and every group still running is killed when the worker's lifecycle
// signal aborts and in `dispose`.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.js";
import { codes, Oats, Processes, type Result } from "./kernel/index.js";

/** The file that marks a deployment directory. */
const DEPLOYMENT_MARKER = "oats-local.yaml";
/**
 * The deployment's event log. Checked on a real deployment (OATS 0.69.20): a spawn, a launch, a
 * stop, a retire and every waiting claim, set or cleared, append one line to a file of this flat
 * directory. It does not change when a harness exits by itself; the server's slow poll carries that.
 */
const EVENTS = [".agents", "events"] as const;
/** How long the list of souls a spawn is checked against is reused. */
const SOULS_TTL_MS = 30_000;

type Base = { deployment: string; oatsBin: string };

export function createHostEntry() {
  const processes = new Processes();
  const souls = new Map<string, { at: number; names: string[] }>();
  let lifecycleBound = false;
  let watching: { path: string; subscription: ExperimentalHostWatchSubscription } | null = null;
  let watchQueue: Promise<unknown> = Promise.resolve();

  /** Kills every `oats` when the worker goes away (idle eviction, reload, disable, daemon stop). */
  const bind = (context: { lifecycle: { signal: AbortSignal } }) => {
    if (lifecycleBound) return;
    lifecycleBound = true;
    context.lifecycle.signal.addEventListener("abort", () => void processes.killAll(), { once: true });
  };

  const refuse = (message: string): Result<never> => ({ ok: false, error: { code: codes.invalidInput, message } });

  /** The kernel for this call: the deployment is its cwd, and the binary is `oats` or an absolute path. */
  const kernel = (base: Base): Result<Oats> => {
    if (!isAbsolute(base.deployment)) return refuse("the deployment must be an absolute directory");
    if (base.oatsBin !== "" && !isAbsolute(base.oatsBin)) return refuse("the oatsBin setting must be an absolute path to `oats`, or empty");
    return { ok: true, value: new Oats({ bin: base.oatsBin === "" ? "oats" : base.oatsBin, cwd: base.deployment, processes }) };
  };

  /** The names `oats souls` lists: a spawn is checked against them before its process starts. */
  const knownSouls = async (base: Base, oats: Oats, signal: AbortSignal): Promise<Result<string[]>> => {
    const cacheKey = `${base.deployment}\0${base.oatsBin}`;
    const cached = souls.get(cacheKey);
    if (cached && Date.now() - cached.at < SOULS_TTL_MS) return { ok: true, value: cached.names };
    const listed = await oats.souls(signal);
    if (!listed.ok) return listed;
    return { ok: true, value: remember(base, listed.value.souls) };
  };
  const remember = (base: Base, listed: readonly { name: string }[]): string[] => {
    const names = listed.map((soul) => soul.name);
    souls.set(`${base.deployment}\0${base.oatsBin}`, { at: Date.now(), names });
    return names;
  };

  /** One verb: binds the worker's lifecycle, and runs `use` with the kernel of this call, or refuses its base. */
  const run = async <Value>(
    base: Base,
    context: { lifecycle: { signal: AbortSignal } },
    use: (oats: Oats) => Promise<Result<Value>>,
  ): Promise<Result<Value>> => {
    bind(context);
    const oats = kernel(base);
    return oats.ok ? use(oats.value) : oats;
  };

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      discover: ({ deployment, roots }, context) => {
        bind(context);
        const machine = hostname();
        if (deployment !== "") {
          const found = isAbsolute(deployment) && existsSync(join(deployment, DEPLOYMENT_MARKER));
          return { deployment: found ? resolve(deployment) : null, machine };
        }
        for (const root of roots) {
          if (!isAbsolute(root)) continue;
          for (let directory = resolve(root); ; directory = dirname(directory)) {
            if (existsSync(join(directory, DEPLOYMENT_MARKER))) return { deployment: directory, machine };
            if (dirname(directory) === directory) break;
          }
        }
        return { deployment: null, machine };
      },

      status: (base, context) => run(base, context, (oats) => oats.status(context.signal)),
      souls: (base, context) =>
        run(base, context, async (oats) => {
          const listed = await oats.souls(context.signal);
          // The list the Souls page shows is the list a spawn from it is checked against.
          if (listed.ok) remember(base, listed.value.souls);
          return listed;
        }),
      capabilities: (base, context) => run(base, context, (oats) => oats.capabilities(context.signal)),
      teams: (base, context) => run(base, context, (oats) => oats.teams(context.signal)),
      servers: (base, context) => run(base, context, (oats) => oats.servers(context.signal)),

      spawnPreview: ({ soul, name, task, ...base }, context) =>
        run(base, context, async (oats) => {
          const known = await knownSouls(base, oats, context.signal);
          if (!known.ok) return known;
          return oats.spawnPreview({ soul, name, task }, { knownSouls: known.value, tempDir: context.experimental_paths.tempDir }, context.signal);
        }),
      spawn: ({ soul, name, task, key, revision, ...base }, context) =>
        run(base, context, async (oats) => {
          const known = await knownSouls(base, oats, context.signal);
          if (!known.ok) return known;
          return oats.spawn({ soul, name, task, key, revision }, { knownSouls: known.value, tempDir: context.experimental_paths.tempDir }, context.signal);
        }),

      stopPlan: ({ instance, ...base }, context) => run(base, context, (oats) => oats.stopPlan(instance, context.signal)),
      stopApply: ({ instance, revision, key, ...base }, context) => run(base, context, (oats) => oats.stopApply({ instance, revision, key }, context.signal)),
      start: ({ home, ...base }, context) => run(base, context, (oats) => oats.start(home, context.signal)),
      restart: ({ home, ...base }, context) => run(base, context, (oats) => oats.restart(home, context.signal)),
      retirePlan: ({ instance, ...base }, context) => run(base, context, (oats) => oats.retirePlan(instance, context.signal)),
      retireApply: ({ instance, revision, key, ...base }, context) => run(base, context, (oats) => oats.retireApply({ instance, revision, key }, context.signal)),

      watch: ({ deployment }, context) => {
        bind(context);
        // One at a time: two calls must not leave two subscriptions.
        const next = watchQueue.then(async () => {
          const path = isAbsolute(deployment) ? join(resolve(deployment), ...EVENTS) : null;
          if (watching && watching.path === path) return { watching: path };
          if (watching) {
            await watching.subscription.dispose();
            watching = null;
          }
          // No event log yet (a deployment nothing was spawned in): the server asks again later.
          if (path === null || !existsSync(path)) return { watching: null };
          const subscription = await context.experimental_watch({ rootPath: path, debounceMs: 250, maxWaitMs: 2_000 }, async (event) => {
            if (event.kind === "watch-error") {
              // The daemon's watcher gave up on this directory: forget it, so the next call watches again.
              if (watching?.path === path) watching = null;
              await subscription.dispose();
            }
            await context.experimental_emitSignal("changed", { reason: event.kind });
          });
          watching = { path, subscription };
          return { watching: path };
        });
        watchQueue = next.catch(() => undefined);
        return next;
      },
    },
    dispose: () => processes.killAll(),
  });
}

export default createHostEntry();
