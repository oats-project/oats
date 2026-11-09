---
name: plan-and-spec
description: Turn a goal into a plan and one executable spec per surface (code area, package or service) for developers to implement. Use when starting a feature, fix or project in your domain, when a developer needs a spec, or when work must be split across developers.
---

# Plan and spec

A spec is done when a developer can implement it without asking what you meant or guessing.

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

## 5. Check the plan before launching
- Every "done when" is covered by some spec's tests.
- No two developers edit the same files without an agreed order.
- The riskiest assumption is tested first (a probe: a spike, a real run, `/send-a-probe`),
  not last.
- Each spec has a developer to build it (`/coordinate-developers`), which iterates with
  fresh reviewers until a round finds nothing to fix. You build none of it, and you verify
  each converged branch once.
- The plan and each spec are in your instance state; the design decision, with the
  alternatives rejected, is in your knowledge.
