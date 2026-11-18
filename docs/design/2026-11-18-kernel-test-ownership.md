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
provider package owns these native paths and has counterparts in its
`test/oats-aweb-hook-1-13.test.mjs`. Their removal makes no claim that those
package opt-ins run in CI. Future kernel tests titled `real aw`/`real-aw` fail
the root gate if skipped; the count, file and title are reported.

No version-named suite is retired by this change. Their substantive provider
assertions must be transferred and present in the pinned mirrored release,
and K1's kernel retire-hook contract test must land, before that retirement.

## Removed provider-source checks from the steward guidance test

The following checks read implementation text in the provider mirror. They
were removed because they did not execute the advertised behaviour:

- Literal spelling of the setup check's `console.log(JSON.stringify(...))`.
- Literal `predictedTeam` assignment and signup return-object spelling.
- Presence of four invite refusal codes in concatenated source files.
- Presence of policy/default-preservation throw statements and root-path
  construction expressions.
- Presence of `awebUrl` in invite source for a version range.

`AW_INVITE_INSPECT` is now imported from the provider's export, rather than
extracted from its source with a regex. These provider behaviours belong to
its own executable setup/invite tests. Kernel guidance checks continue to
hold the documented operator instructions: stop on `member:false`, preserve
workspace default-team policy, do not spend an unusable invite, and wait for
the broker before spawning an expert it delivers to. In particular, the
broker prose assertions formerly at lines 541–549 remain: they guard the
explicit step 9/item 6 contract in `skills/oats-getting-started/SKILL.md`.
Other source inspections outside the review's specified groups remain out of
scope; this change claims no blanket conversion of the steward file.

## Container checks

The entrypoint test now checks command/argument structure (one final `exec`
to the installed supervisor, NSS export and host-key command) and the Docker
`COPY` instruction, instead of matching word fragments.

The auth test invokes the real acceptance orchestration through an injected
Docker subprocess boundary. Its strict double returns nonzero and prints
unexpected argv. It checks the complete emitted Claude command, scratch-cwd
program and absence of a Docker `--workdir` pointing at the instance. This
pins orchestration argv; it does not claim Docker accepted it. Team-image CI
owns real image/container acceptance. Production still defaults to
`spawnSync`, and the CLI calls the orchestration exactly as before.

The provider's `test/kernel-module-boundary.test.mjs` remains a legitimate
static module boundary check and is not removed or weakened by this work.
