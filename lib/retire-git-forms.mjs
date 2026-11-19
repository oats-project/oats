/**
 * Which of a retire's Git commands read no file of a work tree. lib/core.mjs
 * (retireGitArgv) runs those without the overrides of the repository's filter
 * drivers, and every other one with them. Kernel-private, dependency-free.
 */

/** A form whose first argument is one of `verbs`. */
const firstIs = (...verbs) => (rest) => verbs.includes(rest[0]);
/** The forms of Git command a retire runs that read refs, objects, the index or
 *  the configuration, and no file of a work tree: no filter driver can run in
 *  them, so they are not preceded by the read of the repository's drivers.
 *  A subcommand is here with the forms of it that are so, never as a whole:
 *  `true` for one that has no form that touches a work tree, else what its
 *  arguments must be (`stash store` is here, `stash push` is not). A form that
 *  is not here gets the overrides, so one added to the retire is covered until
 *  it is listed. */
const RETIRE_READS_NO_WORK_TREE_FILE = new Map([
  ["rev-parse", true], ["symbolic-ref", true], ["show-ref", true], ["for-each-ref", true], ["update-ref", true],
  ["cat-file", true], ["ls-tree", true], ["fetch", true], ["config", true],
  // The index's entries, as recorded. Other forms compare the work tree's files with it (--modified, --deleted) or list them (--others).
  ["ls-files", (rest) => rest.length > 0 && rest.every((arg) => ["--stage", "-s", "-v", "-z", "--resolve-undo"].includes(arg)) && rest.some((arg) => arg !== "-z" && arg !== "-v")],
  // Content from standard input, hashed as it is. With a file, or with `--path` (which gives the
  // content read from standard input the filters of that path), the content goes through filters.
  ["hash-object", (rest) => rest.includes("--stdin") && !rest.some((arg) => arg === "--path" || arg.startsWith("--path="))],
  ["reflog", firstIs("show")],
  ["remote", firstIs("remove")],
  ["stash", firstIs("store")],
  ["worktree", firstIs("list")],
]);
/** Where the subcommand is in `args`, a retire Git command: after any `-c <setting>` of its own. */
export function retireSubcommandAt(args) {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return at;
}
/** Whether `args` (a retire Git command) is a form in RETIRE_READS_NO_WORK_TREE_FILE. */
export function retireGitReadsNoWorkTreeFile(args) {
  const at = retireSubcommandAt(args);
  const form = RETIRE_READS_NO_WORK_TREE_FILE.get(args[at]);
  return form === true || (typeof form === "function" && form(args.slice(at + 1)));
}
