/** What retires left behind in a deployment, as `oats doctor` information
 *  lines (#703 part 2a): the recovery copies under each instances directory's
 *  `.oats-retirement/recovery/`, and the retained worktrees under
 *  `<deployment>/.agents/worktrees/<repo>/`. Each line gives the facts to
 *  decide with (docs/souls-and-instances.md, "After a retire: inspect,
 *  restore, dispose"): whether the HEAD commit is reachable from another ref
 *  of the source repository, and what is uncommitted. Never a conclusion
 *  ("unique", "redundant", "safe to delete"): a retained worktree and a
 *  recovery can hold the same uncommitted bytes.
 *
 *  Read-only: nothing is written, moved or removed. Git runs only through
 *  gitRead/gitRepoRead (helper-free, no optional locks, no lazy fetch), so no
 *  index is refreshed. Links are never followed, neither to size a tree nor
 *  to read a JSON file. What can't be read is said on its line and never fails
 *  doctor. Each line is one line of text: values from disk or Git have their
 *  control characters escaped. */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gitOperationInProgress, instancesDirs, retainedWorktreesRoot, retirementRecoveryRoot } from "./core.mjs";
import { filterDriverKeys, gitRead, gitRepoRead } from "./instance-git.mjs";
import { formatBytes } from "./retire-output.mjs";
import { joinBytes } from "./tree-copy.mjs";

/** Item lines per kind; past it, one `… and N more` line. */
export const RETAINED_LINES_MAX = 50;
/** Entries a size walk visits before it stops and reports a lower bound. */
export const SIZE_ENTRIES_MAX = 250_000;
/** recovery.json and the copied instance.json are read up to this size. */
const JSON_MAX_BYTES = 16 * 1024 * 1024;
const RECOVERY = "retained-recovery";
const WORKTREE = "retained-worktree";
const DOCS = "to inspect, restore or dispose of them, see docs/souls-and-instances.md#after-a-retire-inspect-restore-dispose";

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** A value from disk, Git or a JSON file as text on one line: control
 *  characters (C0, DEL, C1) and the line and paragraph separators escaped,
 *  at most 512 characters. */
function shown(value) {
  const s = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return s.length > 512 ? `${s.slice(0, 512)}…` : s;
}
const why = (e) => shown(e?.code ?? e?.message ?? e);
const realOrNull = (path) => { try { return realpathSync(path); } catch { return null; } };
/** The entries of `dir` sorted, [] when it does not exist; throws when it can't be read. */
function namesIn(dir) {
  try { return readdirSync(dir).sort(byCodeUnit); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return []; throw e; }
}
/** What a path is, without following a link → "dir" | "link" | "other" | { error }. */
function kindOf(path) {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "other";
  } catch (e) { return { error: e }; }
}
/** The facts a path that is not a directory gets instead of its kind's. */
function notADirectory(kind) {
  return kind === "link" ? "a symbolic link, not followed" : kind === "other" ? "not a directory" : `could not be read (${why(kind.error)})`;
}

/** The bytes under `path` as a retire counts them (treeBytes in core.mjs: a
 *  link counts as itself, never followed; a directory as what it holds), names
 *  read as bytes, visiting at most SIZE_ENTRIES_MAX entries. → its fact. */
function sizeFact(path) {
  let bytes = 0, entries = 0;
  const pending = [Buffer.from(path)];
  while (pending.length) {
    const at = pending.pop();
    if (++entries + pending.length > SIZE_ENTRIES_MAX) return `size: at least ${formatBytes(bytes)} (stopped after ${SIZE_ENTRIES_MAX} entries)`;
    let st;
    try { st = lstatSync(at); } catch (e) { return `size: unknown (${shown(at.toString())} could not be read: ${why(e)})`; }
    if (!st.isDirectory()) { bytes += st.size; continue; }
    try { for (const name of readdirSync(at, { encoding: "buffer" })) pending.push(joinBytes(at, name)); }
    catch (e) { return `size: unknown (${shown(at.toString())} could not be read: ${why(e)})`; }
  }
  return `size: ${formatBytes(bytes)}`;
}

/** A JSON file read without following a link and without blocking on a FIFO,
 *  up to JSON_MAX_BYTES → { value } | { error } (what it is, as a phrase). */
function readJsonFile(path) {
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (e) { return { error: e?.code === "ENOENT" ? "missing" : e?.code === "ELOOP" ? "a symbolic link, not followed" : `unreadable (${why(e)})` }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: "not a regular file" };
    if (st.size > JSON_MAX_BYTES) return { error: `larger than ${formatBytes(JSON_MAX_BYTES)}` };
    let text;
    try { text = readFileSync(fd, "utf8"); } catch (e) { return { error: `unreadable (${why(e)})` }; }
    try { return { value: JSON.parse(text) }; } catch { return { error: "not valid JSON" }; }
  } finally { closeSync(fd); }
}
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Ref names are read as bytes, one character each ("latin1"), so that two
 *  names compare equal only when their bytes do; `refText` is a name as text,
 *  for a line (bytes that are not UTF-8 shown as U+FFFD). */
const BYTES = { encoding: "latin1" };
const refText = (ref) => Buffer.from(ref, "latin1").toString("utf8");
/** The short name of a ref, as Git prints it for a branch, a remote-tracking
 *  ref or a tag; any other ref by its full name. */
function shortRef(ref) {
  for (const prefix of ["refs/heads/", "refs/remotes/", "refs/tags/"]) if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
}
/** The ref a line names among those that reach a commit: a remote-tracking
 *  ref first (a remote's HEAD after its branches), then a branch, a tag, any
 *  other ref; by name within each. */
function preferredRef(refs) {
  const rank = (r) => r.startsWith("refs/remotes/") ? (r.endsWith("/HEAD") ? 1 : 0) : r.startsWith("refs/heads/") ? 2 : r.startsWith("refs/tags/") ? 3 : 4;
  return [...refs].sort((a, b) => rank(a) - rank(b) || byCodeUnit(a, b))[0];
}

/** The reachability fact of `commit` in the repository whose Git directory is
 *  `commonDir`: whether a ref other than `ownRef` (the tree's own branch,
 *  null when detached) reaches it, and if none does, how many commits no
 *  other ref reaches. Per-worktree refs (refs/worktree/, refs/bisect/) are
 *  not other refs. → "commits: …". */
function commitsFact(commonDir, commit, ownRef) {
  const short = commit.slice(0, 12);
  const present = gitRepoRead(commonDir, ["cat-file", "--batch-check"], { input: `${commit}^{commit}\n` });
  if (!present.ok) return `commits: unknown (whether the source repository has HEAD ${short} could not be read: ${shown(present.err)})`;
  if (/ missing\s*$/.test(present.out)) return `commits: HEAD ${short} is not in the source repository`;
  const other = (ref) => ref && ref !== ownRef && !ref.startsWith("refs/worktree/") && !ref.startsWith("refs/bisect/");
  const reaching = gitRepoRead(commonDir, ["for-each-ref", "--contains", commit, "--format=%(refname)"], BYTES);
  if (!reaching.ok) return `commits: unknown (which refs reach HEAD ${short} could not be read: ${shown(reaching.err)})`;
  const reachedBy = reaching.out.split("\n").filter(other);
  if (reachedBy.length) return `commits: all reachable from ${shown(refText(shortRef(preferredRef(reachedBy))))}`;
  // No other ref reaches HEAD: count what none of them reaches. Each other
  // ref's commit goes on stdin, so the argv stays bounded however many there are.
  const refs = gitRepoRead(commonDir, ["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)"], BYTES);
  if (!refs.ok) return `commits: unknown (the refs could not be read: ${shown(refs.err)})`;
  const tips = [];
  for (const row of refs.out.split("\n")) {
    const [oid, type, peeled, peeledType, ref] = row.split("\0");
    if (!other(ref)) continue;
    if (type === "commit") tips.push(oid);
    else if (type === "tag" && peeledType === "commit") tips.push(peeled);
  }
  const count = gitRepoRead(commonDir, ["rev-list", "--count", "--stdin"], { input: [commit, ...tips.map((t) => `^${t}`)].join("\n") + "\n" });
  const n = Number(count.out.trim());
  if (!count.ok || !Number.isInteger(n)) return `commits: unknown (the commits could not be counted: ${shown(count.err || count.out)})`;
  return n === 0 ? "commits: all reachable from another ref" : `commits: ${n} not reachable from any other ref`;
}

/** A tree's HEAD, read through Git (gitRead/gitRepoRead's `read`) →
 *  { commit, ref } (`ref` null when detached) | { error }. `ref` is the ref's
 *  bytes (BYTES) as Git prints them, without the line feed that ends them:
 *  nothing else is trimmed, since a name may begin or end with a character
 *  that reads as white space (headName in instance-git.mjs). Only Git's quiet
 *  answer (exit 1, nothing on stderr) is "detached". */
function headOf(read) {
  const commit = read(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const oid = commit.ok ? commit.out.replace(/\n$/, "") : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return { error: commit.err || "it names no commit" };
  const ref = read(["symbolic-ref", "--quiet", "HEAD"], BYTES);
  if (ref.ok) return { commit: oid, ref: ref.out.replace(/\n$/, "") };
  return ref.err === "git symbolic-ref exited with 1" ? { commit: oid, ref: null } : { error: `what it has checked out could not be read: ${ref.err}` };
}
/** The content filters (`filter.<driver>.clean` or `.process`) the
 *  configuration of the repository at `path` names → { names } | { error }.
 *  A status that compares a file's bytes with the index runs the filter its
 *  attributes name, and doctor runs no helper: with one configured, it does
 *  not ask for a status. A driver's name is any text, the empty one included
 *  (`filter..clean`), and a key counts whatever its value: Git decides what
 *  an empty one means, not this guard. */
function contentFilters(path) {
  const config = gitRead(path, ["config", "--list", "-z"]);
  if (!config.ok) return { error: config.err };
  const names = new Set(filterDriverKeys(config.out).filter((key) => key.variable === "clean" || key.variable === "process").map((key) => key.name));
  return { names: [...names].sort(byCodeUnit) };
}
/** Whether the index of the tree at `path` holds a submodule (a gitlink,
 *  mode 160000) → true | false | { error }. */
function holdsSubmodules(path) {
  const index = gitRead(path, ["ls-files", "--stage", "-z"]);
  if (!index.ok) return { error: index.err };
  return index.out.split("\0").some((row) => row.startsWith("160000 "));
}
/** The uncommitted classes in a `git status --porcelain=v1 -z --ignored`
 *  answer, in a fixed order. */
function uncommittedClasses(z) {
  const found = new Set();
  const fields = z.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const xy = fields[i].slice(0, 2);
    if (fields[i].length < 4) continue;
    if (xy[0] === "R" || xy[0] === "C") i++; // a rename or copy carries its source path next
    if (xy === "??") found.add("untracked files");
    else if (xy === "!!") found.add("ignored files");
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) found.add("conflicts");
    else {
      if (xy[0] !== " ") found.add("staged changes");
      if (xy[1] !== " ") found.add("unstaged changes");
    }
  }
  return ["staged changes", "unstaged changes", "conflicts", "untracked files", "ignored files"].filter((c) => found.has(c));
}

/** Whether the tree at `path` (Git directory `gitDir`) is clean, as retire's
 *  rule has it (untracked and ignored files and an operation in progress
 *  count) → its facts. The status never runs a helper: not with a content
 *  filter configured (contentFilters), and never inside a submodule, which
 *  would be a Git of its own with its own configuration
 *  (`--ignore-submodules=dirty` compares only the commit a submodule is at). */
function cleanFacts(path, gitDir) {
  const classes = [];
  if (gitOperationInProgress(gitDir, path)) classes.push("an operation in progress");
  const uncommitted = classes.length ? `; uncommitted: ${classes.join(", ")}` : "";
  const filters = contentFilters(path);
  if (filters.error) return [`clean: unknown (its configuration could not be read: ${shown(filters.error)})${uncommitted}`];
  if (filters.names.length) return [`clean: unknown (its repository configures a content filter that doctor does not run: ${filters.names.map((n) => (n === "" ? 'filter."" (the empty driver name)' : shown(`filter.${n}`))).join(", ")})${uncommitted}`];
  const status = gitRead(path, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal", "--ignore-submodules=dirty"]);
  if (!status.ok) return [`clean: unknown (its status could not be read: ${shown(status.err)})${uncommitted}`];
  classes.unshift(...uncommittedClasses(status.out));
  // What a submodule's own work tree holds is not read, so a tree with one is
  // clean only as far as the rest goes: unknown, unless the rest is not clean.
  const submodules = holdsSubmodules(path);
  const unread = submodules === true ? "submodule work trees not read" : submodules.error ? `whether it holds submodules could not be read: ${shown(submodules.error)}` : null;
  if (classes.length) return [`not clean; uncommitted: ${classes.join(", ")}`, ...(unread ? [unread] : [])];
  return [unread ? `clean: unknown (${unread})` : "clean"];
}

/** One retained worktree, read: → { path, facts, commonDir?, ref? }.
 *  `commonDir` (its repository's Git directory, canonical) and `ref` (its
 *  branch) when it is a registered linked worktree. */
function retainedWorktree(path) {
  const kind = kindOf(path);
  if (kind !== "dir") return { path, facts: [notADirectory(kind)] };
  const gitFile = kindOf(join(path, ".git"));
  if (gitFile !== "other") return { path, facts: ["not a registered worktree (it has no .git file)"] };
  const dirs = gitRead(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  if (!dirs.ok) return { path, facts: [`not a registered worktree (Git could not read it: ${shown(dirs.err)})`] };
  const [gitDir, commonDir, toplevel] = dirs.out.split("\n");
  const real = realOrNull(path);
  if (!toplevel || realOrNull(toplevel) !== real) return { path, facts: [`not a registered worktree (its top level is ${shown(toplevel || "unknown")})`] };
  const realCommon = commonDir && realOrNull(commonDir);
  if (!gitDir || !realCommon || realOrNull(gitDir) === realCommon) return { path, facts: ["not a registered worktree (it is not a linked worktree)"] };
  const list = gitRepoRead(realCommon, ["worktree", "list", "--porcelain", "-z"]);
  const trees = list.ok ? list.out.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length)) : [];
  if (!list.ok) return { path, facts: [`not a registered worktree (its repository's worktree list could not be read: ${shown(list.err)})`] };
  if (!trees.some((t) => realOrNull(t) === real)) return { path, facts: ["not a registered worktree (its repository's worktree list does not name it)"] };
  const facts = [`repository ${shown(trees[0])}`];
  const head = headOf((argv, options) => gitRead(path, argv, options));
  if (head.error) facts.push(`HEAD unknown (${shown(head.error)})`);
  else facts.push(head.ref ? `branch ${shown(refText(shortRef(head.ref)))}` : `detached at ${head.commit.slice(0, 12)}`);
  facts.push(...cleanFacts(path, gitDir));
  if (!head.error) facts.push(commitsFact(realCommon, head.commit, head.ref));
  return { path, facts, commonDir: realCommon, ref: head.ref ?? null };
}

/** The retained worktrees under `<deployment>/.agents/worktrees/<repo>/`,
 *  each read (retainedWorktree), sorted by path; an entry that is not a
 *  directory, at either level, is listed as such. → { trees, unreadable }:
 *  `unreadable`, the directories that could not be listed. */
export function retainedWorktrees(deployment) {
  const root = retainedWorktreesRoot(deployment);
  const trees = [], unreadable = [];
  let repos;
  try { repos = namesIn(root); } catch (e) { return { trees, unreadable: [{ path: root, error: e }] }; }
  for (const repo of repos) {
    const dir = join(root, repo);
    const kind = kindOf(dir);
    if (kind !== "dir") { trees.push({ path: dir, facts: [notADirectory(kind)] }); continue; }
    let leaves;
    try { leaves = namesIn(dir); } catch (e) { unreadable.push({ path: dir, error: e }); continue; }
    for (const leaf of leaves) trees.push({ path: join(dir, leaf) });
  }
  // Read every tree: a recovery line names the one on its branch, wherever it is in the list.
  return { trees: trees.map((t) => (t.facts ? t : retainedWorktree(t.path))), unreadable };
}

/** The repository a recovery's copied home records (`instance.json` `repo`):
 *  a hint, never authority. It is used only when it is the top level of a
 *  Git repository, canonical paths compared (or a bare repository's Git
 *  directory). → { commonDir } (canonical) | { error }. */
function recordedRepository(recorded) {
  const notGit = { error: `recorded repository ${shown(recorded)} is not a Git repository` };
  if (!isAbsolute(recorded)) return notGit;
  const real = realOrNull(recorded);
  if (!real) return { error: `recorded repository ${shown(recorded)} is not there` };
  const work = gitRead(real, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (work.ok) {
    const [toplevel, commonDir] = work.out.split("\n");
    if (realOrNull(toplevel) === real && realOrNull(commonDir)) return { commonDir: realOrNull(commonDir) };
  }
  const bare = gitRepoRead(real, ["rev-parse", "--path-format=absolute", "--is-bare-repository", "--git-common-dir"]);
  if (bare.ok) {
    const [isBare, commonDir] = bare.out.split("\n");
    if (isBare === "true" && realOrNull(commonDir) === real) return { commonDir: real };
  }
  return notGit;
}

/** The facts of a recovery's repository copy (`repo/`): its HEAD's
 *  reachability in the source repository, and the retained worktree of that
 *  repository on the same branch, when there is one. */
function recoveryCommitFacts(recovery, worktrees) {
  const repo = join(recovery, "repo");
  const kind = kindOf(repo);
  if (kind.error?.code === "ENOENT") return ["commits: no repository copy"];
  if (kind !== "dir") return [`commits: unknown (repo/: ${notADirectory(kind)})`];
  const gitDir = join(repo, ".git");
  if (kindOf(gitDir) !== "dir") return ["commits: unknown (repo/.git is not a directory)"];
  // The clone's own Git directory, named explicitly: never one found by walking up from it.
  const head = headOf((argv, options) => gitRepoRead(gitDir, argv, options));
  if (head.error) return [`commits: unknown (the copy's HEAD could not be read: ${shown(head.error)})`];
  const home = readJsonFile(join(recovery, "home", "instance.json"));
  const recorded = isObject(home.value) ? home.value.repo : undefined;
  if (typeof recorded !== "string" || !recorded) return [`commits: unknown (the copied home's instance.json ${home.error ? `is ${home.error}` : "records no repository"})`];
  const source = recordedRepository(recorded);
  if (source.error) return [`commits: unknown (${source.error})`];
  const facts = [commitsFact(source.commonDir, head.commit, head.ref)];
  if (head.ref) for (const tree of worktrees) if (tree.commonDir === source.commonDir && tree.ref === head.ref) facts.push(`retained worktree on the same branch: ${shown(tree.path)}`);
  return facts;
}

/** One recovery copy's facts. A dot-named entry is the staging of a copy
 *  that a retire could not remove. */
function recoveryFacts(path, name, worktrees) {
  const kind = kindOf(path);
  if (kind !== "dir") return [notADirectory(kind)];
  if (name.startsWith(".")) return ["unfinished copy (staging a retire could not remove)", sizeFact(path)];
  const facts = [];
  const manifest = readJsonFile(join(path, "recovery.json"));
  const m = manifest.value;
  if (!isObject(m)) {
    facts.push(`recovery.json is ${manifest.error ?? "not a JSON object"}, so its phase and classes are not known`);
    // `<instance>-<six random characters>`, as the retire names it (mkdtemp).
    facts.push(`instance ${shown(name.replace(/-[^-]{6}$/, ""))} (by the directory's name)`);
  } else {
    facts.push(typeof m.instance === "string" ? `instance ${shown(m.instance)}` : "instance not recorded");
    facts.push(typeof m.phase === "string" ? `phase ${shown(m.phase)}` : "phase not recorded");
    const classes = Array.isArray(m.classes) && m.classes.every((c) => typeof c === "string") ? m.classes : null;
    facts.push(classes ? `classes: ${classes.length ? classes.map(shown).join(", ") : "none"}` : "classes not recorded");
  }
  facts.push(sizeFact(path));
  const afterHooks = kindOf(join(path, "after-hooks"));
  facts.push(afterHooks === "dir" ? "after-hooks/ present" : afterHooks.error?.code === "ENOENT" ? "no after-hooks/" : `after-hooks: ${notADirectory(afterHooks)}`);
  facts.push(...recoveryCommitFacts(path, worktrees));
  return facts;
}

/** The count line, then at most RETAINED_LINES_MAX lines: the items, then
 *  the directories that could not be listed (whose contents are not counted);
 *  past them, `… and N more`. [] when there is nothing to say. */
function boundedLines(prefix, noun, items, unreadable, facts) {
  if (!items.length && !unreadable.length) return [];
  const notListed = unreadable.length ? `; ${unreadable.length} ${unreadable.length === 1 ? "directory" : "directories"} could not be listed, and what they hold is not counted` : "";
  const lines = [`${prefix}: ${items.length} ${noun(items.length)} that retires left in this deployment${notListed}; nothing removes them; ${DOCS}`];
  const entries = [...items, ...unreadable.map((u) => ({ ...u, unreadable: true }))];
  for (const entry of entries.slice(0, RETAINED_LINES_MAX)) {
    lines.push(entry.unreadable ? `${prefix}: ${shown(entry.path)} could not be listed (${why(entry.error)})` : `${prefix}: ${shown(entry.path)}: ${facts(entry).join("; ")}`);
  }
  if (entries.length > RETAINED_LINES_MAX) lines.push(`${prefix}: … and ${entries.length - RETAINED_LINES_MAX} more`);
  return lines;
}

/** The `retained-recovery:` information lines: one per recovery copy under
 *  the recovery storage of each instances directory of the agents root
 *  `agentsRoot` (where retire writes them: retirementRecoveryRoot), with its
 *  instance, phase, classes, size, after-hooks/ and the reachability of its
 *  clone's HEAD. `kept`: retainedWorktrees(deployment). */
export function retainedRecoveryLines(agentsRoot, kept) {
  const items = [], unreadable = [];
  for (const instances of instancesDirs(agentsRoot)) {
    const root = retirementRecoveryRoot(instances);
    let names;
    try { names = namesIn(root); } catch (e) { unreadable.push({ path: root, error: e }); continue; }
    for (const name of names) items.push({ path: join(root, name), name });
  }
  items.sort((a, b) => byCodeUnit(a.path, b.path));
  return boundedLines(RECOVERY, (n) => `recovery ${n === 1 ? "copy" : "copies"}`, items, unreadable, (item) => recoveryFacts(item.path, item.name, kept.trees));
}

/** The `retained-worktree:` information lines: one per entry under
 *  `<deployment>/.agents/worktrees/<repo>/`, with its repository, branch (or
 *  detached commit), whether it is clean, and its HEAD's reachability.
 *  `kept`: retainedWorktrees(deployment). */
export function retainedWorktreeLines(kept) {
  return boundedLines(WORKTREE, (n) => `retained worktree${n === 1 ? "" : "s"}`, kept.trees, kept.unreadable, (tree) => tree.facts);
}
