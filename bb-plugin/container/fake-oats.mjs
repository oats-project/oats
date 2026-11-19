#!/usr/bin/env node
// A fake `oats` for the plugin's tests: it prints the recorded answer of the verb it is asked
// (test/fixtures/) and logs every call. It stands at the one real boundary the plugin has, the
// `oats` process; the fixtures it prints are recorded from the real kernel or shaped as its
// reference documents them (test/fixtures/README.md).
//
// Configuration: the JSON file named by FAKE_OATS_CONFIG, else `fake-oats.json` beside this script:
//   { "fixtures": "<dir of the fixture files>",
//     "log": "<file: one JSON line per call>",              (optional)
//     "verbs": { "<verb>": { "file": "x.json" | "stdout": "…", "exit": 0, "sleepMs": 0,
//                            "grandchild": false, "stderr": "…" } } }   (optional overrides)
// A verb is the command's words: status, souls, capabilities, teams, "server list",
// "spawn --preview", spawn, "instance stop --plan", "instance stop --apply", "session start",
// "session restart", "retire --plan", retire. The verb "*" overrides every one.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(process.env.FAKE_OATS_CONFIG ?? join(here, "fake-oats.json"), "utf8"));
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

const defaults = {
  status: { file: "status.json" },
  souls: { file: "souls.json" },
  capabilities: { file: "capabilities.json" },
  teams: { file: "teams.json" },
  "server list": { file: "servers.json" },
  "spawn --preview": { file: "spawn-preview.json" },
  spawn: { file: "spawn.json" },
  "instance stop --plan": { file: "stop-plan.json" },
  "instance stop --apply": { file: "stop-apply.json" },
  "session start": { file: "start.json" },
  "session restart": { file: "restart.json" },
  "retire --plan": { file: "retire-plan.json" },
  retire: { file: "retire-apply.json" },
};

function verbOf() {
  const [first, second] = argv;
  if (first === "spawn") return has("--preview") ? "spawn --preview" : "spawn";
  if (first === "instance" && second === "stop") return has("--plan") ? "instance stop --plan" : "instance stop --apply";
  if (first === "session" || first === "server") return `${first} ${second}`;
  if (first === "retire") return has("--plan") ? "retire --plan" : "retire";
  return first ?? "";
}

const verb = verbOf();
const known = defaults[verb];
const behaviour = { ...known, ...config.verbs?.["*"], ...config.verbs?.[verb] };

const call = { at: new Date().toISOString(), pid: process.pid, verb, argv, cwd: process.cwd() };
const taskFile = after("--task-file");
if (taskFile !== undefined) {
  try {
    call.taskFile = { path: taskFile, mode: (statSync(taskFile).mode & 0o777).toString(8), text: readFileSync(taskFile, "utf8") };
  } catch (error) {
    call.taskFile = { path: taskFile, error: error.code };
  }
}
if (behaviour.grandchild) {
  // A child of this process's own, in its process group: it must not outlive a killed `oats`.
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  call.grandchild = child.pid;
}
if (config.log) appendFileSync(config.log, `${JSON.stringify(call)}\n`);

function answer() {
  if (behaviour.stderr) process.stderr.write(behaviour.stderr);
  if (known === undefined && behaviour.file === undefined && behaviour.stdout === undefined) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_UNKNOWN_COMMAND", message: `fake oats: no answer for "${argv.join(" ")}"` } })}\n`);
    process.exit(1);
  }
  const text = behaviour.stdout ?? readFileSync(join(config.fixtures, behaviour.file), "utf8");
  let exit = behaviour.exit;
  if (exit === undefined) {
    // Like the kernel: a refusal exits nonzero.
    try {
      exit = JSON.parse(text).ok === false ? 1 : 0;
    } catch {
      exit = 0;
    }
  }
  process.stdout.write(text, () => process.exit(exit));
}

if (behaviour.sleepMs) setTimeout(answer, behaviour.sleepMs);
else answer();
