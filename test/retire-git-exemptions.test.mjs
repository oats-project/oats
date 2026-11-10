// Which of a retire's Git commands run without the overrides of the repository's filter drivers
// (lib/core.mjs retireGitReadsNoWorkTreeFile): only the exact forms that read no file of a work
// tree. A form of the same subcommand that does read or write one is not among them.
import test from "node:test";
import assert from "node:assert/strict";
import { retireGitReadsNoWorkTreeFile as exempt } from "../lib/core.mjs";

test("the forms a retire runs that read no work-tree file are exempt", () => {
  for (const args of [
    ["rev-parse", "HEAD"], ["symbolic-ref", "-q", "HEAD"], ["show-ref", "--verify", "refs/heads/x"], ["for-each-ref", "refs/"],
    ["update-ref", "-d", "refs/stash"], ["update-ref", "--stdin"], ["cat-file", "-e", "HEAD"], ["ls-tree", "-r", "HEAD"],
    ["fetch", "origin"], ["config", "--get", "core.bare"], ["-c", "core.quotePath=false", "config", "--get", "x.y"],
    ["ls-files", "--stage", "-z"], ["ls-files", "-s", "-v", "-z"], ["ls-files", "--resolve-undo", "-z"],
    ["hash-object", "-t", "blob", "-w", "--stdin"],
    ["reflog", "show", "--format=%H %gs", "refs/stash", "--"],
    ["remote", "remove", "origin"],
    ["stash", "store", "-m", "subject", "0123"],
    ["worktree", "list", "--porcelain", "-z"],
  ]) assert.equal(exempt(args), true, JSON.stringify(args));
});

test("a form that reads or writes a work-tree file gets the overrides, whatever its subcommand", () => {
  for (const args of [
    ["status", "--porcelain"], ["checkout", "--detach", "HEAD"], ["diff"], ["add", "-A"], ["clone", "a", "b"],
    // Subcommands with an exempt form, in a form that touches the work tree.
    ["stash", "push"], ["stash"], ["stash", "pop"], ["stash", "apply"], ["stash", "create"],
    ["worktree", "remove", "tree"], ["worktree", "add", "tree"], ["worktree", "move", "a", "b"], ["worktree"],
    ["hash-object", "file.txt"], ["hash-object", "-w", "file.txt"], ["hash-object", "--stdin-paths"],
    ["ls-files", "--modified"], ["ls-files", "-m"], ["ls-files", "--others"], ["ls-files", "-o", "--stage"], ["ls-files", "--deleted"], ["ls-files"],
    ["reflog", "expire", "--all"], ["remote", "update"], ["remote", "add", "o", "url"],
    ["-c", "a=b", "stash", "push"],
    [], ["-c", "a=b"],
  ]) assert.equal(exempt(args), false, JSON.stringify(args));
});
