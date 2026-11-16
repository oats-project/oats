---
name: build-in-the-repository
description: Builds a change the way its repository wants it - finds and follows the repository's own rules before the first edit (they outrank habits and the spec), works in extra worktrees made from the remote, keeps one author for a change and its tests, follows the commit rules from the first commit, proves the change with the repository's own gate and the checks CI runs, and names the evidence for every claim. Use before the first edit in any repository and in each new directory, when the work needs another checkout, and before handing a branch back or pushing a fix.
---

# Build in the repository

You know how to write and test code. This skill holds what the team adds: whose rules
win, where you work, and what counts as proof.

## 1. The repository's rules win
A repository says how it wants to be changed, and its rules outrank your habits, general
practice and any line of your spec that contradicts them. Before your first edit, and
again in each new directory, read what exists:
- its agent instructions (`AGENTS.md`, `CLAUDE.md`), at the root and in every directory
  on the path to the files you touch, and its rule folders;
- its own skills: a development skill there is how the repository wants work done. Where
  one needs a credential or a person's sign-in, stop and ask your expert;
- the contributing and architecture docs, and any record of past review findings:
  reviewers will hold your change to them;
- the gate as executed: the task runner, the linter configuration, the CI workflows
  (title and commit checks included) and the PR template.

Note what binds this change: where the code goes, the patterns to use and to avoid, the
exact gate commands, the commit rules. Where the spec and the repository disagree, ask
your expert with your proposed answer before you build that part. Don't settle it
silently either way.

Docs are part of the change: when your change makes a document, a rule or a comment
untrue, fix it in the same change. A doc that was already wrong: fix it, or name it in
your hand-back if it is outside your surface. What the next developer needs goes into the
repository, never only into a knowledge base.

## 2. Your trees
Work only in trees of your own, made from the remote's current branch. From your home:
```bash
oats worktree add --purpose <slug> --branch <branch> --base <the default branch> --repo <member key or clone path>
```
- `--base` names the remote's branch, which the command fetches when it runs. Check the
  commit it reports (`from origin's <branch> @ <commit>`) against
  `git -C <clone> ls-remote origin <branch>`. If they differ, the remote moved: remove
  the tree and add it again under a new branch name: a tree never reuses a branch.
- Name the branch by the repository's rules. To rework an open PR, start the new branch
  from its branch and push `HEAD` back to it.
- One tree per path that touches the same files, a spike you may throw away in its own
  tree, and one per extra base or branch.
- **Consolidate before review:** merge every path into the one tree whose branch becomes
  the PR, and run the full verification there. Every review round, your expert's return
  and your PR's fixes run on that tree, so it stays until you finish.
- **Before you hand back,** every other tree is merged, or its branch is pushed and
  named in your hand-back, or it is deliberately abandoned; then it is removed. **At finish,** with your PR merged
  or closed, remove them all. Retire an instance attached to a tree before you remove it.

## 3. While you build
- **A change and its tests have one author.** One context is the default. Fan out only
  across components with a settled interface between them, or independent questions.
<!-- adapt: How many agents may a developer's workflow run without asking its person? -->
- **A workflow of your harness's own agents** runs your own paths without asking while
  it stays under 10 agents, counted across all stages and back-to-back workflows. Ten
  or more need your person's permission: say how many, why, and what the smaller shape
  would cost. Where the harness itself requires a person's opt-in to run a workflow,
  that consent is theirs: use a standing opt-in they gave, or ask once per task with
  the agent count. Read what the agents produced: it goes through consolidation and the
  review loop as your own work. A path that needs a soul's knowledge, or a testing
  capability you lack, is no workflow agent's: ask your expert for an OATS child of that soul.
- **The spec's acceptance tests go in unchanged.** One that looks wrong goes to your
  expert, with why.
- **Commit rules from the first commit:** the repository's sign-off, signing and message
  format. A check that refuses an early commit is fixed only by rewriting history.
- Generated code is regenerated with the repository's generator, never edited by hand.
  A rename, a move or an extraction goes in a commit of its own.
- **A bug you can't reproduce with a command stops its fix:** tell your expert what you
  tried and what would let you (an environment, a captured artefact, instrumentation).
  **Three failed fixes for one bug means stop:** tell your expert what you learned, with
  your recommendation, before a fourth. A fix with no seam that can hold a regression
  test is a finding: name it in your hand-back.
- **No test asserts on a double instead of the behaviour.** Doubles stand only at real
  boundaries (the network, the clock, a paid service), never for your own collaborators.
  A double of an external tool or API is checked against the real one at least once,
  with the command in your hand-back.
<!-- adapt: Does the organisation enforce the quality floor with its runtime's hooks, and with which checks? -->
- **The quality floor** in your briefing is yours to keep: nothing enforces it but you
  and your reviewers.

## 4. Prove it
Prove the change the way the repository runs it, within your landing rules' house rules
for the hosts.
1. Build and run it locally, with the services it needs, and exercise the changed
   behaviour as a caller would. The environment your soul provides is how, where it has
   one.
2. Run the repository's gate and the checks CI runs for what you changed, as bare
   commands on the consolidated tree: no filter piped after a test command (it replaces
   the exit status), and no gate inside a chain. Where the linter or type checker
   already fails on the default branch, compare against its count and say so.
3. Run the spec's acceptance tests and QA steps, and keep the evidence: commands,
   outputs, screenshots for a UI change.
4. Say what you could not run, and why. If that gap recurs, your expert raises it.

Every claim in your hand-back names the command you ran at that head and what it
printed. "Should pass" is not evidence, and neither is an agent's report of success:
rerun what it reports, and read its diff. List the repository files you read and, for
each rule that shaped the change, one line on how the change follows it.

Adapted from sources listed in THIRD-PARTY-NOTICES.md
