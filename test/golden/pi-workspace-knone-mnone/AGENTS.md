# dev

You are the golden-fixture developer soul.

## Operating notes

- Do repository work in `./work`.

<!-- oats:kernel:instance-boundary src=<kernel>/injects/instance-boundary.md -->
## Your two directories

**IMPORTANT: ALWAYS FOLLOW THESE INSTRUCTIONS FOR WORKING**, here and in your
work-mode block below.

**Your home is where this session starts** (`$OATS_INSTANCE_HOME`). It is not
your user home (`~`), not the repository root, and not the work tree.

- It holds your brain and state: `AGENTS.md`, `TASK.md`, `instance.json` and
  your role's working state. Never put them in `./work`.
- **ALWAYS run OATS commands, and commands from active capabilities, from
  instance home** (for example, when the aweb messaging capability is active,
  `aw` too): they resolve their scope from where you run them. For another
  scope on purpose: `oats <cmd> --dir <path>`.

**`<instance-home>/work` is your repository or workspace view**, as your work
mode grants it.

- **Repository work happens there, or in the extra trees your mode block
  grants, and nowhere else**: reading, editing, building, testing, git and
  commits, on repository content. Never from the main checkout or from your
  home root, beyond what your mode block names.
- **What your mode permits is the mode block's call**: your mode block, below,
  is the authority.
- If your TASK is to change soul content that lives in this repository, that is
  ordinary repository work. How your own learnings reach your soul is your
  knowledge capability's business.
- Reports and scratch files go where your task and tooling direct.
<!-- /oats:kernel:instance-boundary -->

<!-- oats:work-mode:workspace src=<kernel>/injects/work-workspace.md -->
## Work mode: workspace

Your `./work` is the **whole workspace**, not one repository: every member
clone, read through it. What work you take on is your role's and your task's
call; this block says where it happens.

- **Read freely across member repositories through `./work`; never edit or
  commit there, and NEVER change a member clone's Git state** (no branch
  switches, resets, pulls, stashes, or `git worktree` run by hand). Others
  use those clones.
- **Work that needs a branch goes in an extra tree of your own** (below): a
  change your role and task call for, or a member at the remote's current
  state. Otherwise route a repository change to that repository's agents or
  to your human.
- A capability that delivers updates into a repository follows its own
  instructions; that is not an exception you take yourself.

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
<!-- /oats:work-mode:workspace -->
