# Second-operator preparation before-evidence

These are supplied captures from OATS 0.24.1 (macOS, Node 26.8.2), **not expected
post-fix outputs**. Only the original absolute host prefix was replaced with
`/fixture/second-operator`, and the operator's names (its document id, and the
narrative file's name) with invented ones of the same length; the captures are
otherwise as supplied. Tests replace that prefix with an owned temporary
fixture root and explicitly map source/workspace/member to their inert Git
transport. No test here contacts the captured public repositories.

- `inspect-request.json` / `inspect-result.json`: original request includes an
  explicit workTarget; absent deployment was reported eligible for fresh setup.
- `prepare-{valid,bogus}-request.json`: original differing Git store locators.
- `prepare-{valid,bogus}-result.json`: preserve the identical pair, including
  actual artifact-set identities and empty post-approval approvalRequired arrays.
  SHA256 of **each**: `4af161a8521a9decf0cac4d98b3ee90c4e9eef837b129564ebe6dfca50cda97b`.
- `wire/`: original wire formatting; its prepare result pair is also identical,
  each SHA256 `684ec4340a04d74ef5edcfb707df7cd761efa8f04a1e9c07f927b6f66a87bb79`.
- `trust-dir-*` / `lock-v3-keys.json`: classic trust rejected the prepared v3 lock.
  The key inventory is evidence, **not a valid lock to install or synthesize**.
- `builder-raw-artifacts.md`: original narrative and absent-deployment repro note;
  preserve historical claims as supplied, not as proof of causation.

## Important scope correction

Equality alone does not establish that aweb prevented OKF normalize from running.
The original pair already contains a knowledge `needs-configuration` problem.
The reviewed OKF 2.1.1 normalization source requires explicit `bindings-file` and
`state-dir` settings; neither has a default. These captured operator policies are
empty. Both locators are structurally valid, so both can legitimately hit the same
missing-settings hold. Even with those settings, pure normalize/bind do not check
remote repository existence. A held messaging slot still prevents a resolution.

The public kernel regression in `test/workspace-onboarding-public.test.mjs`
therefore separately uses an **inert knowledge provider with an explicit source
hard-root constraint**, plus an inert no-interface messaging provider. It reuses
the captured request values to prove independent slot evaluation, choice-conflict
provenance and safe attribution. The changed root conflicts with that fixture's
source requirement. This is **not** proof that the captured bogus public repository
was checked or that real OKF/aweb preparation, readiness, auth or native launch is
qualified. Do not manufacture inequality by echoing/hashing opaque inputs or
changing these before-results.
