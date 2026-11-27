#!/usr/bin/env node
// oats.bb: the bb session provider. `session <verb>` is the kernel's to call (JSON in on
// stdin, one JSON document out); `retire-hook` is its retire hook; `doctor` is a person's.
import { sessionHandlers } from "../lib/commands.mjs";
import { bounded } from "../lib/errors.mjs";
import { removeLaunchSettings, removeLeftovers, sandboxKeysOf } from "../lib/local-settings.mjs";
import { clearHomeProjectEnv } from "../lib/project-env.mjs";
import { FULL_MODE_ONLY, readinessResult } from "../lib/readiness.mjs";
import { DEFAULT_DAEMON_PORT, readSettings } from "../lib/settings.mjs";
import { retire } from "../lib/stop.mjs";
import { PROVIDER, VERBS, answer, readStdin, settingsFromEnv } from "../lib/wire.mjs";

// The command takes no launch in a sandboxed mode: they are not offered (lib/commands.mjs says why).
const handlers = sessionHandlers();
/** doctor's arguments: `--json`, and `--soul <name>`, which the kernel reads to choose
 *  whose settings it resolves into OATS_SETTINGS and then forwards: it changes nothing
 *  here. → {json} | null for anything else. */
function doctorArgs(args) {
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--soul" && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--")) i += 1;
    else if (!/^--soul=.+/.test(args[i])) return null;
  }
  return { json };
}
// Every line a hook prints: a warning is cut to what the kernel relays.
const print = (doc) => process.stdout.write(`${JSON.stringify(typeof doc?.warning === "string" ? { ...doc, warning: bounded(doc.warning) } : doc)}\n`);

const USAGE = `oats bb: the bb session provider (oats.bb)

  oats bb doctor [--json] [--soul <name>]
                             check this deployment's bb: server, host daemon (and the port
                             bb's CLI is told to find it at), version,
                             exposure, trust, bb's claude-code provider (and, as a warning, what
                             a pi launch would be refused for), orphaned threads
                             (--soul: whose settings to read; the kernel resolves them)

Called by the kernel (JSON on stdin, one JSON document on stdout):
  session launch | inspect | inspectMany | input | stop | check
  launch-hook                on another backend, removes what the provider wrote into the home
                             and into the env of its bb project
  retire-hook                archives the home's bb threads at retire, removes the env of
                             its bb project, and deletes its bb environment where every
                             thread on it is the home's own
`;

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "session" && VERBS.includes(rest[0]) && rest.length === 1) {
    print(await answer(rest[0], await readStdin(), handlers));
    return 0;
  }
  if (command === "launch-hook" && rest.length === 0) {
    // Runs at every start of a home that has this capability, whatever its backend. On
    // this provider the launch verb writes Claude's local settings. Where the home ran on
    // bb before and now starts on another backend, the provider's keys are removed, so
    // a tmux Claude neither reads a stale launch env nor keeps the sandbox block and the deny rules.
    // Which backend it ran on before is the kernel's word (OATS_PREVIOUS_BACKEND, from its
    // record outside the home), never anything the home holds: a tmux home a person set
    // up by hand keeps its own `env`.
    const home = process.env.OATS_INSTANCE_HOME, backend = process.env.OATS_BACKEND, previous = process.env.OATS_PREVIOUS_BACKEND;
    if (!home) { process.stderr.write("oats bb launch-hook: OATS_INSTANCE_HOME is not set\n"); return 2; }
    if (!backend || backend === PROVIDER || process.env.OATS_LAUNCH_PREVIEW === "1") return 0;
    // What an earlier version of the provider kept in the home goes, unread, whatever the
    // home ran on: those names are the provider's own, and they decide nothing (best effort).
    removeLeftovers(home);
    if (!previous) {
      // A first launch, or a kernel that does not say: nothing is removed. Where the file
      // holds what only this provider writes there (a sandbox block, or bb's directory-move
      // tool in the deny list), it may be the provider's, left behind. A person's own deny
      // rules are not that: a home that never ran on bb is told nothing.
      const keys = sandboxKeysOf(home);
      if (keys.sandbox || keys.deny) print({ warning: `this home starts on ${backend}, its .claude/settings.local.json holds sandbox keys as the bb provider writes them (sandbox, permissions.deny, permissions.blockWritesOutsideWorkingDirectories), and this kernel does not say which backend the home ran on before: the bb provider removed nothing. If the home ran on bb, those keys and the env key are the provider's and may be stale: remove them by hand` });
      return 0;
    }
    if (previous !== PROVIDER) return 0;
    // The kernel relays the warning of the hook's last line, 500 characters of it: everything is
    // said in one, each part short and with its remedy before its cause, so that both remedies
    // fit when both things fail.
    const said = [];
    // Why the settings file could not be changed goes last: it may be long, and a cut takes it.
    let why = "";
    try {
      if (removeLaunchSettings(home)) said.push("the bb provider removed its keys from .claude/settings.local.json");
    } catch (error) {
      said.push(`the bb provider's keys could not be removed from .claude/settings.local.json: remove env, sandbox, permissions.deny and permissions.blockWritesOutsideWorkingDirectories there by hand`);
      why = ` Why the file could not be changed: ${error?.message ?? error}`;
    }
    // And what a pi launch wrote into the env of the home's bb project (contract r23,
    // A12(2)): bb is asked, and a bb that cannot be asked is a warning, never a failed
    // start on the other backend.
    const env = await clearHomeProjectEnv(home, () => readSettings(settingsFromEnv(process.env)), { deadline: Date.now() + 15_000 });
    if (env.warning !== null) said.push(env.warning);
    else if (env.removed.length > 0) said.push(`the bb provider removed the launch env it kept in the home's bb project (${env.removed.length} variable${env.removed.length > 1 ? "s" : ""})`);
    if (said.length > 0) print({ warning: `this home starts on ${backend}, no longer on bb: ${said.join(". ")}${why ? `.${why}` : ""}` });
    return 0;
  }
  if (command === "retire-hook" && rest.length === 0) {
    const home = process.env.OATS_INSTANCE_HOME;
    if (!home) { process.stderr.write("oats bb retire-hook: OATS_INSTANCE_HOME is not set\n"); return 2; }
    // What an earlier version of the provider kept in the home goes here too (best effort):
    // a home it launched and nothing started since is not left holding it at its retire.
    removeLeftovers(home);
    // The settings are read inside retire: a failure to read them, or to reach bb, is a
    // warning there, never a failed retire.
    print(await retire(home, () => readSettings(settingsFromEnv(process.env)), { deadline: Date.now() + 40_000 }));
    return 0;
  }
  const doctor = command === "doctor" ? doctorArgs(rest) : null;
  if (doctor !== null) {
    const settings = readSettings(settingsFromEnv(process.env));
    const { result, credential } = await readinessResult(settings);
    result.warnings.push({ ...FULL_MODE_ONLY });
    // Which host daemon port bb's CLI is told (settings.oats.bb.hostDaemonPort), or that it
    // is told none: bb's CLI then uses its own default (a port in this command's
    // environment never reaches it).
    if (doctor.json) print({ ...result, credential, hostDaemonPort: settings.hostDaemonPort });
    else {
      process.stdout.write(`bb session provider: ${result.status}\n`);
      process.stdout.write(`  host daemon port: ${settings.hostDaemonPort === null ? `default ${DEFAULT_DAEMON_PORT}` : `${settings.hostDaemonPort} (settings.oats.bb.hostDaemonPort)`}\n`);
      for (const problem of result.problems) process.stdout.write(`  problem ${problem.code}: ${problem.message}\n`);
      for (const warning of result.warnings) process.stdout.write(`  warning ${warning.code}: ${warning.message}\n`);
      if (credential) process.stdout.write(`  claude-code credential: ${credential}\n`);
    }
    return result.status === "ready" ? 0 : 1;
  }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") { process.stdout.write(USAGE); return 0; }
  process.stderr.write(`oats bb: unknown command ${JSON.stringify(argv.join(" "))}\n\n${USAGE}`);
  return 2;
}

// A rejection here is an outcome in doubt (or a bug): nothing on stdout, a nonzero exit.
// So is a process that runs out of work before main has finished (a wait that nothing
// keeps alive): it must never end with status 0 and no answer, which reads as success.
let finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  process.stderr.write("oats bb: ended before it had an answer\n");
  process.exitCode = 1;
});
main(process.argv.slice(2)).then((code) => { finished = true; process.exitCode = code; }, (error) => {
  finished = true;
  process.stderr.write(`oats bb: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
