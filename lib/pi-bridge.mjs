/** The pi bridge (`oats-pi`, in the kernel's own npm scope) in every pi folder a launch of a deployment uses: which
 *  folders those are, the bridge found in each, and what `oats update` does there
 *  (awebai/oats#991, #852). `oats doctor` warns from the same list.
 *
 *  This module only reads: the environment it is given, the launch configurations it is given
 *  and each folder's bridge `package.json`. Nothing here runs `pi` or `npm`; `oats update`
 *  (bin/oats.mjs) runs the steps the plan names.
 *
 *  A pi folder of the deployment is the default (`~/.pi/agent`), this process's own
 *  `PI_CODING_AGENT_DIR`, and the `PI_CODING_AGENT_DIR` of each launch configuration whose
 *  harness is pi: "the ambient one and each launch configuration's", as `trustTargets`
 *  (harness-trust-write.mjs) lists the claude and codex configuration files. Homes' recorded
 *  launches are not read: a home keeps a launch its configuration no longer has, and the list
 *  would then depend on every home.
 *
 *  `oats update` moves forward only (awebai/oats#1011): the CLI to a newer version of the
 *  registry, a bridge to the version the kernel has after the run. Neither is ever moved back,
 *  and the registry's answer is checked to be one version before anything is made of it.
 *
 *  The move is one `pi install` over the installed bridge, never an uninstall first: pi
 *  replaces the settings entry and the files of the same package, and an install that fails
 *  leaves the old ones in place (established with pi 1.0.2). The folder's version is read
 *  back after each step, so a pi that behaves otherwise is a named failure, not a silent one. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { compareVersions, parseVersion } from "./resolve.mjs";
import { safeText } from "./refused-text.mjs";
import { HARNESS_FOLDER_VAR, launchConfigFolder } from "./harness-trust.mjs";
import { OATS_PACKAGE_NAME } from "./version.mjs";

/** The kernel and its bridge under the npm name this kernel was installed by, so `oats update` never
 *  crosses from one name to the other. */
const KERNEL_PACKAGE = OATS_PACKAGE_NAME;
export const PI_BRIDGE = `${OATS_PACKAGE_NAME.split("/")[0]}/oats-pi`;
/** The variable that moves pi's folder. */
export const PI_FOLDER_VAR = HARNESS_FOLDER_VAR.pi;

const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const userHome = (env) => env.HOME || homedir();
/** One shell word: as is when it needs no quoting, else single-quoted. */
const shellWord = (value) => /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
const bridgeSpec = (target) => `npm:${PI_BRIDGE}@${target}`;
const configsNamed = (names) => `launch configuration${names.length > 1 ? "s" : ""} ${names.join(", ")}`;

/** One published version as `npm view <package> version` prints it: three numbers and an
 *  optional prerelease, at most 256 characters (npm's own limit). No `v`, no partial version,
 *  no build metadata, no blank: a subset of what `parseVersion` (resolve.mjs) reads. */
const PUBLISHED_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What a registry lookup printed, checked to be one version and nothing else before it reaches
 *  a step, an argument or the screen (awebai/oats#1011): the line, its one line ending aside.
 *  `lookup` is the command that was asked, for the message.
 *  → { version } | { problem }, the answer in `problem` made safe to print: bounded, its control
 *  characters shown as escapes or replaced (refused-text.mjs). */
export function registryVersion(stdout, lookup) {
  const text = String(stdout ?? "").replace(/\r?\n$/, "");
  if (text.length <= 256 && PUBLISHED_VERSION.test(text)) return { version: text };
  return { problem: `\`${lookup}\` answered ${text ? safeText(JSON.stringify(text), 80) : "nothing"}, which is not a version` };
}

/** Version `a` against `b` by the kernel's own ordering (`compareVersions`, resolve.mjs, the
 *  one the compatibility check uses): negative, zero or positive. A prerelease is below its
 *  release, and build metadata orders nothing (`0.53.0+build.1` equals `0.53.0`). null when
 *  either is not a version: what cannot be compared is neither ahead nor the same. */
function versionOrder(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  return pa && pb ? compareVersions(pa, pb) : null;
}
const isAhead = (a, b) => versionOrder(a, b) > 0;
/** The same version: the same text, or two spellings that compare equal. */
const sameVersion = (a, b) => a === b || versionOrder(a, b) === 0;

/** The kernel's own lookup, as arguments: the version the registry lists for the CLI. */
export const kernelLookup = () => ["npm", "view", KERNEL_PACKAGE, "version"];

/** What that lookup says, from what spawnSync returned for it (`ran`, both streams captured):
 *  → { version }, checked (registryVersion), or { problem }, the message that stops the update.
 *  Nothing npm printed reaches the screen as it came, on either stream: a failed lookup's error
 *  output is in the message bounded and made safe to print, and a lookup that ended well has its
 *  error output dropped. */
export function kernelLookupResult(ran) {
  if (ran.error || ran.status !== 0) {
    const said = String(ran.stderr ?? "").trim();
    return { problem: `cannot check npm for the latest version: ${ran.error ? ran.error.message : `exit ${ran.status ?? ran.signal}`}${said ? `: ${safeText(JSON.stringify(said), 300)}` : ""}` };
  }
  const checked = registryVersion(ran.stdout, kernelLookup().join(" "));
  return checked.problem ? { problem: `${checked.problem}. Nothing was changed. Run \`oats update\` again.` } : checked;
}

/** The CLI's own part of `oats update`, forward only: the install `step` only when the registry's
 *  version is newer than the installed one, and the `target` of the bridges, which is the
 *  version the kernel has after the run. An installed version ahead of the registry (a checkout,
 *  a build not yet published) is left alone, with the `note` that says so; one that is the same
 *  version (a local build's metadata aside) is left alone too. An installed version that cannot
 *  be compared is another version, and the step is proposed. `registry` is a checked version
 *  (registryVersion).
 *  → { installed, registry, target, ahead, step?: { argv, display }, note? } */
export function planCliUpdate(installed, registry) {
  if (isAhead(installed, registry)) return { installed, registry, target: installed, ahead: true, note: `The installed ${installed} is ahead of the registry's ${registry}: nothing to do for the CLI.` };
  if (sameVersion(installed, registry)) return { installed, registry, target: installed, ahead: false };
  const argv = ["npm", "install", "-g", `${KERNEL_PACKAGE}@${registry}`];
  return { installed, registry, target: registry, ahead: false, step: { argv, display: argv.join(" ") } };
}

/** The last OATS Desktop with the hard CLI ceiling: it refuses every CLI newer than its own minor version.
 *  Every later Desktop accepts such a CLI and holds back what it was not tested with (oats-project/oats#1879,
 *  option 3). The release lane corrects this one value if another 0.69 patch ships before the soft ceiling;
 *  test/release-packaging.test.mjs and test/above-tested-wording.test.mjs read it from here. */
export const LAST_HARD_CEILING_DESKTOP = "0.69.17";

/** The line `oats update` prints under its steps when the CLI's install (`cli`, from planCliUpdate) moves
 *  it to another minor or major version. A Desktop accepts a newer CLI and holds back every change it was
 *  not tested with until it is updated (docs/upgrading.md, "Either order works"); its core sentence is the
 *  Desktop's own notice for the same version, written here because the kernel imports nothing of its
 *  clients (packages/client/above-tested-notice.mjs `heldBackSentence`; test/above-tested-wording.test.mjs
 *  holds the two equal). An older Desktop, one with the hard ceiling, refuses the CLI instead, which the
 *  line says after the core. Fixed text, whether or not a Desktop is installed here: one on another host,
 *  or installed another way, would not be seen. Prerelease and build metadata do not count (0.56.0-rc.1 to
 *  0.56.0 says nothing); an installed version that cannot be read is another minor.
 *  → the line, or null when there is no install or it stays within the minor. */
export function desktopFirstLine(cli) {
  if (!cli.step) return null;
  const from = parseVersion(cli.installed), to = parseVersion(cli.target);
  if (from && to && from.major === to.major && from.minor === to.minor) return null;
  const minor = to ? `${to.major}.${to.minor}` : cli.target;
  return `An OATS Desktop older than ${minor} holds actions back with this CLI. `
    + `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${cli.target}. `
    + `(An OATS Desktop of ${LAST_HARD_CEILING_DESKTOP} or older refuses this CLI until then.)`;
}

/** The lookup `oats update` makes before any step, as arguments: the bridge's exact version on
 *  the registry, with npm told to revalidate its cache (awebai/oats#852). */
export const bridgeLookup = (target) => ["npm", "view", `${PI_BRIDGE}@${target}`, "version", "--prefer-online"];

/** What that lookup says, from what spawnSync returned for it (`ran`): null when the version was
 *  seen (exit 0 and the checked answer is the target's version: npm answers a local build's
 *  `0.53.0+build.1` with the `0.53.0` it lists), else the message that stops the update.
 *  An answer that is not a version is said to be that, with the lookup named; any other is "not
 *  seen", an older npm's exit 0 with no output included. When the installed kernel is ahead of
 *  the registry (`cli`, from planCliUpdate), the message says so: its bridge is not one that
 *  appears in a few minutes. */
export function bridgeLookupProblem(ran, cli) {
  const { target } = cli;
  const answered = !ran.error && ran.status === 0 && String(ran.stdout ?? "").trim() ? registryVersion(ran.stdout, bridgeLookup(target).join(" ")) : null;
  if (answered?.problem) return `${answered.problem}. Nothing was changed, and every bridge is in place. Run \`oats update\` again.`;
  if (answered?.version && sameVersion(answered.version, target)) return null;
  const why = ran.error ? ran.error.message : ran.status !== 0 ? `exit ${ran.status}` : answered ? `it answered ${answered.version}` : "no answer";
  const notSeen = `${PI_BRIDGE}@${target} was not seen on the registry (npm view: ${why})`;
  if (cli.ahead) return `${notSeen}: the installed kernel ${cli.installed} is ahead of the registry's ${cli.registry}, so its bridge may not be published. Nothing was changed, and every bridge is in place. Run \`oats update\` again once npm lists ${cli.installed}.`;
  return `${notSeen}: a version is listed a few minutes after it is published. Nothing was changed, and every bridge is in place. Run \`oats update\` again in a few minutes.`;
}

/** The pi folders of a deployment, in a fixed order: the default, this process's own, then each
 *  pi launch configuration's in name order. Folders are deduplicated by real path; one keeps
 *  every reason it is listed for, and the path it was first named by. A folder that cannot be
 *  resolved is listed with its `problem` and no `dir`, never dropped.
 *  → [{ dir, real, reasons: [{ kind: "default" | "shell" | "launch-config", name?, executable? }], problem? }] */
export function piFolders({ env = process.env, launchConfigs = {} } = {}) {
  const folders = [], byReal = new Map();
  const add = (dir, reason) => {
    const key = real(dir);
    if (byReal.has(key)) { byReal.get(key).reasons.push(reason); return; }
    const folder = { dir, real: key, reasons: [reason] };
    byReal.set(key, folder);
    folders.push(folder);
  };
  const unresolved = (reason, found) => folders.push({ dir: null, real: null, reasons: [reason], problem: found.problem, ...(found.fromEnv ? { fromEnv: found.fromEnv } : {}) });
  add(join(userHome(env), ".pi", "agent"), { kind: "default" });
  // An empty value is not set, as core.mjs reads it (piAgentDir).
  if (env[PI_FOLDER_VAR]) {
    const found = launchConfigFolder(PI_FOLDER_VAR, { [PI_FOLDER_VAR]: env[PI_FOLDER_VAR] }, env);
    if (found.problem) unresolved({ kind: "shell" }, found); else add(found.dir, { kind: "shell" });
  }
  for (const config of Object.values(launchConfigs).filter((c) => c.harness === "pi").sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const found = launchConfigFolder(PI_FOLDER_VAR, config.env, env);
    if (!found) continue;
    // A relative executable is a path against the deployment directory, as a launch resolves it.
    const executable = config.executable?.includes("/") && !isAbsolute(config.executable) && config.source ? resolve(config.source, config.executable) : config.executable;
    const reason = { kind: "launch-config", name: config.name, ...(executable !== undefined ? { executable } : {}) };
    if (found.problem) unresolved(reason, found); else add(found.dir, reason);
  }
  return folders;
}

/** Why a folder is looked at: "the default", "this shell's PI_CODING_AGENT_DIR", "launch configurations a, b". */
export function whyLookedAt(folder) {
  const configs = folder.reasons.filter((r) => r.kind === "launch-config").map((r) => r.name);
  return [
    ...(folder.reasons.some((r) => r.kind === "default") ? ["the default"] : []),
    ...(folder.reasons.some((r) => r.kind === "shell") ? [`this shell's ${PI_FOLDER_VAR}`] : []),
    ...(configs.length ? [configsNamed(configs)] : []),
  ].join(", ");
}

/** The bridge in a pi folder, read where pi installs it:
 *  → { status: "no-folder" | "no-bridge" | "installed" | "unreadable", file, version?, problem? } */
export function piBridgeState(dir) {
  const file = join(dir, "npm", "node_modules", ...PI_BRIDGE.split("/"), "package.json");
  if (!existsSync(dir)) return { status: "no-folder", file };
  if (!existsSync(file)) return { status: "no-bridge", file };
  let version;
  try { version = JSON.parse(readFileSync(file, "utf8")).version; } catch { return { status: "unreadable", file, problem: `${file} cannot be read as JSON` }; }
  if (typeof version !== "string" || !version) return { status: "unreadable", file, problem: `${file} names no version` };
  return { status: "installed", file, version };
}

/** `piFolders`, each resolved one with the `bridge` found in it. */
export function piBridgeFolders(options) {
  return piFolders(options).map((folder) => folder.dir ? { ...folder, bridge: piBridgeState(folder.dir) } : folder);
}

/** `oats doctor`'s warnings: one per folder whose bridge is not the kernel's version (two
 *  spellings that compare equal are one version, as in the plan below), and one per folder that
 *  could not be looked at. A folder that does not exist or holds no bridge is not a skew.
 *  A bridge ahead of the kernel is a skew too, with its own ending: `oats update` moves no bridge
 *  back, and doctor reads no registry, so it says what ends the skew instead of "run `oats update`". */
export function piBridgeSkewWarnings(folders, kernelVersion) {
  const warnings = [];
  for (const folder of folders) {
    const why = whyLookedAt(folder);
    if (folder.problem) warnings.push(`pi bridge not checked — ${why}: ${folder.problem}, so its pi folder could not be looked at; \`oats update\` says what to run there`);
    else if (folder.bridge.status === "unreadable") warnings.push(`pi bridge not checked in ${folder.dir} (${why}) — ${folder.bridge.problem}; \`oats update\` says what to run there`);
    else if (folder.bridge.status === "installed" && !sameVersion(folder.bridge.version, kernelVersion)) {
      const ending = isAhead(folder.bridge.version, kernelVersion)
        ? `the bridge is ahead of the kernel, and \`oats update\` never moves a bridge back. The skew ends when the kernel is at ${folder.bridge.version} (\`oats update\` moves it once npm lists that version), or when the kernel's bridge is installed there by hand (docs/upgrading.md, "By hand")`
        : "run `oats update` (they publish in lockstep)";
      warnings.push(`version skew — kernel ${kernelVersion}, pi bridge ${folder.bridge.version} in ${folder.dir} (${why}); ${ending}`);
    }
  }
  return warnings;
}

/** What `oats update` does in each folder to bring its bridge to `target`, the version the
 *  kernel has after the run (planCliUpdate):
 *  - `move`: the bridge is at another version, and not ahead of `target`; `step` is the one
 *    command, as arguments. A version that cannot be compared is another version.
 *  - `leave`: already at `target` (the same version, a build's metadata aside), or `ahead` of
 *    it: a bridge is never moved back.
 *  - `none`: no folder, or no bridge in it. `oats update` installs no first bridge.
 *  - `skip`: not touched, with the `detail` and, where there are any, the `commands` to run
 *    there: a folder that does not resolve, a bridge that cannot be read, or a folder named only
 *    by launch configurations that run their own executable (update never runs a wrapper).
 *    One command per distinct executable, each with the configurations it is for (`where`) when
 *    there are several.
 *  The step runs the plain `pi` on PATH with PI_CODING_AGENT_DIR set to the folder, except for
 *  the default folder when `env` sets none, and with pi's npm told to revalidate its cache.
 *  `detail` is the plan's line for the folder: what was found there, then what happens.
 *  → the folders, each with { action, detail, ahead?, commands?: [{ command, where? }], step?: { argv, env, display } } */
export function planPiBridges(folders, target, { env = process.env } = {}) {
  return folders.map((folder) => {
    const wrapped = folder.reasons.every((r) => r.kind === "launch-config" && r.executable !== undefined);
    // The programs a by-hand command names: the plain `pi`, or each distinct executable of the
    // configurations, in their order, with the names of those that run it.
    const programs = new Map();
    for (const r of wrapped ? folder.reasons : []) programs.set(r.executable, [...(programs.get(r.executable) ?? []), r.name]);
    if (!wrapped) programs.set("pi", []);
    const byHand = (folderWord, where) => [...programs].map(([program, names]) => {
      const said = where ?? (programs.size > 1 ? `for ${configsNamed(names)}` : null);
      return { command: `${PI_FOLDER_VAR}=${folderWord} ${shellWord(program)} install ${bridgeSpec(target)}`, ...(said ? { where: said } : {}) };
    });
    if (folder.problem) {
      return { ...folder, action: "skip", detail: `not touched: ${folder.problem}`, ...(folder.fromEnv ? { commands: byHand(`"$${folder.fromEnv}"`, `where ${folder.fromEnv} is set`) } : {}) };
    }
    const { bridge } = folder;
    if (bridge.status === "no-folder") return { ...folder, action: "none", detail: "no bridge (the folder does not exist): not touched" };
    if (bridge.status === "no-bridge") return { ...folder, action: "none", detail: "no bridge: not touched" };
    if (bridge.status === "unreadable") return { ...folder, action: "skip", detail: `bridge not read: not touched: ${bridge.problem}`, commands: byHand(shellWord(folder.dir)) };
    if (sameVersion(bridge.version, target)) return { ...folder, action: "leave", detail: `bridge ${bridge.version}: left alone, already at ${target}` };
    if (isAhead(bridge.version, target)) return { ...folder, action: "leave", ahead: true, detail: `bridge ${bridge.version}: left alone, ahead of ${target}` };
    if (wrapped) {
      const names = folder.reasons.map((r) => r.name);
      return { ...folder, action: "skip", detail: `bridge ${bridge.version}: not touched: ${configsNamed(names)} run${names.length > 1 ? " their" : "s its"} own executable, and \`oats update\` runs no wrapper`, commands: byHand(shellWord(folder.dir)) };
    }
    const setsFolder = !(folder.reasons.some((r) => r.kind === "default") && !env[PI_FOLDER_VAR]);
    const stepEnv = { ...(setsFolder ? { [PI_FOLDER_VAR]: folder.dir } : {}), npm_config_prefer_online: "true" };
    const argv = ["pi", "install", bridgeSpec(target)];
    const display = [...Object.entries(stepEnv).map(([name, value]) => `${name}=${shellWord(value)}`), ...argv.map(shellWord)].join(" ");
    return { ...folder, action: "move", detail: `bridge ${bridge.version}: move to ${target}`, step: { argv, env: stepEnv, display } };
  });
}

/** The plan's lines, two or more per folder: the folder and why it is looked at, what happens
 *  there, and each command to run where update does not. Then one line when the installed kernel
 *  is ahead of the registry (`cli`, from planCliUpdate) and a bridge is to move to its version:
 *  the plan makes no lookup, so it does not know that this version is published, and the run
 *  stops before any step when it is not (bridgeLookupProblem). */
export function piBridgePlanLines(plan, cli = {}) {
  const lines = [];
  for (const entry of plan) {
    lines.push(`  ${entry.dir ?? "(not resolved)"}  (${whyLookedAt(entry)})`);
    lines.push(`    ${entry.detail}`);
    for (const { command, where } of entry.commands ?? []) lines.push(`    run there${where ? `, ${where}` : ""}: ${command}`);
  }
  if (cli.ahead && plan.some((entry) => entry.step)) lines.push(`  A bridge moves to ${cli.target} only if ${PI_BRIDGE}@${cli.target} is published: the installed kernel is ahead of the registry's ${cli.registry}, and a run checks that before any step.`);
  return lines;
}

/** Why a bridge step did not do its work, or null when the folder is now at `target` (as the plan
 *  reads "the same version"): the run's own failure (`problem`), or a run that ended well with
 *  another version in the folder. */
export function piBridgeStepProblem(entry, target, problem) {
  if (problem) return problem;
  const now = piBridgeState(entry.dir);
  return now.status === "installed" && sameVersion(now.version, target) ? null : `pi ended without an error, but the bridge there is not ${target}`;
}

/** The message of a step that failed: the folder and the exact step to run again, what the
 *  folder holds now (read from it, not assumed), and the folders not reached. `entry` is the
 *  folder of the failed step, absent when the step was not a folder's (the CLI's own). */
export function piBridgeFailure({ entry, display, problem, notReached = [] }) {
  const lines = [];
  if (entry) {
    const now = piBridgeState(entry.dir), before = entry.bridge.version;
    const holds = now.status === "installed" ? (now.version === before ? `the bridge there is still ${before}` : `the bridge there is now ${now.version}`)
      : now.status === "unreadable" ? `the bridge there cannot be read (${now.problem})`
      : "the bridge is now ABSENT there: a pi session started with this folder has no OATS extension until the step succeeds";
    lines.push(`step failed in ${entry.dir} (${whyLookedAt(entry)}): ${problem}`, `  ${holds}`, `  run it again: ${display}`);
  } else lines.push(`step failed: ${display}: ${problem}`, "  no pi folder was touched");
  if (notReached.length) lines.push(`  not reached (run \`oats update\` again for ${notReached.length > 1 ? "them" : "it"}):`, ...notReached.map((e) => `    ${e.dir}  (${whyLookedAt(e)})`));
  return lines.join("\n");
}
