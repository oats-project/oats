---
name: plan-and-spec
description: Turns a goal into a plan - frames the goal, designs at the lead's level, sizes the tree, splits the work by surface, writes one executable spec per surface with pinned acceptance tests, and decides who builds each spec (the lead itself, or a developer; a large feature always goes to developers). Use when starting a feature, a fix or a project as a lead or as a specialist, when a spec needs writing, and when deciding who builds it.
---

# Plan and spec

A spec is done when whoever builds it can implement it without asking what you meant.

## 1. Frame the goal
- **The record.** An effort has one record, where your landing rules keep them: your task
  names it, or you open it before you plan. Your tasks layer holds outcomes only (the
  effort, a change to land, a bug to fix). A probe, a helper's piece, a specialist's
  assignment, a spec and a review round live on the effort's record, never as items of
  their own.
- **The problem,** in a sentence or two, and who has it. **Done means** observable
  outcomes. **Constraints:** compatibility, contracts others rely on, security
  boundaries, dates set outside the work. **Out of scope.**

## 2. Design at your level
- Read your knowledge first. A design that contradicts a recorded decision changes, or
  says why the decision should, and to whom.
- Record each rejected alternative and why, one line each.
- Name every contract the change touches (APIs, file formats, CLI output, environment
  variables, events). A contract change names its consumers and an order: the consumer
  accepts the new shape first.
- If a simpler design meets most of the goal, raise it with the requester first.
- A choice your landing rules keep for a person (a one-way door) is asked before you
  build on it (`/hand-off-and-ask`).

## 3. Size the tree, and split by surface
Size the tree as your briefing says, for the effort or for your area, and record the
choice and its reason on the effort's record. The tree may grow: an effort that turns out
larger gets its specialists then. With specialists, write the interfaces between areas
first; each specialist then writes its own area's specs.

A surface is a part one builder can own, build and test on its own (a package, a service,
a module group). Where surfaces meet, the interface comes first and both specs cite it.
Sequence the pieces: what runs in parallel, what must land first.

## 4. Write each spec

```
# Spec: <title>
Goal:            <the problem and the outcome>
Done when:       <checkable outcomes>
Design:          <the approach; the key decisions and why>
Contracts:       <what must not break; what changes, and for whom>
Edge cases:      <inputs, failures and states the code must handle>
Acceptance:      <the tests that prove "done when", pinned: the builder adds them unchanged>
Tests:           <what else proves it: unit, integration, a real run, the QA steps>
Out of scope:    <what not to do>
Surface / files: <the repository, where the work lives in it; what to leave alone>
Delivery:        <branch, PR target, the reviews the lane counts>
```

## 5. Who builds it
Decide per spec, and record the choice and the case that decided it. Neither is the
default, and both cost: a developer costs a context to fill and a hand-off that loses
detail; building it yourself costs the context you hold the plan in. A developer earns its
place in three cases:
- **Context:** the build is sustained work whose detail (long diffs, test output,
  debugging) would crowd out the rest of the effort.
- **Parallel:** two or more surfaces are independent and can be built at once.
- **Specialisation:** the surface needs an environment, tools or knowledge you lack, or
  instructions that would conflict with your own.

<!-- adapt: What counts as a large feature here, past which a lead always sends developers? -->
A large feature always goes to developers, one per surface: more than one surface, or
sustained building and testing. If none of the three cases holds, build it yourself:
usually a small change, or
one that is a single line of reasoning with the plan. A change and its tests have one
author: never split one coupled change across agents.

**When you build it yourself,** you are its author as a developer would be: pin the
spec's acceptance tests first, work in an extra worktree (`/build-in-the-repository`),
and run the review loop with fresh reviewers, never yourself (`/run-the-review-loop`).
Where a build skill says "your expert", that is you: there is no hand-back and no
`VERIFIED` note for your own work. The round that finds nothing to fix stands in for a
verification: open the PR, work its reviews and land it. A helper building a scoped
piece hands that head back to its sender instead.

## 6. Check the plan before launching
- Every "done when" is covered by some spec's tests.
- No two builders edit the same files without an agreed order, and every interface
  between two areas is written.
- The riskiest assumption is tested first: by you where the work is simple, otherwise by
  a probe, or one probe per competing approach (`/orchestrate-agents`).
- The plan and each spec are in your state file; the design decision, with the
  alternatives rejected, is in your knowledge.
