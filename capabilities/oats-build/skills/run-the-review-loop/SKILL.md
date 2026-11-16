---
name: run-the-review-loop
description: Runs the author's review loop on a finished change before any PR - a fresh code-reviewer each round, spawned as an OATS child attached to the consolidated worktree, on a model at or above the floor and different from the author's, briefed with the pinned range and the criteria and never the author's reasoning, until a round whose report lists what it checked finds nothing to fix; who reads each fix (a fresh reviewer after a blocker or a major, a delta read for a minor), the cap of 4 fresh rounds, the hand-back, and the finish once the PR is merged or closed. Use when a piece of work is complete and proven on a local branch, when an expert returns a branch, and when the PR is merged or closed.
---

# Run the review loop

You built the change, so you iterate with the reviewers: a developer, or a lead or a
specialist building its own spec. You are never your own reviewer, and whoever verifies
your work runs no rounds. Where this skill says "your expert" and you are a lead or a
specialist building your own spec, there is no hand-back: the clean round stands in for
a verification, and you open the PR. A developer, or a helper with a scoped piece,
always hands back and waits for `VERIFIED`, even where it drafted the spec.

## When
Once per piece of work (usually one future PR), on your local branch: when it is
complete, consolidated into one worktree and proven there (`/build-in-the-repository`).
Again for a branch your expert returns, and for a fix on your PR where
`/work-the-reviews` says. Not per commit.

A change is never too small for the loop. The one exception is a one-line docs fix
(`/landing-rules-detail`).

## The reviewer
Each round's reviewer is a new `code-reviewer` instance, your OATS child, attached to
your tree to read it:
```bash
oats spawn code-reviewer --work attached --work-dir <the consolidated worktree> \
  --parent "$OATS_INSTANCE" --same-work --repo <the worktree's clone, absolute path> \
  --name <change-slug>-r<round>-reviewer --task-file <review-brief.md>
```
- Always give both `--work-dir` and `--repo` (`repo` in your `instance.json`, or the
  clone you made the extra tree from). `--work attached` gives the reviewer your tree, to
  read the code and run the tests; it must not edit it.
- Name it for the change and its round (`gateway-limits-r2-reviewer`). One that replaces
  a reviewer in the same round adds a letter to the round (`-r2b-`): a name is used once.
- **One reviewer, one report.** It retires itself when its report is sent, so the next
  round always gets a new one.
- **Its model:** at or above the floor your landing rules set, and different from yours,
  since agents of one model share blind spots.
  [references/model-and-history.md](references/model-and-history.md) says how to compare
  and choose.
- An OATS child, not a native subagent, unless your person asks for one or your
  harness's multi-agent workflow mode is in use: a review is work your person can see.

## The brief: the range and the criteria, not your reasoning
Pin the range in the consolidated worktree: `git status --porcelain` prints nothing, and
`base_sha` is the merge base with the target branch, `target_sha` your head. The target
branch comes from the spec, your expert or the repository's convention.

`review-brief.md` holds exactly: the goal in two or three sentences; the repository, the
target branch, `base_sha` and `target_sha` in full; the criteria, verbatim (the spec's
"done when", its acceptance tests, contracts, edge cases and what is out of scope); how
to run the tests that bear on the change; and who to report to (you). A later round adds
`round: <n> of 4`, and nothing about earlier rounds. No design reasoning, no risks you
see, nothing you already checked: a reviewer told what to think approves it. It may ask
you for a fact while it reads.

A native reviewer, where one is allowed, gets the same brief, plus: "review
adversarially: correctness, the spec, edge cases, tests; report findings with a verdict,
then a Checked section: one line per 'done when' item and pinned acceptance test, saying
how you checked it, then the attacks that found nothing".

While it runs, edit, stage, commit or check out nothing in that worktree. Set a
checkpoint before you end your turn to wait on it (`/wait-and-retire`).

## Iterate
1. **The report** has a verdict (`APPROVE`, `APPROVE WITH NITS` or `CHANGES NEEDED`),
   each finding ranked blocker, major, minor or nit, and a Checked section. Once it is
   in, that reviewer is gone: check that `oats status` no longer lists it before the
   next step (`/wait-and-retire`, "The parent's sweep").
2. **A round is clean** only if it found nothing to fix (or only findings you dispute
   with a concrete reason) and its Checked section covers every "done when". A report
   without that is no review: run one fresh reviewer more.
3. **Each finding:** verify it against the code, then fix it, or dispute it with a
   concrete reason (a test, a contract, a spec line, a repository rule). One that would
   add an abstraction, an option or a test for a case that can't happen: if nothing
   needs it now, decline it with why. Skip none silently. If the findings show the
   design is wrong, go to your expert before you fix.
4. **One fix commit per round,** never an empty one; a rename, a move or an extraction
   the round asks for goes in a commit of its own beside it.
5. **Who reads the fix** is decided by the reviewer's severity, not by your wish:
   - a fresh reviewer, on the whole change: after a fix to a blocker or a major, or any
     delta that changes behaviour, a contract or the design;
   - a read of the delta alone: a fix to a minor, a nit you take, or a CI fix that
     changes no behaviour. Before a PR exists, and where no review bot runs, a fresh
     reviewer briefed with the delta's range, the findings it answers
     and the criteria (`<change-slug>-r<round>-delta-reviewer`). On an open PR,
     the review bot's review at the new head, where one runs. A fix ranked minor that
     turns out to change behaviour gets a fresh reviewer on the whole change;
   - nobody: a rebase whose range-diff shows every commit unchanged, or a merge of the
     default branch that leaves your own diff unchanged.

**The cap is 4 fresh rounds;** a delta's read is not a round. With findings still open
after the fourth, stop and take them, with your position on each, to your parent: a
developer's expert; for a specialist, the effort's lead; for a root lead, its person, as
a card. One overruled counts as disputed with a concrete reason; one upheld you fix,
then run a fresh round.

A secret or personal data in an intermediate commit needs a history rewrite: see the
reference before you touch it.

## Hand back
Hand over only a head a reviewer read, in one message: the branch at its head; what was
done against each "done when"; what you ran, with results, and what you could not; the
reviewers that ran and the number of rounds; the final round's verdict and Checked
section; each finding and how it was settled; the repository rules you followed;
deviations, and how to undo the change. If your expert is on another machine, push the
branch: still no PR before `VERIFIED`.

If your expert returns the branch, fix it in one commit (a structural change in its own
beside it), let the fix decide who reads it
as above, prove it again and hand back.

## Finish
Once your PR is merged and green, or closed, or the work is dropped, finish unprompted:
`/wait-and-retire`, "Retire yourself". You send your done line and retire yourself;
nobody does it for you.
