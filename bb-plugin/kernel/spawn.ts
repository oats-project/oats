// `oats spawn <soul> --backend bb …`: the preview, and the apply bound to the previewed decision.
// docs/desktop-cli-api.md "Spawn": the kernel takes `--idempotency-key` only with
// `--expect-decision <revision>`, and the revision is the preview's `decision.revision`.
import { z } from "zod";
import type { SpawnSummary } from "../model/types.js";
import { shaped } from "./envelope.js";
import { checkInstance, checkKey, checkRevision, checkSoul } from "./input.js";
import { ok, type Result } from "./result.js";

export type SpawnInput = { soul: string; name: string };

/** Refuses a soul `oats souls` does not list and a name that is not an instance name. */
export function checkSpawn(input: SpawnInput, knownSouls: readonly string[]): Result<SpawnInput> {
  const name = checkInstance(input.name);
  if (!name.ok) return name;
  const soul = checkSoul(input.soul, knownSouls);
  if (!soul.ok) return soul;
  return ok({ soul: soul.value, name: name.value });
}

const common = (input: SpawnInput, taskFile: string): string[] => [
  "spawn",
  input.soul,
  "--backend",
  "bb",
  "--name",
  input.name,
  "--task-file",
  taskFile,
];

export const spawnPreviewArgv = (input: SpawnInput, taskFile: string): string[] => [...common(input, taskFile), "--preview", "--json"];

export function spawnArgv(input: SpawnInput, taskFile: string, apply: { revision: string; key: string }): Result<string[]> {
  const revision = checkRevision(apply.revision);
  if (!revision.ok) return revision;
  const key = checkKey(apply.key);
  if (!key.ok) return key;
  return ok([...common(input, taskFile), "--expect-decision", revision.value, "--idempotency-key", key.value, "--json"]);
}

const text = z.string().nullish();
const preview = z.looseObject({
  decision: z.looseObject({ revision: z.string().min(1) }),
  modules: z
    .array(z.looseObject({ name: z.string(), from: z.looseObject({ kind: text, version: text }).nullish() }))
    .nullish(),
  teams: z.array(z.looseObject({ label: z.string(), team: text, default: z.boolean().nullish() })).nullish(),
  harness: text,
  model: text,
  modelSource: text,
  launchConfig: text,
  warnings: z.array(z.string()).nullish(),
  preflight: z.looseObject({ status: text, budgetMs: z.number().nullish() }).nullish(),
  backendStatus: z.looseObject({ name: text, installed: z.boolean().nullish() }).nullish(),
  launch: z.looseObject({ problem: z.looseObject({ code: text, message: text }).nullish() }).nullish(),
});

export function parseSpawnPreview(document: unknown): Result<{ summary: SpawnSummary; revision: string }> {
  const parsed = shaped(preview, document, "oats spawn --preview");
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const problems: string[] = [];
  if (value.backendStatus && value.backendStatus.installed === false) {
    problems.push(`the ${value.backendStatus.name ?? "session"} backend is not installed on this machine`);
  }
  if (value.preflight?.status === "timeout") {
    problems.push(`the kernel's checks did not finish within ${Math.round((value.preflight.budgetMs ?? 0) / 1000)} s`);
  }
  if (value.launch?.problem) {
    problems.push([value.launch.problem.code, value.launch.problem.message].filter(Boolean).join(": "));
  }
  const model = value.model ?? "the harness's default model";
  const launch = value.harness
    ? [
        value.harness,
        value.modelSource ? `${model} (${value.modelSource})` : model,
        value.launchConfig ? `launch configuration ${value.launchConfig}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")
    : null;
  return ok({
    revision: value.decision.revision,
    summary: {
      modules: (value.modules ?? []).map((module) => (module.from?.version ? `${module.name} ${module.from.version}` : module.name)),
      teams: (value.teams ?? []).map((team) =>
        [team.label, team.default ? "(default)" : null, team.team ? null : "(not mapped)"].filter((part) => part !== null).join(" "),
      ),
      launch,
      warnings: value.warnings ?? [],
      problems,
    },
  });
}

const spawned = z.looseObject({
  instance: z.string().min(1),
  session: z.looseObject({ endpoint: z.looseObject({ threadId: text }).nullish() }).nullish(),
});

/** The spawned instance and, when the kernel named it, the bb thread it runs in. */
export function parseSpawn(document: unknown): Result<{ instance: string; threadId: string | null }> {
  const parsed = shaped(spawned, document, "oats spawn");
  if (!parsed.ok) return parsed;
  return ok({ instance: parsed.value.instance, threadId: parsed.value.session?.endpoint?.threadId ?? null });
}
