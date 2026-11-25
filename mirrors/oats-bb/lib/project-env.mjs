// The launch env of a pi thread: three variables, in the env of the home's bb project
// (contract r23, A12(2)).
//
// bb starts pi itself, and pi reads no settings file of the home for its environment, so
// the one way a launch's variables reach the thread's pi (and its tools) is bb's own
// project env: `bb machine env set <NAME> --project <id>`, the value on stdin. bb keeps
// that in its database (and shows no value back: `value: null, secret: true`).
//
// So only three names ever go there: OATS_INSTANCE and OATS_INSTANCE_HOME, which say
// which home this is and hold nothing else (without the second, @awebai/oats-pi loads none
// of the home's skills), and PATH, which puts the home's kernel shim first. Nothing a
// capability or a launch configuration adds to a launch's env is carried: a harness
// credential must never land in bb's database, and no rule over names could promise that.
//
// The home's bb project is the provider's (it makes it, rooted at the home), and so is its
// env, whole: a pi launch makes it exactly those three, removing every other name; the
// retire hook and a move to another backend remove all of it. A Claude launch of the same
// home removes those three (bb hands a project's env to every thread of it, and starts
// `claude` by a project PATH) and leaves any other name. No record of it is kept in
// the home. One project is one home: a project with a second root would hand the env to
// whatever runs there, and a pi launch refuses it.
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { bbClient } from "./bb.mjs";
import { ProviderError, fail, isObject, someOf } from "./errors.mjs";
import { withPathPrepend } from "./local-settings.mjs";
import { loopbackOrigin } from "./settings.mjs";
import { projectsOfHome, samePath } from "./threads.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The kernel's own two: which home this is. Carried only as the kernel's.
const KERNEL_NAMES = new Set(["OATS_INSTANCE", "OATS_INSTANCE_HOME"]);
/** The only names a pi launch ever writes into a bb project's env. */
export const PI_ENV_NAMES = Object.freeze(["OATS_INSTANCE", "OATS_INSTANCE_HOME", "PATH"]);

/** The env a pi launch carries, from the launch input's `env` and `pathPrepend`: at most
 *  OATS_INSTANCE, OATS_INSTANCE_HOME and PATH. PATH holds paths only: the launch's
 *  directories (`pathPrepend`: the home's kernel shim directory), then the PATH the
 *  provider itself was called with. Never a value out of a launch's env, a PATH entry
 *  included.
 *
 *  Every other entry is not carried. What becomes of it depends on who asked:
 *  - the kernel's and a capability's (oats.aweb's AWEB_DELIVERY and AWEB_IDENTITY_HOME come
 *    with every launch): left out. They are not a person's request, and refusing them
 *    would refuse every pi home that has messaging.
 *  - a launch configuration's, a secret one's, or one of a source this provider does not
 *    know: refused by name (E_BACKEND_LAUNCH_ENV). A person asked for it and it cannot
 *    reach pi; left out, it would look like a setting that works.
 *  The value is never part of a message. */
export function piLaunchEnv(env, pathPrepend, ambientPath) {
  if (env !== undefined && env !== null && !Array.isArray(env)) throw fail("E_BACKEND_LAUNCH_ENV", "the launch env must be a list of {name, value, source}");
  const out = {};
  const seen = new Set();
  for (const entry of env ?? []) {
    if (!isObject(entry) || typeof entry.name !== "string") throw fail("E_BACKEND_LAUNCH_ENV", "a launch env entry has no name");
    const from = typeof entry.source === "string" && entry.source ? ` (source ${entry.source}${typeof entry.capability === "string" ? `, ${entry.capability}` : ""})` : "";
    if (!NAME.test(entry.name)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env entry ${JSON.stringify(entry.name)}${from} is not a variable name`);
    if (seen.has(entry.name)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env names ${entry.name} twice`);
    seen.add(entry.name);
    const plain = entry.secret === undefined || entry.secret === false;
    const ownSource = entry.source === "kernel" || entry.source === "capability";
    const carried = plain && KERNEL_NAMES.has(entry.name) && entry.source === "kernel";
    if (carried) {
      if (typeof entry.value !== "string" || /[\0\n\r]/.test(entry.value)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env entry ${entry.name}${from} is not a one-line string`);
      out[entry.name] = entry.value;
      continue;
    }
    // OATS's own additions: left out, whatever they hold (a secret mark included: it is
    // then simply not written anywhere).
    if (ownSource) continue;
    throw fail("E_BACKEND_LAUNCH_ENV", `the launch sets ${entry.name}${from}, and the bb backend carries nothing of a launch's environment to a pi thread but OATS_INSTANCE, OATS_INSTANCE_HOME and PATH: bb would keep it in its database, where a credential must never land. Remove it from the launch; what pi needs of this host belongs in the bb server's own environment`);
  }
  return withPathPrepend(out, pathPrepend, ambientPath);
}

/** A file that can be run: a directory of that name passes the access check, and is none. */
function executable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

/** The program a script asks `env` to run it with (`#!/usr/bin/env node`), or null: for a
 *  file that is no such script (a binary, another shebang) or cannot be read. */
function envInterpreter(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(256);
    const line = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("latin1").split("\n")[0];
    // `env [-S] [NAME=value ...] program`: the program is the first word that is no assignment.
    // Any other option of env (-i, -u) is not read: such a script is not checked.
    const match = /^#!\s*(?:\/usr)?\/bin\/env\s+(?:-S\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([A-Za-z0-9][A-Za-z0-9._+-]*)(?:\s|$)/.exec(line);
    return match ? match[1] : null;
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** Why the PATH a pi launch gives its thread cannot start pi, or null. bb runs the command
 *  `pi`, found on the thread's PATH, and a project PATH replaces the one bb's own process
 *  has: with no pi on it, or without the program pi is run with (pi is a script that asks
 *  `env` for node), the spawn answers a thread and the thread then dies ("pi exited (code
 *  127)"). Asked only of a launch that carries a PATH. → {code, message} | null. */
export function piPathRefusal(path, { isExecutable = executable, interpreterOf = envInterpreter } = {}) {
  if (typeof path !== "string") return null;
  const dirs = path.split(delimiter).filter((dir) => dir && isAbsolute(dir));
  const find = (name) => dirs.map((dir) => join(dir, name)).find((file) => isExecutable(file)) ?? null;
  const pi = find("pi");
  const remedy = (program) => `bb starts the command \`pi\` by that PATH (the launch's directories, then the PATH oats itself runs with), so the thread would end as soon as it started. Put ${program}'s directory on the PATH of the process that runs oats, then start again. Nothing was started`;
  if (pi === null) return { code: "E_BACKEND_LAUNCH_ENV", message: `the PATH this launch gives its bb thread holds no pi: ${remedy("pi")}` };
  const needs = interpreterOf(pi);
  if (needs !== null && find(needs) === null) return { code: "E_BACKEND_LAUNCH_ENV", message: `the PATH this launch gives its bb thread holds pi and not ${needs}, which pi is run with: ${remedy(needs)}` };
  return null;
}

/** Why the home's bb project cannot take a pi launch's env, or null: it has a root other
 *  than the home, so its env would reach threads that run elsewhere (another home's, a
 *  person's). → {code, message} | null. `project`: the home's project, or null when the
 *  launch will make one (bb roots a project it creates at the one directory given). */
export function sharedProjectRefusal(project, home) {
  if (project === null) return null;
  const roots = (project.sources ?? []).filter((source) => isObject(source) && typeof source.path === "string").map((source) => source.path);
  const others = roots.filter((root) => !samePath(root, home));
  if (others.length === 0) return null;
  return { code: "E_SESSION_START_FAILED", message: `bb project ${project.id} is rooted at this home and at ${others.length > 1 ? `${others.length} other directories` : "another directory"}: one home is one bb project, and a pi launch writes the home's env into its project, where every thread of the project would get it. Remove the other root${others.length > 1 ? "s" : ""} from that project in bb, or archive its threads and delete it so that the launch makes a new one. Nothing was started. Also rooted at: ${someOf(others, 3)}` };
}

/** Make the project's env exactly this launch's: every name bb holds for the project that
 *  the launch does not carry is removed, then each of the launch's is set. Only the three
 *  names a pi launch may carry are ever set: anything else here is a bug, and throws.
 *  Throws E_SESSION_START_FAILED naming the variable, never its value. */
export async function writeProjectEnv(bb, projectId, env) {
  const stray = Object.keys(env).find((name) => !PI_ENV_NAMES.includes(name));
  if (stray !== undefined) throw new Error(`the bb provider would have written ${stray} into a bb project's env`);
  for (const name of await bb.projectEnvNames(projectId)) {
    if (Object.hasOwn(env, name)) continue;
    const removed = await bb.envUnset(projectId, name);
    if (!removed.ok) throw fail("E_SESSION_START_FAILED", `the launch env could not be written to bb project ${projectId}: bb machine env unset ${name} failed (${removed.message})`);
  }
  for (const [name, value] of Object.entries(env)) {
    const set = await bb.envSet(projectId, name, value);
    if (!set.ok) throw fail("E_SESSION_START_FAILED", `the launch env could not be written to bb project ${projectId}: bb machine env set ${name} failed (${set.message})`);
  }
}

/** For a Claude launch: remove from the project's env the three names a pi launch of this
 *  home may have left there, and nothing else (a Claude launch owns no project env: any
 *  other name is left as it is). Throws E_SESSION_START_FAILED naming the variable. */
export async function removePiEnv(bb, projectId) {
  for (const name of await bb.projectEnvNames(projectId)) {
    if (!PI_ENV_NAMES.includes(name)) continue;
    const removed = await bb.envUnset(projectId, name);
    if (!removed.ok) throw fail("E_SESSION_START_FAILED", `what a pi launch may have left in the env of bb project ${projectId} could not be removed: bb machine env unset ${name} failed (${removed.message})`);
  }
}

/** Remove what bb holds as the project's env: every name, or `only` those given. Each
 *  name removed is added to `removed` as it goes, so a caller knows what went before a
 *  failure. */
async function clearProjectEnv(bb, projectId, removed, only = null) {
  for (const name of await bb.projectEnvNames(projectId)) {
    if (only !== null && !only.includes(name)) continue;
    const answer = await bb.envUnset(projectId, name);
    if (!answer.ok) throw bb.refusal(answer, ["machine", "env"]);
    removed.push(name);
  }
}

/** Remove the env of every bb project rooted at the home: what a pi launch wrote there.
 *  For the retire hook and for a home that moves to another backend. A project that is the
 *  home's alone is the provider's, env and all: every name goes. One that is also rooted
 *  elsewhere is not (a pi launch refuses it, a Claude launch takes it): only the three
 *  names a pi launch writes go, and what a person keeps there for the other root stays.
 *  It never throws for bb's sake: → { removed: [names], warning: <text> | null }. */
export async function clearHomeProjectEnv(home, readSettings, { deadline, env = process.env, bb = null, projects = null } = {}) {
  const removed = [];
  try {
    let client = bb;
    if (client === null) {
      const settings = readSettings();
      client = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: loopbackOrigin(settings.server, "server"), deadline, env });
    }
    const mine = projects ?? projectsOfHome(await client.projects(), home);
    for (const project of mine) await clearProjectEnv(client, project.id, removed, sharedProjectRefusal(project, home) === null ? null : PI_ENV_NAMES);
    return { removed, warning: null };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { removed, warning: `what a pi launch may have written into the env of this home's bb project could not be removed (${error.code}): remove it in bb (bb machine env unset <NAME> --project <id>, for OATS_INSTANCE, OATS_INSTANCE_HOME and PATH)${removed.length ? `. Removed: ${someOf(removed)}` : ""}` };
  }
}
