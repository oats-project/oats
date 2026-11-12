---
name: oats-upgrade
description: >-
  Use when someone asks to upgrade OATS, update to the latest version, or
  move a host to a newer OATS release: the Desktop, the CLI (the kernel), the
  pi bridge and each deployment's check. Reads `docs/upgrading.md` and the
  release notes' Upgrade sections at the latest release's tag, never the copy
  in the installed CLI, then walks the person through each step on their
  approval. Package pins are `/oats-package-pins`. Part of the setup and
  config of an OATS workspace (oats.setup); day-to-day operation inside an
  instance is oats.core.
---

# Upgrading OATS to the latest version

**What to do comes from the latest release, read at its tag.** The page
`docs/upgrading.md` opens with "Upgrading to the latest version": the latest
version, the CLIs its Desktop accepts, and the steps. Each release's own
steps are in the `## Upgrade` section of its notes,
`docs/release-notes/v<version>.md`. Read both at the tag `v<latest>` of
`awebai/oats`:

- **Not the installed copy** (`"$(oats root)/docs/"`): it belongs to the
  version you are upgrading from and cannot describe a newer one.
- **Not memory, and never a step of your own.** Every step you propose
  comes from the page or from a release's notes, and you say which.
- **Not a downgrade.** Going back to an older version is not this skill:
  the notes of the release you leave say how, when they do.

The person approves each step: show the whole plan first, then run each
step on its own yes.

## 1. The installed version and the latest

```sh
oats version --json               # "version": the installed CLI
npm view @awebai/oats version     # the latest release
```

Use the latest only if it is three numbers (`^[0-9]+\.[0-9]+\.[0-9]+$`);
anything else, stop and show what npm answered. A CLI ahead of the latest (a
checkout, an unpublished build) is not upgraded: say so and stop.

Ask the person, with any other question you have, whether the Desktop is
installed on this host, and at which version. On a host without it, ask
whether they want it installed: a getting-started hand-over whose
Desktop line says "not installed" left it to this skill. When the CLI is already the
latest there are no notes to read, but the Desktop, the bridges and the
check may still lag: make the plan of section 3 without its notes steps.

## 2. Read the page and the notes at the latest tag

The repository is public, so plain HTTPS reads need no login. The listing of
`docs/release-notes/` at the tag names every release that has notes:

```sh
V=$(npm view @awebai/oats version)
curl -fsSL "https://raw.githubusercontent.com/awebai/oats/v$V/docs/upgrading.md"
curl -fsSL "https://api.github.com/repos/awebai/oats/contents/docs/release-notes?ref=v$V"
curl -fsSL "https://raw.githubusercontent.com/awebai/oats/v$V/docs/release-notes/v<version>.md"
```

Where `gh` is signed in, `gh api "repos/awebai/oats/contents/<path>?ref=v$V"`
reads the same, with `-H "Accept: application/vnd.github.raw"` for a file.
Read every notes file from the tag `v$V`: it holds the notes of every
earlier release too.

**The releases to read** are the `v<version>.md` files above the installed
version, up to `v$V`, without prereleases (a version with `-`), oldest
first. **From each, from 0.53.0 on,** take its `## Upgrade` section; a
release with none asks for nothing more. **For a release before 0.53.0,**
read the whole notes: up to 0.39.0 the section may be called `## Upgrading`
or `## Upgrading from <version>`, and some releases give their order under
another heading (0.49.0's oats.okf 5.0 cutover, for one).

**From the page**, take "Upgrading to the latest version": the version it
names, the CLIs its Desktop accepts, and its steps. "Coming from an older
version" is a guide to the notes, never a replacement for reading them.

**A tag up to v0.67.0** has a page without "Upgrading to the latest
version". Take the order from its "The steps" section, and the version and
the CLIs its Desktop accepts from the latest release's own Upgrade section,
which gives them.

**Stop and say so** when the page's "Upgrading to the latest version" names
a version other than `$V`, or when a notes file of a release in your list
cannot be read. Name what you could not read; never fill the gap from the
installed copy.

## 3. The plan

Include every execution host used with `--server` in the plan. The routing
floor is 0.69.15: upgrade any older host first with
`npm install -g @awebai/oats@latest` there. The new router refuses it before
spawning. A host at the floor must also advertise `spawn-task-stdin`,
`spawn-preview-2`, `spawn-apply-2` and `spawn-idempotency-2`; missing features
are an upgrade refusal too, never a fallback that puts the task on argv or
spawns without a retry key.

Write one plan, in this order, each step with the release or the page that
asks for it:

1. **Before the CLI:** what an Upgrade section says to do with the old CLI
   still installed, or before `oats sync` (a host tool such as aw, for
   one). Those steps run with the installed CLI, so they may use only
   commands it has.
2. **The Desktop**, where it is installed, and on a host without it when
   the person wants it: version `$V`, from the assets of
   `https://github.com/awebai/oats/releases/tag/v$V`. The person installs
   it; you give the link and the CLIs it accepts. It goes before the CLI
   because the older Desktop refuses the new CLI. A first install is the
   same step, and the same release's Desktop: when the CLI is already
   `$V`, it is the whole plan with the check.
3. **The CLI:** `npm install -g @awebai/oats@$V`, as the page says.
4. **The pi bridges:** `oats update`, run by the new CLI, in every
   deployment on the host. Do not let the old CLI's `oats update` install
   the CLI: before 0.53.0 it moves the default pi folder only.
5. **After the CLI:** the rest of the Upgrade sections, in their releases'
   order. A step that several releases ask for (a rerun of `oats setup`, a
   restart) is done once, with the new CLI, unless a release's notes say
   otherwise.
6. **The check:** `oats doctor` in each deployment, after the steps above:
   a check run before a conversion the notes ask for reports what that
   conversion fixes.
7. **Restarts:** the pi sessions that were running, and any instance an
   Upgrade section names.

**Package pins are the person's choice,** and `oats update` moves none. When
the notes tie a step to a pin (a tool before `oats sync`, a rerun after it,
a pin that is itself the fix), keep that step with the pin, in the notes'
order, and take the pin through `/oats-package-pins` and its trust step. A
pin with no step tied to it is offered after the plan.

## 4. Walking the person through it

For each step: say what it does and which release asks for it, wait for the
person's yes, run it or hand it over, then read back what it did.

**The CLI install.** Run it yourself only when the kernel in use is the one
npm installs over:

```sh
realpath "$(oats root)"
realpath "$(npm prefix -g)/lib/node_modules/@awebai/oats"   # Windows: <prefix>/node_modules/@awebai/oats
```

When they differ (a Node version manager, another prefix), or npm answers
`EACCES`, the CLI the person uses is not the one your shell runs: hand the
person the install, and then, for each deployment, the bridge step and the
check below, all to run from their own shell. Your `oats` is still the old
CLI, so never run the bridge step yourself in that case; check what they
ran with their output, or with `oats doctor <deployment>` read only for its
warnings. Otherwise, `oats version --json` must report `$V` before the
bridges move.

**The deployments on the host** are listed by `oats deployments` (from OATS
0.65.0); on an older CLI, ask the person. With the new CLI, in each one:

```sh
oats update --check --dir <deployment>   # the plan; runs nothing
oats update --yes --dir <deployment>     # on the person's yes: your shell has no terminal
oats doctor <deployment>                 # after the steps that come after the CLI
```

Read the `--check` plan before each `--yes`: it must move bridges only. If
it holds a CLI install, npm lists a release newer than `$V` since you
started: stop, and start again from section 1 for that release.

**What the person runs themselves:** the Desktop install, and every step an
Upgrade section says to run from the user's own shell or login session (the
record `oats setup`, the host wake broker, the host timer). Give the exact
command and say why it is theirs; check its result with a read-only command.

**A step that fails:** `oats update` stops at the first failed step and
prints the step to run again and what each folder holds. Read it, tell the
person, and rerun only that step on their yes. Never edit `oats-lock.json`
or `instance.json`, and never work around a refusal.

**A step that looks wrong or unclear** in the notes: say so, and ask the
person or report it on the release's issue. Do not rewrite it into a step
you think works.

## 5. Done

The upgrade is done when:

- `oats version --json` reports `$V`;
- each deployment's `oats doctor`, run after the last step, shows no
  version-skew warning, and you read its other warnings to the person;
- where the Desktop is installed, or the person asked for it, it is
  version `$V` and lists the
  deployment's instances;
- every step of the plan is done, or the person declined it.

Report what ran, what the person ran, what was declined and what remains,
with the releases that asked for each. Instances already running keep what
they were spawned with; a new spawn gets what the deployment now resolves.
