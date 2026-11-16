# Probes: testing what the plan rests on

A probe tries one theory or one approach by experiment, in a fresh context. Test the
riskiest assumption first, before you specify the build on it. Where the work is simple,
test it yourself.

## Contents
- What a probe can test
- A closed question
- Competing approaches
- A probe never checks its own claim
- Its model: the floor, then a different one
- What it is worth

## What a probe can test
- **A theory:** does a claim the plan rests on hold (a cause, how a library or a service
  behaves, that a limit holds, that a fix removes the failure)? Name the theory, and the
  result that would refute it, before the probe runs: a probe told only what would
  confirm it finds that. It tries small, concrete cases first, tries as hard to break
  the claim as to confirm it, and reports each case it ran with its result.
- **An approach:** does this design work? The smallest spike or run that answers it.
- **A use case:** does the plan hold for this user, input or flow?
- **A plan or a design, adversarially:** what breaks in it?
- **An alternative:** what would the other way cost, and what would it give?

Two questions are two probes.

## A closed question
A question is closed when you can write its possible answers before you send it (yes or
no, which of these, a number, the cases that fail) and say what each would change in the
plan. "Look into X" and "how should we do Z" are open: the child then decides for itself
what you meant.

An open question is yours to frame, since you hold the problem: the decision it serves,
what "answered" means, the angles as closed questions (usually 2 to 4), where to look and
when to stop. Then send one probe per angle.

**Exploration with bounds is a closed task too.** Where you can't frame the angles yet
(it needs sources or a field you don't know), send one probe to explore, with four
things: the decision it serves; where to look; when to stop (a number of sources or
attempts, or the first sufficient answer); and what to send back (its findings as things
you can open, what it did not look at, and the closed questions that decide the matter,
with what each would change). Where the question is an effort of its own and the
organisation runs the research way of working, a research lead takes it, through your
dispatcher.

## Competing approaches
When more than one approach could work, or a cause has more than one candidate, and the
choice matters, don't pick on reasoning alone:
1. **List them,** usually 2 to 4. Include the one you doubt, the opposite of what you
   expect, and "this already exists".
2. **One probe per approach, in parallel,** each with that approach as its one question,
   the same evidence to bring back and the same measure of success, none told about the
   others, on different models where you can. Each builds the smallest spike that shows
   whether its approach works, and reports what it found on the way, not only a verdict.
3. **Compare on the evidence.** A second round may carry the first round's findings to
   the approaches still in the lead. Drop a dead end as soon as it is one.
4. **Record every approach tried,** and why each was dropped, on the effort's record.

<!-- adapt: How many probes may a lead run in parallel for one decision? -->
At most 4 probes run in parallel for one decision. Beyond that, ask your person first.

## A probe never checks its own claim
A claim the plan rests on, a probe's included, is checked by a different probe with a
fresh context, briefed to find its gaps and to check what it cites. Where a mechanical
check exists (a test, a type check, a benchmark), use it, with a statement you wrote or
approved, never the probe's own. A check a probe can pass without being right (a leaky
test, a judge on the same model) proves nothing.

## Its model: the floor, then a different one
**The floor comes first** (your landing rules' house rules; `/landing-rules-detail`, "The
model floor"). Check the model the child would launch on against it before anything
below: the effective one from the preview as much as one you pass. A smaller, faster or
cheaper model is not a different one.

Then diversity. Agents of one model share blind spots, so their agreement is not
independent: a child that checks work or validates an idea runs on a different model
from the author's, where the organisation has one at or above the floor. The author is
whoever made what is checked: you, for your plan; the helper that made a claim, for that
claim.
1. The author's model is `launch.model` in its `instance.json`.
2. The child's is `launch.effective.model` in `oats spawn <soul> --preview --json`: what
   this machine will launch (a `launch.from` of `local` is this machine's override of the
   soul's preference).
3. Compare models, not harnesses: a provider prefix names a route, so `<provider>/<model>`
   and `<model>` are one model.
4. Both known and different: spawn without `--harness` or `--model`.
5. The same, or either unknown (`null`, absent, a harness's native default): spawn with
   `--harness <h> --model <m>`, or a launch configuration this host defines (`oats
   launch-config list`), on a model you know differs. Your harness reports your own.
6. No other family has a model at or above the floor, or you can't establish its tier:
   use your own model, and say where you use the answer that diversity was lost.

## What it is worth
The fan-out fits what the decision is worth. Most decisions need one probe, and a choice
that is cheap to reverse needs none.
