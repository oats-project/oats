## Fixed

- **`oats worktree add --repo <name>` no longer tells the operator to repoint a
  good clone** (oats-project/oats#1781). A name that isn't a repository key,
  such as a member's name (`--repo oats`) or `--repo awebai/oats`, names no
  member and matches no remote. The refusal still ended with a Git command
  built from that name, `git -C <clone> remote set-url origin
  https://oats.git`, and pasting it pointed a correct clone at a URL that
  doesn't exist.
  - When the clone at the name's convention path has a remote of that name,
    the refusal names the key to pass, `--repo github.com/awebai/oats`, and
    the clone's path as the other spelling that works.
  - Otherwise it says to pass a member's key (`<host>/<org>/<repo>`) or a
    clone path. It never suggests a Git command or a `clones:` entry for such
    a name.
  - The refusals keep their codes and `details`: `E_CLONE_MISMATCH` when a
    clone is at the convention path, `E_CLONE_MISSING` when there is none.
    A well-formed key and spawn's `--repo` are unchanged
    ([Extra trees](../souls-and-instances.md#extra-trees)).
