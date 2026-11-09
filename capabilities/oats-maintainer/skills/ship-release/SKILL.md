---
name: ship-release
description: Ship a planned release as exact artifacts under explicit authority - pin the source, read the project's live release contract, tag, let the release run - then verify the publication item by item with the checklist, and handle a partial or failed publication without hiding it (re-run only the failed step from the same tag, never retag; fix a bad release forward). Use before and after any tag, and when diagnosing a release that half-ran.
---

# Ship a release

Start read-only. Confirm the version and its plan (`/plan-release`), the exact source SHA
(on the default branch, reviewed, CI green), where it will be published, and your authority
to publish: the yes of every owner your landing rules name for this release
(`/plan-release`), with that scope. This skill grants no push, merge,
credential or protected-ref authority.

## Read the live release contract
Read what actually runs the release: the workflow, its scripts, and the project's release
docs or skill. The executable is the authority; where the docs disagree, record it rather
than improvise. Get a broken release step fixed in the project rather than worked around by
hand each release: the fix goes to a lead and its developer (`/launch-work`), the expert
who owns the release tooling where there is one.

## Prepare
1. Pin the source SHA, this version's release notes, and the scope (artifacts, channels).
2. Work from a clean, isolated checkout of that SHA. Never reset a shared, dirty tree to
   make a gate pass.
3. Run the gates the release contract requires; record what ran and what didn't (a
   platform you can't build here, a manual acceptance step).

## Tag and publish
- Tag the exact SHA (annotated, if your project uses them), then let the release run as the
  contract says. A separately authorised publishing step needs that authority.
- Watch the release to its end; a pushed tag is not "released".

## Verify
Go through [references/verify-release.md](references/verify-release.md) item by item, and
report what you observed, with identifiers: versions, commits, digests, URLs. "No errors"
is not verification.

## Partial or failed publication
- Observe what was actually published (versions, their source commits, their contents)
  before choosing how to recover.
- Once the cause is fixed outside the tag (a credential, a runner), re-run only the failed
  step, from the same tag. Never retag; a fault in the tagged source ships fixed as the next
  version.
- A failed later step doesn't undo earlier publication. A retry that skips an
  already-published version doesn't prove that version came from this source: check it.
- Never delete or move a published tag, overwrite an immutable version, or cut a patch to
  hide an unknown partial outcome. Reconcile first; when identity or content is uncertain,
  stop and report.
- A same-name re-upload must match the reviewed artifacts byte for byte; a "replace" flag
  is not permission to replace unknown content.
- A credential fault goes to the human who owns the credential; runner and protected-ref
  faults go to your human or the operator.
- While publication is blocked, installing from the artifacts CI built is the human's call.
  If they choose it, say what differs: the registry and update checks still show the old
  latest version until publication. When publication later ships those same artifacts,
  nothing needs reinstalling.

## If the release is bad
A published release that breaks users is fixed forward, never rewritten:
- Stop the spread first: move the channel tag (`latest`, say) back to the last good
  version, or deprecate or yank the bad one where the registry allows, with a message
  saying what to use instead.
- Ship a fixed version quickly through the normal plan (`/plan-release`, as a hotfix).
- Tell the users and your human what broke, who is affected and what to do. Record it in
  your state, and a coherence rule if it can happen again.

## Close
Record the outcome under "Since the last sweep" in your state file. Tell those who must act
on it, once: whoever deploys it, the experts whose work waited on it, and your human, with
the version and what users must do. Publishing is not deploying: who adopts the release,
and when, is separate.
