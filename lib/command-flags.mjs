/** lib/command-flags.mjs — the flags each state-changing kernel command defines (oats-project/oats#1791),
 *  and the one check of a command's argv against them, which the CLI's dispatch runs before the command
 *  runs and before a `--server` command is sent to its host: a flag the command does not define, a value
 *  on one of its switches, or an argument after its last one is refused with E_BAD_ARGS, never ignored, so
 *  a mistyped protective flag (`--keep-dirs` for `--keep-dir`) never does the unprotected thing. A command
 *  missing here is not checked. Kernel-private, not exported from `./core`. Dependency-free. */

export const RETIRE_DELETE_BRANCH_REFUSED = "oats retire no longer deletes branches: --delete-branch is not accepted. Retire without it; the branch is left in the repository. Inspect it there and delete it with Git if it is no longer wanted.";
export const RETIRE_USAGE = "usage: oats retire <instance> [--plan] [--plan-revision <rev> --idempotency-key <key>] [--home <path>] [--dir <d>] [--server <id>] [--self] [--discard-worktree] [--keep-dir] [--force] [--json]";
export const SPAWN_USAGE = "usage: oats spawn <agent> [--task <text>|--task-file <f>] [--purpose <slug>|--name <slug>|--suggest-name] [--preview] [--base <ref>] [--model <id>|@native-default] [--allow-child-spawns|--no-child-spawns] [--relation child|sibling|parent|unrelated --relative-to <instance> [--relative-root <agents-root>]] [--parent <instance>] [--same-work] [--repo <r>] [--work worktree|checkout|attached|workspace|directory] [--work-dir <owner-work>] [--harness pi|claude|codex] [--backend tmux] [--yolo|--no-yolo] [--background|--no-background] [--model <m>] [--branch <b>] [--no-launch] [--json]";
export const SYNC_USAGE = "usage: oats sync [--dir <deployment>] [--plan] [--json]";
export const APPROVAL_REMOVED = "package approval was removed; declaring a package in packages: is the trust decision";
export const TEAMS_USAGE = "usage: oats teams [--json] | oats teams add <label> --team <id> [--description <d>] [--no-default] | oats teams remove <label> | oats teams default <label> [--if-absent | --expect <label>]  [--dir <deployment>] [--json]";
export const SOUL_LAUNCH_USAGE = "oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>]) [--plan] [--dir <deployment>] [--json] | oats soul launch remove <soul>|'*'|<exact key> [--plan] [--dir <deployment>] [--json]";
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
const INSTANCE_RECORD_VALUES = Object.freeze(["--home", "--dir", "--server"]);
const onOff = (verb) => ({ command: `instance ${verb}`, operands: ["instance", "state"], values: INSTANCE_RECORD_VALUES, switches: ["--json"],
  usage: `usage: oats instance ${verb} <instance> on|off [--home <abs>] [--dir <d> | --server <id>] [--json]` });
const WAITING_VALUES = Object.freeze(["--producer", "--reason", "--message", "--home", "--dir"]);
const waiting = (verb) => ({ command: `instance waiting ${verb}`, operands: [], values: WAITING_VALUES, switches: ["--json"],
  usage: `usage: oats instance waiting ${verb} --producer <id>${verb === "set" ? " --reason permission|question|attention" : ""} [--message=<text>] [--home <abs>] [--dir <d>] [--json]` });
const ATTENTION_USAGE = "usage: oats instance attention [--message=<text>] [--clear] [--json]";
const attentionHasNo = (flag) => `oats instance attention has no ${flag}: it records the agent's own claim on the instance it runs in ($OATS_INSTANCE_HOME); ${ATTENTION_USAGE}`;
const TRIGGER_RUN_SOURCE = Object.freeze(["--run-source", "--json"]);
const SESSION_ADDRESS = Object.freeze(["--home", "--instance", "--server"]);
const UPDATE_TAKES_NO_PACKAGE = "oats update takes no package: pin package versions in oats-workspace.yaml (`oats package add <id> <version>`), then `oats sync`; bare `oats update [--check] [--yes]` updates the kernel";
const SPAWN_REMOVED_SOUL = (flag) => `${flag} created a local soul under local-agents/, which the workspace model removed — author souls/<name>/soul.yaml + AGENTS.md in a member repository, then \`oats sync\``;
/** `oats teams` and `oats soul launch` answer a flag they do not take with E_USAGE in their own words
 *  (docs/desktop-cli-api.md "oats teams", "oats soul launch"). */
const teamsUnknown = (form) => (flag) => ({ code: "E_USAGE", message: `${form} does not take ${flag} (an option this kernel does not know may need a newer kernel; nothing was changed) — ${TEAMS_USAGE}`, details: { flag } });
/** An `oats teams` form takes these, beyond `--dir` and `--json`; anything else is refused, never ignored:
 *  a kernel that ignored `--if-absent` would set unconditionally. */
const teams = (verb, values, switches) => ({ command: `teams ${verb}`, operands: ["label"], values: ["--dir", ...values], switches: [...switches, "--json"], unknown: teamsUnknown(`oats teams ${verb}`),
  usage: `usage: oats teams ${verb} <label>${[...values.map((v) => ` [${v} <${v.slice(2)}>]`), ...switches.map((s) => ` [${s}]`)].join("")} [--dir <deployment>] [--json]` });
/** An `oats soul launch` form takes these; anything else is refused, never ignored: `--home` and `--soul`
 *  among them, since the soul is the argument and the file the deployment's. */
const soulLaunch = (verb, values) => ({ command: `soul launch ${verb}`, operands: [verb === "set" ? "soul" : "soul or key"], values: ["--dir", ...values], switches: ["--plan", "--json"],
  unknown: (flag) => ({ code: "E_USAGE", message: `oats soul launch ${verb} does not take ${flag} (nothing was changed) — usage: ${SOUL_LAUNCH_USAGE}`, details: { flag } }),
  // Every name it was given, in its own words: `remove dev writer` would remove dev alone.
  extra: (args) => ({ code: "E_BAD_ARGS", message: `oats soul launch ${verb} takes one ${verb === "set" ? "soul" : "soul or key"}, and got ${args.length}: ${args.map((n) => JSON.stringify(n)).join(", ")} (nothing was changed) — usage: ${SOUL_LAUNCH_USAGE}` }),
  usage: verb === "set" ? "usage: oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>]) [--plan] [--dir <deployment>] [--json]" : "usage: oats soul launch remove <soul>|'*'|<exact key> [--plan] [--dir <deployment>] [--json]" });

/** Each command's argv, frozen to its arrays: `command` its words; `operands` the names of the arguments
 *  it takes after them, in order (one more is refused); `required` how many of them it needs (all, unless
 *  it says: a missing one is the command's own refusal, and E_USAGE here when `--server` is given);
 *  `values` the flags that take a value, `arity` those that take more than one word (`{ flag: words }`);
 *  `switches` the flags that take none; `refused` the flags it refuses with their own message; `usage`
 *  the line every shared refusal ends with. A row answers in its own words with `unknown(flag)` for a flag
 *  it does not define and `extra(args)` for an argument after its last (`args`: every argument it was
 *  given), each → { code, message, details? }. `--json` is a switch of every one. A value flag given no
 *  value is that flag's own refusal, by the command. */
export const COMMAND_FLAGS = Object.freeze([
  { command: "retire", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--home", "--dir", "--server"], switches: ["--plan", "--self", "--discard-worktree", "--keep-dir", "--force", "--json"],
    refused: { "--delete-branch": RETIRE_DELETE_BRANCH_REFUSED }, usage: RETIRE_USAGE },
  // `--instance` is refused by a local spawn (with its replacement) but still travels to an older host
  // through `--server`, whose route reads it. `--max-age` reaches here only on a preview or an apply bound
  // by --expect-decision: the dispatch allow-list (maxAgeRefusal) refuses it otherwise. `--herdr-socket`
  // and `--backend herdr` are read to be refused (E_HERDR_REMOVED), here and on the route.
  { command: "spawn", operands: ["soul"],
    values: ["--agents-root", "--backend", "--base", "--branch", "--dir", "--expect-decision", "--harness", "--herdr-socket", "--idempotency-key", "--instance", "--launch-config", "--max-age", "--model", "--name", "--parent", "--provider", "--purpose", "--relation", "--relative-root", "--relative-to", "--repo", "--runtime", "--server", "--task", "--task-file", "--trigger-event", "--wake-cron", "--wake-every", "--wake-file", "--wake-json", "--wake-message", "--wake-message-file", "--wake-tz", "--work", "--work-dir"],
    arity: { "--provider": 2 },
    switches: ["--allow-child-spawns", "--background", "--json", "--no-background", "--no-child-spawns", "--no-launch", "--no-yolo", "--preview", "--same-work", "--suggest-name", "--yolo"],
    // Local souls (local-agents/) are gone with the workspace model: a soul is a member
    // repository's souls/<name>, so spawn never writes one.
    refused: { "--instructions-file": SPAWN_REMOVED_SOUL("--instructions-file"), "--def-file": SPAWN_REMOVED_SOUL("--def-file"),
      "--ephemeral": "--ephemeral was removed by the runtime-boundary ruling — declare the agent in a capability manifest (agents:) for automatic ephemeral semantics" },
    unknown: (flag) => ({ code: "E_BAD_ARGS", message: `oats spawn: unknown flag ${flag}` }),
    extra: ([soul, a]) => ({ code: "E_BAD_ARGS", message: /^[A-Za-z0-9_.-]+=/.test(a)
      ? `oats spawn: unexpected argument ${JSON.stringify(a)} after the soul ${JSON.stringify(soul)}: a capability setting is given as --provider <capability> key=value (here: --provider <capability> ${a})`
      : `oats spawn: unexpected argument ${JSON.stringify(a)} after the soul ${JSON.stringify(soul)}: spawn takes one soul` }),
    usage: SPAWN_USAGE },
  // An unknown flag or an argument of sync is refused before anything is read or written (#731).
  { command: "sync", operands: [], values: ["--dir"], switches: ["--plan", "--json"], refused: { "--approve": `--approve: ${APPROVAL_REMOVED}` }, usage: SYNC_USAGE },
  { command: "instance stop", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--grace-ms", "--home", "--dir", "--server"], switches: ["--plan", "--apply", "--no-recursive", "--json"],
    usage: "usage: oats instance stop <instance> (--plan | --apply --plan-revision <rev> --idempotency-key <key>) [--no-recursive] [--grace-ms <n>] [--home <abs>] [--dir <d> | --server <id>] [--json]" },
  { command: "instance upgrade", operands: ["instance"], values: ["--plan-revision", "--idempotency-key", "--home", "--dir"], switches: ["--undo", "--plan", "--json"],
    refused: { "--server": "instance upgrade supports local homes only; run it on the deployment host" },
    usage: "usage: oats instance upgrade <instance> [--undo] (--plan | --plan-revision <rev> --idempotency-key <key>) [--home <abs>] [--dir <d>] [--json]" },
  { command: "instance color", operands: ["instance", "color"], required: 1, values: INSTANCE_RECORD_VALUES, switches: ["--clear", "--json"],
    usage: "usage: oats instance color <instance> (<color> | --clear) [--home <abs>] [--dir <d> | --server <id>] [--json]" },
  onOff("background"),
  onOff("same-work"),
  waiting("set"),
  waiting("clear"),
  { command: "instance attention", operands: [], values: ["--message"], switches: ["--clear", "--json"],
    refused: Object.fromEntries(["--home", "--dir", "--producer", "--reason"].map((f) => [f, attentionHasNo(f)])), usage: ATTENTION_USAGE },
  { command: "instance suggest-name", operands: [], values: ["--soul", "--task", "--task-file", "--harness", "--model", "--launch-config", "--dir"], switches: ["--json"],
    refused: { "--server": "instance suggest-name takes no --server: it runs this machine's harness, for a spawn that may land on another; the host it lands on makes the name unique (or names an unnamed --suggest-name spawn itself)" },
    usage: "usage: oats instance suggest-name --soul <soul> (--task <t> | --task-file <f>) [--harness claude|pi] [--model <m>] [--launch-config <n>] [--dir <d>] [--json]" },
  { command: "worktree add", operands: [], values: ["--purpose", "--branch", "--base", "--repo"], switches: ["--preview", "--json"], refused: WORKTREE_REFUSED,
    usage: "usage: oats worktree add --purpose <p> --branch <b> --base <remote-branch> [--repo <member key|clone path>] [--preview] [--json]" },
  { command: "worktree remove", operands: [], values: ["--purpose"], switches: ["--json"], refused: WORKTREE_REFUSED,
    usage: "usage: oats worktree remove --purpose <p> [--json]" },
  { command: "session start", operands: [], values: SESSION_VALUES, switches: [...SESSION_SWITCHES, "--resume"],
    usage: "usage: oats session start (--home <abs> | --server <id> (--instance <name> | --home <abs>)) [--launch-config <name>|none | --reselect-launch] [--harness pi|claude|codex] [--model <id>] [--yolo|--no-yolo] [--resume] [--json]" },
  { command: "session restart", operands: [], values: [...SESSION_VALUES, "--stop-grace"], switches: SESSION_SWITCHES,
    refused: { "--resume": "--resume exists on session start only: it brings back a session that was lost" },
    usage: "usage: oats session restart (--home <abs> | --server <id> (--instance <name> | --home <abs>)) [--launch-config <name>|none | --reselect-launch] [--harness pi|claude|codex] [--model <id>] [--yolo|--no-yolo] [--stop-grace <seconds>] [--json]" },
  { command: "session resume", operands: [], values: ["--deployment"], switches: ["--plan", "--json"], usage: "usage: oats session resume [--deployment <dir>] [--plan] [--json]" },
  { command: "session input", operands: [], values: ["--home", "--text-file"], switches: ["--json"], usage: "usage: oats session input --home <abs> [--text-file <path>] [--json]" },
  { command: "session receive", operands: [], values: ["--home", "--name"], switches: ["--json"], usage: "usage: oats session receive --home <abs> --name <file name> [--json]" },
  { command: "session upload", operands: [], values: ["--file", ...SESSION_ADDRESS], switches: ["--json"],
    usage: "usage: oats session upload --file <path> (--home <abs> | --server <id> (--instance <name> | --home <abs>)) [--json]" },
  { command: "session attach", operands: [], values: ["--detach-key", ...SESSION_ADDRESS], switches: ["--no-status-line", "--print", "--json"],
    usage: "usage: oats session attach (--home <abs> | --server <id> (--instance <name> | --home <abs>) [--print]) [--detach-key <key>] [--no-status-line]" },
  { command: "schedule add", operands: ["id"], required: 0, values: ["--file", "--spec-json", "--description", "--workspace", "--runs-on", "--owner", ...SCHEDULE_VALUES], switches: ["--json"],
    usage: "usage: oats schedule add [<id>] (--file <spec.json> | --spec-json <json>) [--description=<text>] [--workspace <member> --runs-on <host> --owner <host>/<login>] [--dir <workspace> | --server <id>] [--json]" },
  { command: "schedule update", operands: ["id"], values: ["--file", "--spec-json", "--description", ...SCHEDULE_VALUES], switches: ["--json"],
    usage: "usage: oats schedule update <id> (--file <spec.json> | --spec-json <json> [--description=<text>] | --description=<text>) [--dir <workspace> | --server <id>] [--json]" },
  schedule("remove", ["--force"]),
  schedule("run", ["--force"]),
  schedule("enable"),
  schedule("disable"),
  schedule("reconcile", ["--clear"]),
  { command: "schedule tick", operands: [], values: SCHEDULE_VALUES, switches: ["--dry-run", "--host", "--json"], usage: "usage: oats schedule tick [--dry-run] [--host] [--dir <workspace> | --server <id>] [--json]" },
  { command: "schedule host install", operands: [], values: ["--max-concurrent", "--triggers-max-concurrent", "--os", ...SCHEDULE_VALUES], switches: ["--print", "--json"],
    usage: "usage: oats schedule host install [--max-concurrent <N|default>] [--triggers-max-concurrent <N|none>] | --print [--os darwin|linux] [--dir <workspace> | --server <id>] [--json]" },
  { command: "schedule host uninstall", operands: [], values: SCHEDULE_VALUES, switches: ["--json"], usage: "usage: oats schedule host uninstall [--dir <workspace> | --server <id>] [--json]" },
  { command: "trigger add", operands: [], values: ["--file", "--from", "--set", "--id", "--description", "--workspace", "--runs-on", "--owner", "--dir"], switches: ["--json"],
    usage: "usage: oats trigger add (--file <trigger.json> | --from <package>:<template> [--set <name>=<value>]… [--id <id>]) [--description=<text>] [--workspace <member> --runs-on <host> --owner <host>/<login>] [--dir <deployment>] [--json]" },
  { command: "trigger poll", operands: ["id"], values: ["--dir", "--max-age"], switches: TRIGGER_RUN_SOURCE, usage: "usage: oats trigger poll <id> --run-source [--max-age <s>] [--dir <deployment>] [--json]" },
  { command: "trigger test", operands: ["id"], values: ["--dir"], switches: TRIGGER_RUN_SOURCE, usage: "usage: oats trigger test <id> [--run-source] [--dir <deployment>] [--json]" },
  trigger("remove"),
  trigger("enable"),
  trigger("disable"),
  { command: "teams", operands: [], values: ["--dir", "--max-age"], switches: ["--json"], unknown: teamsUnknown("oats teams"),
    // A word where a form belongs: the forms' usage, as before.
    extra: () => ({ code: "E_USAGE", message: TEAMS_USAGE }), usage: "usage: oats teams [--max-age <s>] [--dir <deployment>] [--json]" },
  teams("add", ["--team", "--description"], ["--no-default"]),
  teams("remove", [], []),
  teams("default", ["--expect"], ["--if-absent"]),
  soulLaunch("set", ["--launch-config", "--harness", "--model"]),
  soulLaunch("remove", []),
  { command: "server check", operands: ["id"], values: [], switches: ["--json"], usage: "usage: oats server check <id> [--json]" },
  { command: "server remove", operands: ["id"], values: [], switches: ["--json"], usage: "usage: oats server remove <id> [--json]" },
  { command: "server forget", operands: ["id"], values: ["--instance"], switches: ["--json"], usage: "usage: oats server forget <id> --instance <name> [--json]" },
  { command: "package add", operands: ["id", "version"], values: ["--dir"], switches: ["--json"], usage: "usage: oats package add <id> <version|git:<repo>@<ref>> [--dir <d>] [--json]" },
  { command: "package remove", operands: ["id"], values: ["--dir"], switches: ["--json"], usage: "usage: oats package remove <id> [--dir <d>] [--json]" },
  { command: "launch-config set", operands: ["name"], values: ["--file", "--dir", "--server"], switches: ["--keep-env", "--json"], refused: launchConfigWrite("set"),
    usage: "usage: oats launch-config set <name> --file <json> [--keep-env] [--dir <scope> | --server <id>] [--json]" },
  { command: "launch-config remove", operands: ["name"], values: ["--dir", "--server"], switches: ["--json"], refused: launchConfigWrite("remove"),
    usage: "usage: oats launch-config remove <name> [--dir <scope> | --server <id>] [--json]" },
  { command: "automations refresh", operands: [], values: ["--dir"], switches: ["--json"], usage: "usage: oats automations refresh [--dir <deployment>] [--json]" },
  // `oats update <package>` left with the installed tier (packages are pinned in the workspace file:
  // `oats package add`); only the kernel self-update remains, and a package word is answered with that.
  { command: "update", operands: [], values: ["--dir"], switches: ["--check", "--yes", "--json"], refused: { "--to": UPDATE_TAKES_NO_PACKAGE },
    extra: ([a]) => ({ code: "E_BAD_ARGS", message: UPDATE_TAKES_NO_PACKAGE, details: { argument: a } }), usage: "usage: oats update [--check] [--yes] [--dir <deployment>]" },
].map((c) => Object.freeze({ ...c, operands: Object.freeze([...c.operands]), required: c.required ?? c.operands.length, values: Object.freeze([...c.values]), switches: Object.freeze([...c.switches]),
  arity: Object.freeze({ ...c.arity }), ...(c.refused ? { refused: Object.freeze({ ...c.refused }) } : {}) })));

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
 *  declaration allows, as { code, message, details? }, or undefined (allowed, or not declared). The first
 *  problem from the left, E_BAD_ARGS unless the row answers in its own words: a refused flag (its own
 *  message), a flag the command does not define (`oats <command>: unknown flag <flag>`, or the row's
 *  `unknown`), a switch given a value with `=`, or an argument after its last (or the row's `extra`, given
 *  every argument); each shared one ends with the command's usage. Then, for a command given `--server`,
 *  a missing argument it requires: E_USAGE with the usage line, so that it is never sent (on this machine
 *  each command answers a missing argument itself). A value flag takes the next word (its `arity` words)
 *  as its value unless it starts with `--`, as the CLI's flag reader does (lib/argv.mjs flagValue); a value
 *  after `=` is its first. `--` is a flag like any other. */
export function commandArgvProblem(argv) {
  const c = commandFlags(argv);
  if (!c) return undefined;
  const given = [];
  let extra = null, routed = false;
  for (let i = c.command.split(" ").length; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      if (given.length === c.operands.length && extra === null) extra = a;
      given.push(a);
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 2 ? a.slice(0, eq) : a;
    // After an argument too many, the rest is read only for the arguments it holds.
    if (extra === null) {
      if (c.refused && Object.hasOwn(c.refused, flag)) return { code: "E_BAD_ARGS", message: c.refused[flag], details: { flag } };
      if (c.switches.includes(flag)) {
        if (flag !== a) return { code: "E_BAD_ARGS", message: `oats ${c.command}: ${flag} takes no value (got ${a})\n${c.usage}`, details: { flag } };
        continue;
      }
      if (!c.values.includes(flag)) return c.unknown ? c.unknown(flag) : { code: "E_BAD_ARGS", message: `oats ${c.command}: unknown flag ${flag}\n${c.usage}`, details: { flag } };
      if (flag === "--server") routed = true;
    } else if (!c.values.includes(flag)) continue;
    for (let words = (c.arity[flag] ?? 1) - (flag === a ? 0 : 1); words > 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"); words--) i++;
  }
  if (extra !== null) return c.extra ? c.extra(given) : { code: "E_BAD_ARGS", message: extraArgument(c, extra, given), details: { argument: extra } };
  if (routed && given.length < c.required) return { code: "E_USAGE", message: c.usage };
  return undefined;
}

function extraArgument(c, a, given) {
  if (!c.operands.length) return `oats ${c.command}: unexpected argument ${JSON.stringify(a)}: ${c.command} takes no argument\n${c.usage}`;
  const last = c.operands.length - 1;
  return `oats ${c.command}: unexpected argument ${JSON.stringify(a)} after the ${c.operands[last]} ${JSON.stringify(given[last])}: ${c.command} takes ${c.operands.map((n) => `one ${n}`).join(" and ")}\n${c.usage}`;
}
