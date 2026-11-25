/** K1 — read-only Git observation of one instance's work tree.
 *
 * Truth comes from the tree itself (never from recorded spawn metadata):
 * branch/HEAD via the worktree, status via porcelain v2 NUL records, ahead/
 * behind reported twice and separately (upstream; merge-base with the
 * repository's default branch) with "no upstream" ≠ 0/0. Diffs are bounded and
 * addressed by an opaque file id minted with an observation revision; a diff
 * against a tree that has since moved is refused, never served. */
import { execFileSync, spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { oatsError } from "./errors.mjs";
import { canonicalHomePath } from "./real-path.mjs";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const DIFF_MAX_BYTES = 256 * 1024;
export const INSTANCE_GIT_API = 1;
/** GIT_NO_LAZY_FETCH arrived in Git 2.45.0: git/git Documentation/RelNotes/2.45.0.adoc
 *  (--no-lazy-fetch), and e6d5479e7a (the environment variable across subprocesses). */
export const NO_LAZY_FETCH_GIT = Object.freeze([2, 45]);

const gitReadSafety = new AsyncLocalStorage();
const probeGitVersion = () => execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, env: gitEnv() });
/** One observation/diff or retire (plan included). Only the version source is injectable.
 *  Nested reads share its single lazy probe; nothing is cached across calls. */
export function withGitReadSafety(gitVersion, read) {
  if (gitVersion === undefined && gitReadSafety.getStore()) return read();
  return gitReadSafety.run({ probe: gitVersion ?? probeGitVersion }, read);
}
function gitReadVersion() {
  const context = gitReadSafety.getStore();
  if (!context) return null;
  if (!Object.hasOwn(context, "version")) {
    let raw;
    try { raw = context.probe(); } catch { raw = ""; } // an unavailable version is unsupported
    const match = /^git version (\d+)\.(\d+)(?:\.\d+)?(?:[. -].*)?\s*$/.exec(String(raw).trim());
    context.version = match ? { found: match[0].slice("git version ".length), major: Number(match[1]), minor: Number(match[2]) } : null;
  }
  return context.version;
}
function gitSupportsNoLazyFetch(version) {
  return version && (version.major > NO_LAZY_FETCH_GIT[0] || (version.major === NO_LAZY_FETCH_GIT[0] && version.minor >= NO_LAZY_FETCH_GIT[1]));
}
/** Check the SAME effective config listing used for filter overrides, before reading objects.
 *  Last values win as in Git; a boolean without a value means true. Remote subsection names
 *  are case sensitive, while Git normalizes the section and variable names in this listing. */
function assertNoLazyFetchSupport(listing, submodule) {
  const context = gitReadSafety.getStore();
  if (!context) return;
  const config = new Map(listing.split("\0").filter(Boolean).map((record) => {
    const nl = record.indexOf("\n");
    return nl < 0 ? [record, null] : [record.slice(0, nl), record.slice(nl + 1)];
  }));
  const trueBoolean = (value) => {
    if (value === null || /^(?:true|yes|on)$/i.test(value.trim())) return true;
    // Git also accepts nonzero integers, including a sign, leading zeroes, hex and k/m/g units.
    const integer = value.trim();
    return /^[+-]?(?:0x[0-9a-f]+|\d+)[kmg]?$/i.test(integer)
      && !/^(?:0x)?0+$/i.test(integer.replace(/^[+-]/, "").replace(/[kmg]$/i, ""));
  };
  const partial = config.has("extensions.partialclone") || [...config].some(([key, value]) =>
    /^remote\..*\.promisor$/s.test(key) && trueBoolean(value));
  if (!partial) return;
  const version = gitReadVersion();
  if (gitSupportsNoLazyFetch(version)) return;
  const found = version?.found ?? "an unknown version", minimum = NO_LAZY_FETCH_GIT.join(".");
  const subject = submodule === undefined ? "this repository" : `the submodule ${submodule}`;
  throw Object.assign(oatsError("E_GIT_UNSUPPORTED", `${subject} is a partial clone, and reading it safely needs Git ${minimum} or later; this is Git ${found}`), {
    details: { found, minimum, reason: "partial-clone", ...(submodule === undefined ? {} : { submodule }) },
  });
}

/** Indexed gitlinks with a .git entry are populated submodules, even when .gitmodules is gone.
 *  This reads this repository's index without entering a submodule. Keep paths
 *  as bytes until a Git invocation needs one; the modern-Git fast path needs no such invocation. */
function populatedGitlinks(work, configEnv) {
  const r = spawnSync("git", ["-C", work, ...READ_ONLY_GIT, "ls-files", "--stage", "-z"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: configEnv ?? gitEnv() });
  if (r.error || r.status !== 0) return { indexListing: null, populated: [] }; // the existing read decides an unreadable index
  const populated = [], seen = new Set();
  for (const row of r.stdout.toString("latin1").split("\0")) {
    const m = /^160000 [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(row);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const name = Buffer.from(m[1], "latin1"), text = name.toString("utf8");
    const rel = relative(resolve(work), resolve(work, text));
    if (isAbsolute(text) || rel === ".." || rel.startsWith(`..${sep}`)) throw oatsError("E_GIT_FAILED", "a submodule's index path leaves its repository");
    const path = Buffer.concat([Buffer.from(`${work}${sep}`), name]);
    if (existsSync(Buffer.concat([path, Buffer.from(`${sep}.git`)]))) populated.push(path);
  }
  return { indexListing: r.stdout.toString("utf8"), populated };
}

/** Before status can start Git in a populated submodule: on old/unknown Git, admit every such
 *  repository recursively. The caller first admits the root config with filterOverrides.
 *  Modern Git needs no submodule config read. `populated` names the
 *  immediate subtrees already covered here, so retire's generic nested-repository walk skips
 *  them. `indexListing` is also the observer's index revision: no duplicate index command. */
export function assertSafeGitSubmodules(work, { configEnv, indexListingNeeded = true } = {}) {
  const context = gitReadSafety.getStore();
  if (!context || (!indexListingNeeded && Object.hasOwn(context, "version") && gitSupportsNoLazyFetch(context.version))) return { indexListing: null, populated: [] };
  const tree = populatedGitlinks(work, configEnv);
  if (!tree.populated.length || gitSupportsNoLazyFetch(gitReadVersion())) return tree;
  const visited = new Set([canonicalHomePath(work)]);
  const visit = (parent) => {
    for (const bytes of parent.populated) {
      const path = bytes.toString("utf8");
      if (!Buffer.from(path).equals(bytes)) throw oatsError("E_GIT_FAILED", "a populated submodule's path is not valid UTF-8 and cannot be passed to Git");
      const canonical = canonicalHomePath(path);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const submodule = relative(work, path).split(sep).join("/");
      const config = filterOverrides(["-C", path], { configEnv, readDrivers: false, submodule });
      if (config.ok) visit(populatedGitlinks(path, configEnv));
    }
  };
  visit(tree);
  return tree;
}

/** The shared source admission for retire and its copier, under withGitReadSafety. Once this
 *  operation knows Git honors the guard, no further source config read is needed for the floor.
 *  Object/ref-only sources use submodules:false: their main checkout's working files and
 *  submodules are not read. A source Git cannot open is left to existing error handling. */
export function assertSafeGitRepository(work, { configEnv, submodules = true } = {}) {
  const context = gitReadSafety.getStore();
  if (context && Object.hasOwn(context, "version") && gitSupportsNoLazyFetch(context.version)) return { indexListing: null, populated: [] };
  const config = filterOverrides(["-C", work], { configEnv, readDrivers: false });
  return config.ok && submodules ? assertSafeGitSubmodules(work, { configEnv }) : { indexListing: null, populated: [] };
}

/** Every invocation is read-only and helper-free: the tree being observed may
 *  carry a hostile repo config (an agent works there), so external diff /
 *  textconv drivers, fsmonitor, hooks and lazy fetch are disabled explicitly,
 *  the caller's Git environment is not inherited, and optional locks are off
 *  so status/diff never refresh (write) the index. Lazy fetch
 *  (GIT_NO_LAZY_FETCH=1): an object a promisor repository lacks is a failed
 *  read, never fetched through the remote, helper, ssh command or credential
 *  helper the repository's configuration names, and never written into it.
 *  Git before NO_LAZY_FETCH_GIT ignores the variable: a partial clone refuses it.
 *
 *  Filter drivers (`filter.<name>.clean`, `.process`, `.smudge`): Git runs a
 *  clean or process filter when a status or a diff compares a work-tree file
 *  that carries the `filter` attribute, and it has no switch that turns
 *  filters off. Their names are the repository's to choose, so a command
 *  is preceded by one read of the configuration Git would use
 *  (`git config --list`, which runs nothing and follows `include.path` and
 *  `includeIf`), and every driver that read names is overridden to no command
 *  and not required (filterOverrides). An observation (observeInstanceGit)
 *  makes that read once, before its status, for its status and its line
 *  counts. A file with such an attribute is then
 *  compared as its bytes are in the work tree, unfiltered. A driver whose
 *  name `-c` cannot carry (it holds `=`, or is not UTF-8) is not overridden:
 *  the command is not run and the read fails. What this does not cover:
 *  - a driver added to the configuration between that read and the command
 *    (two processes; Git reads its configuration itself). For an observation
 *    that is until its last command that reads a work-tree file, the line
 *    counts' diff, which runs after the status and the reads of HEAD, the
 *    index and the refs;
 *  - a submodule's own configuration. A status or a diff of the work tree
 *    runs Git inside each populated submodule to learn whether it is dirty,
 *    and that Git reads the submodule's configuration: the overrides reach it
 *    (as fsmonitor's, the hooks' and the external diff's do), but they name
 *    this repository's drivers, not the submodule's.
 *
 *  Commands that read no file of the work tree are not preceded by that
 *  read: the reads of HEAD and of refs (readHead, gitRefPresence,
 *  worktreeCommitUnreached: `symbolic-ref`, `rev-parse`, `for-each-ref`), and
 *  this module's own READS_NO_WORK_TREE_FILE commands. A command another
 *  module passes (gitRead, gitRepoRead, gitRepoRun) always is. */
/** The setting that keeps Git from running the `core.fsmonitor` command a repository's
 *  configuration names, which it asks whenever it reads the index of a work tree. */
export const NO_FILE_MONITOR = ["-c", "core.fsmonitor=false"];
/** For every Git the kernel runs over the trees of a home on a session provider, or over their
 *  repository: neither the `core.fsmonitor` command nor any hook the repository's configuration
 *  or its `hooks` directory names is run. Such a home's agent may be able to write a tree's `.git`
 *  pointer, and its repository's configuration and hooks; Git would run what they name outside
 *  any sandbox, as the operator (the contract's D16 rule 6). A read by this module, and a retire's
 *  Git, already run so for every home (READ_ONLY_GIT, lib/core.mjs RETIRE_GIT_FLAGS); these are
 *  for the writes: a spawn's `git worktree add` and its rollback, and `oats worktree add|remove`.
 *  A tmux home's are unchanged: its hooks (a `post-checkout`) run as before. */
export const PROVIDER_TREE_GIT = [...NO_FILE_MONITOR, "-c", "core.hooksPath=/dev/null"];
const READ_ONLY_GIT = ["--no-optional-locks",
  ...NO_FILE_MONITOR, "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat",
  "-c", "core.untrackedCache=false", "-c", "index.threads=1", "-c", "safe.bareRepository=explicit"];
/** The subcommands this module runs (git) that read refs, objects, the index or the configuration,
 *  and no file of the work tree: no filter can run in them. */
const READS_NO_WORK_TREE_FILE = new Set(["rev-parse", "symbolic-ref", "merge-base", "rev-list", "ls-files", "config", "remote"]);
function gitEnv() {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  // The user's global config may name helpers too; observations do not need it.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}
/** The `filter.<name>.<variable>` keys of a `git config --list -z` listing → [{ name, variable }].
 *  A record is "<key>\n<value>", or "<key>" alone. A driver's name is any text, dots and the empty
 *  one included (`filter..clean`); a variable holds no dot, and Git prints it in lower case. */
export function filterDriverKeys(listing) {
  const keys = [];
  for (const record of listing.split("\0")) {
    const nl = record.indexOf("\n");
    const m = /^filter\.(.*)\.([^.]+)$/s.exec(nl < 0 ? record : record.slice(0, nl));
    if (m) keys.push({ name: m[1], variable: m[2] });
  }
  return keys;
}
/** The filter drivers the configuration of the repository at `where` (`-C <tree>` or `--git-dir <dir>`)
 *  defines, and the `-c` arguments that keep Git from running any of them
 *  → { ok: true, count, args } | { ok: false, refused, err }.
 *  `refused: true`: a driver is defined whose name `-c` cannot carry, so nothing can be run safely.
 *  `refused: false`: the configuration could not be read (`err` is Git's own words); the command it
 *  was read for would fail the same way.
 *  The listing is read as bytes (latin1 keeps each one): a name is passed on only when it is UTF-8,
 *  since that is how an argument reaches Git.
 *  The configuration listed is the repository's own (its local and per-worktree files and what they
 *  include), read with gitEnv: a driver that only the operator's own configuration (global, system)
 *  defines is not listed, and so not overridden where a caller's Git reads that configuration.
 *  `operatorEnv`, for a caller whose Git reads the operator's own configuration (a retire, a
 *  worktree removal), is the environment that Git runs with. A driver the repository defines under
 *  a name that configuration defines too is then overridden with the operator's own values, not
 *  with none: the operator's command runs, as it does for that name everywhere else the operator's
 *  Git runs (a retire's recovery copy has no configuration of its own), and the repository's never
 *  does. Where the repository defines `process` for that name and the operator's configuration
 *  does not, neither runs: the override that silences the repository's `process` silences the
 *  operator's clean and smudge commands with it, and the file is read or written unfiltered.
 *  The operator's configuration is the human's; the repository's is the agent's to write. A
 *  configuration of the operator's that cannot be read defines nothing.
 *  The one reader of a repository's filter drivers: this module's commands, a retire's
 *  (lib/core.mjs retireGitArgv), and a checkout's and a worktree removal's (workTreeOverrides)
 *  take their overrides here. `configEnv` selects the effective configuration for retire's
 *  partial-clone admission. `readDrivers: false` admits an object-only command without
 *  imposing work-tree filter restrictions on it. Callers that read objects must run under
 *  withGitReadSafety for the partial-clone floor check. */
export function filterOverrides(where, { operatorEnv, configEnv, readDrivers = true, submodule } = {}) {
  const r = spawnSync("git", [...where, ...READ_ONLY_GIT, "config", "--list", "-z"], { encoding: "latin1", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: configEnv ?? gitEnv() });
  if (r.error || r.status !== 0) return { ok: false, refused: false, err: String(r.error?.message ?? r.stderr ?? "").trim() || `git config exited with ${r.status}` };
  assertNoLazyFetchSupport(r.stdout, submodule);
  if (!readDrivers) return { ok: true, count: 0, args: [] };
  const names = new Map();
  for (const key of filterDriverKeys(r.stdout)) names.set(key.name, (names.get(key.name) ?? new Set()).add(key.variable));
  const operator = names.size > 0 && operatorEnv ? operatorDrivers(operatorEnv) : new Map();
  const args = [];
  for (const [raw, variables] of names) {
    const bytes = Buffer.from(raw, "latin1");
    const name = bytes.toString("utf8");
    if (name.includes("=") || !Buffer.from(name, "utf8").equals(bytes)) {
      return { ok: false, refused: true, err: "the repository's configuration defines a filter driver whose name cannot be overridden on Git's command line (it holds \"=\" or is not UTF-8), so Git was not run: it would run that filter" };
    }
    const own = operator.get(raw) ?? {};
    for (const command of ["clean", "smudge", "process"]) {
      // Git runs a driver's clean and smudge commands only while its `process` is not set, and one
      // set to nothing counts as set: the operator's commands for a name whose `process` neither
      // configuration defines run only when `process` is left out.
      if (command === "process" && operator.has(raw) && own.process === undefined && !variables.has("process")) continue;
      args.push("-c", `filter.${name}.${command}=${own[command] ?? ""}`);
    }
    args.push("-c", `filter.${name}.required=${own.required ?? "false"}`);
  }
  return { ok: true, count: names.size, args };
}
/** The `-c` arguments of a Git command that reads or writes the files of a work tree of the
 *  repository at `where`, and that runs with `operatorEnv` and so reads the operator's own
 *  configuration: a checkout (a spawn's `git worktree add` in lib/core.mjs; the `git worktree add`
 *  and `git switch` of `oats worktree add` in lib/worktree.mjs) and the reads of
 *  `oats worktree remove` (lib/worktree.mjs) → filterOverrides's result, its `args` preceded by
 *  NO_FILE_MONITOR. Whoever works in a clone can write its configuration, and such a command would
 *  run two kinds of command it names: a filter driver for a file it reads or writes, and the
 *  `core.fsmonitor` command. Git's hooks (`post-checkout`) are not turned off here. */
export function workTreeOverrides(where, operatorEnv) {
  const filters = filterOverrides(where, { operatorEnv });
  return filters.ok ? { ...filters, args: [...NO_FILE_MONITOR, ...filters.args] } : filters;
}
/** The filter drivers the operator's own configuration defines, as the Git that runs with `env`
 *  reads it: the system configuration, then the global one (`~/.gitconfig`,
 *  `$XDG_CONFIG_HOME/git/config`, or `$GIT_CONFIG_GLOBAL`), whose value wins as it does for Git
 *  → Map of a driver's name, as the bytes of the listing, to { clean?, smudge?, process?,
 *  required? }, each the last value given. A scope that cannot be read (no such file) defines
 *  nothing, and the system one is not read when `env` tells Git not to (GIT_CONFIG_NOSYSTEM, a
 *  Git boolean: `git config --system` itself reads the file regardless). Each is read by its
 *  scope: no repository's configuration is part of it. */
function operatorDrivers(env) {
  const drivers = new Map();
  const noSystem = !["", "0", "false", "no", "off"].includes(String(env.GIT_CONFIG_NOSYSTEM ?? "").trim().toLowerCase());
  for (const scope of noSystem ? ["--global"] : ["--system", "--global"]) {
    const r = spawnSync("git", [...READ_ONLY_GIT, "config", scope, "--list", "-z"], { encoding: "latin1", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env });
    if (r.error || r.status !== 0) continue;
    for (const record of r.stdout.split("\0")) {
      const nl = record.indexOf("\n");
      const [key] = filterDriverKeys(nl < 0 ? record : record.slice(0, nl));
      if (!key) continue;
      if (!drivers.has(key.name)) drivers.set(key.name, {});
      drivers.get(key.name)[key.variable] = Buffer.from(nl < 0 ? "true" : record.slice(nl + 1), "latin1").toString("utf8");
    }
  }
  return drivers;
}
/** `overrides`: a filterOverrides result the caller already has for `cwd` (an observation reads it
 *  once for its commands); without it the command is preceded by its own read. */
function git(cwd, argv, { allowFail = false, input, diffExit = false, overrides } = {}) {
  const [sub, ...rest] = argv;
  const extra = sub === "diff" ? ["--no-ext-diff", "--no-textconv", "--no-color"] : [];
  const filters = READS_NO_WORK_TREE_FILE.has(sub) ? { ok: true, args: [] } : overrides ?? filterOverrides(["-C", cwd]);
  if (!filters.ok) {
    // A refusal is not Git failing: it is never read as "no answer".
    if (allowFail && !filters.refused) return null;
    throw oatsError("E_GIT_FAILED", `git ${sub} failed in ${cwd}: ${filters.err}`);
  }
  try {
    return execFileSync("git", [...READ_ONLY_GIT, ...filters.args, "-C", cwd, sub, ...extra, ...rest], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, input, shell: false, timeout: 30_000, env: gitEnv() });
  } catch (e) {
    // `git diff --no-index` exits 1 when the inputs differ: that is the answer, not a failure.
    if (diffExit && e.status === 1 && typeof e.stdout === "string") return e.stdout;
    if (allowFail) return null;
    throw oatsError("E_GIT_FAILED", `git ${sub} failed in ${cwd}: ${String(e.stderr ?? e.message ?? "").trim() || "unknown error"}`);
  }
}
const trim = (s) => (s === null ? null : s.trim());
/** One helper-free Git probe run like the module's other reads
 *  (READ_ONLY_GIT, gitEnv, argv, no shell) → { ok, out, err }. `out` is text.
 *  Never throws: the caller decides what a failure means. `cwd`: the tree
 *  `-C` names; gitRepoRead names the repository by its Git directory instead.
 *  `input`: text for the command's standard input (`--stdin`), else none.
 *  `encoding`: how `out` is decoded ("latin1" keeps every byte as one
 *  character, for an exact comparison of names), "utf8" by default. */
export function gitRead(cwd, argv, { input, encoding } = {}) { return gitProbe(["-C", cwd], argv, input, encoding); }
/** gitRead against the repository whose (common) Git directory is `gitDir`,
 *  named explicitly (`--git-dir`), so that a bare repository is read too
 *  (READ_ONLY_GIT sets safe.bareRepository=explicit). */
export function gitRepoRead(gitDir, argv, { input, encoding } = {}) { return gitProbe(["--git-dir", gitDir], argv, input, encoding); }
/** A Git command that changes the repository whose Git directory is `gitDir`
 *  (a worktree move, remove or prune), under the same discipline as the
 *  reads: the repository's own configuration names no helper that runs
 *  (fsmonitor, hooks, external diff, filter drivers; they reach the commands
 *  Git starts for it through GIT_CONFIG_PARAMETERS), and nothing of the
 *  caller's Git environment is passed. → stdout; throws the error
 *  execFileSync throws, or an Error when a filter driver cannot be overridden
 *  (filterOverrides), in which case Git was not run. */
export function gitRepoRun(gitDir, argv) {
  const filters = filterOverrides(["--git-dir", gitDir]);
  if (!filters.ok) throw new Error(`git ${argv[0]} was not run in ${gitDir}: ${filters.err}`);
  return execFileSync("git", ["--git-dir", gitDir, ...READ_ONLY_GIT, ...filters.args, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 120_000, env: gitEnv() });
}
/** What the result of a `git rev-parse -q --verify <ref>` (spawnSync's) says
 *  of the ref → "there" (status 0), "absent" (status 1 and nothing printed),
 *  else "unknown". An error or a signal is "unknown" whatever the status: a
 *  Git that could not be started has none, and one that is ended at the
 *  timeout can still exit 1 and print nothing, when it handles the signal. */
export function gitRefPresenceOf(r) {
  if (r.error || r.signal) return "unknown";
  if (r.status === 0) return "there";
  return r.status === 1 && !r.stdout && !r.stderr ? "absent" : "unknown";
}
/** Whether the ref `name` is there in the tree at `cwd`, asked of Git
 *  (`rev-parse -q --verify`), which answers for every format a repository
 *  stores its refs in → "there", "absent" or "unknown" (gitRefPresenceOf);
 *  "unknown" too with no tree to ask in. Never throws: the caller decides
 *  what "unknown" means. Read-only and helper-free, like the module's other
 *  reads. */
export function gitRefPresence(cwd, name) {
  if (typeof cwd !== "string" || !cwd) return "unknown";
  return gitRefPresenceOf(spawnSync("git", ["-C", cwd, ...READ_ONLY_GIT, "rev-parse", "-q", "--verify", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: gitEnv() }));
}
function gitProbe(where, argv, input, encoding = "utf8") {
  const filters = filterOverrides(where);
  if (!filters.ok) return { ok: false, out: "", err: filters.err };
  const r = spawnSync("git", [...where, ...READ_ONLY_GIT, ...filters.args, ...argv], { encoding, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input, maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: gitEnv() });
  return !r.error && r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, out: "", err: String(r.error?.message ?? r.stderr ?? "").trim() || `git ${argv[0]} exited with ${r.status}` };
}

const BRANCH_REFS = Buffer.from("refs/heads/");
/** The two reads of HEAD, as bytes. They run like the module's other reads:
 *  read-only, helper-free, and with the module's own environment (gitEnv),
 *  which keeps only the caller's PATH and HOME: GIT_DIR, GIT_WORK_TREE,
 *  GIT_COMMON_DIR, GIT_INDEX_FILE and every other variable of the caller are
 *  not passed, and no global or system configuration is read, so nothing but
 *  the work tree named by `-C` decides what is read. `-C` comes first. */
const readHead = (work, args) => spawnSync("git", ["-C", work, ...READ_ONLY_GIT, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: gitEnv() });
/** What a failed read of HEAD says, without a line of the output that was not an error. */
const headReadFailure = (r, command) => String(r.error?.message ?? r.stderr ?? "").trim() || `git ${command} ${r.signal ? `was ended by ${r.signal}` : `exited with ${r.status}`}`;

/** What a work tree's HEAD names → { branch, detached, ref }. The one reader
 *  of that name: the retire plan and the retire both use it.
 *
 *  `ref` is the ref HEAD points at, as the bytes `git symbolic-ref --quiet HEAD`
 *  prints, without the one line feed that ends them; null when HEAD is
 *  detached. It is evidence for a comparison and is never serialized. Through a
 *  chain of symbolic refs it is the last one: the branch the commits go to.
 *
 *  `branch` is the name OATS carries for it: the part after `refs/heads/`, when
 *  that part is valid UTF-8 (it decodes and encodes back to the same bytes).
 *  Nothing of it is trimmed or replaced: a name may begin or end with a
 *  character that reads as white space. It is null when HEAD is detached, and
 *  also for a ref OATS carries no name for: one whose name is not valid UTF-8,
 *  or one outside `refs/heads/`. So `branch: null, detached: false` means "a
 *  name OATS does not carry", and two such HEADs are never taken for the same
 *  one by their missing names: compare `ref`.
 *
 *  A read that fails throws E_WORK_INSPECTION_FAILED. Only Git's own quiet
 *  answer (exit 1, nothing printed) is "detached". */
export function headName(work) {
  const r = readHead(work, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!r.error && r.status === 0 && r.stdout.length > 1) {
    const ref = Buffer.from(r.stdout[r.stdout.length - 1] === 0x0a ? r.stdout.subarray(0, -1) : r.stdout);
    let branch = null;
    if (ref.length > BRANCH_REFS.length && ref.subarray(0, BRANCH_REFS.length).equals(BRANCH_REFS)) {
      const name = ref.subarray(BRANCH_REFS.length);
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(name);
        if (Buffer.from(text, "utf8").equals(name)) branch = text;
      } catch { /* not valid UTF-8: a name OATS does not carry */ }
    }
    return { branch, detached: false, ref };
  }
  if (!r.error && r.status === 1 && !r.stdout.length && !r.stderr.length) return { branch: null, detached: true, ref: null };
  throw oatsError("E_WORK_INSPECTION_FAILED", `could not read what the worktree at ${work} has checked out: ${headReadFailure(r, "symbolic-ref")}`);
}

/** A worktree's HEAD for a retire → { commit, branch, detached, ref }: what
 *  headName gives, and the commit HEAD is at.
 *
 *  A HEAD that has no commit (a branch that is not born yet) is a failed read
 *  here: the retire proves its copy against this commit, and removes a
 *  worktree only after it has asked which refs reach it, so there is nothing
 *  it could do without one. That differs from the plan on purpose: the plan
 *  (observeInstanceGit) reads the commit for itself, and an unborn work tree is
 *  a value on its wire (`revision: "unborn"`).
 *
 *  The name and the commit are two reads, and nothing binds them but what is
 *  done with them: a copy is proven against `commit`, so a name read at
 *  another moment than the commit gives a copy that fails its proof. Nothing
 *  destructive rests on the name. */
export function worktreeHead(work) {
  const name = headName(work);
  const r = readHead(work, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const commit = !r.error && r.status === 0 ? r.stdout.toString("latin1").replace(/\n$/, "") : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `the HEAD of the worktree at ${work} has no commit that could be read${r.error || r.stderr?.length ? `: ${headReadFailure(r, "rev-parse")}` : ""}`);
  }
  return { commit, ...name };
}

/** The instance's work tree, from its home. The home's instance.json names
 *  the work mode; the tree is `<home>/work` (a directory or a symlink to the
 *  shared checkout). Missing/retired → attributed refusal, never a crash.
 *
 *  A real directory at `work/` is the instance's work tree only when it is
 *  the top level Git names for it (awebai/oats#962). Git answers for any
 *  directory inside a work tree, so a plain directory in a home whose
 *  deployment is a checkout, or whose home was made a repository, would be
 *  read as that repository's: its branch and its files, none of them the
 *  instance's. That is E_NO_WORKTREE, in every work mode: the rule is the
 *  path. A `work/` that is a link is read as what it leads to, wherever
 *  that is (a workspace instance's leads to the deployment directory, which
 *  is above its home). */
export function instanceWorkTree(home) {
  const metaFile = join(home, "instance.json");
  if (!existsSync(metaFile)) throw oatsError("E_SESSION_UNKNOWN", `${home} is not an OATS instance home (no instance.json)`);
  let meta;
  try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch (e) { throw oatsError("E_SESSION_UNKNOWN", `${metaFile}: ${e.message}`); }
  const work = join(home, "work");
  if (!existsSync(work)) throw oatsError("E_NO_WORKTREE", `${meta.instance ?? home} has no work tree at ${work} (retired, recovered, or never materialized)`);
  // A plain directory can inherit a parent's repository, but is not this home's tree (#962).
  // Classify that with metadata only; never admit the parent's config as this tree's.
  const linked = lstatSync(work).isSymbolicLink();
  const filters = linked || existsSync(join(work, ".git")) ? filterOverrides(["-C", work]) : { ok: true, count: 0, args: [] };
  if (!filters.ok) {
    if (filters.refused) throw oatsError("E_GIT_FAILED", `could not read the configuration of ${work}: ${filters.err}`);
    throw oatsError("E_NO_WORKTREE", `${work} is not inside a git work tree`);
  }
  // One read: whether Git answers for `work` at all, and the top level it names for it.
  const [inside, ...rest] = (trim(git(work, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFail: true })) ?? "").split("\n");
  if (inside !== "true") throw oatsError("E_NO_WORKTREE", `${work} is not inside a git work tree`);
  const top = rest.join("\n");
  if (!linked && (!top || canonicalHomePath(top) !== canonicalHomePath(work))) {
    throw oatsError("E_NO_WORKTREE", `${work} is not a git work tree of its own: Git reads it as a directory inside another work tree`);
  }
  return { meta, work, mode: meta.work ?? null, filters };
}

/** Porcelain v2 `-z` records → entries. Renames carry both paths. */
export function parsePorcelainV2(raw) {
  const fields = raw.split("\0");
  const entries = [];
  let branch = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [, key, ...rest] = rec.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") { const m = /^\+(\d+) -(\d+)$/.exec(value); if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); } }
      continue;
    }
    const type = rec[0];
    if (type === "1") {
      const parts = rec.split(" ");
      entries.push({ kind: "changed", xy: parts[1], submodule: parts[2] !== "N...", path: parts.slice(8).join(" "), origPath: null });
    } else if (type === "2") {
      const parts = rec.split(" ");
      const path = parts.slice(9).join(" ");
      const origPath = fields[++i] ?? null; // rename/copy: the original path is the next NUL field
      entries.push({ kind: /^R/.test(parts[8]) ? "renamed" : "copied", xy: parts[1], submodule: parts[2] !== "N...", score: parts[8], path, origPath });
    } else if (type === "u") {
      const parts = rec.split(" ");
      entries.push({ kind: "unmerged", xy: parts[1], submodule: parts[2] !== "N...", path: parts.slice(10).join(" "), origPath: null });
    } else if (type === "?") entries.push({ kind: "untracked", xy: "??", submodule: false, path: rec.slice(2), origPath: null });
    else if (type === "!") entries.push({ kind: "ignored", xy: "!!", submodule: false, path: rec.slice(2), origPath: null });
  }
  return { branch, entries };
}

function defaultBranch(work) {
  const sym = trim(git(work, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }));
  if (sym) return { ref: sym, source: "origin/HEAD" };
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(work, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { allowFail: true }) !== null) return { ref: candidate, source: "well-known" };
  }
  return null;
}

function countRange(work, range) {
  const out = trim(git(work, ["rev-list", "--left-right", "--count", range], { allowFail: true }));
  if (out === null) return null;
  const [left, right] = out.split(/\s+/).map(Number);
  return { left, right };
}

function indexRevisionOf(work, listing = git(work, ["ls-files", "--stage", "-z"], { allowFail: true })) {
  return listing === null ? "no-index" : createHash("sha256").update(listing).digest("hex").slice(0, 40);
}
function blobOf(work, path) {
  // Content fingerprint of the working-tree file without writing an object.
  return trim(git(work, ["hash-object", "--no-filters", "--", path], { allowFail: true }));
}
/** The branch's upstream remote (else `origin`, else null), with host/path parsed
 *  from ssh/https/git forms so a consumer can pick a forge backend WITHOUT running
 *  Git itself. Parsing only: no network, no forge knowledge. */
export function parseRemoteUrl(url) {
  if (typeof url !== "string" || !url) return { host: null, path: null };
  let m = /^(?:ssh:\/\/)?(?:[^@\/]+@)?([^:\/]+)(?::\d+)?[:\/](.+?)(?:\.git)?\/?$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try { const u = new URL(url); m = [null, u.hostname, u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "")]; } catch { m = null; }
  }
  if (!m || !m[1] || !m[2]) return { host: null, path: null };
  return { host: m[1].toLowerCase(), path: m[2] };
}
function remoteOf(work, branch) {
  const configured = branch ? trim(git(work, ["config", "--get", `branch.${branch}.remote`], { allowFail: true })) : null;
  const name = configured && configured !== "." ? configured : (trim(git(work, ["remote"], { allowFail: true })) ?? "").split("\n").includes("origin") ? "origin" : null;
  if (!name) return null;
  const url = trim(git(work, ["remote", "get-url", name], { allowFail: true }));
  if (!url) return null;
  return { name, url, ...parseRemoteUrl(url), source: configured && configured !== "." ? "branch-upstream" : "origin" };
}
/** Per-file line counts (0.29.1), from ONE `git diff <captured HEAD> --numstat -z -M`: the working tree
 *  against the observed commit, staged and unstaged combined. That is the same baseline as the status letters
 *  and `oats instance diff`. An unborn tree counts against the empty tree (`hash-object` without -w writes nothing).
 *  → Map path → { additions, deletions, binary }, keyed by the NEW path for a rename; null when git failed.
 *  -z records: "A\tD\tpath\0", or "A\tD\t\0old\0new\0" for a rename; "-\t-" is a binary file. */
function lineCounts(work, headOid, overrides) {
  const against = headOid ?? trim(git(work, ["hash-object", "-t", "tree", "/dev/null"], { allowFail: true, overrides }));
  if (!against) return null;
  const raw = git(work, ["diff", against, "--numstat", "-z", "-M", "--"], { allowFail: true, overrides });
  if (raw === null) return null;
  const counts = new Map(), recs = raw.split("\0");
  for (let i = 0; i < recs.length;) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(recs[i++]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { i++; path = recs[i++]; } // a rename: skip the old path, key the new one
    if (typeof path !== "string" || !path) continue;
    counts.set(path, m[1] === "-" ? { additions: null, deletions: null, binary: true } : { additions: Number(m[1]), deletions: Number(m[2]), binary: false });
  }
  return counts;
}
/** An entry's counts: untracked (no baseline; contents are not read) and submodules have none (all null). */
function countsOf(counts, entry) {
  if (entry.kind === "untracked" || entry.submodule) return { additions: null, deletions: null, binary: null };
  return counts?.get(entry.path) ?? { additions: null, deletions: null, binary: null };
}

function fileId(revision, indexOid, entry) {
  return createHash("sha256").update(`${revision}\0${indexOid}\0${entry.kind}\0${entry.path}\0${entry.origPath ?? ""}`).digest("hex").slice(0, 24);
}

/** The HEAD of a worktree a retire is about to remove, and whether a ref of
 *  its repository reaches that commit → { head, unreached }. A ref outlives
 *  the worktree; HEAD, and refs only the worktree has, do not.
 *
 *  One read in the repository that carries no ref name, so a ref whose name is
 *  not valid UTF-8, or very many refs, cannot make it refuse:
 *  `git for-each-ref --contains <commit> --count=1 --format=%(objectname)`.
 *  Exit 0 with a line printed: some ref reaches the commit. Exit 0 with
 *  nothing printed: none does, and the commit is something to preserve. Any
 *  other exit throws E_WORK_INSPECTION_FAILED. Standard error is not a failure
 *  here: a damaged ref prints a warning there with exit 0, and reaches
 *  nothing. A commit that only another worktree's HEAD reaches counts as not
 *  reached, which can only add a copy. */
export function worktreeCommitUnreached(repo, work) {
  const head = worktreeHead(work);
  const r = spawnSync("git", ["-C", repo, ...READ_ONLY_GIT, "for-each-ref", "--contains", head.commit, "--count=1", "--format=%(objectname)"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER, shell: false, timeout: 30_000, env: gitEnv() });
  if (r.error || r.status !== 0) throw oatsError("E_WORK_INSPECTION_FAILED", `could not read which refs of ${repo} reach the commit the worktree at ${work} has checked out: ${headReadFailure(r, "for-each-ref")}`);
  return { head, unreached: r.stdout.length === 0 };
}

/** The check made immediately before a retire removes a worktree: HEAD as it
 *  is now (`now`, worktreeHead) against HEAD as the final inspection read it
 *  (`inspected`). Equal when the commits are equal and both are detached or
 *  both point at a ref with the same bytes. The branch names are not compared:
 *  for a ref OATS carries no name for they are null on both sides, and null
 *  equal to null proves nothing. Anything else throws
 *  E_WORK_PRESERVATION_FAILED, and the worktree is not removed. */
export function assertSameWorktreeHead(inspected, now) {
  const same = !!inspected && !!now && inspected.commit === now.commit
    && (inspected.ref === null || now.ref === null ? inspected.ref === null && now.ref === null && inspected.detached === true && now.detached === true : Buffer.compare(inspected.ref, now.ref) === 0);
  if (!same) throw oatsError("E_WORK_PRESERVATION_FAILED", "the worktree's HEAD changed after it was inspected, so the worktree was not removed. The home and the worktree are kept, and so is any recovery the retire wrote; retry the retire.");
}

/** One consistent observation of the tree. Every field is what git said. */
export function observeInstanceGit(home, { gitVersion } = {}) {
  return withGitReadSafety(gitVersion, () => observeGit(home));
}
function observeGit(home) {
  const { meta, work, mode, filters } = instanceWorkTree(home);
  const { indexListing } = assertSafeGitSubmodules(work);
  const headOid = trim(git(work, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }));
  // The repository's filter drivers, read once for the observation's commands that read a
  // work-tree file (the status here, the line counts below).
  const raw = git(work, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=none"], { overrides: filters });
  const { branch, entries } = parsePorcelainV2(raw);
  // The name comes from headName, not from the status header, which prints
  // "(detached)" and other words where a name would be and is read as text.
  // The header still gives the upstream and its counts.
  const head = headName(work);
  // The index state participates in the revision so that a stage/unstage
  // between observation and diff is a moved tree, not a stale-but-served diff.
  // Hashed from the index listing: no `write-tree`, so observing creates no object.
  const indexOid = indexRevisionOf(work, indexListing);
  const revision = headOid ?? "unborn";
  const at = new Date().toISOString();
  const upstream = branch.upstream
    ? { ref: branch.upstream, ahead: branch.ahead, behind: branch.behind }
    : { ref: null, ahead: null, behind: null };
  const base = defaultBranch(work);
  let baseComparison = { ref: null, source: null, mergeBase: null, ahead: null, behind: null };
  if (base && headOid) {
    const mergeBase = trim(git(work, ["merge-base", "HEAD", base.ref], { allowFail: true }));
    const counts = mergeBase ? countRange(work, `${base.ref}...HEAD`) : null;
    baseComparison = { ref: base.ref, source: base.source, mergeBase, ahead: counts ? counts.right : null, behind: counts ? counts.left : null };
  }
  const counts = lineCounts(work, headOid, filters);
  const files = entries.filter((e) => e.kind !== "ignored").map((e) => ({ id: fileId(revision, indexOid, e), ...e, ...countsOf(counts, e) }));
  const summary = { changed: 0, renamed: 0, copied: 0, unmerged: 0, untracked: 0 };
  for (const f of files) summary[f.kind]++;
  // A home spawned before #641 may record the word "HEAD" for a detached HEAD; no branch is named that, so it reads as none.
  const recordedBranch = meta.branch === "HEAD" ? null : meta.branch ?? null;
  return {
    instanceGitApi: INSTANCE_GIT_API,
    instance: meta.instance ?? null, agent: meta.agent ?? null, home, workMode: mode,
    observation: { revision, indexRevision: indexOid, at, worktree: work, branch: head.branch, detached: head.detached && headOid !== null, unborn: headOid === null },
    recorded: { branch: recordedBranch, repo: meta.repo ?? null, drift: recordedBranch !== null && head.branch !== recordedBranch },
    upstream, base: baseComparison,
    remote: remoteOf(work, head.branch),
    summary, files,
    notes: [
      ...(upstream.ref === null ? ["no upstream configured: upstream ahead/behind are unknown, not zero"] : []),
      ...(baseComparison.ref === null ? ["no default branch found (origin/HEAD, origin/main, origin/master, main, master): base comparison unknown"] : []),
      ...(counts === null ? ["line counts unavailable (git diff --numstat failed): additions/deletions are unknown, not zero"] : []),
      ...(filters.ok && filters.count > 0 ? ["the repository's configuration defines a filter driver, and filters are not run: a file one applies to is compared as its bytes are in the work tree, so it can read as changed, and its diff is against the stored form"] : []),
    ],
  };
}

/** A bounded unified diff for one observed file. The caller passes the id
 *  and the observation revision it was minted under; a moved tree refuses. */
export function diffInstanceFile(home, { gitVersion, ...options } = {}) {
  return withGitReadSafety(gitVersion, () => diffFile(home, options));
}
function diffFile(home, { fileId: id, revision, indexRevision } = {}) {
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) throw oatsError("E_BAD_ARGS", "--file needs the opaque file id from `oats instance git --json`");
  if (typeof revision !== "string" || !revision) throw oatsError("E_BAD_ARGS", "--revision needs the observation revision the file id was minted under");
  const current = observeInstanceGit(home);
  if (current.observation.revision !== revision || (indexRevision !== undefined && current.observation.indexRevision !== indexRevision)) {
    throw Object.assign(oatsError("E_STALE_OBSERVATION", "the work tree moved since this file id was observed; re-observe with `oats instance git --json`"), { observation: current.observation });
  }
  const file = current.files.find((f) => f.id === id);
  if (!file) throw Object.assign(oatsError("E_STALE_OBSERVATION", "this file id is not part of the current observation; re-observe"), { observation: current.observation });
  const work = current.observation.worktree;
  const paths = file.origPath ? [file.origPath, file.path] : [file.path];
  const before = { blob: blobOf(work, file.path) };
  let patch, binary = false;
  if (file.kind === "untracked") {
    const numstat = trim(git(work, ["diff", "--no-index", "--numstat", "--", "/dev/null", file.path], { diffExit: true, allowFail: true }));
    binary = /^-\t-\t/.test(numstat ?? "");
    patch = binary ? "" : (git(work, ["diff", "--no-index", "--", "/dev/null", file.path], { diffExit: true, allowFail: true }) ?? "");
  } else {
    const numstat = trim(git(work, ["diff", current.observation.revision, "--numstat", "-M", "--", ...paths], { allowFail: true }));
    binary = /^-\t-\t/.test(numstat ?? "");
    patch = binary ? "" : git(work, ["diff", current.observation.revision, "-M", "--", ...paths]);
  }
  // Consistency across the read, not only before it: HEAD, index and the file's
  // own content must be what the observation said when the patch was produced.
  const after = { revision: trim(git(work, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true })) ?? "unborn", indexRevision: indexRevisionOf(work), blob: blobOf(work, file.path) };
  if (after.revision !== current.observation.revision || after.indexRevision !== current.observation.indexRevision || after.blob !== before.blob) {
    const moved = observeInstanceGit(home);
    throw Object.assign(oatsError("E_STALE_OBSERVATION", "the work tree moved while the diff was being read; re-observe with `oats instance git --json`"), { observation: moved.observation });
  }
  const bytes = Buffer.byteLength(patch, "utf8");
  const truncated = bytes > DIFF_MAX_BYTES;
  const body = truncated ? Buffer.from(patch, "utf8").subarray(0, DIFF_MAX_BYTES).toString("utf8") : patch;
  return {
    instanceGitApi: INSTANCE_GIT_API, observation: current.observation,
    file: { id: file.id, kind: file.kind, xy: file.xy, path: file.path, origPath: file.origPath },
    against: file.kind === "untracked" ? "empty" : current.observation.revision, binary, bytes, truncated, limit: DIFF_MAX_BYTES, patch: body,
    readOnly: { helpers: "disabled", optionalLocks: "off", objectsWritten: 0 },
  };
}
