---
name: simplification-review
description: The reviewer's refactor pass. Find where the change could be simpler, smaller or more consistent with the code around it, without changing behaviour, and report only suggestions worth the author's time. Use in every adversarial review round.
---

# Simplification review

Good code is the smallest code that does the job clearly. Look for what could go.

## Look for
- **Unneeded generality:** options, flags, parameters, abstraction layers or extension
  points nothing uses yet.
- **Duplication:** logic that already exists nearby (a helper, a validator, a pattern the
  module uses), re-implemented.
- **Indirection:** wrappers that only forward, one-use helpers that hide simple code,
  deep call chains for a small result.
- **Dead or defensive noise:** unreachable branches, checks that can't fail given the
  types or callers, commented-out code, stale TODOs.
- **Tangled control flow:** nested conditions that early returns would flatten; state
  flags that a clearer structure would remove.
- **Inconsistency:** a new name or pattern for something the codebase already names or
  does another way.
- **Tests:** repetitive tests that a table would express; tests of implementation details
  that will break on harmless refactors.

## Report
In a separate **Simplifications** section after the findings, **at most 3**, each as:
```
file:line: what to simplify → the simpler form (one or two lines, or a short sketch)
  why: less code / removes a duplicate / matches <existing pattern>
```
- Only suggest what preserves behaviour and is clearly better, not just different.
- Simplifications never block on their own. If one also fixes a bug, report the bug as a
  finding instead.
