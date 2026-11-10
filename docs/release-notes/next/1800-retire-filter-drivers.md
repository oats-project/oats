## Fixed

- **`oats retire` and `oats worktree remove` run no filter driver the
  repository configures.** A repository's own configuration, which an agent
  working in the tree can write, can define `filter.<name>.clean` or
  `filter.<name>.process` and select it with a `filter` attribute
  (`.gitattributes`, or `info/attributes` in the Git directory). Git runs
  such a command during a `git status`, as whoever runs it, and a retire and
  a removal both ask for one: a retire of the worktree, of a repository
  under it and of its recovery copy (and a spawn, for the baseline a retire
  compares with); a removal for its own status, inside `git worktree remove`
  and when it compares an unregistered tree's surviving files. Each of
  those commands is preceded by a read of the configuration
  (`git config --list`, which runs nothing), and each filter driver it
  defines is overridden to no command, as `oats instance git` does it.
  - A retire or a removal in a repository with no filter driver of its own
    is unchanged. A driver that the operator's global or system
    configuration defines runs with the operator's command, also when the
    repository defines one of the same name (`git lfs install --local`):
    the repository's values for that name are replaced by the operator's.
  - A file a repository's filter applies to is compared as its bytes are in
    the work tree. A clean filter could make a rewritten file read as
    unchanged: `oats retire --discard-worktree` then removed the worktree
    with that file in it and wrote no recovery, and `oats worktree remove`
    removed the tree. Such a file is uncommitted work: the retire copies it
    to the recovery, and the removal refuses with `E_WORKTREE_DIRTY`. A
    file whose size and times are the ones the index recorded still reads
    as unchanged.
  - A driver whose name cannot be passed on Git's command line (it holds `=`
    or is not UTF-8) is refused before Git runs. A retire answers
    `E_WORK_INSPECTION_FAILED` before its hooks, with `--discard-worktree`
    and `--force` too; a spawn into a worktree of that repository is
    refused and rolled back; a removal answers
    `E_WORK_PRESERVATION_FAILED` with the tree and its record kept.
  - A retire that copies a worktree compares the copy's status with the
    worktree's, and the copy has none of the repository's configuration.
    For a file a repository's filter applies to, the two can disagree, and
    the retire then refuses with `E_WORK_PRESERVATION_FAILED` and removes
    nothing. That is so only for a driver the repository alone defines,
    and was so before (an untouched file whose stored form is the filtered
    one).
  - Not covered: a driver written between that read and the Git command,
    and a filter that a submodule's own configuration defines, which matters
    where the agent and whoever retires or removes its worktree are separate
    system users
    ([Filter drivers](../souls-and-instances.md#retire-filter-drivers)).
