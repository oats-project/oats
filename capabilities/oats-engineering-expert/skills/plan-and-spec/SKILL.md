---
name: plan-and-spec
description: Turn a goal into a plan and one executable spec per surface (code area, package or service), and decide who builds each, you or a developer - a developer only where it protects your context, builds in parallel, or specialises in a lane of its own. Use when starting a feature, fix or project in your domain, when a spec is needed, when choosing who builds it, or when work must be split.
---

# Plan and spec

A spec is done when whoever builds it, a developer or you, can implement it without asking
what you meant or guessing.

## 1. Frame the goal
- **The problem**, in a sentence or two, and who has it.
- **Done means** observable outcomes, not activities.
- **Constraints:** compatibility promises, contracts others rely on, security boundaries,
  performance limits, dates set outside the work (a sunset, a launch).
- **Out of scope:** what this work deliberately does not do.

## 2. Design at your level
- Read your knowledge first. A design that contradicts a recorded decision either changes,
  or says why the decision should, and to whom.
- Choose the design; record each rejected alternative and why, one line each.
- Name every contract the change touches (APIs, file formats, CLI output, env vars,
  events) and whether it changes. A contract change names its consumers and an order (the
  consumer accepts the new shape first).
- If a simpler design meets 90% of the goal, raise it with the requester before choosing
  the bigger one.

## 3. Split by surface
- A surface is a part one developer can own and build and test on its own (a package, a
  service, a module group).
- Where surfaces meet, the interface (the shape, the error cases) comes first; both specs
  cite it.
- Sequence the pieces: what runs in parallel, what must land first.

## 4. Write each spec
Use this shape, as short as the work allows:

```
# Spec: <title>
Goal:            <one paragraph: the problem and the outcome>
Done when:       <checkable outcomes>
Design:          <the approach; the key decisions and why>
Contracts:       <what must not break; what changes, and for whom>
Edge cases:      <inputs, failures and states the code must handle>
Acceptance:      <the tests that prove "done when", pinned: the developer adds them unchanged>
Tests:           <what else proves it: unit, integration, a real run, the QA steps>
Out of scope:    <what not to do>
Surface / files: <the repository, where the work lives in it; what to leave alone>
Delivery:        <branch, PR target, the reviews the lane counts>
```

## 5. Who builds it
For each spec, decide who builds it: you, or a developer. Record the choice, and the case
that decided it, in your instance state: one line per spec.

An extra agent costs: a context to fill, a hand-off that loses detail, messages to
coordinate, and several times the tokens. A developer earns its place in three cases:
- **Context:** the build is sustained work whose detail (long diffs, test output,
  debugging) the rest of the effort doesn't need, and which would crowd out what it does.
- **Parallel:** two or more surfaces are independent and can be built at once.
- **Specialisation:** the surface is in a lane of its own. It needs an environment, tools,
  skills or a soul's knowledge you lack, or instructions that would conflict with your own
  (`/send-a-helper`, "Specialisation").

**A large feature always goes to developers,** one per surface: more than one surface, or
sustained building and testing. It is the context case by definition. If none of the cases
holds, build it yourself: usually a small change, or one that is a single line of
reasoning with the plan you hold. Where one holds, a developer builds it
(`/coordinate-developers`). Never split one coupled change across agents: a change and its
tests have one author.

**When you build it yourself,** you are its author, as a developer would be:
- Write the spec, short, and pin its acceptance tests before you build.
- Work in an extra worktree of your own:
  ```bash
  oats worktree add --purpose <short-slug> --branch <branch> --base <its default branch> \
    --repo <clone of the spec's repository>
  ```
  Here `--base` names the remote's branch, which the command fetches when it runs (unlike
  `oats spawn --base`, a ref in the clone). Then check the commit it reports
  (`from origin's <branch> @ <commit>`) against
  `git -C <clone> ls-remote origin <its default branch>`; if they differ, the remote moved
  meanwhile: remove the tree and add it again.
- Follow the build skills as a developer does: `/execution-strategy`, `/worktrees`,
  `/test-first`, `/diagnose-before-fixing`, `/design-while-writing`, `/prove-it-works`,
  `/maintain-dev-docs`, `/run-the-review-loop`, then `/work-the-reviews`. Where one says
  "your expert", that is you: there is no hand-back to yourself and no `VERIFIED` note for
  your own work. Everything else applies, the review loop above all.
- **You are never its reviewer.** You run the review loop for your own work: each round's
  reviewer is a fresh `code-reviewer` instance, your OATS child, on a different model from
  yours, spawned attached to your tree as `/run-the-review-loop` says. You never read your
  own change as its review, and you still run no rounds for a developer's work.
- The round that finds nothing to fix is your green light: open the PR and work its
  reviews (`/work-the-reviews`), then land it (`/land-on-agreement`). A helper building a
  scoped piece of its parent lead's effort hands that head back instead, and opens no PR
  until its parent has verified it, as a developer's work: "your expert" is then the
  parent lead, not you.

## 6. Check the plan before launching
- Every "done when" is covered by some spec's tests.
- No two builders edit the same files without an agreed order.
- The riskiest assumption is tested first, not last: a probe that tests a theory the plan
  rests on, a spike or a real run, or, where the plan can go more than one way, one probe per
  competing approach (`/send-a-helper`).
- Each spec has its builder, you or a developer, by the cases in section 5, recorded one
  line per spec. Whoever builds it iterates with fresh reviewers until a round finds
  nothing to fix. You verify a developer's converged branch once, and run no review rounds
  for it.
- The plan and each spec are in your instance state; the design decision, with the
  alternatives rejected, is in your knowledge.
