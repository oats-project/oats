---
name: review-dev-docs
description: The reviewer's pass over a change's effect on the repository's development docs and code comments. Check that they still describe how the code works and how to work in it, that the change updated what it made untrue, and that nothing drift-prone was added. Use in every adversarial review round.
---

# Review the development docs

The code is only half the change. Check the docs and comments the next developer will rely
on.

## Check
- **Coverage:** did the change alter a structure, a flow, a convention, a command, a public
  promise or a rule that the contributor guide, the architecture docs, a module README or a
  comment describes? If so, is that doc updated in the same change?
- **Truth:** does every doc and comment the diff touches match the code as it now is? Read
  them against the code, not against the author's intent.
- **The why:** does non-obvious new code (an invariant, a workaround, a subtle ordering)
  carry a comment saying *why*?
- **Drift-prone content:** decisions in motion ("for now", dates, PR numbers, who asked),
  version history, or comments that restate what the code does. These belong in git or with
  whoever is deciding, not in the docs.
- **Duplication:** a rule restated in several places, which will diverge.

## Report
Use the `/adversarial-review` format:
- **major:** a doc now tells the next developer something false about how to build, test or
  change the code, or a contract's docs don't match the new behaviour.
- **minor:** a missing *why* on non-obvious code; drift-prone content; a stale sentence
  nearby.
Missing docs for a trivial change aren't a finding. At most 2 doc minors per round.
