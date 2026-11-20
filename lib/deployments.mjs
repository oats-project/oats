/**
 * This computer's deployments (docs/workspaces.md "This computer's deployments"; awebai/oats#1390).
 *
 * One per-user list of the deployments on this machine, `~/.oats/config/deployments.json`
 * (OATS_HOME_DIR overrides `~/.oats`, as for the server registry). It holds facts only: each row's
 * canonical path, when it joined and how. Which deployments a client has open stays with that
 * client, and remote machines stay in the server registry (lib/servers.mjs).
 *
 * Who writes it: `oats onboard` (what it created), `oats deployments add|remove|import`, and any
 * kernel command that resolves a deployment that is not listed yet (listResolved, which the CLI
 * sets to observe the command's own resolution: lib/resolved-deployment.mjs). A row `oats deployments remove` took out is kept as a tombstone (`removed`,
 * `removedAt`): nothing automatic lists that path again, and only an explicit add (or an onboard)
 * brings it back.
 *
 * The first command that touches the list imports `$HOME/Agents` once (the deployments directly
 * inside it), under the same lock, and records `imports["agents-dir"]` even when there is nothing
 * to import. A command whose import could not run fails: it never answers a list that skipped it.
 *
 * Concurrency: every read-modify-write holds `config/deployments.lock` (withDirLock: a file that
 * names its holder, taken over when that process is gone), waits up to 3 s for a holder that runs
 * and re-reads inside it; each write replaces the file atomically. Readers take no lock:
 * they read a regular file only, without following a link, up to 1 MiB. A row's `state` is an
 * existence check: no deployment's content is read here.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalDeploymentPath } from "./deployment-path.mjs";
import { withDirLock } from "./dir-lock.mjs";
import { writeFileAtomic } from "./write-file-atomic.mjs";
import { canonicalHomePath } from "./real-path.mjs";

export const DEPLOYMENTS_API = 1;
export const DEPLOYMENTS_SCHEMA = 1;
export const DEPLOYMENTS_FILE_BUDGET = 1024 * 1024;
/** The most entries the `~/Agents` import reads. */
export const AGENTS_DIR_IMPORT_LIMIT = 200;
const LOCK_WAIT_MS = 3000;
/** How a row joined the list (information only). */
export const DEPLOYMENT_VIA = Object.freeze(["onboard", "tui", "desktop", "cli", "import:agents-dir", "import:desktop"]);
/** The `--via` values `oats deployments add` takes from a client. */
export const CLIENT_VIA = Object.freeze(["tui", "desktop"]);

const oatsHomeDir = () => process.env.OATS_HOME_DIR || join(homedir(), ".oats");
export const deploymentsConfigDir = () => join(oatsHomeDir(), "config");
export const deploymentsFile = () => join(deploymentsConfigDir(), "deployments.json");
export const deploymentsLock = () => join(deploymentsConfigDir(), "deployments.lock");
/** The real `$HOME`, never OATS_HOME_DIR: `~/Agents` is the person's directory. */
const agentsDir = () => join(homedir(), "Agents");

function deploymentsError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
const invalid = (file, reason) => deploymentsError("E_DEPLOYMENTS_INVALID",
  `${file} cannot be read as this computer's deployments list (${reason}). Fix it, or move it aside and run \`oats deployments add <dir>\` for each deployment; nothing was changed`, { file, reason });
const writeFailed = (file, e) => deploymentsError("E_DEPLOYMENTS_WRITE", `cannot write ${file} (${e?.message ?? e}); nothing was changed`, { file, ...(e?.code ? { cause: { code: e.code } } : {}) });

// ---------------------------------------------------------------- the file

/** The file's text: a regular file, never through a link, within the budget; null when absent. */
function readBounded(file) {
  let st;
  try { st = lstatSync(file); }
  catch (e) { if (e.code === "ENOENT") return null; throw invalid(file, e.code || e.message); }
  if (st.isSymbolicLink()) throw invalid(file, "it is a link");
  if (!st.isFile()) throw invalid(file, "it is not a regular file");
  if (st.size > DEPLOYMENTS_FILE_BUDGET) throw invalid(file, `it is ${st.size} bytes, over 1 MiB`);
  let fd;
  try {
    // Writers replace the file by rename: the descriptor opened here is one whole old or new file.
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw invalid(file, "it is not a regular file");
    if (fst.size > DEPLOYMENTS_FILE_BUDGET) throw invalid(file, `it is ${fst.size} bytes, over 1 MiB`);
    const buf = Buffer.alloc(fst.size); let got = 0;
    while (got < fst.size) { const n = readSync(fd, buf, got, fst.size - got, got); if (n <= 0) break; got += n; }
    return buf.subarray(0, got).toString("utf8");
  } catch (e) {
    if (e?.code === "E_DEPLOYMENTS_INVALID") throw e;
    throw invalid(file, e.code === "ELOOP" ? "it is a link" : e.code || e.message);
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to recover */ } }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The list as stored: `{ schemaVersion, deployments, imports, ...unknown keys kept }`; an empty
 *  list when the file is absent. Lock-free. Throws E_DEPLOYMENTS_INVALID | E_DEPLOYMENTS_VERSION. */
export function readDeploymentsDocument() {
  const file = deploymentsFile();
  const text = readBounded(file);
  if (text === null) return { schemaVersion: DEPLOYMENTS_SCHEMA, deployments: [], imports: {} };
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw invalid(file, `not JSON: ${e.message}`); }
  if (!isPlainObject(doc)) throw invalid(file, "not a JSON object");
  const v = doc.schemaVersion;
  if (Number.isSafeInteger(v) && v > DEPLOYMENTS_SCHEMA) {
    throw deploymentsError("E_DEPLOYMENTS_VERSION", `${file} was written by a newer oats (schema ${v}); upgrade oats`, { file, schemaVersion: v });
  }
  if (v !== DEPLOYMENTS_SCHEMA) throw invalid(file, `schemaVersion must be ${DEPLOYMENTS_SCHEMA}, got ${JSON.stringify(v)}`);
  if (!Array.isArray(doc.deployments)) throw invalid(file, "deployments must be an array");
  const seen = new Set();
  for (const [i, row] of doc.deployments.entries()) {
    if (!isPlainObject(row)) throw invalid(file, `deployments[${i}] must be an object`);
    if (typeof row.path !== "string" || !isAbsolute(row.path)) throw invalid(file, `deployments[${i}].path must be an absolute path`);
    if (seen.has(row.path)) throw invalid(file, `${row.path} is listed twice`);
    if (typeof row.addedAt !== "string") throw invalid(file, `deployments[${i}].addedAt must be a string`);
    if (!DEPLOYMENT_VIA.includes(row.via)) throw invalid(file, `deployments[${i}].via must be one of ${DEPLOYMENT_VIA.join(", ")}`);
    seen.add(row.path);
  }
  if (doc.imports === undefined) doc.imports = {};
  if (!isPlainObject(doc.imports)) throw invalid(file, "imports must be an object");
  for (const [k, v] of Object.entries(doc.imports)) if (typeof v !== "string") throw invalid(file, `imports.${k} must be a string`);
  return doc;
}

function writeDocument(doc) {
  const file = deploymentsFile();
  const text = JSON.stringify(doc, null, 2) + "\n";
  // Never write what the readers would refuse: the list stays as it was.
  const bytes = Buffer.byteLength(text);
  if (bytes > DEPLOYMENTS_FILE_BUDGET) throw writeFailed(file, `it would be ${bytes} bytes, over 1 MiB`);
  try {
    mkdirSync(deploymentsConfigDir(), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, text, { mode: 0o600 });
  } catch (e) { throw writeFailed(file, e); }
}

/** One read-modify-write: under the lock, over the file as it is now, with the first-use `~/Agents`
 *  import done first; written once, only when something changed. `change(doc, now)` mutates `doc`
 *  and returns what the caller answers. `wait`: how long the lock may be waited for. */
function updateDeployments(change, { wait = LOCK_WAIT_MS } = {}) {
  const file = deploymentsFile(), lock = deploymentsLock();
  // The directory is created private before withDirLock would create it with the default mode.
  try { mkdirSync(deploymentsConfigDir(), { recursive: true, mode: 0o700 }); } catch (e) { throw writeFailed(file, e); }
  try {
    return withDirLock(lock, "this computer's deployments list", () => {
      const doc = readDeploymentsDocument();
      const before = JSON.stringify(doc);
      const now = new Date().toISOString();
      importAgentsDir(doc, now);
      const out = change(doc, now);
      if (JSON.stringify(doc) !== before) writeDocument(doc);
      return out;
    }, { retryMs: wait, busy: (why) => deploymentsError("E_DEPLOYMENTS_BUSY", `this computer's deployments list is locked (${why}); if no oats process is changing it, remove ${lock} and retry; nothing was changed`, { file, lock }) });
  } catch (e) {
    if (typeof e?.code === "string" && e.code.startsWith("E_")) throw e;
    // The lock itself could not be made or written: the list was not touched.
    if (typeof e?.code === "string") throw writeFailed(file, e);
    throw e;
  }
}

// ---------------------------------------------------------------- rows

/** A deployment's state, from existence checks only: `ok` (a regular, non-link oats-local.yaml, the
 *  rule of packages/client/workspace-admission.mjs), `missing` (the path is gone, or on a volume
 *  that is not mounted), `not-a-deployment` (it exists, with no such file), `unreadable` (the check
 *  failed, e.g. EACCES). */
export function deploymentState(path) {
  try { statSync(path); }
  catch (e) { return e.code === "ENOENT" ? "missing" : e.code === "ENOTDIR" ? "not-a-deployment" : "unreadable"; }
  try {
    const st = lstatSync(join(path, "oats-local.yaml"));
    return st.isFile() ? "ok" : "not-a-deployment";
  } catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR" ? "not-a-deployment" : "unreadable"; }
}

/** A path as the list stores it: absolute, its spelling on disk (realpath of what exists, so a link
 *  or another letter case on a case-insensitive filesystem is one row), then the deployment's
 *  primary checkout when it sits in a linked Git worktree, a worktree's root included
 *  (canonicalDeploymentPath `self`: probed from the directory itself, never through a child). */
export function canonicalListPath(p) {
  return canonicalDeploymentPath(canonicalHomePath(resolve(p)), { self: true });
}
/** canonicalListPath, or the realpath'd form when Git cannot say (a saved path a migration keeps). */
function canonicalOrReal(p) {
  try { return canonicalListPath(p); } catch { return canonicalHomePath(resolve(p)); }
}

const rowOf = (doc, path) => doc.deployments.find((r) => r.path === path);
const live = (row) => row && row.removed !== true;

/** Add `path` (canonical) to `doc`. An explicit add clears a tombstone; an automatic one (`revive`
 *  false: the imports, the auto-add) skips a tombstoned path. → whether a row joined. */
function addRow(doc, path, via, now, { revive }) {
  const row = rowOf(doc, path);
  if (live(row)) return false;
  if (row) {
    if (!revive) return false;
    delete row.removed; delete row.removedAt;
    Object.assign(row, { addedAt: now, via });
    return true;
  }
  doc.deployments.push({ path, addedAt: now, via });
  return true;
}

/** The first-use import of `$HOME/Agents`, inside the caller's lock: every directory directly inside
 *  it (at most AGENTS_DIR_IMPORT_LIMIT entries read, no link followed) that holds a regular
 *  `oats-local.yaml`. The marker is set even when the directory is missing, a link or empty. One
 *  that cannot be read is E_DEPLOYMENTS_IMPORT, and the caller writes nothing: an import that did
 *  not run is never marked. An entry that cannot be checked is not a deployment to import. */
function importAgentsDir(doc, now) {
  if (Object.hasOwn(doc.imports, "agents-dir")) return;
  const dir = agentsDir();
  const unreadable = (e) => deploymentsError("E_DEPLOYMENTS_IMPORT",
    `cannot read ${dir} to import its deployments (${e?.message ?? e}); make it readable, or move it aside, and retry; nothing was changed`, { dir, ...(e?.code ? { cause: { code: e.code } } : {}) });
  let st = null;
  try { st = lstatSync(dir); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw unreadable(e); }
  if (st?.isDirectory()) {
    let handle;
    try {
      handle = opendirSync(dir);
      for (let read = 0; read < AGENTS_DIR_IMPORT_LIMIT; read++) {
        const entry = handle.readSync();
        if (!entry) break;
        if (!entry.isDirectory()) continue; // a link is not followed
        const path = join(dir, entry.name);
        if (deploymentState(path) === "ok") addRow(doc, canonicalOrReal(path), "import:agents-dir", now, { revive: false });
      }
    } catch (e) { throw unreadable(e); }
    finally { if (handle) try { handle.closeSync(); } catch { /* closed */ } }
  }
  doc.imports["agents-dir"] = now;
}

// ---------------------------------------------------------------- commands

/** The import has run once, and nothing is written when it has: → the stored document. */
function importedDocument() {
  const doc = readDeploymentsDocument();
  if (Object.hasOwn(doc.imports, "agents-dir")) return doc;
  return updateDeployments((d) => d);
}

/** `oats deployments [list] --json`: the live rows, sorted by path, each with its state. */
export function listDeployments() {
  const doc = importedDocument();
  const deployments = doc.deployments.filter(live)
    .map((r) => ({ path: r.path, name: basename(r.path) || r.path, state: deploymentState(r.path), addedAt: r.addedAt, via: r.via }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { deploymentsApi: DEPLOYMENTS_API, file: deploymentsFile(), deployments, imports: doc.imports };
}

/** The deployment at or above `dir`: the first directory walking up whose oats-local.yaml is a
 *  regular file, not a link (the rule a client admits a deployment by, and the list's `ok`), or
 *  null. Anything else of that name (a directory, a link) is passed over (awebai/oats#1397). */
export function deploymentAtOrAbove(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    try { if (lstatSync(join(d, "oats-local.yaml")).isFile()) return d; } catch { /* not here */ }
    if (dirname(d) === d) return null;
  }
}

/** `oats deployments add`, and onboard's add: list the deployment directory `dir`; a tombstone is
 *  cleared. → `{ path, added }` (added false: it was listed already, and nothing changed). */
export function addDeployment(dir, { via = "cli" } = {}) {
  if (!DEPLOYMENT_VIA.includes(via)) throw deploymentsError("E_BAD_ARGS", `via must be one of ${DEPLOYMENT_VIA.join(", ")}`);
  const path = canonicalListPath(dir);
  return updateDeployments((doc, now) => ({ path, added: addRow(doc, path, via, now, { revive: true }) }));
}

/** `oats deployments remove <path>`: the row whose stored path is `<path>` resolved (or its
 *  canonical spelling), not walked up, so a stale row can go. It becomes a tombstone; nothing on
 *  disk is touched. → `{ path, removed }`. */
export function removeDeployment(given) {
  const resolved = resolve(given);
  const candidates = [...new Set([resolved, canonicalOrReal(resolved)])];
  return updateDeployments((doc, now) => {
    const row = candidates.map((p) => rowOf(doc, p)).find(live);
    if (!row) return { path: resolved, removed: false };
    Object.assign(row, { removed: true, removedAt: now });
    return { path: row.path, removed: true };
  });
}

/** `oats deployments import --from desktop <path>...`: the Desktop's own lists, once. The first run
 *  adds every path given, whatever its state, and sets `imports.desktop`, in one write; every later
 *  run changes nothing. A tombstoned path is not listed again. → `{ imported, at, added? }`. */
export function importDesktopDeployments(paths) {
  const relative = paths.find((p) => typeof p !== "string" || !isAbsolute(p));
  if (relative !== undefined) throw deploymentsError("E_BAD_ARGS", `oats deployments import takes absolute paths only, got ${JSON.stringify(relative)}; nothing was changed`);
  const canonical = [...new Set(paths.map(canonicalOrReal))];
  return updateDeployments((doc, now) => {
    if (Object.hasOwn(doc.imports, "desktop")) return { imported: false, at: doc.imports.desktop };
    const added = canonical.filter((p) => addRow(doc, p, "import:desktop", now, { revive: false }));
    doc.imports.desktop = now;
    return { imported: true, at: now, added };
  });
}

/** Whether `dir` sits in a Git work tree whose `.git` is a file (a linked worktree, or a
 *  submodule): the nearest `.git` at or above it, from lstat alone. */
function inGitFileWorkTree(dir) {
  for (let d = dir; ; d = dirname(d)) {
    try { return lstatSync(join(d, ".git")).isFile(); } catch { /* not here */ }
    if (dirname(d) === d) return false;
  }
}

/** The temporary directories, as the auto-add knows them (awebai/oats#1397): os.tmpdir(), /tmp,
 *  /private/tmp and /var/folders (macOS's per-user ones), each by its realpath. */
export const TEMPORARY_DIRECTORIES = Object.freeze(["/tmp", "/private/tmp", "/var/folders"]);
/** Whether the real path `real` is one of the temporary directories or under one. */
export function underTemporaryDirectory(real) {
  return [tmpdir(), ...TEMPORARY_DIRECTORIES].some((dir) => {
    const top = canonicalHomePath(dir);
    return dirname(top) !== top && (real === top || real.startsWith(top + sep)); // a TMPDIR of / is not taken
  });
}

/** The auto-add of awebai/oats#1390 (amendment and its performance budget): `root`, the deployment
 *  directory the command itself resolved (`canonical`: the root ensureRoot canonicalized), is
 *  listed when it is not. A listed deployment (live or tombstoned) costs one lock-free bounded read
 *  of the list, compared with `root`: no lock, no write, no process, no realpath. Past that:
 *  - a root that is only spelled (loadLocal's) and sits in a linked worktree or a submodule is left
 *    to the commands that resolve its canonical root, from lstat alone: its stored path is the
 *    primary checkout's, which only Git can tell;
 *  - another spelling of a listed deployment (a link, /var for /private/var) costs a realpath;
 *  - an unlisted root whose realpath is under a temporary directory is never listed by it
 *    (awebai/oats#1397): test fixtures live there, and would stay in the list as `missing`. An
 *    explicit add, onboard and the imports still list such a root;
 *  - only an unlisted deployment is canonicalized (a Git probe) and tries the lock once (no wait:
 *    busy skips, the next command tries again) to add it `via: cli`.
 *  Best effort and silent: it never throws or prints. → `"listed" | "added" | "skipped"`. */
export function listResolved(root, { canonical = false } = {}) {
  try {
    const doc = readDeploymentsDocument();
    const known = (p) => doc.deployments.some((r) => r.path === p);
    if (known(root)) return "listed";
    try { if (!lstatSync(join(root, "oats-local.yaml")).isFile()) return "skipped"; } catch { return "skipped"; }
    if (!canonical && inGitFileWorkTree(root)) return "skipped";
    const real = canonicalHomePath(root);
    if (known(real)) return "listed";
    if (!canonical && real !== root && inGitFileWorkTree(real)) return "skipped";
    if (underTemporaryDirectory(real)) return "skipped";
    const path = canonicalListPath(root);
    if (known(path)) return "listed";
    return updateDeployments((d, now) => (addRow(d, path, "cli", now, { revive: false }) ? "added" : "listed"), { wait: 0 });
  } catch { return "skipped"; }
}
