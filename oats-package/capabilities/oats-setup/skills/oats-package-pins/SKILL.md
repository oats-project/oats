---
name: oats-package-pins
description: >-
  Use when adding, bumping or removing a package in a workspace, choosing
  between a catalog version and a git reference, deciding whether to trust a
  package, reading the lock, or diagnosing a package that will not resolve or
  a spawn refused for a package. This skill is only about packages; member
  capabilities come from membership. Part of the setup and config of an OATS
  workspace (oats.setup); day-to-day operation inside an instance is
  oats.core.
---

# Packages, pins and the lock

Packages are the only versioned things in a workspace. A package is a
capability distribution read from `oats-package/` in its repository, pinned
**once** in the workspace file's `packages:`; souls say `{ from: package }`
and never a version. Contract: `docs/workspaces.md` ("Packages, lock,
catalog") and `docs/packages.md` in the installed kernel
(`"$(oats root)/docs/"`).

**Declaring a package is the trust decision.** Its commands and hooks run on
every operator's machine at spawn, so before a pin is added, show the operator
what the package runs (each capability manifest's `commands` and `hooks` at
that version) and let them decide. A pin is added only for a package they
trust.

## Two forms of pin

```yaml
packages:
  oats.okf: v4.1.1                                    # bare version: resolved through the official catalog
  acme.tools: git:github.com/acme/tools@v0.4.0        # outside the catalog: git:<repo>@<tag or full commit>
```

- A **bare version** works only for ids in the official catalog
  (`package-catalog.json` in the OATS repository — the reviewed official list).
- A **git reference** names a tag or a full commit. A reference that resolves
  to a branch is refused: versions must not move. A tag that moved fails
  integrity on the next sync (`E_PACKAGE_INTEGRITY`); a new version needs a new
  version string.
- A repository can be a workspace member **and** publish a package; the two
  never collapse. `from: package` reads only the lock; `from: <repo>` reads
  only that member's `capabilities/`. Never "fix" a package by pointing a soul
  at the publisher's repository.

## What one pin brings

A package's `oats-package.json` lists its **capabilities**, and it may also
list **souls** and **trigger templates**. One pin versions all of them:

- **Package souls** are listed by `oats souls` as `kind: package`, named
  `<package>/<soul>` (a bare name when unique), and spawned at the locked
  commit. Their homes are `agents/<package>--<soul>/` (`.` → `-` in the
  package id), and `oats status` marks their instances moved once the pin
  moves. They are trusted with the package and disabled per machine like any
  soul (`souls.disabled`).
- **Trigger templates** are instantiated with
  `oats trigger add --from <package>:<template>` (`/oats-automations`).

Contract: `docs/packages.md` ("Package souls").

## Change a pin

The workspace file is shared through Git, so a pin change is a reviewed
change to the host repository:

```bash
oats package add <id> <version|git:<repo>@<ref>>   # edits packages: when the host repo is the current checkout; else prints the line
oats package remove <id>
```

Commit it as `/oats-workspace-config`, "Change a shared file" says
(straight to the default branch only when its checks pass, else a pull
request). Once it is on the default branch, run `oats sync` on each
deployment. A bump affects only new spawns; running instances keep what they
were given (`oats status` shows them as moved).

## Sync and the lock

```bash
oats sync                                        # resolve every pin to a commit, fetch, verify integrity, write oats-lock.json
oats sync --json                                 # the same, as the machine-readable envelope
```

- `oats sync` resolves each pin to a commit, fetches the package, computes the
  integrity of its tree and writes the lock; it asks nothing and exits 0 on
  success. Entries dropped from `packages:` are dropped from the lock.
- The lock (v3) is reproducibility: for a pin already locked, the commit and
  the integrity must be unchanged, else `E_PACKAGE_INTEGRITY`. It also records
  each package soul's `name`, `path` and `digest`; a changed soul list is
  `E_PACKAGE_INTEGRITY` (`why: "souls"`), and a spawned soul whose digest
  differs is `why: "soul-digest"`. At spawn the package's capability list at
  the locked commit must still match the lock, and only packages the
  workspace still declares are used (`E_PACKAGE_MISSING` otherwise).
- Never edit `oats-lock.json` by hand; it is written by `oats sync` only and
  is identical on every machine that synced the same workspace commit.
- After a sync that adds a package soul: this machine's `souls.launch."*"`,
  when it has one, wins over that soul's own `launch:`. For each new soul
  whose `launch.declared.harness` in `oats souls --json` differs from it
  and is installed and logged in on this machine, give it its own entry by
  the row's `key` (with `--model <its model>` when it names one), plan
  first (from OATS 0.53.0):
  `oats soul launch set <key> --harness <its harness> --plan`, then without
  `--plan`. A declared harness that isn't installed here stays under `'*'`,
  so the soul can run; tell the person.
  Check a new reviewer soul by its model too, since `'*'` replaces the
  model as well as the harness: where it declares the same harness as `'*'`
  but another model, give it its own entry the same way, with
  `--harness <its harness> --model <its model>`. Then its
  `oats spawn <key> --preview --json` must show a `launch.effective` model
  from a family other than the developers'. Where its declared model can't
  run here, set one that can, from another family; with none, tell the
  person its reviews share the developers' model.

## Diagnose

| Symptom | Meaning |
|---|---|
| the package id is not in the catalog | use `git:<repo>@<ref>` or add it to the catalog through review |
| the pin resolves to a branch | pin a tag or a full commit |
| a soul's spawn is refused, package missing | the lock lacks a provider of that capability — run `oats sync` |
| `E_PACKAGE_INTEGRITY` on sync or spawn | the tag moved or the content changed under the pin — pin a new version (or a full commit) through review |
| a capability exists only inside a member's package | it is package-tier: `{ from: package }` plus a pin |
| `E_SOUL_AMBIGUOUS` on a package soul | a member soul shares its bare name: use `<package>/<soul>` |
