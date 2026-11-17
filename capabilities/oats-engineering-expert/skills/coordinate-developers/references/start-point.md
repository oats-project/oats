# The start point of a developer's worktree

A developer of a worktree soul starts on a new branch at a commit the spawn reads. Check
that commit before you apply, or it builds on a stale base.

- **The developer soul's own repository:** leave out `--repo` and `--base`. The worktree
  starts at the commit the spawn observed on the remote.
- **Another repository:** add `--repo <clone> --base origin/<its default branch>`.
  `--base` names a ref in the clone, read there and never fetched: a bare branch name is
  the clone's local branch, however far behind, and `origin/<branch>` is as fresh as the
  clone's last fetch.

Preview the same command with `--preview` and compare its start point, `from <ref or
repository>@<commit>`, with the remote: `git -C <clone> ls-remote origin <its default
branch>`. If they differ, don't apply:
- for the soul's own repository, the remote moved since the preview: preview again;
- for another, the clone is behind: update its remote-tracking ref, then preview again.
  Name the destination, so the fetch updates that ref whatever branches the clone tracks:
  `git -C <clone> fetch origin refs/heads/<branch>:refs/remotes/origin/<branch>`.

`--same-work` records that the developer does your work, and your person's sidebar draws
its line to you. It shares no work tree: the developer keeps its own worktree and branch,
and only a reviewer is attached to its author's tree.
A developer started without the flag gets it with `oats instance same-work <developer> on`.
