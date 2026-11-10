---
name: verify-developer-work
description: The expert's one verification of work a developer hands back once its review loop converged, a fresh reviewer each round. Checks architecture, coherence, fit with the whole system, simplicity and glaring bugs; does not redo the line-by-line review, never runs review rounds or spawns reviewers, and sends what it finds back to the developer, which fixes it and runs its loop again. Use when a developer hands back its reviewed local branch, before any PR is opened for it.
---

# Verify developer work

The developer iterates with fresh reviewers, not you: its reviewers covered line-level
bugs, security and simplification. You verify the converged branch once. On the same local
branch, before any PR, you judge whether it belongs in the system, built this way. You
never run review rounds or spawn reviewers for it.

## 0. Check the handover is complete
- Verify only at the head the developer names when it reports its review loop converged.
  Pin that head; if the branch moves while you verify, stop and wait for its next report.
- Read your knowledge's recorded decisions and coherence rules for this area first.
- The handover needs: what was done, against the spec's "done when"; how it was verified
  (tests and real runs, with results); the final round's verdict with its Checked section
  (how each "done when" item was checked) and the number of rounds; anything deliberately
  left out.
- No review, a last round that still found something to fix, or a final verdict with no
  Checked section, or one that leaves a "done when" item out: send it back. You don't do
  the reviewers' job. A finding the developer disputed with a concrete reason, listed in
  the hand-back, is not one to fix, nor is one you overruled when its loop reached its round
  cap: read each, and return one only where it touches the design or a contract.

## 1. Architecture
- Is it the design the spec asked for? A deviation must be better, and recorded.
- Are responsibilities in the right places, or did logic leak across a boundary?
- Are contracts kept? A changed contract has its consumers handled, in the right order.

## 2. Coherence and fit
- Does it keep the recorded decisions and coherence rules? If it breaks one, the work
  changes or the decision does, explicitly.
- Does it follow the system's patterns and names, or invent a parallel way? Does it
  duplicate something that exists?
- Will the next change here be easier or harder because of it?

## 3. Simplicity
- Is it the simplest solution that meets "done"? Look for layers, options, flags or
  generality nobody asked for, and pieces that could go with no loss.

## 4. Glaring bugs
- Read the main and failure paths once, as a user would hit them, for what's obviously
  wrong; don't audit every line.
- The tests must prove the "done when" items, not just that the code runs.
- Where the spec asks for a real run (a deployment, a live call, a UI flow), check its
  evidence: what was run, where, what it showed. Passing tests don't replace it.

## Verdict
- **Accept**: write `VERIFIED at <head>` with the checks you ran. Only then does the work
  become a PR: the developer opens it once the lane's green light is given
  (`/land-on-agreement`).
- **A PR handed back after its reviews:** read the delta since your verified head, and
  verify again only where it touches the design (`/land-on-agreement`, "Handed back ready").
- Or **return** with numbered reasons, each saying what's wrong and why it matters; keep
  taste out of it. The same developer fixes it and runs its review loop again, fresh
  reviewers included, before it hands back; don't spawn a new developer per return, and
  don't review its fixes yourself. An architecture-level return may need a spec change
  first: make it, then return.
