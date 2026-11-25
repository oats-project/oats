// The deny rules a sandboxed launch writes (contract item 6c, D16 rule 1).
//
// In bb's sandboxed modes the agent can write its own home and more, and some of what it
// can write is later run, or read as configuration, OUTSIDE its sandbox: OATS's module
// copies and hooks, Claude's settings, `.mcp.json`, git's config and hooks. Each path
// below gets a `permissions.deny` rule `Edit(//<absolute path>)` in the home's
// `.claude/settings.local.json`; Claude refuses its Edit and Write tools there, and makes
// the same paths read-only for sandboxed Bash.
//
// These rules are a defence against accidents, not a boundary: bb lets a command leave the
// sandbox, and an unsandboxed command writes past them (the README says so).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fail } from "./errors.mjs";
import { stateRoot } from "./record.mjs";

// In the home: OATS's module copies and its record of the instance, Claude's project
// configuration, the skills, the MCP servers, the messaging identity (the key stays
// readable: aw signs with it), the instructions OATS composes and the kernel's task, the
// memory file Claude loads at every launch. (The provider keeps nothing of its own in the home.)
const HOME_ENTRIES = [".git", ".git/**", ".oats/**", "instance.json", ".claude/**", ".agents/**", ".mcp.json", ".aw/signing.key", ".aw/workspace.yaml",
  "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "TASK.md"];
// What Claude loads as configuration from a directory: denied in every directory above
// the home (Claude loads it from a parent of its project), and in bb's thread storage
// (bb passes it to Claude as an added directory; not loaded today, denied so it never is).
const CONFIG_ENTRIES = [".mcp.json", "CLAUDE.md", ".claude/**"];
// In a git directory: what git runs or reads as configuration (its config, a worktree's
// own config, its hooks), and the two files that say where git's directories are (git
// follows them; rewritten, it would use another directory's config and hooks).
const GIT_ENTRIES = ["config", "config.worktree", "hooks/**", "commondir", "gitdir"];
// Claude's managed settings: root-owned, so the system already refuses; the rule costs nothing.
const MANAGED = "/etc/claude-code/**";
// bb builds its Claude plugin directory under the system's temporary directory: taken
// from this process's own (os.tmpdir()), which is bb's where both run with the same TMPDIR.
const PLUGIN_DIRS = "bb-provider-bridge-*/**";

// A path a rule can carry: absolute, normal, and free of what the rule's own syntax uses
// (parentheses, a line break), would widen (a wildcard in a path that is not ours to
// widen) or would change which path it names (a backslash escapes the next character).
const CARRIABLE = /^\/[^()\x00-\x1f\x7f*?[\]{}\\]*$/;
const carriable = (path) => typeof path === "string" && isAbsolute(path) && normalize(path) === path && path !== "/" && CARRIABLE.test(path);

const rule = (path) => `Edit(/${path})`;

/** The directories above `dir`, nearest first, the root included (`/x/y` → `/x`, `/`). */
function ancestors(dir) {
  const out = [];
  for (let at = dirname(dir); ; at = dirname(at)) {
    out.push(at);
    if (at === dirname(at)) return out;
  }
}

// A path as a refusal shows it: short, whatever it holds.
const shown = (path) => JSON.stringify(String(path).length > 120 ? `${String(path).slice(0, 117)}...` : String(path));

/** Why the deny rules cannot be written for this launch. The remedy stands first: the
 *  wire cuts a message at 480 characters, and a path can be long. */
const unwritable = (why) => fail("E_BACKEND_SANDBOX_PATH", `the sandbox's deny rules cannot be written for this launch. Launch in full mode (--yolo), or fix this: ${why}`);

/** The real path of `path`, as the system resolves it (Node's fs.realpathSync folds ".."
 *  before it looks, and would name another directory wherever a ".." follows a link).
 *  → the path; null where there is no such path. Throws where the real path cannot be
 *  written as text exactly (bytes that are not UTF-8): a rule built from it would name
 *  another path, a look-alike, and leave the real one uncovered. */
function realOf(path) {
  let bytes;
  try { bytes = realpathSync.native(path, { encoding: "buffer" }); } catch { return null; }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw unwritable(`the real path of ${shown(path)} holds bytes that are not UTF-8, which a rule cannot name`);
  return text;
}

/** The path and, where it differs, the path it resolves to: a home reached through a link
 *  is protected under both names. A path that is not there yet has its own name only. */
function withReal(path) {
  const real = realOf(path);
  return real === null || real === path ? [path] : [path, real];
}

/** The names a directory that may not be there yet will have once it is made: the path
 *  itself, and the same path below the real path of the nearest directory above it that
 *  exists (a state directory whose parent is a link, before the first record is written). */
function withRealAbove(path) {
  const real = realOf(path);
  if (real !== null) return real === path ? [path] : [path, real];
  const rest = [];
  for (let at = path; at !== dirname(at); at = dirname(at)) {
    rest.unshift(basename(at));
    const above = realOf(dirname(at));
    if (above !== null) {
      const planned = join(above, ...rest);
      return planned === path ? [path] : [path, planned];
    }
  }
  return [path];
}

/** What a small regular file names, read as git reads a `.git` pointer and a
 *  `commondir`: the whole content, less the line ends at its end. Never follows a link,
 *  never waits, reads at most 4 KiB.
 *  → the text; undefined where there is no such name; null where the name is there and
 *  this is not what git would take from it for certain: not a small regular file, bytes
 *  that are not UTF-8, or text with a line break inside it (the caller refuses, as it
 *  does for a blank at either end). */
function namedIn(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > 4096) return null;
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(4097);
    const got = readSync(fd, buffer, 0, 4097, 0);
    if (got > 4096) return null;
    // Exactly the bytes git reads: text that is not UTF-8 would be decoded to a look-alike.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, got)).replace(/[\r\n]+$/, "");
    return /[\r\n\0]/.test(text) ? null : text;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/** The git directories git uses for a tree: the tree's own `.git` where that is a
 *  directory (a clone), or the directory its pointer file names (a linked worktree); and,
 *  where that directory holds a `commondir`, the directory it names (the clone's `.git`,
 *  whose config and hooks git runs for every worktree; git honours a `commondir` in a
 *  plain clone's `.git` too). → [] where the tree has no `.git`.
 *
 *  `tree` is the tree's real path: git resolves a relative pointer against it.
 *
 *  Git reads a pointer and a `commondir` this module may not be able to (a link to one,
 *  a file padded past 4 KiB, a name with a line break in it), and then runs the config and
 *  hooks of a directory no rule covers. So a `.git` or a `commondir` that is there and
 *  cannot be read, for certain, as git reads it, naming a directory, refuses the launch
 *  (E_BACKEND_SANDBOX_PATH): a rule silently missing is the failure that matters. */
function gitDirsOf(tree) {
  const refuse = (what) => unwritable(`repair the tree (git worktree repair). The tree ${shown(tree)} has ${what}, so no rule can cover the git directory that git would use there`);
  // The directory a name stands for, found as git finds it: by the filesystem, which
  // follows a link before it takes a ".." step. (path.resolve and path.join fold ".."
  // first, and would name another directory wherever a ".." follows a link.) The name
  // as written, folded, is covered too, beside the real one: where it is the same
  // directory under another name the rule is needed, and where it is not, a rule on a
  // directory git does not use costs nothing.
  const found = (base, named, what) => {
    const written = isAbsolute(named) ? named : `${base}/${named}`;
    const real = realOf(written);
    if (real === null) throw refuse(`${what} that names nothing (${shown(written)})`);
    if (!isDirectory(real)) throw refuse(`${what} that names no directory (${shown(written)})`);
    return { real, names: [...new Set([real, normalize(written)])] };
  };
  const at = join(tree, ".git");
  const stat = lstatSync(at, { throwIfNoEntry: false });
  if (!stat) return [];
  let gitDir = { real: at, names: [at] };
  if (!stat.isDirectory()) {
    const pointer = namedIn(at);
    // As git writes and reads it: "gitdir: " and the path, nothing around them.
    const named = typeof pointer === "string" && pointer.startsWith("gitdir: ") ? pointer.slice("gitdir: ".length) : "";
    if (!named || named !== named.trim()) throw refuse("a .git that is neither a directory nor a pointer file this provider reads as git does (gitdir: <path>, one line)");
    gitDir = found(tree, named, "a .git pointer");
  }
  const common = namedIn(join(gitDir.real, "commondir"));
  if (common === undefined) return gitDir.names;
  if (!common || common !== common.trim()) throw refuse(`a git directory whose commondir this provider cannot read as git does, one line naming a directory (${shown(gitDir.real)})`);
  const commonDir = found(gitDir.real, common, "a git directory whose commondir is one");
  // And the common directory as each other name of the git directory would spell it.
  const spelled = isAbsolute(common) ? [] : gitDir.names.map((name) => normalize(`${name}/${common}`));
  return [...new Set([...gitDir.names, ...commonDir.names, ...spelled])];
}

/** Why a sandboxed launch that names no trees cannot be taken, or null. Git runs a tree's
 *  config and hooks outside any sandbox, and only the kernel knows a home's trees (the
 *  home's own record of them is its agent's to write): a launch that does not name them
 *  would leave some uncovered, so it is refused. → {code, message} | null. */
export function treesRefusal(trees) {
  if (Array.isArray(trees)) return null;
  return { code: "E_BACKEND_SANDBOX_TREES", message: `this launch would run in one of bb's sandboxed modes and its input has no "trees" (the list of the home's work tree and extra trees), so the deny rules could not cover git's config and hooks there, which git runs outside the sandbox. An OATS kernel that protects a provider home's files sends it: upgrade OATS to the release this provider names as its floor, or launch in full mode (--yolo)` };
}

/** Why a sandboxed launch that names no protected paths cannot be taken, or null. The
 *  kernel keeps what it runs for a provider home outside the home (its own copy of the
 *  home's modules) and names it, with the retirement directory, in the launch input: a
 *  launch that does not would leave them writable by the agent's file tools.
 *  → {code, message} | null. */
export function protectedRefusal(protectedPaths) {
  if (Array.isArray(protectedPaths)) return null;
  return { code: "E_BACKEND_SANDBOX_PROTECTED", message: `this launch would run in one of bb's sandboxed modes and its input has no "protected" (the directories the kernel keeps outside the home that the agent must never write: its own copy of the home's modules, the retirement directory), so the deny rules could not cover them. An OATS kernel that protects a provider home's files sends it: upgrade OATS to the release this provider names as its floor, or launch in full mode (--yolo)` };
}

/** The `permissions.deny` rules of a sandboxed launch, in a stable order, each once.
 *  `trees` is the home's work tree and extra trees, as the kernel names them: a launch
 *  that names none is refused (treesRefusal).
 *  A path a rule cannot carry refuses the launch (E_BACKEND_SANDBOX_PATH): a rule that is
 *  silently missing would leave that path writable. → [rule]. */
export function denyRules({ home, trees, protected: protectedPaths, dataDir, stateDir = stateRoot(), userHome = homedir(), tmp = tmpdir() }) {
  const paths = [];
  // The home is the kernel's word; a rule still needs it plain (a ".." step after a link
  // would put the rules on another directory than the home is).
  if (!carriable(home)) throw unwritable(`the home ${shown(home)} is not one exact absolute path with no wildcard, parenthesis, backslash or control character`);
  for (const root of withReal(home)) {
    for (const entry of HOME_ENTRIES) paths.push(join(root, entry));
    for (const above of ancestors(root)) for (const entry of CONFIG_ENTRIES) paths.push(join(above, entry));
  }
  // The configuration bb's Claude runs with: the user-scope state file and directory of
  // the OS user that runs bb, which is the user this provider runs as. (A launch that
  // sets CLAUDE_CONFIG_DIR is refused, so the path is known.)
  for (const root of withReal(userHome)) paths.push(join(root, ".claude.json"), join(root, ".claude/**"));
  paths.push(MANAGED);
  const missing = treesRefusal(trees);
  if (missing !== null) throw fail(missing.code, missing.message);
  for (const tree of trees) {
    if (!carriable(tree)) throw unwritable(`the launch names a tree that is not one exact absolute path with no wildcard, parenthesis, backslash or control character (${shown(tree)})`);
    // Named, it must be there: a tree that is no directory is refused, never skipped.
    const real = isDirectory(tree) ? realOf(tree) : null;
    if (real === null) throw unwritable(`the launch names a tree that is not a directory (${shown(tree)}): the rules cover each tree the kernel names, and this one cannot be read`);
    // The `.git` name itself, under each name of the tree: a worktree's pointer, or a
    // clone's directory (and what git runs there, for a `.git` that is made later).
    for (const root of new Set([tree, real])) paths.push(join(root, ".git"), ...GIT_ENTRIES.map((entry) => join(root, ".git", entry)));
    // The directories git uses for the tree, read from the tree's real path as git reads
    // them, and covered under each of their names.
    for (const gitDir of gitDirsOf(real)) paths.push(...GIT_ENTRIES.map((entry) => join(gitDir, entry)));
  }
  // What the kernel keeps outside the home and the agent must never write, though it reads
  // and runs it: the kernel's own copy of the home's modules, the retirement directory.
  // The kernel makes each before the launch, so one that is no directory is a fault.
  const unnamed = protectedRefusal(protectedPaths);
  if (unnamed !== null) throw fail(unnamed.code, unnamed.message);
  for (const entry of protectedPaths) {
    if (!carriable(entry)) throw unwritable(`the launch names a protected path that is not one exact absolute path with no wildcard, parenthesis, backslash or control character (${shown(entry)})`);
    const real = isDirectory(entry) ? realOf(entry) : null;
    if (real === null) throw unwritable(`the launch names a protected path that is not a directory (${shown(entry)}): the kernel makes each before a launch`);
    for (const root of new Set([entry, real])) paths.push(root, join(root, "**"));
  }
  // bb's thread storage, under the name the setting gives and under its real path (a
  // storage moved to another disk and linked from the data directory).
  for (const base of withReal(dataDir)) for (const root of withReal(join(base, "thread-storage"))) for (const entry of CONFIG_ENTRIES) paths.push(join(root, entry));
  for (const root of withReal(tmp)) paths.push(join(root, PLUGIN_DIRS));
  // The provider's own state directory, whole: its record of the threads it made for each
  // home, which decides whether a retire deletes a home's bb environment (lib/record.mjs;
  // contract r32, A17, on A8's list). It is outside every home and the agent runs as the
  // same user, so only a rule keeps its tools off it. The first launch on a host makes the
  // directory after these rules are written: it is covered under the names it will have.
  if (!carriable(stateDir)) throw unwritable(`the provider's state directory ${shown(stateDir)} (XDG_STATE_HOME) is not one exact absolute path with no wildcard, parenthesis, backslash or control character`);
  for (const root of withRealAbove(stateDir)) paths.push(root, join(root, "**"));

  const rules = [];
  for (const path of paths) {
    // The wildcards are this module's own, at the end of a path it built; what stands
    // before them must be a plain path.
    const base = path.replace(/\/(\*\*|bb-provider-bridge-\*\/\*\*)$/, "");
    if (!carriable(base)) throw unwritable(`a path the rules must cover holds a wildcard, a parenthesis, a backslash or a control character (${shown(base)}); move it to a path without them`);
    const text = rule(path);
    if (!rules.includes(text)) rules.push(text);
  }
  return rules;
}

/** The deny rules of a launch in a sandboxed mode, with the one check of this host they
 *  need first: bb's data directory must be the one bb uses, or its thread storage would go
 *  uncovered. The launch and the check of a planned launch share it. → rules. Throws
 *  E_BACKEND_SETTINGS, E_BACKEND_SANDBOX_TREES, E_BACKEND_SANDBOX_PATH. */
export function sandboxDeny({ mode, home, trees, protected: protectedPaths, dataDir, stateDir }) {
  checkDataDir(mode, dataDir);
  return denyRules({ home, trees, protected: protectedPaths, dataDir, stateDir });
}

/** bb does not say where its data directory is: a wrong setting would leave bb's thread
 *  storage out of the deny rules, with nothing to show it. Throws E_BACKEND_SETTINGS. */
export function checkDataDir(mode, dataDir) {
  if (!isAbsolute(dataDir) || normalize(dataDir) !== dataDir || dataDir === "/") throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.dataDir must be an absolute path with no . or .. step: a launch in bb's ${mode} mode reads it to keep the agent's tools off bb's thread storage. Set it in oats-local.yaml, or launch in full mode (--yolo)`);
  if (statSync(join(dataDir, "thread-storage"), { throwIfNoEntry: false })?.isDirectory()) return;
  throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.dataDir (${dataDir}) holds no thread-storage directory, so it is not this bb's data directory: a launch in bb's ${mode} mode must keep the agent's tools off bb's thread storage there. Set it in oats-local.yaml to the directory bb-app runs with (its --data-dir), or launch in full mode (--yolo)`);
}
