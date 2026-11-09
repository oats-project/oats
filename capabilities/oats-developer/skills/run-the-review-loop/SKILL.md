---
name: run-the-review-loop
description: The developer's review loop - you, never your expert, iterate with fresh reviewers - a new code-reviewer instance each round, spawned as your OATS child (a native subagent only where your person asks for one or your harness's multi-agent workflow mode is in use) on a different model from yours where one is available, never the previous round's, briefed without your reasoning, until a round finds nothing to fix; retire each reviewer once its findings are settled; the same loop for fixes your expert returns and for bigger fixes on your PR; finish once your PR is merged or closed so your expert retires you. Use when a piece of work is complete and verified on your local branch, before presenting it to your expert and before any PR exists, when a fix on your PR needs a review, and when your PR is merged and green, or closed.
---

# Run the review loop

You iterate with the reviewers; your expert never does. It verifies the converged branch
once, and whatever it returns comes back through this loop.

## When
For each piece of work (a spec's worth, usually one future PR), on your local branch,
before any PR: when it's complete, consolidated into one worktree (`/worktrees`) and your
own verification passes there, with fresh reviewers round by round until one finds nothing
to fix. Again for a branch your expert returns, and for a fix on your PR where
`/work-the-reviews` says. Not per commit, not before the work runs.

## A fresh reviewer each round
Each round's reviewer is fresh: a new `code-reviewer` instance, your OATS child, never the
previous round's. It reads the change as it is, without the earlier rounds.
- **An OATS child:** a review is proper work, so its reviewer is an OATS child, not a
  native subagent of your harness (Claude Code's, pi's or Codex's). An OATS child is
  visible to your person (its status, the Desktop), has its own messaging and knowledge,
  and is retired on record; a native subagent is invisible to everyone but you. A native
  reviewer only where your person asks for one, or in your harness's multi-agent workflow
  mode (Claude Code's ultracode, say) when it is in use.
- **On a different model from yours** where the organisation has one (Pick a different
  model): agents of one model share blind spots, so their agreement is not independent.

It is spawned attached to your tree:
```bash
oats spawn code-reviewer --work attached --work-dir <the consolidated worktree> \
  --parent "$OATS_INSTANCE" --same-work --repo <repository> \
  --purpose <short-slug> --task-file <review-brief.md>
```
Always give both `--work-dir` and `--repo`. `<repository>` is the absolute path of the
worktree's clone: `repo` in your `instance.json`, or the clone you made an extra worktree
from. Each reviewer is your child, on your work (`--same-work`), shares your tree to read
the code and run the tests, and must not edit it; each gets a purpose of its own, so no two
share a name.

## Pick a different model
A reviewer on your model shares your blind spots. Before spawning, compare:
- yours: your `instance.json` → `launch.harness` and `launch.model`;
- the reviewer's: `oats spawn code-reviewer --preview --json` → `launch.declared` (the
  soul's default) and `launch.effective` (what this machine will launch; when
  `launch.from` is `local`, the machine's `oats-local.yaml` `souls.launch` entry named by
  `launch.at` overrides the default).

<!-- adapt: Which harnesses and models does this organisation have for model diversity? -->
Compare the models, not the harnesses: a provider prefix names a route to a model, not
another model, so `github-copilot/gpt-6-astra` on pi and `gpt-6-astra` on Codex are one
model. When the effective reviewer's model is known and differs from yours, spawn without
`--harness`/`--model`, so the machine's override applies; don't force the soul's default
over it. When it would run on your model, on any harness, spawn it on another
state-of-the-art model, on another harness when you can: currently Codex with Astra, Claude Code with Opus 5.5, Fable, or the latest Grok,
through a launch configuration this host defines (`oats launch-config list`) or
`--harness`/`--model`. If none is available, use the effective one and say so in your
handback.

If either model is unknown (`null`, absent, or a harness's native default), the comparison
proves nothing: spawn the reviewer with `--harness`/`--model` (or a launch configuration) on
a model you know differs from the one you run, which your harness reports (its status line,
or its model command). If you can't establish a difference, say so in your handback.

## Brief it: context, not conclusions
Every round's `review-brief.md` holds exactly:
1. The goal, in two or three sentences.
2. The spec, or a link to it: "done when", contracts, edge cases, out of scope.
3. The diff range at this round's head (`git diff <base>...<head>` in that worktree) and the
   branch.
4. How to run the relevant tests, so it can confirm a suspected bug.
5. Who to report to (you), and how (your messaging layer, if any).

Leave out your design reasoning, what you think is risky, what you already checked, how
confident you are, and the earlier rounds' findings. The reviewer can ask you for a fact.
Its method is its own `oats.code-review` capability. A native reviewer (where one is
allowed, above) gets the same brief, plus "review adversarially: correctness, the spec, edge
cases, tests; report findings with a verdict".

## Iterate, one fresh reviewer per round
1. The round's reviewer reports findings with a verdict: `APPROVE`, `APPROVE WITH NITS` or
   `CHANGES NEEDED`.
2. Fix each finding, or dispute it with a concrete reason (a test, a contract, a spec
   line). Skip none silently, and record each in your notes. A finding you can't place or
   reproduce, ask that reviewer about while it still runs: a fact about its finding, never
   a review of your fix.
3. Once every finding is fixed or disputed, close the round and retire its reviewer
   (Close); a native reviewer ends with its report.
4. Start the next round's fresh reviewer at the new head.
5. Repeat until a round finds nothing to fix: `APPROVE` or `APPROVE WITH NITS`, or only
   findings you already dispute with a concrete reason. Nits are yours to take or leave: a
   nit you take moves the head, and a moved head gets a fresh round, so leave the rest for
   the PR. Hand back only the head a clean round reviewed.

Cap: 4 rounds. Still `CHANGES NEEDED` after round 4: stop, and take the open findings with
your position on each to your expert, who decides each. One it overrules counts as disputed
with a concrete reason (its decision, in your hand-back); one it upholds you fix, then run a
fresh round.

## Set a checkpoint before you wait
Once your turn ends you run no instructions, and a stalled reviewer may report nothing: a
refused provider, a stuck harness or a sign-in screen can each leave it `running`, with no
claim and no new event. So before you end your turn to wait for a round's verdict from a
reviewer instance, set a wake that fires from outside your session. From your
home:
```bash
oats session inspect --home "$OATS_INSTANCE_HOME" --json   # wakeHold: see below
node -e 'const d=new Date(Date.now()+60*60000);console.log(d.getUTCMinutes(),d.getUTCHours())'
cat > checkpoint.json <<EOF
{"kind":"wake","enabled":true,"cron":"<minute> <hour> * * *","tz":"UTC","home":"$OATS_INSTANCE_HOME",
 "message":"Checkpoint: <reviewer> owes a verdict on <head>. If it came, remove this job and stop; if not, follow 'Set a checkpoint before you wait' in /run-the-review-loop."}
EOF
oats schedule add "$OATS_INSTANCE-review" --file checkpoint.json
oats schedule show "$OATS_INSTANCE-review" --json   # nextRun must be the moment you meant
```
- **Read `wakeHold` first.** A wake's Enter answers whatever your session is showing. Set
  one only where it reads `on-claims` or `not-exposed`. With `unknown` or no `wakeHold`, set none: hand the wait to your
  expert in one line (who owes what, by when), and it sets a checkpoint on you, on its own
  home: its recipe watches you, never your reviewer, which is yours to replace. When it is
  due, your expert tells you so: follow "When it fires" below, taking its first message as
  your first checkpoint and its second as your second.
- **The 60 is the minutes until the verdict is overdue:** what a round like this took, with
  margin; with nothing to go on, an hour.
- **The cron repeats daily on purpose.** A minute the host slept through is never replayed,
  so a pinned date would stay silent for a year; this one comes round the next day.
- **When the verdict arrives,** remove the job: `oats schedule remove
  "$OATS_INSTANCE-review"`. If that refuses because the job is running, the wake started
  your stopped session: add `--force`, which stops nothing.
- **To set a later checkpoint,** remove the job the same way and run the recipe again: `add`
  refuses an id that exists. Start the message with "Second checkpoint:", so the wake says
  which one this is, even after a restart.
- **No wake can fire** unless `oats schedule add` succeeds and `oats schedule host status`
  answers `active: true`, `registered: true` and no `problems`. Failing that, tell your
  expert once, in one line: its own checkpoint on you then bounds this step. Installing the
  host's timer is the operator's.
- **`E_SCHEDULER_BUSY`** may be a tick holding the lock, and nothing changed: run the
  command once more a little later. Still busy, no wake can be set: tell your expert, as
  above. That lock is never yours to remove.

**When it fires,** the verdict is overdue, nothing more: a reason to look, not proof the
reviewer failed, and no reason to interrupt one that is working. Read its row in `oats
status --json` and `oats instance events <reviewer> --json` (`waitingClaims`), then:
- **A verdict or question reached you and you missed it:** act on it.
- **A claim says what it needs:** give it.
- **A `wake-held` event:** history, not a state. Read the job it names: `oats schedule show
  <schedule> --json`. Only a `lastRun` that still carries `held` means its wake is waiting,
  and then someone outside it has to act: tell your expert. Never clear the claim or answer
  the dialog yourself: a claim can be stale, but a live dialog takes the next Enter.
- **A claim says its turn failed, or `running` is false with `sessionEnd` `exited` or
  `lost`:** replace it now (below).
- **`running` is false with `sessionEnd` `stopped`, or none:** it may have been stopped on
  purpose. Replace nothing: ask your expert whether it should run.
- **Anything else:** `running` with no claim says nothing either way. Ask it one precise
  question through your messaging layer, and set a second checkpoint, half as far out.

**A second overdue checkpoint ends the wait.** Never set a third, and never read silence as
approval. Spawn a new reviewer with the same brief, on another model if a provider refused
this one, retire the stalled one (`oats retire <name>`) and say so in your handback.

## Close
- Hand the branch to your expert only once the loop converges, never intermediate heads,
  with: the branch and its head, what was done against "done when", how it was verified and
  what you could not run (`/prove-it-works`), the final verdict, the number of rounds, each
  disputed finding and its resolution, and anything deliberately left out.
- If the expert returns the branch, fix what it found and run the loop again, fresh
  reviewers included, and hand back only once a round finds nothing to fix: every change on
  the branch is reviewed before a PR exists.
- On the PR (`/work-the-reviews`), a fix bigger than a few lines gets a fresh round before
  you push it.
- Retire each round's reviewer once every finding of its round is fixed or disputed, before
  the next round starts, without asking anyone. With no messaging layer, it printed its
  report as its final message and can't send a done line or answer a question: retire it
  once you have the report. Otherwise tell it the round is closed, and once it
  replies "done, harvested:
  <harvester>" or "done, no harvest duty" (after "done, harvest pending: <proposal>", wait
  for the first), check `oats retire <name> --plan`, run `oats retire <name>`, note it
  (name, why). The consolidated worktree it read stays: the next round, your expert's
  return and your PR's fixes all run on it, and it goes at Finish (`/worktrees`). Retire only
  your own children, and never give a new reviewer a retired one's name. None of this
  involves a person.

## Finish
An instance is **finished** when all of these hold:
- its work has landed: its PRs are merged (or deployed, where the effort deploys) with CI
  green on the merged commit, or closed, or the work was explicitly dropped. Handed back
  is not landed: it may still be needed for fixes and rebases;
- nothing waits on it: no open PR, review, question or hand-back of its own, and its own
  children are retired;
- with a harvest duty (your knowledge layer says whether you have one), its final harvest
  checkpoint ("you finish a task") is recorded in its log.md with the harvester's name, and
  the harvester is launched. The harvester snapshots its evidence at spawn and the retire
  keeps a recovery copy, so nobody waits for the harvester to finish.

Once you learn your PR is merged and green, or closed, or that the work was dropped (your
expert tells you, or you see it on the forge), finish unprompted:
1. Retire any reviewer you still run, as above: children are retired before their parent.
2. Leave nothing uncommitted or unpushed, and remove your extra worktrees (`/worktrees`):
   your expert checks `oats instance git` before it retires you, since a retire would keep
   such a work tree, not deliver it. When your work isn't a Git work tree (directory or
   workspace mode), it checks each repository your done report names instead.
3. With a harvest duty, run your final checkpoint and launch the harvester.
4. Send your done line: "done, harvested: <harvester>" or "done, no harvest duty". After
   "done, harvest pending: <proposal>" you are not finished: send "done, harvested:
   <harvester>" once the proposal goes through. When your work isn't a Git work tree, name
   each repository you used under it, with its branch. Your expert, your parent, then
   retires you with `oats retire <name>`, without asking anyone.
