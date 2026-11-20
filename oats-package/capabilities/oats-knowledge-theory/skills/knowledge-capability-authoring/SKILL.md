---
name: knowledge-capability-authoring
description: >-
  Use when designing or reviewing a knowledge capability, explaining the OATS
  reference knowledge theory, mapping memory and proposals to a native store,
  writing reader/capture injections or judgment and proposal instructions, or
  assessing adoption versus an alternative learning model. Not for proposing
  knowledge from a working instance, ordinary note taking, or merely pinning a
  package.
---

# Author a complete knowledge capability

This is optional authoring guidance, not a runtime protocol. The expert is an
assistant to authors, not a prerequisite for using their capabilities. This
skill works with knowledge disabled and requires neither OKF nor network docs.
A workspace gets it by pinning `oats.framework` in `packages:` and giving a
soul `oats.knowledge-theory: { from: package }`; declaring the package is the
trust decision.

## Read progressively, using only this local curriculum

Start with the [authoring guide](references/knowledge-capability-authoring.md)
and [reference model](references/knowledge-reference/model.md). Follow links
relative to their containing file, not from the instance home or work tree.

| Task | Read next |
|---|---|
| Choose the model or document a departure | [Adoption and alternatives](references/knowledge-reference/adoption.md) |
| Map a native store and its actual guarantees | [Provider mapping](references/knowledge-reference/provider-mapping.md) |
| Write working-agent instructions | [Reader and capture](references/knowledge-reference/reader-capture.md) |
| Write judgment and delivery instructions | [Judgment and proposal](references/knowledge-reference/proposal.md) |
| Package the capability, soul and skill | [Package craft](references/knowledge-reference/package-craft.md) |
| Verify behavior and installed usability | [Acceptance cases](references/knowledge-reference/acceptance.md) |

## Authoring checklist

1. Ask whether the author adopts, adapts, or replaces the reference theory.
   Do not turn its promotion doctrine into a universal compatibility gate.
2. Inventory the real tool/version and read/write/acceptance guarantees. Mark
   unknowns explicitly; never invent commands or a transaction API for a tool
   you have not verified.
3. Fill the provider mapping and assign every runtime responsibility to the
   new capability. Logical names, physical locations and ownership differ.
4. Draft a short always-loaded reader/capture injection; put occasional
   procedures in that capability's own skills. Ship the complete judgment
   and proposal instructions and the native delivery protocol too.
5. For reference adoption, working instances never write accepted state:
   they propose at checkpoints, their last one before retirement, and a
   reviewer accepts; use PRs for Git and native confirmation for non-Git.
   Instructional no-write is not an OS sandbox. An independent harvester is
   an option with its own obligations (adoption and alternatives).
6. Package every referenced resource locally. In an isolated workspace, pin
   the package in `packages:` (declaring it is the trust decision, so show its
   commands and hooks first), run `oats sync`, give a test soul the capability
   `{ from: package }`, and scaffold a spawn with the intended harness. A
   no-launch probe can still run hooks: never use a live deployment.
7. Test semantic judgment and actual delivery/reader visibility separately.
   Report a proposal as a proposal, not as accepted or queryable knowledge.

## Hand-off

Return: model choice and departures; verified tool/version facts; responsibility
and custody map; proposed package files; behavioral test results; remaining
unknowns and approvals. No edits to live deployments or silent migrations.

## Gotchas

- An additive authoring package is not a knowledge-layer implementation. No
  mandatory doctrine injection or dependency on this expert belongs in core.
- Neither a source feature branch nor a soul's physical location selects the
  destination. Missing bindings must not create empty substitute knowledge.
- Captured evidence, completed judgment, delivered proposal, accepted state
  and reader visibility are different facts; a command exit is not all five.
- Static package checks cannot prove learning. A fresh reader must use accepted
  knowledge without the original source home or transcript for that claim.
