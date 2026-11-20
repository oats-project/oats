---
name: crossed-mail-freeze-discipline
description: Use when a coordinator sends crossed or out-of-order HOLD/GO/HOLD instructions, a freeze arrives after action was already taken, reviewer findings arrive during a freeze, or mail may be stale against your already-sent state reports.
---

# Crossed-mail freeze discipline

Use this protocol when freeze/unfreeze coordination mail crosses in flight.

## Steps

1. Treat each incoming HOLD/GO/HOLD instruction as possibly stale. Compare it
   with the state you already reported, the remote branch head, local commits,
   and uncommitted work before acting.
2. If a HOLD arrives after you already acted, do not undo solely for compliance
   theater. Freeze at the named point and report the exact ledger: pushed state,
   local unpushed commits, uncommitted changes, and any relevant verification.
3. During a freeze, keep the remote head stable. Reviewer findings may still be
   fixed locally as unpushed commits that ride with the closing commit after the
   freeze lifts.
4. Verify moving-head claims yourself before relying on mail text. Fetch as
   needed, use ancestry checks such as `git merge-base --is-ancestor`, inspect
   logs, and include the verification result in your report.
5. If an instruction describes a state you already reached or reported, take no
   duplicate action. Reply only when an explicit ACK or ledger update is needed
   for coordination.

## Gotchas

- A precise state dump is more useful than trying to recreate the coordinator's
  expected timing after mail crossed.
- Local unpushed freeze-time fixes preserve the frozen origin head for other
  verifiers while avoiding idle time.
- Do not push freeze-time fixes until the freeze is lifted or the coordinator's
  instruction permits the closing commit.
