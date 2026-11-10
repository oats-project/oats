/** lib/command-flags.mjs — the flags each state-changing kernel command defines (oats-project/oats#1791),
 *  and the one check of a command's argv against them, which the CLI's dispatch runs before the command
 *  runs and before a `--server` command is sent to its host: a flag the command does not define, a value
 *  on one of its switches, or an argument after its last one is refused with E_BAD_ARGS, never ignored, so
 *  a mistyped protective flag (`--keep-dirs` for `--keep-dir`) never does the unprotected thing. A command
 *  missing here is not checked. Kernel-private, not exported from `./core`. Dependency-free. */

export const RETIRE_DELETE_BRANCH_REFUSED = "oats retire no longer deletes branches: --delete-branch is not accepted. Retire without it; the branch is left in the repository. Inspect it there and delete it with Git if it is no longer wanted.";
export const RETIRE_USAGE = "usage: oats retire <instance> [--plan] [--plan-revision <rev> --idempotency-key <key>] [--home <path>] [--dir <d>] [--server <id>] [--self] [--discard-worktree] [--keep-dir] [--force] [--json]";
export const WORKTREE_USAGE = "usage: oats worktree add --purpose <p> --branch <b> --base <remote-branch> [--repo <member key|clone path>] [--preview] [--json] | oats worktree remove --purpose <p> [--json]";

const WORKTREE_REFUSED = Object.freeze({
  "--server": "oats worktree runs in an instance home on this machine; --server is not accepted",
  "--dir": `oats worktree has no --dir: it acts on the instance home it runs in; ${WORKTREE_USAGE}`,
  "--home": `oats worktree has no --home: it acts on the instance home it runs in; ${WORKTREE_USAGE}`,
});
const launchConfigWrite = (sub) => {
  const refused = `launch-config ${sub} writes the deployment's oats-local.yaml: address it with --dir, not --home or --soul`;
  return { "--home": refused, "--soul": refused };
};
const SESSION_VALUES = Object.freeze(["--home", "--instance", "--launch-config", "--harness", "--runtime", "--model", "--server"]);
const SESSION_SWITCHES = Object.freeze(["--reselect-launch", "--yolo", "--no-yolo", "--json"]);
const SCHEDULE_VALUES = Object.freeze(["--dir", "--server"]);
const schedule = (verb, switches = []) => ({ command: `schedule ${verb}`, operands: ["id"], values: SCHEDULE_VALUES, switches: [...switches, "--json"],
  usage: `usage: oats schedule ${verb} <id>${switches.map((s) => ` [${s}]`).join("")} [--dir <workspace> | --server <id>] [--json]` });
const trigger = (verb) => ({ command: `trigger ${verb}`, operands: ["id"], values: ["--dir"], switches: ["--json"], usage: `usage: oats trigger ${verb} <id> [--dir <deployment>] [--json]` });

/** Each command's argv, frozen to its arrays: `command` its words; `operands` the names of the arguments it takes after them,
 *  in order (one more is refused; a missing one is the command's own refusal); `values` the flags that
 *  take a value, `switches` the flags that take none; `refused` the flags it refuses with their own
 *  message; `usage` the line every refusal ends with. `--json` is a switch of every one. A value flag
 *  given no value is that flag's own refusal, by the command. */
export const COMMAND_FLAGS = Object.freeze([
  { command: "retire", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--home", "--dir", "--server"], switches: ["--plan", "--self", "--discard-worktree", "--keep-dir", "--force", "--json"],
    refused: { "--delete-branch": RETIRE_DELETE_BRANCH_REFUSED }, usage: RETIRE_USAGE },
  { command: "instance stop", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--grace-ms", "--home", "--dir", "--server"], switches: ["--plan", "--apply", "--no-recursive", "--json"],
    usage: "usage: oats instance stop <instance> (--plan | --apply --plan-revision <rev> --idempotency-key <key>) [--no-recursive] [--grace-ms <n>] [--home <abs>] [--dir <d> | --server <id>] [--json]" },
  { command: "instance upgrade", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--home", "--dir"], switches: ["--undo", "--plan", "--json"],
    refused: { "--server": "instance upgrade supports local homes only; run it on the deployment host" },
    usage: "usage: oats instance upgrade <instance> [--undo] (--plan | --plan-revision <rev> --idempotency-key <key>) [--home <abs>] [--dir <d>] [--json]" },
  { command: "worktree add", operands: [], values: ["--purpose", "--branch", "--base", "--repo"], switches: ["--preview", "--json"], refused: WORKTREE_REFUSED,
    usage: "usage: oats worktree add --purpose <p> --branch <b> --base <remote-branch> [--repo <member key|clone path>] [--preview] [--json]" },
  { command: "worktree remove", operands: [], values: ["--purpose"], switches: ["--json"], refused: WORKTREE_REFUSED,
    usage: "usage: oats worktree remove --purpose <p> [--json]" },
  { command: "session start", operands: [], values: SESSION_VALUES, switches: [...SESSION_SWITCHES, "--resume"],
    usage: "usage: oats session start (--home <abs> | --server <id> (--instance <name> | --home <abs>)) [--launch-config <name>|none | --reselect-launch] [--harness pi|claude|codex] [--model <id>] [--yolo|--no-yolo] [--resume] [--json]" },
  { command: "session restart", operands: [], values: [...SESSION_VALUES, "--stop-grace"], switches: SESSION_SWITCHES,
    refused: { "--resume": "--resume exists on session start only: it brings back a session that was lost" },
    usage: "usage: oats session restart (--home <abs> | --server <id> (--instance <name> | --home <abs>)) [--launch-config <name>|none | --reselect-launch] [--harness pi|claude|codex] [--model <id>] [--yolo|--no-yolo] [--stop-grace <seconds>] [--json]" },
  schedule("remove", ["--force"]),
  schedule("run", ["--force"]),
  schedule("enable"),
  schedule("disable"),
  schedule("reconcile", ["--clear"]),
  { command: "schedule host uninstall", operands: [], values: SCHEDULE_VALUES, switches: ["--json"], usage: "usage: oats schedule host uninstall [--dir <workspace> | --server <id>] [--json]" },
  trigger("remove"),
  trigger("enable"),
  trigger("disable"),
  { command: "server remove", operands: ["id"], values: [], switches: ["--json"], usage: "usage: oats server remove <id> [--json]" },
  { command: "server forget", operands: ["id"], values: ["--instance"], switches: ["--json"], usage: "usage: oats server forget <id> --instance <name> [--json]" },
  { command: "package add", operands: ["id", "version"], values: ["--dir"], switches: ["--json"], usage: "usage: oats package add <id> <version|git:<repo>@<ref>> [--dir <d>] [--json]" },
  { command: "package remove", operands: ["id"], values: ["--dir"], switches: ["--json"], usage: "usage: oats package remove <id> [--dir <d>] [--json]" },
  { command: "launch-config set", operands: ["name"], values: ["--file", "--dir", "--server"], switches: ["--keep-env", "--json"], refused: launchConfigWrite("set"),
    usage: "usage: oats launch-config set <name> --file <json> [--keep-env] [--dir <scope> | --server <id>] [--json]" },
  { command: "launch-config remove", operands: ["name"], values: ["--dir", "--server"], switches: ["--json"], refused: launchConfigWrite("remove"),
    usage: "usage: oats launch-config remove <name> [--dir <scope> | --server <id>] [--json]" },
  { command: "automations refresh", operands: [], values: ["--dir"], switches: ["--json"], usage: "usage: oats automations refresh [--dir <deployment>] [--json]" },
].map((c) => Object.freeze({ ...c, operands: Object.freeze([...c.operands]), values: Object.freeze([...c.values]), switches: Object.freeze([...c.switches]), ...(c.refused ? { refused: Object.freeze({ ...c.refused }) } : {}) })));

/** The declaration of the command `argv` (the CLI's argv, after `oats`) runs: the one whose words its
 *  first words are, the longest of them; undefined for a command not declared here. */
export function commandFlags(argv) {
  let found;
  for (const c of COMMAND_FLAGS) {
    const words = c.command.split(" ");
    if (words.every((w, i) => argv[i] === w) && (!found || words.length > found.command.split(" ").length)) found = c;
  }
  return found;
}

/** Why `argv` (the CLI's argv, after `oats`, as typed: `--flag=value` unexpanded) is not a command its
 *  declaration allows, as { message, details }, or undefined (allowed, or not declared). The first
 *  problem from the left: a refused flag (its own message), a flag the command does not define
 *  (`oats <command>: unknown flag <flag>`), a switch given a value with `=`, or an argument after its
 *  last; each but a refused flag's ends with the command's usage. A value flag takes the next word as
 *  its value unless that starts with `--`, as the CLI's flag reader does (lib/argv.mjs flagValue); `--`
 *  is a flag like any other. */
export function commandArgvProblem(argv) {
  const c = commandFlags(argv);
  if (!c) return undefined;
  const operands = [];
  for (let i = c.command.split(" ").length; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      if (operands.length === c.operands.length) return { message: extraArgument(c, a, operands), details: { argument: a } };
      operands.push(a);
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 2 ? a.slice(0, eq) : a;
    if (c.refused && Object.hasOwn(c.refused, flag)) return { message: c.refused[flag], details: { flag } };
    if (c.switches.includes(flag)) {
      if (flag !== a) return { message: `oats ${c.command}: ${flag} takes no value (got ${a})\n${c.usage}`, details: { flag } };
      continue;
    }
    if (!c.values.includes(flag)) return { message: `oats ${c.command}: unknown flag ${flag}\n${c.usage}`, details: { flag } };
    if (flag === a && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
  }
  return undefined;
}

function extraArgument(c, a, operands) {
  if (!c.operands.length) return `oats ${c.command}: unexpected argument ${JSON.stringify(a)}: ${c.command} takes no argument\n${c.usage}`;
  const last = c.operands.length - 1;
  return `oats ${c.command}: unexpected argument ${JSON.stringify(a)} after the ${c.operands[last]} ${JSON.stringify(operands[last])}: ${c.command} takes ${c.operands.map((n) => `one ${n}`).join(" and ")}\n${c.usage}`;
}
