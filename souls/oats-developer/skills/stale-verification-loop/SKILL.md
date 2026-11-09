---
name: stale-verification-loop
description: Use when a coordinator or reviewer repeatedly verifies stale commits, demands already-landed work, or keeps missing pushed changes despite prior acknowledgements; respond with commit-anchored Git evidence instead of restating that the work is done.
---

# Break stale-verification loops with commit-anchored evidence

Use this protocol when coordination gets stuck because the other side is
checking old commits or asking for work that is already on the remote branch.


## Steps

1. ACK the specific mails or requests the other side named, even if you already
   acknowledged them earlier.
2. Show the remote branch head with `git ls-remote origin <branch>` and include
   the head SHA in the reply.
3. If they cite an older commit, prove ancestry with
   `git merge-base --is-ancestor <claimed-commit> origin/<branch>`.
4. Pin feature evidence to the exact remote blob with
   `git show origin/<branch>:<file> | grep -c <pattern>` or an equivalently
   reproducible blob-at-head command.
5. When grepping for removed public surface, separate negation mentions such as
   "There is NO public X" from live API or user-facing surface.
6. Tell the coordinator the exact command they can run to re-verify the current
   head.
7. Invite them to quote `file@head` for anything still missing; fix quoted
   head-state defects, but do not rework already-landed changes from stale
   commit evidence.

## Gotchas

- Restating "it's done" can prolong the loop; prefer reproducible evidence.
- A commit being stale is not enough by itself. Show both branch head and
  ancestry so the other side can see the stale commit is already included.
- Some coordinator loop detectors key on explicit ACK references rather than
  message delivery state; keep naming the acknowledged mails each round.
