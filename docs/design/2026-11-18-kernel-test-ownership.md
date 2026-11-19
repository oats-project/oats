# Kernel test ownership and real-path evidence

K2 of the second systemic review, findings 13.14, 13.16 and 13.21. This
records explicit removals and replacements; it does not claim a source-text
match proved behaviour.

## Removed optional native tests

These three tests ran a provider or `aw` directly, never kernel consumption:

- `test/oats-aweb-hook-1-10.test.mjs`, “real aw fixture: unattached grant
  home reports the released custody locator error”.
- `test/oats-aweb-hook-1-13.test.mjs`, “real aw 1.36.33 custody preflight
  reports needs-configuration instead of faking a pass”.
- The same file's “real aw fixture: unattached grant home reports the released
  custody locator error”.

Ordinary kernel CI provisioned neither `AW_REAL_CLI_BIN` nor
`AW_REAL_GRANT_FIXTURE`, so these were normally skipped, not successful native
regressions. The locator case was also duplicated inside the kernel. The
provider package owns these native paths. All three have released counterparts
at `v1.43.0` (commit `00f60a241cfb5bc5aa6acbf1ebcb111756ee8fa0`), in its
[`test/oats-aweb-hook-1-13.test.mjs`](https://github.com/awebai/oats-aweb/blob/v1.43.0/test/oats-aweb-hook-1-13.test.mjs):

| Removed kernel case | Released covering test |
| --- | --- |
| hook-1-10 unattached locator | “real aw fixture: unattached grant home reports the released custody locator error” (line 212) |
| hook-1-13 custody preflight | “real aw at the floor: custody preflight reports needs-configuration instead of faking a pass” (line 194) |
| hook-1-13 unattached locator | The same released locator test (line 212) |

The outcome assertions match the released source, independently checked with
`git show v1.43.0:test/oats-aweb-hook-1-13.test.mjs`. Their removal makes no
claim that those package opt-ins run in CI. Admission floors differ: the
released custody test accepts 1.36.32+ and its locator test 1.36.13+, while
the removed kernel copies required 1.36.33+. Future kernel tests titled `real aw`/`real-aw` fail
the root gate if skipped; the count, file and title are reported.

No version-named suite is retired by this change. Their substantive provider
assertions must be transferred and present in the pinned mirrored release,
and K1's kernel retire-hook contract test must land, before that retirement.

## Removed provider-source checks from the steward guidance test

The following checks read implementation text in the provider mirror. They
were removed because they did not execute the advertised behaviour:

- Literal spelling of the setup check's `console.log(JSON.stringify(...))`.
- Literal `predictedTeam` assignment and signup return-object spelling.
- Presence of the setup policy/default-preservation throw statements.

These groups are the content at lines 136–138, 152–153 and 227–229 of the
spec's pinned source, kernel `3a5503c2993a307a0bb48d0b41dcab7d175adc27`.
Their line numbers moved in later main commits. Other provider-source checks
(the four-code loop, root construction, invite output and floor extraction)
remain; this change claims no blanket conversion of the steward file.

The prose test “getting-started: a join never runs aw team ensure”, at the
original 3a5503c2 lines 541–549, remains. It guards the documented workflow
contract in [the getting-started skill](../../skills/oats-getting-started/SKILL.md):
team creation belongs only to step 5 for a new workspace; joining an existing
workspace must not create a second team. The broker-before-spawn and later
souls.launch/reviewer-model guidance guards also remain, separately; the
launch-preference contract is documented in
[the launch preference design](2026-09-28-soul-launch-preference.md).

## Container checks

The entrypoint test now checks command/argument structure (one final `exec`
to the installed supervisor, NSS export and host-key command) and the Docker
`COPY` instruction, instead of matching word fragments.

The auth test invokes the real acceptance orchestration through an injected
Docker subprocess boundary. Its strict double returns nonzero and prints
unexpected argv. It checks the complete emitted Claude command, scratch-cwd
program and absence of a Docker `--workdir` pointing at the instance. This
pins orchestration argv; it captures and asserts the simulated report rather
than printing fixture PASS receipts, and does not claim Docker accepted it. Team-image CI
owns real image/container acceptance. Production still defaults to
`spawnSync`, and the CLI calls the orchestration exactly as before.

The provider's `test/kernel-module-boundary.test.mjs` remains a legitimate
static module boundary check and is not removed or weakened by this work.
