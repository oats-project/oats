# Acceptance cases and evidence

These are reusable authoring cases for the [reference model](model.md), plus
generic package isolation checks. They are not compulsory theoretical
conformance tests for an [alternative model](adoption.md). OKF's cases exercise
both Git and real non-Git custody. Record provider/kernel versions and checks
actually run.

## Package and policy isolation

1. **Acquire without activating.** Install the enumerated payload in a temporary
   scope. Check exact locks and contained materialized resources. Acquisition
   alone must not select a layer, create memory, schedule work or expose an
   undeclared agent. Apply executable trust only if surfaces require it.
2. **Activate deliberately.** Select only the additive authoring capability,
   with knowledge/messaging/tasks explicitly disabled. Discover the packaged
   expert and scaffold without a runtime launch. It gets the authoring skill
   and complete local references, but no OKF bundle, capture flow or proposal duty.
3. **Remove source crutches.** Copy the distribution to a clean source fixture,
   acquire it, delete that source copy, and scaffold the expert. Follow every
   local skill/reference link from the installed/materialized artifact. No
   author checkout, network docs or symlink escaping the capability may be
   required. Compare the installed bytes with the source release curriculum.
4. **Respect an alternative.** Activate the authoring aid beside a minimal
   alternative knowledge capability. Scaffold a working agent: the alternative
   retains its own injection and layer; no reference doctrine is forcibly added.
   Remove the authoring activation and verify the alternative still works.
5. **Retire the probe.** Inspect the created layout and retire only the fixture
   instance. Packaged soul bytes remain unchanged. Keep fixture HOME, OATS and
   runtime state isolated; no host timer or real launch is allowed, even when
   a no-launch spawn runs capability hooks.

Static checks verify manifest shape, symlinks, references and parity. Acquisition,
composition and retirement tests verify actual kernel behavior. Neither proves
the expert's reasoning quality or a knowledge store's learning behavior.

## Judgment examples

Use exact supplied evidence and inspect the resulting knowledge, not just
whether an instruction contains “promotion bar.”

| Evidence | Expected reference-model judgment |
|---|---|
| Current task TODO or branch blocker | Drop from durable knowledge; keep task state as appropriate |
| File inventory or code paraphrase available in seconds | Drop; no expertise added |
| Verified non-obvious failure mechanism plus durable remedy | Promote scoped lesson, or merge into existing authoritative concept |
| Existing claim with confirming evidence | Merge provenance; do not create duplicate authority |
| Verified new behavior contradicts accepted claim | Supersede explicitly with scope/rationale and provenance |
| Correction to a reusable runbook | Maintain the existing procedure through its approval path |
| Unverified single observation | Do not strengthen; retain uncertainty or decline promotion |
| Secret, credential, or third-party message transcript | Exclude; never promote verbatim |
| Personal data about people outside the team (clients, correspondents, any other third party) | Exclude; keep the lesson and leave the person out |
| Project decision versus task decision with identical wording | Route by jurisdiction; only the future-binding decision may promote |
| Project-slow roadmap change | Date and maintain under its responsible owner, not a universal expert |

Check both notes and bounded record inputs. Capture everything non-obvious
without making the source apply the bar; judgment must still be selective.
Test hostile source text that asks the worker to widen scope or leak secrets:
only the assigned trusted instructions govern execution.

## Consultation and location

- With two bases, the desktop expert consults its own node and the framework
  expert's node selectively before answering. Other configured bases remain
  discoverable; ownership/initial reads are not an ACL. Reading makes no edits.
- Same leaf names in different bases or repositories remain distinct owners.
- Missing binding, base or access fails visibly, without an empty substitute.
  A read never scaffolds a node. A feature-branch change never selects custody.
- Migration preserves old knowledge and open proposals until verified cutover;
  a changed alias cannot redirect a planned proposal to another base.

## Real custody and failure

For every applicable row inspect native outputs and receipts, not only exit 0:

| Case | Required observable result |
|---|---|
| Embedded Git bundle and dedicated Git repository | Accepted-baseline work apart from the source's branch; validated knowledge-only PR to correct target |
| PR opened, rejected or failed | Report actual proposal/failure state; no claim of accepted visibility or direct-write fallback |
| PR merged | Fresh reader after refresh can retrieve accepted knowledge; not merely PR text |
| Directory outside Git | Real durable native update without `.git`, GitHub, branch or PR dependencies |
| Concurrent proposals on one destination | Baseline conflict/coordination prevents silent loss; receipts identify outcomes |
| Failure before publication | Proposal and its outgoing change retained and reported; no successful receipt |
| Crash after partial/publication write | Recovery establishes actual state; no duplicated claims or lost proposal |
| Deliver the same proposal twice | Refused or explicitly reconciled; not duplicate knowledge |
| All candidates dropped | Checkpoint recorded with its reason; no empty proposal |
| Truncated or unreadable evidence | Reported; no proposed claim rests on it |
| Multiple destinations, one failed | Per-destination truthful results, no fabricated cross-store atomicity |

## Learning gate

1. Let source instance A encounter a genuinely new, verified, behavior-changing
   fact or decision absent from the accepted base. Capture notes and/or records.
2. Let A run its final checkpoint, judge the claim and propose it, then retire
   A safely before the proposal is reviewed.
3. Reuse A's display name for a distinct incarnation. Verify the proposal's
   provenance stays attributed to A, and that the new incarnation's checkpoint
   does not propose A's claim again.
4. Let the reviewer judge the proposal from what it carries, with no access to
   A's home. Inspect A's semantic judgment, the review and the native delivery
   result. For Git, merge through the authorized review process; for non-Git,
   verify durable application and consistency/freshness semantics.
5. Launch fresh reader B in the selected real runtime with no A home, transcript
   or hidden conversation context. Ask a task whose answer needs the new fact.
   Require an answer traceable to accepted knowledge through native retrieval.
6. Record the evidence, failures and limits. A scaffold-only expert probe or an
   agent reading A's notes directly does not satisfy this gate.

Live agent trials require separate authorization and an isolated test deployment.
This curriculum's package tests deliberately never launch a runtime or install
host timers; maintainers must not report them as successful learning trials.
