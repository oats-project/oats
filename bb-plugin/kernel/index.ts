// One function per `oats` command: it builds the argv, runs it (kernel/run.ts) and reads the answer
// with a schema into the plugin's types. No bb and no React import, so plain unit tests cover it.
import type { Capability, Machine, Soul, SpawnSummary, Team } from "../model/types.js";
import { answerOf } from "./envelope.js";
import * as lifecycle from "./lifecycle.js";
import * as pages from "./pages.js";
import type { Result } from "./result.js";
import { Processes } from "./run.js";
import * as spawn from "./spawn.js";
import { parseStatus, statusArgv, type Status } from "./status.js";
import { withTaskFile } from "./task-file.js";

/** How long each verb may run before it is stopped. */
export type Timeouts = { read: number; preview: number; act: number; long: number };
export const timeouts: Timeouts = {
  /** The spec's limit for `oats status`; the other reads share it. */
  read: 20_000,
  /** The kernel gives a preview's own checks 20 s. */
  preview: 45_000,
  /** A stop waits for the harness to exit; a start launches one. */
  act: 120_000,
  /** A spawn or a retire runs the capabilities' hooks; the host RPC cap is 30 minutes. */
  long: 25 * 60_000,
};

export type OatsOptions = {
  /** The binary: an absolute path, or `oats` to be found on PATH. */
  bin: string;
  /** The deployment directory: every `oats` runs with it as its cwd. */
  cwd: string;
  processes: Processes;
  env?: NodeJS.ProcessEnv;
  /** Overrides the limits above; tests use it. */
  timeouts?: Partial<Timeouts>;
};

export class Oats {
  readonly #options: OatsOptions;
  readonly #timeouts: Timeouts;

  constructor(options: OatsOptions) {
    this.#options = options;
    this.#timeouts = { ...timeouts, ...options.timeouts };
  }

  async #run<Value>(
    argv: Result<string[]> | string[],
    parse: (document: unknown) => Result<Value>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<Value>> {
    const checked: Result<string[]> = Array.isArray(argv) ? { ok: true, value: argv } : argv;
    if (!checked.ok) return checked; // refused before any process starts
    const { bin, cwd, processes, env } = this.#options;
    const outcome = await processes.run({ bin, argv: checked.value, cwd, timeoutMs, signal, env });
    const document = answerOf(outcome, bin);
    return document.ok ? parse(document.value) : document;
  }

  status(signal?: AbortSignal): Promise<Result<Status>> {
    return this.#run(statusArgv(), parseStatus, this.#timeouts.read, signal);
  }
  souls(signal?: AbortSignal): Promise<Result<{ souls: Soul[] }>> {
    return this.#run(pages.soulsArgv(), pages.parseSouls, this.#timeouts.read, signal);
  }
  capabilities(signal?: AbortSignal): Promise<Result<{ capabilities: Omit<Capability, "souls">[] }>> {
    return this.#run(pages.capabilitiesArgv(), pages.parseCapabilities, this.#timeouts.read, signal);
  }
  teams(signal?: AbortSignal): Promise<Result<{ teams: Team[] }>> {
    return this.#run(pages.teamsArgv(), pages.parseTeams, this.#timeouts.read, signal);
  }
  servers(signal?: AbortSignal): Promise<Result<{ machines: Machine[] }>> {
    return this.#run(pages.serversArgv(), pages.parseServers, this.#timeouts.read, signal);
  }

  /**
   * `knownSouls` is what `oats souls` lists; `tempDir` holds the task file for the length of the
   * call. A soul not in the list or a name that is no instance name starts no process and writes
   * no file.
   */
  async spawnPreview(
    input: spawn.SpawnInput & { task: string },
    context: { knownSouls: readonly string[]; tempDir: string },
    signal?: AbortSignal,
  ): Promise<Result<{ summary: SpawnSummary; revision: string }>> {
    const checked = spawn.checkSpawn(input, context.knownSouls);
    if (!checked.ok) return checked;
    return withTaskFile(context.tempDir, input.task, (taskFile) =>
      this.#run(spawn.spawnPreviewArgv(checked.value, taskFile), spawn.parseSpawnPreview, this.#timeouts.preview, signal),
    );
  }

  /**
   * Reads the decision (unless `revision` is the one an earlier call with this key applied), then
   * applies exactly that decision with the idempotency key.
   */
  async spawn(
    input: spawn.SpawnInput & { task: string; key: string; revision: string | null },
    context: { knownSouls: readonly string[]; tempDir: string },
    signal?: AbortSignal,
  ): Promise<Result<{ instance: string; threadId: string | null; revision: string }>> {
    const checked = spawn.checkSpawn(input, context.knownSouls);
    if (!checked.ok) return checked;
    // The key is checked before the preview runs: a bad one must start no process either.
    const probe = spawn.spawnArgv(checked.value, "task", { revision: input.revision ?? "0", key: input.key });
    if (!probe.ok) return probe;
    return withTaskFile(context.tempDir, input.task, async (taskFile) => {
      let revision = input.revision;
      if (revision === null) {
        const preview = await this.#run(spawn.spawnPreviewArgv(checked.value, taskFile), spawn.parseSpawnPreview, this.#timeouts.preview, signal);
        if (!preview.ok) return preview;
        revision = preview.value.revision;
      }
      const applied = await this.#run(spawn.spawnArgv(checked.value, taskFile, { revision, key: input.key }), spawn.parseSpawn, this.#timeouts.long, signal);
      return applied.ok ? { ok: true, value: { ...applied.value, revision } } : applied;
    });
  }

  stopPlan(instance: string, signal?: AbortSignal): Promise<Result<lifecycle.Plan>> {
    return this.#run(lifecycle.stopPlanArgv(instance), lifecycle.parseStopPlan, this.#timeouts.read, signal);
  }
  stopApply(apply: { instance: string; revision: string; key: string }, signal?: AbortSignal): Promise<Result<Record<string, never>>> {
    return this.#run(lifecycle.stopApplyArgv(apply), lifecycle.parseStopApply, this.#timeouts.act, signal);
  }
  start(home: string, signal?: AbortSignal): Promise<Result<{ threadId: string | null }>> {
    return this.#run(lifecycle.startArgv(home), (document) => lifecycle.parseSessionStart(document, "start"), this.#timeouts.act, signal);
  }
  restart(home: string, signal?: AbortSignal): Promise<Result<{ threadId: string | null }>> {
    return this.#run(lifecycle.restartArgv(home), (document) => lifecycle.parseSessionStart(document, "restart"), this.#timeouts.act, signal);
  }
  retirePlan(instance: string, signal?: AbortSignal): Promise<Result<lifecycle.Plan>> {
    return this.#run(lifecycle.retirePlanArgv(instance), lifecycle.parseRetirePlan, this.#timeouts.read, signal);
  }
  retireApply(apply: { instance: string; revision: string; key: string }, signal?: AbortSignal): Promise<Result<Record<string, never>>> {
    return this.#run(lifecycle.retireApplyArgv(apply), lifecycle.parseRetireApply, this.#timeouts.long, signal);
  }
}

export { Processes } from "./run.js";
export { codes, isKernelCode, type KernelError, type Result } from "./result.js";
