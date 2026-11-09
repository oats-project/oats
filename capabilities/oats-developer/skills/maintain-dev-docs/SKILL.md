---
name: maintain-dev-docs
description: Keep a repository's development docs and code comments current (how the code works, its structure, conventions, how to build, test and change it), writing only long-lived facts. Use whenever a change affects how the code works or how people work in it, and before handing back.
---

# Maintain the development docs

You keep no knowledge base: what the next developer needs goes into the repository's
development docs and comments, in the same change as the code.

## What they are
Use the repository's existing names and places:
- Contributor guide (`AGENTS.md`, `CONTRIBUTING.md`, the README's development section):
  build, test and run; the branch and PR rules; the test gate.
- Architecture (`ARCHITECTURE.md`, `docs/architecture/`, a module's README): the parts,
  their responsibilities, how data and control flow, where to change what.
- Conventions: naming, error handling, logging, file layout, patterns used and avoided.
- Code comments: a module's purpose at its top; why a non-obvious piece is so; the
  invariant a function relies on; what a public function promises.

## Write what stays true
How things are and why the design is shaped this way. Keep out:
- Decisions in motion: "for now", who asked, PR numbers, dates, version history. History
  is git's; open decisions belong with whoever is deciding.
- Restated code: a comment says why, or nothing.
- Duplicates: state a rule once, in the most specific place, and link to it.

Test: still true and useful in a year if the code hasn't changed?

## When you change code
- It altered a structure, flow, convention, command or rule a doc describes: update that
  doc in the same change.
- You added something non-obvious (an invariant, a workaround, a subtle ordering): comment
  the why next to it.
- A doc was already wrong: fix it, or name it in your handback if it's outside your
  surface.
- Delete docs and comments your change made untrue.

## Keep them lean
One clear page over five partial ones: short sections, concrete examples, links to the
code. A doc that needs updating on every change should describe the stable shape instead.
