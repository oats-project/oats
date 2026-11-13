## Work mode: directory

Your `./work` is an **instance-owned execution directory**, not a Git worktree,
checkout or link. The `repo` recorded for you supplies configuration only; it
grants no permission to edit the `repo` directory.

- Work inside `./work`, apart from your extra trees. **Never initialize a
  fake repository**; a containing repository Git discovers is not yours.
- **Repository work that needs a branch goes in an extra tree of your own**
  (below): a change your role and task call for, or a repository at the
  remote's current state. What work you take on stays your role's and your
  task's call.
- Use external inputs and destinations only as your task and capabilities
  explicitly authorize.
- Deliver results through your task's own protocol before you finish: the
  recovery copy kept at retirement is not publication.

### Extra trees

For a branch of a member repository, from your home (`--preview` first;
`<repo>`: the member key or clone path, always, since your own `./work` is
not a Git tree; `<base>`: the remote branch to start from, or the one you
rework):

    oats worktree add --purpose <purpose> --branch <branch> --base <base> --repo <repo>

It moves none of the clone's refs. A tree is yours alone: build, test and
commit there.

- Name `<branch>` by the repository's rules, else `agents/<instance>-<purpose>`
  (if taken, `<instance>/<branch>`). Never reset a branch with `-B`/`-C`.
- `add` may take minutes: use a long timeout; if killed, rerun it.
- Push with `git push origin HEAD:<remote-branch>` (`<base>` when reworking).
- Before you finish, merge each tree into your PR branch, or push it and name
  it in your hand-back; then `oats worktree remove --purpose <purpose>`.
  Retirement may keep a tree with uncommitted work; don't rely on it.
  Details: `oats worktree --help`, and `/oats-operate` if you have it.
