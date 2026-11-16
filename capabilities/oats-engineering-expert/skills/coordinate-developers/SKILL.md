---
name: coordinate-developers
description: Launches and drives the developers that build a lead's or a specialist's specs, and verifies what they hand back - one developer per surface with the environment its repository needs, the spec as its task, answers while it builds, then the one verification of its converged branch (architecture, the repository's rules, coherence, simplicity, glaring bugs, evidence for every acceptance criterion) ending in VERIFIED at the head or a return. Use when a spec whose builder is a developer is ready, when a developer asks a question, and when a developer or a helper hands back a reviewed branch, before any PR is opened for it.
---

# Coordinate developers

You specified the work, as the effort's lead or the specialist of its area, so its
developers are yours: you launch them, answer them and verify their branches. In an
effort with specialists, the root lead runs none of them.

## Launch
A developer builds a spec only where `/plan-and-spec` ("Who builds it") gives it one.
- **One developer per surface;** two independent surfaces, two developers in parallel.
  Never one developer for two unrelated surfaces, and never one coupled change split
  across agents.
<!-- adapt: Which developer souls exist, and which environment does each provide? -->
- **The soul** brings the environment its repositories need. The default `developer`
  builds in any repository of the organisation.
- **Spawn it** as your child, the spec as its task:
  ```bash
  oats spawn <developer-soul> --parent "$OATS_INSTANCE" --same-work \
    --name <piece-slug>-developer --task-file <spec.md>
  ```
  Where the spec's repository isn't the developer soul's own, add `--repo <clone of the
  spec's repository> --base origin/<its default branch>`. Preview the command first and
  check its start point against the remote:
  [references/start-point.md](references/start-point.md).
- **Add only what the spec can't hold:** the effort's record; in one line, why a
  developer builds it (protecting context, parallel work or specialisation); the branch
  or PR to target; and which developers share an interface with it, so they talk
  directly.
- Record each in your state file: instance name, surface, spec, branch.

## While they work
- The spec fixes what and the constraints; the developer chooses how.
- The repository's own instructions bind the developer: a spec line that contradicts them
  is a question it brings you. Don't ask a developer to skip its review rounds.
- Answer questions quickly. If one shows a hole in the spec, fix the spec and tell
  everyone it affects. When two developers disagree about a shared shape, you decide.
- Before you end a turn to wait on one, set its checkpoint (`/wait-and-retire`).

## When a branch comes back
A developer, or a helper with a scoped piece, reports once its review loop has converged.
It iterates with its reviewers, not you: don't act on intermediate heads, run review
rounds or spawn reviewers for its work.

Verify it once, at the head it names, with
[references/verification.md](references/verification.md). You judge whether the change
belongs in the system, built this way; its reviewers covered the lines.
- **Accept:** send the developer `VERIFIED at <head>` with what you checked against each
  "done when". It opens the PR at that head and works its reviews, raising to you only
  what needs product or architecture direction. You land it (`/land-on-agreement`).
- **Return:** numbered reasons, each saying what is wrong and why it matters, to the same
  developer. It fixes them and runs its loop again before it hands back. An
  architecture-level return may need a spec change first: make it, then return.

A hand-back isn't finished: the developer may still be needed for fixes and rebases.
Once its PR is merged and green, or closed, tell it so, with the merge commit. It sends
its done line and retires itself; check that it is gone (`/wait-and-retire`, "The
parent's sweep").
