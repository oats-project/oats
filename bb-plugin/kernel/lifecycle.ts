// Stop, start, restart and retire, each through OATS so that a stopped agent stays stopped
// (docs/desktop-cli-api.md "Lifecycle: stop and retire", "Start and restart"). A plan is read into
// the lines the confirmation shows; an apply carries the plan's revision and an idempotency key.
import { z } from "zod";
import { shaped } from "./envelope.js";
import { checkHome, checkInstance, checkKey, checkRevision } from "./input.js";
import { err, ok, type Result } from "./result.js";

export type Plan = { revision: string; lines: string[] };
type Apply = { instance: string; revision: string; key: string };

const text = z.string().nullish();
const session = z.looseObject({ state: text, established: z.boolean().nullish() }).nullish();
const work = z
  .looseObject({ observed: z.boolean().nullish(), branch: text, changed: z.number().nullish(), untracked: z.number().nullish(), reason: text })
  .nullish();
const idle = (state: string | null | undefined): boolean => state === "shell" || state === "stopped" || state === "not-launched";

function sessionWords(value: z.output<typeof session>): string {
  if (!value || value.established === false) return "whether it runs is not known";
  return idle(value.state) ? "not running" : "running";
}

function workWords(value: z.output<typeof work>): string | null {
  if (!value || value.observed !== true) return null;
  const changed = value.changed ?? 0;
  const untracked = value.untracked ?? 0;
  if (changed === 0 && untracked === 0) return null;
  return `${changed} changed and ${untracked} untracked file${changed + untracked === 1 ? "" : "s"} in its work tree`;
}

function applyArgv(head: string[], apply: Apply, tail: string[]): Result<string[]> {
  const instance = checkInstance(apply.instance);
  if (!instance.ok) return instance;
  const revision = checkRevision(apply.revision);
  if (!revision.ok) return revision;
  const key = checkKey(apply.key);
  if (!key.ok) return key;
  return ok([...head, instance.value, ...tail, "--plan-revision", revision.value, "--idempotency-key", key.value, "--json"]);
}

// ---- oats instance stop ----
export function stopPlanArgv(instance: string): Result<string[]> {
  const checked = checkInstance(instance);
  return checked.ok ? ok(["instance", "stop", checked.value, "--plan", "--json"]) : checked;
}
export const stopApplyArgv = (apply: Apply): Result<string[]> => applyArgv(["instance", "stop"], apply, ["--apply"]);

const stopPlan = z.looseObject({
  planRevision: z.string().min(1),
  targets: z.array(z.looseObject({ instance: z.string(), agent: text, depth: z.number().nullish(), session, work, midTask: z.unknown() })),
  skipped: z.array(z.looseObject({ instance: z.string(), reason: text })).nullish(),
  ambiguous: z.array(z.looseObject({ instance: z.string(), reason: text })).nullish(),
  notes: z.array(z.string()).nullish(),
});

export function parseStopPlan(document: unknown): Result<Plan> {
  const parsed = shaped(stopPlan, document, "oats instance stop --plan");
  if (!parsed.ok) return parsed;
  const plan = parsed.value;
  const lines: string[] = [];
  // The kernel lists the descendants first; a person reads the agent they asked about first.
  for (const target of [...plan.targets].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
    const facts = [sessionWords(target.session), target.midTask === true ? "in the middle of a task" : null, workWords(target.work)];
    const who = (target.depth ?? 0) === 0 ? `Stop ${target.instance}` : `Stop its child ${target.instance}`;
    lines.push(`${who}${target.agent ? ` (${target.agent})` : ""}: ${facts.filter((fact) => fact !== null).join(", ")}`);
  }
  for (const row of plan.skipped ?? []) lines.push(`Not stopped: ${row.instance}${row.reason ? ` (${row.reason})` : ""}`);
  for (const row of plan.ambiguous ?? []) lines.push(`Not stopped, its parent is ambiguous: ${row.instance}${row.reason ? ` (${row.reason})` : ""}`);
  lines.push("Kept: every home, its work, its transcript and its launch settings. Start brings an agent back.");
  lines.push(...(plan.notes ?? []));
  return ok({ revision: plan.planRevision, lines });
}

const stopReceipt = z.looseObject({
  ok: z.boolean().nullish(),
  results: z.array(z.looseObject({ instance: text, ok: z.boolean().nullish(), code: text, message: text })).nullish(),
});

/** A stop that left a session running is the kernel's refusal, with its code and message. */
export function parseStopApply(document: unknown): Result<Record<string, never>> {
  const parsed = shaped(stopReceipt, document, "oats instance stop --apply");
  if (!parsed.ok) return parsed;
  const failed = (parsed.value.results ?? []).find((result) => result.ok === false);
  if (failed) return err(failed.code ?? "E_SESSION_STOP_FAILED", failed.message ?? `${failed.instance ?? "the instance"} was not stopped`);
  return ok({});
}

// ---- oats session start | restart ----
function sessionArgv(verb: "start" | "restart", home: string): Result<string[]> {
  const checked = checkHome(home);
  return checked.ok ? ok(["session", verb, "--home", checked.value, "--json"]) : checked;
}
export const startArgv = (home: string): Result<string[]> => sessionArgv("start", home);
export const restartArgv = (home: string): Result<string[]> => sessionArgv("restart", home);

const started = z.looseObject({ session: z.looseObject({ endpoint: z.looseObject({ threadId: text }).nullish() }).nullish() });

/** The thread the session now runs in, when the answer names it (the endpoint is replaced at each start). */
export function parseSessionStart(document: unknown, verb: "start" | "restart" = "start"): Result<{ threadId: string | null }> {
  const parsed = shaped(started, document, `oats session ${verb}`);
  if (!parsed.ok) return parsed;
  return ok({ threadId: parsed.value.session?.endpoint?.threadId ?? null });
}

// ---- oats retire ----
export function retirePlanArgv(instance: string): Result<string[]> {
  const checked = checkInstance(instance);
  return checked.ok ? ok(["retire", checked.value, "--plan", "--json"]) : checked;
}
export const retireApplyArgv = (apply: Apply): Result<string[]> => applyArgv(["retire"], apply, []);

const retirePlan = z.looseObject({
  planRevision: z.string().min(1),
  instance: z.string(),
  home: text,
  facts: z
    .looseObject({
      session,
      work,
      ownWorktree: z.boolean().nullish(),
      children: z.array(z.looseObject({ instance: z.string(), session })).nullish(),
      ambiguous: z.array(z.looseObject({ instance: z.string() })).nullish(),
      extraWorktrees: z.array(z.looseObject({ path: text, branch: text, disposition: text })).nullish(),
    })
    .nullish(),
  defaults: z
    .looseObject({ retainWorktree: z.boolean().nullish(), deleteBranch: z.boolean().nullish(), stopChildren: z.boolean().nullish(), retainChildren: z.boolean().nullish() })
    .nullish(),
  notes: z.array(z.string()).nullish(),
});

export function parseRetirePlan(document: unknown): Result<Plan> {
  const parsed = shaped(retirePlan, document, "oats retire --plan");
  if (!parsed.ok) return parsed;
  const plan = parsed.value;
  const facts = plan.facts ?? {};
  const defaults = plan.defaults ?? {};
  const lines: string[] = [];
  const established = facts.session && facts.session.established !== false;
  const sessionLine = !established
    ? "Whether its session runs is not known; one that runs is stopped first."
    : idle(facts.session?.state)
      ? "Its session is not running."
      : "Its session is running and is stopped first.";
  lines.push(`Removed: the home of ${plan.instance}${plan.home ? ` (${plan.home})` : ""}. ${sessionLine}`);
  if (facts.ownWorktree === true) {
    const branch = facts.work?.branch ? ` on branch ${facts.work.branch}` : "";
    const pending = workWords(facts.work);
    lines.push(
      defaults.retainWorktree === false
        ? `Removed: its work tree${branch}${pending ? ` (${pending})` : ""}.`
        : `Kept: its work tree${branch}, moved out of the home${pending ? ` (${pending})` : ""}.`,
    );
    lines.push(defaults.deleteBranch === true ? "Removed: its branch." : "Kept: its branch.");
  }
  for (const tree of facts.extraWorktrees ?? []) {
    lines.push(`${tree.disposition === "retain" ? "Kept" : "Removed"}: the extra tree ${tree.path ?? ""}${tree.branch ? ` on branch ${tree.branch}` : ""}.`);
  }
  const children = facts.children ?? [];
  if (children.length > 0) {
    const names = children.map((child) => child.instance).join(", ");
    const stop = defaults.stopChildren === false ? "left as they are" : "stopped";
    lines.push(`Its ${children.length === 1 ? "child" : `${children.length} children`} (${names}): ${stop}${defaults.retainChildren === false ? "" : " and kept"}.`);
  }
  for (const row of facts.ambiguous ?? []) lines.push(`Not touched, its parent is ambiguous: ${row.instance}`);
  lines.push(...(plan.notes ?? []));
  return ok({ revision: plan.planRevision, lines });
}

const retireReceipt = z.looseObject({ retired: z.string().min(1) });

/** A first guarded retire prints the receipt itself; a replayed one prints it in an envelope. */
export function parseRetireApply(document: unknown): Result<Record<string, never>> {
  const parsed = shaped(retireReceipt, document, "oats retire");
  return parsed.ok ? ok({}) : parsed;
}
