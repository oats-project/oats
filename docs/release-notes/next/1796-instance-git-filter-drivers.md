## Fixed

- **`oats instance git` and `oats instance diff` run no filter driver the
  work tree's repository configures.** A repository's own configuration,
  which an agent working in the tree can write, can define
  `filter.<name>.clean` or `filter.<name>.process` and select it with a
  `filter` attribute (`.gitattributes`, or `info/attributes` in the Git
  directory). Git runs such a command during a `git status` or a `git diff`,
  as whoever runs it. Every Git command of the observation that reads a
  work-tree file is preceded by a read of the configuration
  (`git config --list`, which runs nothing), and each filter driver it
  defines is overridden to no command.
  - The observation of a repository with no filter driver is unchanged.
  - A file a filter applies to (a Git LFS file, for one) is compared as its
    bytes are in the work tree: rewritten, it reads as `changed` even when
    its filtered form is what is stored, and its diff is the stored form
    against the work tree's bytes. The observation says so in a note.
  - A driver whose name cannot be passed on Git's command line (it holds `=`
    or is not UTF-8) refuses the read with `E_GIT_FAILED`.
  - Not covered: a driver written between that read and the Git command, and
    a filter that a submodule's own configuration defines
    ([Git and diff](../desktop-cli-api.md#git-and-diff)).
