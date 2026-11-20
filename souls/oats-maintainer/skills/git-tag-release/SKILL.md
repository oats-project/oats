---
name: git-tag-release
description: "OATS's release lane: the release workflow and scripts, how a tag becomes the kernel, adapter and Desktop releases, the runnerless lane, Desktop signing and acceptance, and OATS's artifacts and bump PR. Load it with /plan-and-ship-release whenever you prepare, ship or verify an OATS release, or diagnose a partial tag-driven or runnerless release."
---

# OATS's release lane

`/plan-and-ship-release` (from `oats.maintainer`) is the method: authority, exact source, gates,
tagging, the verify-release checklist and partial-publication rules. This skill is what
OATS's lane adds.

## The live contract
In an exact-commit checkout, read `.github/workflows/release.yml`, `docs/release-lane.md`,
`scripts/release-lane.mjs` and the tag's release notes.

- CI builds the exact tag SHA, and requires that it is on `main`, that
  `docs/release-notes/<tag>.md` exists and that nothing is left under
  `docs/release-notes/next/`.
- Pull requests leave their release-notes entries as files under
  `docs/release-notes/next/`. In the release-prep PR, run
  `node scripts/assemble-release-notes.mjs --tag <tag>`: it moves every entry into
  `docs/release-notes/<tag>.md` and removes the entry files. Review the diff there and
  reorder entries by hand. A tag with an entry file left is refused by the workflow and
  by the lane's `build`, each naming that command. `docs/release-lane.md`,
  "Release-notes entries", is the rule.
- The tag version is derived into the root, adapter and Desktop manifests with
  `--allow-same-version`. A version already aligned is not an error, and doesn't justify
  reverting versions or retagging.
- The default tag workflow gates all build, test and smoke legs before publishing, then
  publishes the kernel, then the adapter, and creates the Desktop GitHub Release last.
- The runnerless lane's documented kernel-first exception is a separate, explicitly
  chosen release scope, not proof that the Desktop is ready. Use its recorded manifest and
  status, and keep its unfinished obligations.

## Gates specific to OATS
- `node scripts/release-lane.mjs status --tag <tag>` reports staged state; it can't prove
  a remote publication.
- The clean-room installed-artifact smoke (`npm run smoke:tarball`).
- **Desktop:** artifact inventory, native ABI and signature checks are not GUI use.
  Ad-hoc signing is not Developer ID signing or notarization, and a headless build smoke
  is not live GUI acceptance.
- **Runtime composition or knowledge changes** need the assigned installed-runtime and
  real-task evidence. A no-launch scaffold is not a model session or a learning test;
  lifecycle hooks may still run.

## OATS's artifacts
- npm: `@awebai/oats` (the kernel) and `@awebai/oats-pi` (the adapter), published in that
  order. `@awebai/oats-desktop` ships as the Desktop GitHub Release's assets, with their
  checksums.
- The workflow's last step opens the version-bump PR (root, pi and Desktop manifests) to
  `main`. It runs after publication: when it fails, both npm versions and the Desktop
  Release are already out, and the bump PR is opened by hand.

## The framework package
`oats.framework` (the `oats-package/` directory) releases from its own tag line,
`oats-framework/v<version>`, not from the kernel's tag. **A kernel release whose PRs
touched `oats-package/` ships a framework bump in the same release**; otherwise the
kernel ships behaviour whose skill text reaches no deployment.

- When you plan the release, diff `oats-package/` between the last `oats-framework/` tag
  and `main`, plus the PRs still to merge. An empty diff needs nothing.
- Otherwise the release has two prep PRs. The first bumps the changed capabilities and
  the package, with its notes entry as a file under `docs/release-notes/next/`; tag its
  merge commit `oats-framework/v<version>`.
  The kernel prep PR then pins that version: the catalog ref, `oats-workspace.yaml`, and
  the version literals in the docs and tests. Push the tag before the pin's CI runs: two
  kernel tests read the catalog's ref from the remote and fail until it exists. A green
  CI proves the tag exists, not which commit it names: before the pin merges, confirm on
  the remote that it names the first PR's merge commit.
- In the first PR, read every skill line added since the last framework tag: a command or
  behaviour that an admitted older kernel lacks names its version ("from OATS 0.49.0").
  Guidance text alone never raises a capability's floor.
- `docs/release-lane.md`, "Releasing `oats.framework`", is the procedure.
