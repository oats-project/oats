/** The suggested instance name (feature spawn-suggest-name, awebai/oats#1421 §3): `oats spawn <soul>
 *  --preview --suggest-name` asks the soul's own harness, in one isolated non-interactive call, for a
 *  descriptive name for the task, and names the instance `<descriptive>-<role>`. A failure is never an
 *  error: the preview numbers the instance as before and says why (`naming.reason`, a closed set).
 *
 *  The call starts nothing that runs code: no MCP server, hook, plugin, extension or project setting
 *  (the maintainer's condition). NAMING_CALLS holds the argv of each harness where that is proven
 *  (scripts/naming-isolation-proof.mjs, a recorded run per harness); a harness not in it answers
 *  `unsupported-harness`. The prompt goes on stdin, never in argv (argv is readable by local users),
 *  from a fresh empty working directory, without a shell, in its own process group, with no
 *  `OATS_INSTANCE*` variable, for at most NAMING_TIMEOUT_MS, reading at most NAMING_OUTPUT_MAX bytes.
 *
 *  Dependency-free: lib/core.mjs's spawn preview drives it (spawnBody, where the name is decided). */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killGroup } from "./process-group.mjs";

/** The prompt's fixed words (the maintainer's wording); the task follows. */
export const NAMING_PROMPT = "Name an agent for this task: 2–4 lowercase words joined by hyphens, describing the work, not the role. Reply with the name only.";
/** The task text the prompt carries, in characters (code points). */
export const NAMING_TASK_MAX = 4000;
/** The call's limits: the time after which its process group is killed, and the stdout read. */
export const NAMING_TIMEOUT_MS = 20_000;
export const NAMING_OUTPUT_MAX = 4096;
/** The closed set of `naming.reason`. */
export const NAMING_REASONS = Object.freeze(["no-task", "unsupported-harness", "timeout", "harness-failed", "invalid-reply"]);
/** Instance names are at most this long (lib/core.mjs MAX_INSTANCE_NAME, the messaging alias's limit). */
const NAME_MAX = 64;
/** The descriptive part keeps at most this many words. */
const WORDS_MAX = 4;

/** The prompt for `task`: the fixed words, then the task, cut to NAMING_TASK_MAX characters. */
export function namingPrompt(task) {
  return `${NAMING_PROMPT}\n\nTask:\n${Array.from(String(task)).slice(0, NAMING_TASK_MAX).join("")}`;
}

/** The role of a soul name: its last `-`-separated word after any package qualifier (what follows the
 *  last `/` or `--`); '' when there is none. The clients' rule (packages/client/instance-name.mjs
 *  soulRole), kept here because the kernel imports nothing from packages/: test/instance-naming.test.mjs
 *  pins it to the clients' cases (test/client-instance-name.test.mjs ROLE_CASES). */
export function soulRole(soulName) {
  if (typeof soulName !== "string") return "";
  const slash = soulName.lastIndexOf("/"), dashes = soulName.lastIndexOf("--");
  const bare = soulName.slice(Math.max(slash < 0 ? 0 : slash + 1, dashes < 0 ? 0 : dashes + 2));
  return bare.slice(bare.lastIndexOf("-") + 1);
}

/** lib/core.mjs slug() without its "agent" fallback: lowercase letters and digits, single dashes. */
const slugWords = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean);

/** The descriptive words of a reply: its first non-empty line as a slug, without one or more trailing
 *  `-<role>` (a role the model adds is not doubled; a reply that is only the role describes no work),
 *  at most WORDS_MAX words, cut at a word boundary to fit `NAME_MAX − 1 − len(role)`. [] when nothing
 *  is left: an invalid reply. */
export function descriptiveWords(reply, role) {
  const line = String(reply ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const words = slugWords(line);
  while (role && words.length && words[words.length - 1] === role) words.pop();
  const kept = words.slice(0, WORDS_MAX);
  const budget = NAME_MAX - (role ? role.length + 1 : 0);
  while (kept.length && kept.join("-").length > budget) kept.pop();
  return kept;
}

/** The name for `words` and `role`: `<descriptive>-<role>`, made unique by `-2`, `-3`, … while
 *  `taken(name)` (an instance or a soul of the deployment, or a live window: what an explicit name
 *  is refused for). A suffix that would pass NAME_MAX drops a descriptive word first, and cuts the
 *  last one only when one word is left. null for no words. */
export function uniqueName(words, role, taken) {
  if (!words.length) return null;
  let kept = [...words];
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const fixed = (role ? role.length + 1 : 0) + suffix.length;
    while (kept.length > 1 && kept.join("-").length + fixed > NAME_MAX) kept.pop();
    if (kept.join("-").length + fixed > NAME_MAX) kept = [kept[0].slice(0, NAME_MAX - fixed).replace(/-+$/, "")];
    const name = `${kept.join("-")}${role ? `-${role}` : ""}${suffix}`;
    if (!taken(name)) return name;
  }
}

/** The naming call of each harness where it is proven to start nothing that runs code: `model` picks
 *  the naming model from the model the instance would run on (null: the harness's own default), and
 *  `argv` renders the call for it. The prompt is on stdin. A launch configuration's `args` are not
 *  passed (they could load what these flags keep out); its executable and environment are.
 *  - claude: the faster model, the alias `haiku`. `--tools ""` (no tools), `--strict-mcp-config`
 *    with no `--mcp-config` (no MCP server or connector), `--setting-sources ""` (no user, project or
 *    local settings: no hook, no plugin), `--disable-slash-commands` (no skill). Native authentication
 *    is kept: `--bare` would read no OAuth. A login through `apiKeyHelper` is not read: such a user
 *    gets harness-failed and a numbered name. Claude Code's own built-in plugins (`cc-plugin-*@builtin`)
 *    load as they always do, `--bare` included; none of the user's plugins, hooks or MCP servers do.
 *    Managed-policy hooks still apply: they are the host admin's.
 *  - pi: the instance's model. No tools, extensions (packages and built-ins), MCP, skills, prompt
 *    templates, themes, context files or project-local files. pi runs its own credential commands
 *    (`!command` keys and headers in models.json), as every pi launch does: they are its login (the
 *    decided exception, kept by harness-native authentication).
 *  - codex is not here: `-c mcp_servers={}` does not remove a user's MCP server, only
 *    `--ignore-user-config` does (and drops the user's provider settings), and its logged-in surfaces
 *    are unproven. It answers `unsupported-harness`; the proof script keeps its argv. */
export const NAMING_CALLS = Object.freeze({
  claude: Object.freeze({
    model: () => "haiku",
    argv: (model) => ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--model", model],
  }),
  pi: Object.freeze({
    model: (instanceModel) => (typeof instanceModel === "string" && instanceModel ? instanceModel : null),
    argv: (model) => ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", ...(model ? ["--model", model] : [])],
  }),
});

/** The naming call's environment: `env` without any `OATS_INSTANCE*` variable (the caller's own
 *  identity, when an instance spawns, is not the new instance's and is nobody's to pass on). */
export function namingEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("OATS_INSTANCE")));
}

/** A numbered answer for `reason`, with its message and the time spent. */
const numbered = (reason, message, ms) => ({ source: "numbered", reason, message, ms });

/** Ask `harness` (its executable `bin`) for a name for `task`, under `env` (a function: the launch's
 *  environment, built only when a call is made), within `timeoutMs`. → Promise of
 *  `{ answer, reply? }`: `answer` is `naming` with `source: "numbered"` and its reason, or the
 *  suggested answer's facts without the name; `reply` the stdout read when the harness answered.
 *  Never rejects. `spawnImpl` is a seam for the tests. */
export async function namingCall({ harness, bin, instanceModel, env, task, timeoutMs = NAMING_TIMEOUT_MS, spawnImpl = spawn }) {
  const started = Date.now();
  const ms = () => Date.now() - started;
  if (typeof task !== "string" || !task.trim()) return { answer: numbered("no-task", "the task is empty: there is nothing to name the instance from", 0) };
  const call = Object.hasOwn(NAMING_CALLS, harness) ? NAMING_CALLS[harness] : null;
  if (!call) return { answer: numbered("unsupported-harness", `${harness} has no naming call that is proven to start nothing (suggested names work on ${Object.keys(NAMING_CALLS).join(" and ")})`, 0) };
  if (!(timeoutMs > 0)) return { answer: numbered("timeout", "the preview's preflight budget was spent before the naming call", 0) };
  if (typeof bin !== "string" || !bin) return { answer: numbered("harness-failed", `${harness} could not be run: no executable for it here`, 0) };
  const model = call.model(instanceModel);
  let environment;
  try { environment = namingEnvironment(env()); }
  catch (e) { return { answer: numbered("harness-failed", `${harness} could not be run: its launch's environment is not known (${e?.code || "error"})`, ms()) }; }
  let cwd;
  try { cwd = mkdtempSync(join(tmpdir(), "oats-naming-")); }
  catch (e) { return { answer: numbered("harness-failed", `${harness} could not be run: no working directory (${e?.code || "error"})`, ms()) }; }
  const outcome = await new Promise((settle) => {
    let child, timer, timedOut = false, done = false, size = 0;
    const chunks = [];
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    // The kernel's process ends with its caller, and the call with it: its group is killed on exit
    // and on a signal, which is then raised again with the default action.
    const onExit = () => killGroup(child);
    const onSignal = (sig) => { killGroup(child); cleanup(); process.kill(process.pid, sig); };
    const cleanup = () => { process.off("exit", onExit); for (const s of signals) process.off(s, onSignal); };
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); cleanup(); settle(value); };
    try {
      child = spawnImpl(bin, call.argv(model), { cwd, env: environment, detached: true, stdio: ["pipe", "pipe", "ignore"], shell: false });
    } catch (e) { return finish({ error: e }); }
    process.once("exit", onExit);
    for (const s of signals) process.once(s, onSignal);
    timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    child.on("error", (e) => finish({ error: e }));
    child.stdout.on("data", (chunk) => {
      if (size >= NAMING_OUTPUT_MAX) return;
      const take = chunk.subarray(0, NAMING_OUTPUT_MAX - size);
      chunks.push(take); size += take.length;
    });
    child.on("close", (code, signal) => finish({ code, signal, timedOut, stdout: Buffer.concat(chunks).toString("utf8") }));
    child.stdin.on("error", () => { /* a harness that exits before reading answers by its exit */ });
    child.stdin.end(namingPrompt(task));
  });
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a temporary directory */ }
  // The message gives the exit or the signal, never the output.
  if (outcome.timedOut) return { answer: numbered("timeout", `${harness} gave no name within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`, ms()) };
  if (outcome.error) return { answer: numbered("harness-failed", `${harness} could not be run (${outcome.error.code || "error"})`, ms()) };
  if (outcome.signal) return { answer: numbered("harness-failed", `${harness} was ended by ${outcome.signal}`, ms()) };
  if (outcome.code !== 0) return { answer: numbered("harness-failed", `${harness} exited with ${outcome.code}`, ms()) };
  return { answer: { source: "suggested", ms: ms(), harness, model }, reply: outcome.stdout };
}

/** The suggested name for `task`: the call, then the name built from its reply for `soulName`'s role,
 *  unique by `taken`. → Promise of `{ naming, name? }`: `name` only when `naming.source` is
 *  "suggested". Never rejects. */
export async function suggestInstanceName({ soulName, taken, ...call }) {
  const { answer, reply } = await namingCall(call);
  if (answer.source !== "suggested") return { naming: answer };
  const role = soulRole(soulName);
  const name = uniqueName(descriptiveWords(reply, role), role, taken);
  if (!name) return { naming: numbered("invalid-reply", `${call.harness}'s reply holds no name`, answer.ms) };
  return { naming: answer, name };
}
