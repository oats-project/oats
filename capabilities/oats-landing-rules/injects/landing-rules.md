## Landing rules: how work lands here

"Your landing rules" in a skill means this section: this organisation's rules for landing
work, and its ownership record. They change only on the yes of the person who owns the
lane, each rule with its reason. Whoever writes a change then messages you, and it wins
once you record it in your state file. No rule sets a deadline, and silence approves
nothing.

**Lanes and their owners.**
<!-- adapt: Which lanes does the organisation have, what does each cover, and which person owns each? -->
- `main`: everything in this workspace's repositories, owned by the person who runs the
  workspace. It is also the release lane.

A lane's maintainer, where it has one, is the instance named `<person>-<lane>-maintainer`.
There is no lane map: the name is the seat.

**What merges a change** built inside an effort: all of these, at one head. A PR with no
lead (an outside contributor's, a person's own, a maintainer's release prep) follows
`/landing-rules-detail`.
<!-- adapt: Per lane, which agreements must hold at a PR's head before it merges, and who merges it? -->
1. CI green.
2. A review at that head: the forge's review bot's where one runs, every finding fixed
   or answered; otherwise a round of the author's review loop that found nothing to fix.
3. `VERIFIED at <head>` from whoever specified the work, for a developer's or a helper's
   change. A change a lead or a specialist built itself needs none: nobody verifies
   their own work.

A new commit needs them again unless a carry rule holds (`/landing-rules-detail`). The
lead merges, or the specialist for its area's PRs. Why: independent checks at one head,
and whoever owns the work lands it.

**A maintainer's green light, and releases.**
<!-- adapt: Where does the organisation require a maintainer's green light on a PR, keep the merge for a maintainer or a person, and who releases? -->
No lane needs a maintainer's green light. A release's contents are approved by the owners
whose lanes have changes in it; the release lane's maintainer plans, tags and publishes
it, started when first needed. Why: a maintainer holds what a lead wouldn't, and is called
only for it.

Where a lane does ask for it, "green light" means only that maintainer's verdict at an
exact head, by message: `GREEN LIGHT at <head>`, `RETURN at <head>` with its findings, or
`ESCALATE`, a direction question gone to whoever decides it, which you wait on. It
judges direction, contracts, coherence, scope and evidence, never a second code review.

**One-way doors kept for people.**
<!-- adapt: Which acts must a person approve, beyond a release's contents? -->
A release's contents, publishing outside the organisation, spending money, and deleting
what someone else uses. Nothing else goes to a person by rule.

**The ownership record.** With one person, they own every path and lane.
<!-- adapt: With more than one person, who owns which paths and lanes? -->
- (one line per area: its paths, and the person who owns them)

**Records.**
<!-- adapt: Where are the effort records and holds kept? -->
- An effort record: one item per effort in your tasks layer, its status at the top.
- A hold: marked on the PR it holds, or, for the default branch, one open record in your
  tasks layer, each with its reason, its scope and who lifts it.

**House rules, for every role.**
- Name every instance you spawn `--name <task>-<role>`: its task first, and last the
  role it plays in the effort (lead, specialist, helper, probe, developer, reviewer,
  maintainer, dispatcher), never its soul, which the sidebar already shows. Five words at
  most, the role included. A person tells instances apart by name alone, so never reuse
  one: when a name is taken, make the task's part more specific.
<!-- adapt: Which is the weakest model tier a child may run on, in each model family the organisation launches? -->
- IMPORTANT: NEVER run a child, an OATS child or a native subagent, on a model below the
  floor: a weaker model fails without saying so, and its answer is used as your own. The
  floor is your own model's tier, in your family or another: never a smaller, faster or
  cheaper model, to save cost or time. It comes before model diversity, and it binds the
  model a child would actually launch on (`/landing-rules-detail`).
<!-- adapt: Where may agents build and run tests, which hosts are shared, and which are read-only? -->
- Build and test in an environment of your own (your worktree, a scratch directory, a
  container), never against another instance's or a person's state. On a shared host,
  run the tests that bear on the change, no load or soak tests, and only as much in
  parallel as the host can take. A customer's or a production host is read-only.
- Never run code you haven't read on your host: an outside contributor's change runs in
  CI. Never put a secret in a message, a brief, a report, a log or a commit: say where
  it is and who can grant it.

**Skills.** `/landing-rules-detail` when you judge whether an agreement holds at a head,
and for what this section leaves open. `/wait-and-retire` before you end a turn to wait
on an instance you started, and when one is finished.
