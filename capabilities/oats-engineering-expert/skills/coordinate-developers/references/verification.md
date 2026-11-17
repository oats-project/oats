# The one verification

You verify a converged branch once, on the developer's local branch, before any PR.

## Contents
- Check the handover
- What you judge
- The verdict

## Check the handover
- Pin the head the developer names. If the branch moves while you verify, stop and wait
  for its next report.
- Read your knowledge's recorded decisions and coherence rules for the area first.
- The handover needs: what was done against the spec's "done when"; how it was verified
  (tests and real runs, with results); the final round's verdict with its Checked section
  (how each "done when" item was checked) and the number of rounds; anything deliberately
  left out.
- Send it back when there was no review, the last round still found something to fix, or
  the final verdict has no Checked section or leaves a "done when" item out. You don't do
  the reviewers' job.
- A finding the developer declined with a concrete reason is not one to fix, nor is one
  you overruled when its loop reached its round cap: read each, and return one only where
  it touches the design or a contract.

## What you judge
1. **Architecture.** Is it the design the spec asked for? A deviation must be better, and
   recorded. Are responsibilities in the right places? Are contracts kept, and a changed
   contract's consumers handled in the right order?
2. **The repository's own rules.** Does it follow the repository's instructions and
   documented conventions? A change that is correct but built against them is returned.
   Did it update the docs and comments it affects?
3. **Coherence and fit.** Does it keep the recorded decisions and coherence rules? If it
   breaks one, the work changes or the decision does, explicitly. Does it follow the
   system's patterns and names, or duplicate something that exists?
4. **Simplicity.** Is it the simplest solution that meets "done"? Look for layers,
   options, flags or generality nobody asked for.
5. **Glaring bugs.** Read the main and failure paths once, as a user would hit them. Don't
   audit every line.
6. **Evidence.** The tests prove the "done when" items, not just that the code runs. Where
   the spec asks for a real run (a deployment, a live call, a UI flow), check what was
   run, where, and what it showed. Passing tests don't replace it.

## The verdict
- **`VERIFIED at <head>`** lists what you checked against each "done when". It means the
  spec's pinned acceptance tests and the suite that bears on the change ran at that head,
  the cases that must fail included: read the evidence for each criterion, and run what
  it leaves open. A verification that lists nothing it checked isn't one, and neither is
  one or two checks and a pass.
- **A return** keeps taste out of it. The same developer fixes it; don't spawn a new
  developer per return, and don't review its fixes yourself.
