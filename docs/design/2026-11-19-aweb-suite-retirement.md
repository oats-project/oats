# K2 retirement audit against oats.aweb v1.44.0

Release: `v1.44.0`, peeled commit `5d1c6720bdf60a16379f8486c7d3f6f972294279`.
Transfer merge: `dc90c9556e58d03a80da9c5b3e6ed6139f22471e`; `git merge-base --is-ancestor dc90c955 v1.44.0` exits 0 in the owned `.work-aweb-audit` tree.
Original assertion inventory: kernel `3a5503c2993a307a0bb48d0b41dcab7d175adc27`.
Released transfer manifest: [docs/kernel-test-transfer.md](https://github.com/awebai/oats-aweb/blob/v1.44.0/docs/kernel-test-transfer.md) (17 + 11 + 9 + 19 = 56 rows).
This is a static assertion match, not a run of provider tests or a claim about a CI result.

Package test files below are at that exact released commit. Titles/behaviour identify cases independently of line shifts. `hook13` means `test/oats-aweb-hook-1-13.test.mjs`; other short names are files under `test/` with `.test.mjs` suffix. The old kernel files run provider binaries directly and never the kernel hook runner.

## hook-1-10 — 17 rows

| Original line | Released covering assertion or explicit retirement reason |
| --- | --- |
| 145 | hook13 normal global grants: scopes, custody-before-mint order, socket/team/cwd/env and written grant home. Old brief spelling is superseded by current messaging text. |
| 165 | hook13 attachment verification failure vectors: mismatch/missing socket fails, revokes actual fake-service grant and removes home. |
| 177 | hook13 fresh launch renewal: new home/locator, written grant, old grant revoke and service state. |
| 192 | hook13 recorded-final-locator readiness: wrong/newer unattached home cannot override selected locator. Old unconditional ready expectation is superseded because broker evidence is now required. |
| 209 | resident-journey printedStepsJourney: minted disposable grant copied without socket_path, real custody status exits nonzero with missing locator. Replaces external optional fixture. |
| 222 | 1-18 session runtime matrix, fatal register/refused transition and retire deregister; new “an unrecognized delivery setting uses the channel route for Claude” covers fallback explicitly. |
| 255 | 1-18 codex/claude/pi transitions, registration-state assertions, refusal to leave two paths and side-effect-free preview cases. |
| 292 | 1-17-4 killed/deadline mint returns confirmed identity for compensation; killed-mint-240 retains intent cleanup/redaction. Old test never invoked kernel compensation. |
| 304 | 1-17-4 “retire recovers an alias missing from meta from the workspace binding”: exact delete argv uses recovered alias. |
| 317 | 1-17-4 alias-held first/retry receipts and successful self-delete retry: aliasReusable, persisted completion, exactly one delete. Old arbitrary native reason spelling is superseded by current native reason handling. |
| 341 | 1-17-4 alias-held refusal, no meta, redaction and --name remedy; killed-mint-240 covers refusal intent removal. |
| 356 | oats-aweb 64/65-character alias test plus 1-17-4 exactly one init --join-from from home: exact argv and absence of separate token/invite route. |
| 389 | retained-seat-killed-spawn-228 “retained authority closure, copy exclusions, command sequence and lock do not depend on a spawner PID”; copied bytes, exclusions, lock.home/no pid, no API-key leak/no mint. retained-seat-modes checks private directories and files at all nested depths plus source unchanged; lock-227/-236/restart-226 own takeover/source retention. Old check --online tuple intentionally superseded by native status/whoami (#276). |
| 439 | retained-seat-killed-spawn-228 rollback vector “a status pointing elsewhere”: second connect in original cwd, copied state and lock absent, source key preserved. |
| 457 | Same test vector “a whoami with another DID”: same restoration/cleanup assertions. |
| 469 | retained-seat-restart-226 local identity and no grant/custody calls; 1-14 retained retirement drops lock while preserving retained primary. |
| 484 | retained-seat-killed-spawn-228 vector “wake registration refused after connect”: restore original binding, remove copied authority/lock, preserve source. |

## hook-1-12 — 11 rows

| Original line | Released covering assertion or explicit retirement reason |
| --- | --- |
| 126 | 1-17-4 byte-for-byte local spawn output across runtime/delivery and 1-18 channel matrix cover metadata/env/launch. |
| 141 | hook13 parameterized “global spawn refuses missing resident name” and “unresolved resident”: fatal remedy before mint. |
| 156 | hook13 “global spawn refuses retained source in global mode before mint”: both configuration keys in warning, no mint. |
| 167 | hook13 legacy grant receipt: full explicit scopes/90m TTL, seat/global metadata, env, exact mint and wake tuples, custody cwd/no inherited identity home. |
| 193 | hook13 wrong minted team, both successful/failed compensation: service team/status, retained seat receipt, truthful live-grant metadata/remedy, team-qualified revoke cwd/no caller identity. |
| 209 | hook13 global post-mint wake-register failure: actual revoked service state, absent grant metadata/home, retained seat receipt, correct custody cwd/env. |
| 223 | hook13 no-JSON mint, revoke failure=false: id recovered from grant.yaml, exact team-qualified revoke/custody cwd/env, actual revoked state, home removed, truthful warning. |
| 237 | Same no-JSON case failure=true: actual active state, compensation grant metadata and remedy, home removed, no false revoked claim. The transfer preserves the current removal policy; it does not endorse a new policy. |
| 250 | hook13 global retire uses custody, caller identity cleared, exact revoke, wake deregister and identityRevoked. |
| 267 | hook13 uncertain-revoke show-status revoked/active vectors: show invoked for current team/id; retired/identityRevoked only on revoked, active fails and warns. |
| 281 | hook13 missing-id retire now uses documented nothing-to-delete; never-grant failed revoke covers finite expiry and never-grant remedy plus successful retry. Old nothing-to-revoke assertion is deliberately rejected by K1's kernel contract. |

## hook-1-12-1 — 9 rows

| Original line | Released covering assertion or explicit retirement reason |
| --- | --- |
| 115 | oats-aweb roots[team] before root/workspace primary spawn: selected authority, one mint from new home, .aw env, no separate invite/join. |
| 144 | oats-aweb explicitly selected empty root: refuses rather than falling back to working workspace root, names selected root/current setup remedy, no init. Old classic/bounded prose is obsolete. |
| 167 | oats-aweb authority discovery does not walk above workspace: ancestor authority cannot mint. |
| 191 | 1-14 classic OATS environment refuses spawn/setup/binding before any aw call. |
| 205 | Current oats-aweb/setup-team-roots setup acts cover missing team and declared authority. Retire exact old username/API-key/join menu/help tuple as obsolete prose, not kernel behaviour. |
| 224 | workspace-readiness-wire binding-less check pins ready result and read-only wake read; no-team readiness/spawn test pins actionable failure. Retire old combined error ordering: current no-team result and broker prerequisites supersede it. |
| 254 | 1-15 unmapped default refuses both spawn and binding; no init or team calls/active-team fallback. |
| 277 | 1-15 removed settings.team refuses spawn and binding with zero native effects. |
| 298 | setup-team-roots / setup-invite-56 / 1-21 current invite combinations cover explicit deployment/join and token redaction. Retire old argument/help prose where current native invite inspection now supports token-only joining; no old refusal is claimed as still required. |

## hook-1-13 — 19 rows

| Original line | Released covering assertion or explicit retirement reason |
| --- | --- |
| 164 | hook13 normal grants scopes, custody ordering, socket/team/cwd/env and materialized home. |
| 185 | hook13 reviewer/default/explicit scopes and unknown profile refusal. |
| 207 | hook13 typed custody failure/status/errors and serve remedy before mint. |
| 219 | hook13 grant-status endpoint readiness, missing readiness compatibility, required certificate. |
| 242 | hook13 real floor custody preflight case: explicit Claude runtime, native needs-configuration/custody_unavailable and no grant minted. v1.44.0 CI unit job provisions AW_REAL_CLI_BIN and zero-skips gate; this audit does not claim a CI run succeeded. |
| 260 | resident-journey real minted missing-socket case, as hook10:209; removes duplicate external fixture. |
| 271 | hook13 missing E2EE ops refuses; explicit e2ee:false permits signing-only with warning. |
| 287 | hook13 single aw floor refuses old binary before mint, always passes team. |
| 305 | hook13 all attachment verification failures revoke service grant and remove home. |
| 326 | hook13 missing preflight socket refuses before mint/home creation. |
| 337 | hook13 grant.yaml alias overrides mint alias, resident fallback only when both absent. |
| 352 | hook13 recorded-final-locator readiness supersedes old ready-without-broker assertion, as hook10:192. |
| 372 | hook13 renewal off retains locator/metadata, session env and registration on existing grant. |
| 386 | hook13 local renew=launch retains local identity env and delivery without grant renewal. |
| 398 | hook13 fresh renewal writes new home, emits exact locator and revokes old grant. |
| 416 | hook13 mint failure keeps old home/locator/grant and warns without old revoke. |
| 432 | hook13 failed attachment/missing preflight keeps old grant; any failed newly minted grant is revoked/removed. |
| 461 | hook13 old revoke failure warns truthfully and keeps newly active grant/home. |
| 474 | hook13 retire current grant id and every .aweb-identity directory; additional custody cwd/env/wake tuple in transferred retire test. |

## Satisfied retirement gates

K1 #1950 merged as 6b69263e66bdb29f802c7f4b8aef75edfe057bc4. Keep `test/retire-hook-contract.test.mjs` unchanged; it exercises kernel consumption in ordinary retire, rollback, quarantine retry and outstanding hook debt.
OATS #1989 merged as `6d3d282ede454567232c7ec0fca978773c03b84a`, this
branch's base. The catalog pins `v1.44.0`. A read-only Git-object comparison
matched all 70 mirrored blobs, their executable modes/symlink targets and the
complete file/directory set to that release. No mirror bytes were edited.

This change removes exactly these four direct-provider suites:
`test/oats-aweb-hook-1-10.test.mjs`, `test/oats-aweb-hook-1-12.test.mjs`,
`test/oats-aweb-hook-1-12-1.test.mjs`, `test/oats-aweb-hook-1-13.test.mjs`.
The table above records every source test and the released covering case or
specific superseded/prose reason. The released package retains the regression
coverage; no direct-provider suite is renamed as kernel integration evidence.
Release-lane adaptations outside those files remain, as does K1's kernel
contract test. No production code or deployment contract changes.

The maintainer authorized retirement after both merges and this released-row
match (parent decisions `cef42455-e66b-405e-87bc-a2edd82f2695` and
`e55641a6-1e17-4b71-98a4-6436c1293b0d`). The pre-deletion plan and complete
row table were sent as `4b923d01-236a-4c44-8a03-2c268f42a684`.
Full CI was not run locally; it runs after parent acceptance and PR creation.
