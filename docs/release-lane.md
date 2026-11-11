# The runnerless release lane

`scripts/release-lane.mjs` releases OATS without GitHub Actions. It is the
same release as [`.github/workflows/release.yml`](../.github/workflows/release.yml),
run phase by phase on operator machines, with every output written under a
stage directory so the release can stop and resume at any phase.

The policy it satisfies: no release capability may permanently depend on
GitHub or GitHub Actions. Registry publish works on its own; tags and hosted
release assets can follow later.

The sections after the lane's own cover release-notes entries, the
post-publish Desktop check, mirroring a released `oats.okf` and releasing
`oats.framework`.

## When to use it

- **Runner outage.** GitHub Actions is down, queued, or a runner image has
  broken under the workflow. Build and publish here; push the tag and let the
  workflow catch up when it can.
- **Urgent release.** The kernel fix must reach npm now. `build` and
  `publish-npm` are enough for that; Desktop installers and the GitHub Release
  follow when they are ready.
- **By choice.** Any release may be cut this way. The gates are the workflow's
  gates; only the host differs.

## Phases

Every phase takes `--tag vX.Y.Z` and reads or writes `stage/<tag>/`
(gitignored; `--stage <dir>` overrides). `MANIFEST.json` there records the
SHA, the Node and npm versions it was built with (`node`, `npmVersion`), the
tarballs and their digests (`npm.tarballs`), the assets, and which phases
completed.
Every external command is printed before it runs and its output is logged
under `stage/<tag>/logs/`; a failing step exits non-zero with the log path.

| Phase | Mirrors in `release.yml` | Writes |
| --- | --- | --- |
| `build --tag vX.Y.Z [--sha <commit>]` | jobs `build-and-test` and `tests` (the lane runs the suite unsharded): notes gate, unassembled-entries gate, three-manifest bump, `node --check`, `npm ci`, `npm run check`, Desktop test deps, `npm test`, `pack:check` and the tarball greps, `smoke:tarball`, the `version --json` probe | `npm/*.tgz`, `MANIFEST.json` |
| `desktop --tag vX.Y.Z --arch arm64\|x64` | one `desktop-build` matrix leg: desktop `npm ci`, `npm test`, `npm run dist -- --<arch>`, strict deep `codesign --verify` (macOS), `dist:smoke` in build-verify mode | `assets/oats-desktop-*` |
| `stage --tag vX.Y.Z` | publish job, "Checksums" (`shasum -a 256`) | `assets/SHA256SUMS.txt` |
| `publish-npm --tag vX.Y.Z [--dry-run] --yes` | publish job, the two guarded `npm publish --access public` steps, kernel then adapter | — |
| `tag --tag vX.Y.Z [--push --yes]` | the tag push that triggers the workflow | annotated tag |
| `release-github --tag vX.Y.Z --yes` | publish job, `gh release create` / `gh release upload --clobber` | GitHub Release |
| `status --tag vX.Y.Z` | — | prints what ran, what exists, what remains |

`build` refuses on a dirty working tree and, like the workflow, refuses a SHA
that is not on `origin/main` (`--allow-off-main` is the explicit human
override; report the risk you accepted). It never touches the checkout it
runs from: it exports the SHA into a detached worktree under the system
temporary directory (recorded in `MANIFEST.json`, `--export <dir>` overrides)
and runs every build step there. The bumped manifests exist only in that
export; the version-bump commit reaches `main` through the pull request the
workflow opens (or a manual one), merged by a maintainer.

`publish-npm` and `release-github` print their plan and refuse without
`--yes`. `tag` creates the local tag without `--yes` but pushes only with
`--push --yes`. Authentication for npm is whatever `npm whoami` reports, or
`NPM_TOKEN` when set: the token goes into a temporary `.npmrc` handed to npm
through `NPM_CONFIG_USERCONFIG` and deleted afterwards, never into the repo.

## A full release from a Mac plus a Linux host

Release notes must exist at `docs/release-notes/<tag>.md` on the commit being
released, with no entry file left under `docs/release-notes/next/`
([Release-notes entries](#release-notes-entries)), and the commit must be on
`origin/main`. On the Mac:

```bash
git fetch origin
node scripts/release-lane.mjs build --tag v0.22.0                 # minutes
node scripts/release-lane.mjs desktop --tag v0.22.0 --arch arm64
node scripts/release-lane.mjs desktop --tag v0.22.0 --arch x64    # needs Rosetta on an arm64 Mac
node scripts/release-lane.mjs status --tag v0.22.0
```

On the Linux host, from a checkout of the same commit. Besides the build tools,
the host needs binutils (`readelf` and `ar`) and `tar`. The `desktop` phase's
`dist:smoke` reads every ELF file of the DEB and the AppImage and checks it
against the installers' glibc floor (`packages/desktop/scripts/linux-floor.json`).
No flag skips that check, and it stops naming the tool when one is missing.

```bash
node scripts/release-lane.mjs build --tag v0.22.0
node scripts/release-lane.mjs desktop --tag v0.22.0 --arch x64
# then copy stage/v0.22.0/assets/oats-desktop-*-linux-x64.* back to the Mac's stage/v0.22.0/assets/
```

The Linux `build` repeats the kernel checks on that host; its tarballs are
not used. Only the assets travel. Back on the Mac:

```bash
node scripts/release-lane.mjs stage --tag v0.22.0                 # SHA256SUMS.txt over all six assets
node scripts/release-lane.mjs publish-npm --tag v0.22.0 --dry-run --yes
node scripts/release-lane.mjs publish-npm --tag v0.22.0 --yes     # kernel, then adapter
node scripts/release-lane.mjs tag --tag v0.22.0 --push --yes
node scripts/release-lane.mjs release-github --tag v0.22.0 --yes
```

An urgent kernel-only release is `build`, `publish-npm --yes`, and `tag --push
--yes`; the Desktop legs, `stage`, and `release-github` run later against the
same stage directory.

## What is resumable

Everything after `build` reads `MANIFEST.json` and the files already staged:

- A failed step is rerun by rerunning its phase. `build` is build-once: it
  recreates the export and the tarballs; it refuses a stage directory built
  from a different SHA unless `--force`.
- `desktop` legs run in any order, on any number of hosts, days apart. A
  missing export is recreated from the recorded SHA.
- `stage` recomputes the checksums over whatever is in `assets/` and lists
  the legs still missing.
- `publish-npm` skips any version `npm view` already reports live, exactly as
  the workflow does on a same-tag retry, so it can be rerun after a partial
  failure or after the workflow published one of the two.
- `release-github` uploads with `--clobber` when the release exists.

## What the lane cannot produce

- **Build-provenance attestations.** `actions/attest-build-provenance` and
  npm's provenance both require the GitHub OIDC identity; nothing off-runner
  can mint them. A lane-published npm version has no provenance badge, and a
  lane-created GitHub Release has no attestation. Pushing the tag afterwards
  runs `release.yml`, whose steps are idempotent: it skips the live npm
  versions, re-uploads the same assets, and attaches the attestations. That
  later pass is the way to add provenance; nothing is republished.
- **The version-bump PR.** The workflow's final step opens it and stops: the
  run never merges into `main`. A maintainer reviews that the diff is the
  version lines only and merges it. The PR is opened with the workflow token,
  so no checks run on it by themselves; close and reopen it to run them, and
  do not read missing checks as green. Open the PR by hand if the workflow
  does not run.
- **No bump moves an accepted range.** The Desktop's tested bound is the
  minor of its own version (`packages/desktop/package.json`), read at run
  time (`testedBound`, `packages/client/cli-locator.mjs`); `ACCEPT_RANGE`
  holds only the floor. A newer CLI is accepted with only the operations
  `packages/client/above-tested.mjs` allows on. `oats tui` judges the kernel
  it ships with against that kernel's own `package.json`, so it never finds
  it above. The version-bump PR moves the two manifests together; should they
  differ, the Desktop's own wins (it is the installed app's version), and
  `checkReleaseVersions` refuses the checkout. The test "the tested bound is
  the minor of the version the release manifests carry, from one source, and
  no file spells an upper bound" (`test/release-packaging.test.mjs`) holds
  this.
- **Legs for hosts you do not have.** The Linux AppImage/DEB need a Linux
  host; the lane says so and `stage` lists what is missing.
- **The packaged window launch.** `release.yml` launches the packaged window
  on its Linux leg, under xvfb. The lane's `desktop` phase launches nothing on
  any host, so a lane release reports the Linux launch check as not run. The
  obligation stays open until a hosted run (pushing the tag runs
  `release.yml`) or a person's launch covers it.

## How it relates to `release.yml`

`release.yml` is unchanged and remains the default path: pushing a tag runs
it end to end. The lane mirrors its jobs and steps rather than reimplementing
their checks — it calls the same `npm run check`, `npm test`, `pack:check`,
`smoke:tarball`, `dist`, and `dist:smoke` scripts with the same environment
the workflow sets. `test/release-workflow.test.mjs` pins the workflow's
contract; `test/release-lane.test.mjs` covers the lane's gates and phase
logic against fixtures, with `npm` stubbed. The two can run in either order:
a lane release followed by a workflow run, or a broken workflow run finished
by the lane, and neither republishes what the other already did.

## The workflow's actions are named by commit

`release.yml` holds the publishing rights, so it names every action it uses
by a full commit id, with the exact version in a comment beside it:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

A tag is the action owner's to move, and a commit is not: the code that runs
with the publishing rights is the code that was read. `build-installers.yml`
runs the same installer steps, so it names the same commits. So does
`tui-macos.yml`, the TUI's tests on macOS at pull-request time, by the release
lane's call of 2026-10-27: it runs a branch's code on the release's own
actions, and its run is that pull request's macOS evidence, so it names them
at the commits that were read
([Implementation](implementation.md#the-tuis-tests-on-macos)). Every other
workflow keeps tags (`actions/checkout@v4`): nothing is published from them.

`test/workflow-no-cache.test.mjs` holds this. Its table of the actions that
were read has a row for each action: `action`, `id`, `version`. In the three
files every `uses:` is a row's id, the same action is the same id in all of
them, and the comment beside an id is the row's version. In every other
workflow a `uses:` is the major of a row's version.

**An id is moved by a pull request, reviewed like any change to that
workflow.** It changes these together, and nothing else in the three workflow
files:

- the id and the version comment, on every `uses:` line of that action in
  `release.yml`, `build-installers.yml` and `tui-macos.yml`;
- the action's row in the table.

**The id is read from an exact version tag of the action's own repository**
(`v4.4.0`, not the moving `v4`). For an annotated tag it is the commit the tag
object points at:

```bash
gh api repos/actions/checkout/git/ref/tags/v4.4.0 --jq '.object.type, .object.sha'
# type `commit`: that is the id. Type `tag`: the id is the tag object's commit:
gh api repos/actions/checkout/git/tags/<sha of the tag object> --jq '.object.sha'

# The same with git. For an annotated tag, the line that ends in ^{} has the id.
git ls-remote https://github.com/actions/checkout refs/tags/v4.4.0 'refs/tags/v4.4.0^{}'
```

Never take an id because it resolves, and never copy one from another
project's workflow. GitHub resolves `owner/action@<id>` for a commit of any
fork of that action, so an id that works says nothing about whose commit it
is. The pull request gives, for each id it moves, the tag, the id and the
command that read it, so that its reviewer repeats the reading.

**The commit is read before its row is written**, for whether the action
saves or restores an Actions cache by itself: its `action.yml`, the actions
and packages it depends on, and what its entry points call of a cache.

- A composite action names other actions. Check, at the id, that its inner
  `uses:` are full commit ids too: then the outer id fixes them.
- A version of `actions/setup-node` that caches by itself (v5 and later)
  needs `package-manager-cache: false` on every step. The test takes the
  version of an id from the row, so it refuses a step without it.

**`release.yml` and `build-installers.yml` name their runners by version
too** (`ubuntu-24.04`, as they name `macos-15`), never by a label that GitHub
moves to another system by itself (`ubuntu-latest`). The Linux installers are
built on that runner, and what they need of a system follows the system that
built them.
`pull-request.yml` keeps `ubuntu-latest` on purpose: when the label moves, a
break on the new system shows in pull-request CI first and not at a release.

The labels `release.yml` and `build-installers.yml` may name are a list beside
the table of actions in `test/workflow-no-cache.test.mjs`: `ubuntu-24.04` and
`macos-15`. Every job of the two runs on a label of that list, and both build
on the same Linux. A label is added to the list by whoever decides the runner,
as an action's row is by whoever read it.

**Moving the runner is a pull request** that changes the label in
`release.yml`, `build-installers.yml` and the list together, and says what the
installers then need.

**What the Linux installer needs today**, to compare with at the next move.
Read from `oats-desktop-0.52.0-linux-amd64.deb`, built on `ubuntu-24.04`
(sha256
`a6148c8a7b49404d73e46c81523568accc560843ed2fab0c54ca501f09c481b7`):

| part of the DEB | highest glibc symbol version it needs |
|---|---|
| the Electron binary, `oats-desktop` | `GLIBC_2.25` |
| the native module, `node-pty`'s `pty.node` | `GLIBC_2.34` |

```bash
ar x oats-desktop-<version>-linux-amd64.deb && tar -xf data.tar.xz
# for the binary and for each native module under resources/app.asar.unpacked:
objdump -T <file> | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
```

Nothing of the package is run to read it. The numbers are what the DEB's files
ask of the system's glibc, not a floor anybody tested on an older system. The
AppImage, built in the same leg from the same build, was not read. The
module's number follows the runner that builds it: the symbols it needs at
2.34 are the ones a module gets when it is built on a system whose glibc is
2.34 or later.

**The build now holds that number.** `docs/desktop.md` states it (glibc 2.34)
and `packages/desktop/scripts/linux-floor.json` holds it with libstdc++'s
`GLIBCXX` and `CXXABI` (`packages/desktop/test/linux-floor.test.mjs` keeps the
two equal). On the Linux leg of both workflows, `dist:smoke` unpacks the DEB
and the AppImage (its runtime and the libraries it adds included), reads the
version-needs table of every ELF file with `readelf -V -W`, and fails naming
each file that needs a newer version than the floor. A move of the runner, a
new `node-pty` or a new Electron that raises it is then a pull request that
changes that file and the page together.

## Release-notes entries

A release ships one notes file, `docs/release-notes/v<version>.md`. Between
releases a pull request does not write its entry into it: it adds its entry
as a file of its own, and one command moves the entries into the notes file
in the release-prep pull request. Two pull requests that share no code
therefore never conflict over their entries.

### For the author of a pull request

- **One file, `docs/release-notes/next/<name>.md`**, added by the pull
  request that makes the change. The entry does not go into
  `docs/release-notes/v<next>.md`, which a pull request touches for one
  reason only, the next point.
- **Correcting an unreleased entry.** A pull request that makes an existing
  unreleased entry untrue corrects that entry where it stands: in the
  unreleased notes file, or in the entry file of the earlier pull request
  while that file is still under `docs/release-notes/next/`. It adds its own
  entry in its own entry file. In the earlier entry it changes only the
  sentences it makes untrue, and its description names them. A released notes
  file is never corrected this way.
- **The name** is the issue's number and a short slug:
  `991-update-every-pi-folder.md`. Lower-case letters, digits and hyphens,
  then `.md`. The number is a convention: nothing reads the name but the
  order of assembly.
- **The content is a piece of the notes file:** one or more `## <Section>`
  headings, each followed by its entries, and nothing else. No title, no text
  before the first heading. Write the entry as it will read in the notes
  file. The sections, in the notes file's order, are `Upgrade`, `Added`,
  `Changed`, `Fixed`, `Removed`, `Provider updates` and `Documentation`. A
  heading is one of them exactly, from the first column.
- **Links are written for `docs/release-notes/`**, the directory the text
  moves into: a link to `docs/tui.md` has the target `../tui.md`.
  `npm run validate` resolves an entry file's links from that directory. Such
  a link does not resolve when the entry file is opened on its own in a
  browser.
- **`test/release-notes-entries.test.mjs` holds every entry file on the tree
  to these rules:** the name; a regular file directly in the directory; only
  the seven sections, each at most once; at least one non-blank line under
  each heading; no `# ` title; every fenced block closed. A `## ` line inside
  a fenced block is text.
- **The directory exists only while it holds entries.** It has no README and
  no placeholder: anything in it counts as an unassembled entry.

### For the tag owner

```bash
node scripts/assemble-release-notes.mjs --tag v0.54.0
```

- **It moves every entry into `docs/release-notes/v0.54.0.md`** and removes
  the entry files and the emptied directory. A notes file that does not exist
  is created, with the title `# OATS 0.54.0` and the line `Unreleased`.
  `--root <dir>` works in another tree.
- **Order.** Files are taken by name as plain strings, what `LC_ALL=C ls`
  prints: `1002-…` comes before `996-…`. In each section a file's text goes
  after what the section already holds. A section the notes file lacks is
  created at its place in the order above. A heading that is not one of the
  seven, such as a hand-written highlight, stays where it is.
- **It moves text and rewrites none.** Every line it did not add is kept as
  it is, except blank lines where text goes in. It sets no date in place of
  `Unreleased` and sorts nothing inside a section: reorder entries by hand in
  the prep pull request, where the result is reviewed as a diff.
- **All or nothing.** With a problem in any entry, or a notes file that holds
  a section twice or a fenced block that is never closed, it prints every
  problem, writes nothing, removes nothing and exits 2.
- **An interrupted run.** The command writes the notes file first and removes
  the entry files after it. A run that stops in between leaves entry files
  beside a notes file that already holds their text, and a second run would
  add that text again. Put the tree back first, one of two ways: delete the
  entry files that are left, whose text the notes file holds, and the run is
  complete; or return all of `docs/release-notes/` to what Git has, which is
  the notes file (deleted, if this run created it) and the entry files
  already removed, and run the command again. A run that stops before it
  writes the notes file has changed neither; at most it leaves a `.tmp` file
  beside the notes file.
- **Running it more than once in a release is normal.** The pull request that
  moves the manifests to a new version runs it to create that version's notes
  file, which `test/release-packaging.test.mjs` requires for the version the
  manifests carry. The release-prep pull request runs it again for the
  entries merged since, which go after the earlier ones.
- **The Upgrade section opens with the order of the Desktop and the CLI.**
  The tag owner writes it in the release-prep pull request, for every
  release: either order works ([Upgrading](upgrading.md#either-order-works)).
  For a new minor or major it adds what the previous Desktop holds back with
  this CLI until it is updated, and that a Desktop of 0.69.17 or older
  (`LAST_HARD_CEILING_DESKTOP`, `lib/pi-bridge.mjs`) refuses it: install the
  Desktop first there.

  No entry file writes this line: only the tag owner knows the release's
  version when the notes are assembled.
- **The same pull request updates "Upgrading to the latest version"**, the
  section [Upgrading](upgrading.md) opens with: the version being tagged in
  each place the section names it (the latest version, its notes, the
  Desktop and the CLI install), and the CLIs that version's Desktop accepts:
  up to 0.69.17, its band (`>=0.26.0 <0.70.0`); after it, `The <version>
  Desktop accepts OATS CLIs \`>=<floor>\`, tested through <X.Y>`, with the
  Desktop and the CLI `in either order`. The page
  states only this version's; the earlier ones stay in their notes. When the
  release's Upgrade section asks for more than the page's steps, the order
  of the Desktop and the CLI and an optional package pin, the pull request
  also adds the release's entry at the top of "Coming from an older
  version", one line that links its notes.
  `test/release-packaging.test.mjs` checks that the section names the
  version the manifests carry and no other, and states that version's
  Desktop's accepted CLIs in the form above. The oats.setup skill `oats-upgrade` reads
  this page at the release's tag, so what the tag carries is what an upgrade
  follows.
- **A tag is refused while anything is under `docs/release-notes/next/`:** by
  the `build-and-test` job of `release.yml` and by `release-lane.mjs build`,
  each right after its notes-file gate and before anything is built. Each
  names the command to run. The kernel package carries all of `docs/`, so
  these two gates are also what keeps an unassembled entry out of a published
  tarball.

### When it starts

When the change that adds this section is on `main`. Entries already in
`docs/release-notes/v0.53.0.md` stay there. A pull request in flight that has
to rebase for the notes anyway may move its entry into a file at that rebase.

## Desktop release verification

Installer CI gates what headless runners can prove reliably for every
published platform/architecture: electron-builder completes, the expected
DMG/ZIP/AppImage/DEB artifacts exist, both packaged macOS `.app` bundles
pass strict deep codesign verification of their complete ad-hoc signatures
(`codesign --verify --deep --strict`), node-pty's packaged `spawn-helper` is
executable, and node-pty loads and spawns under the packaged Electron ABI.
The macOS x64 leg cross-builds on macos-15 and installs Rosetta 2 so that its
x64 Electron + node-pty ABI probe really executes; a wrong-architecture
native module fails that leg.

CI launches the packaged window on the Linux leg only: `release.yml` and
`build-installers.yml` run the smoke once more with its launch phase, under
xvfb, and a window that does not reach the shell fails the leg. That is the
unpacked Linux build, not an installed AppImage or DEB. CI does **not** gate
the macOS launch: ad-hoc-signed, non-notarized Electron apps do not
have a reliable interactive windowserver in headless CI. The lane does not
launch the window: see
[What the lane cannot produce](#what-the-lane-cannot-produce). Post-publish
launch acceptance is therefore owned by the operator/maintainer, using the
actual released installers (not a source checkout):

1. Verify the asset checksum/attestation, install it outside the source tree,
   and on macOS use right-click → **Open** for the Gatekeeper step (ad-hoc
   signatures carry no identified-developer identity).
2. Launch OATS Desktop and open a real deployment; verify roster, brain and
   Markdown reads.
3. Attach an existing tmux terminal, confirm input/output, and close the tab
   (the durable tmux window must survive).
4. Verify the released global CLI is detected and Spawn is enabled; hide or
   mismatch the CLI and confirm reads/terminal still work while Spawn disables
   with recovery guidance.
5. Repeat per published architecture where hardware is available. In
   particular, launch-check macOS x64 on an Intel Mac if one is available;
   CI's Rosetta ABI probe is the native-module proof, while this is the actual
   shipped-installer/user-launch proof.

Record the installed version, platform/architecture and outcome in the
release verification notes. This post-publish check is acceptance — it does
not weaken the pre-publish build/inventory/ABI gates.

## Mirroring a released `oats.okf`

The standalone `awebai/oats-okf` repository is authoritative. This repository
carries a generated mirror of its capabilities under `mirrors/oats-okf*/`
and the inventory `scripts/okf-source-inventory.json`; neither is edited by
hand. The inventory records each capability at its path inside the package
(`capabilities/oats-okf`, what the tag attests) and, in `mirrorPaths`, where
this repository keeps it. The mirror is not under `capabilities/`: this
repository is a workspace member, and member discovery would list it as a
latest-state member capability beside the package. After an okf release is
tagged:

1. Check out the release in a clean clone of `awebai/oats-okf` at the tagged
   commit, with the tag present locally and `origin` pointing at the official
   repository.
2. From this repository:

   ```bash
   node scripts/check-okf-mirror.mjs --finalize --source <clone> \
     --final-tag v<version> --final-commit <full merged commit id>
   node scripts/check-okf-mirror.mjs --verify
   node scripts/check-okf-mirror.mjs --verify-source --source <clone>
   ```

3. Pin the same version in `package-catalog.json` and `oats-workspace.yaml`,
   update the version literals the tests and smoke script carry, and review
   the diff as one PR.

`--finalize` stamps `release.status: published` only when every check passes:
the tag is exactly `v<package version>` and resolves to the given commit; the
source tree is clean, with no masked index entries; the exported files, modes
and symlink targets equal the raw objects at that commit; `origin` is the
official repository, and a fresh `ls-remote` advertises the same tag object
and commit. A failed check leaves the mirror and inventory untouched.

`--verify` needs no network: it checks the checked-in mirror against the
inventory (file set, bytes, modes, symlinks, wrapper hashes). `--verify-source`
re-checks a published inventory against the source and its origin; it attests
what the remote advertised when queried, so released tags must never move.
`--generate --source <clone>` captures a working tree for development and
always records `release.status: pending`.

## Releasing `oats.framework`

The distribution package in `oats-package/` (`oats.core`, `oats.setup`,
`oats.onboarding`, `oats.coordination-setup`, `oats.support`,
`oats.knowledge-theory`) is not published
by `release.yml` or by this lane. A deployment takes it from this repository at the tag
`oats-framework/v<version>`, through the catalog ref or its workspace pin. A
skill changed under `oats-package/` therefore reaches deployments only when
that tag moves, whatever kernel version carried the change.

**A kernel release whose pull requests touched `oats-package/` ships a
framework release with it.** To see whether one is owed:

```bash
git diff --stat "$(git describe --tags --abbrev=0 --match 'oats-framework/v*' origin/main)" origin/main -- oats-package
```

When the diff is not empty:

1. **The framework prep PR.** Bump `version` in the `oats.json` of each
   changed capability and in `oats-package/oats-package.json`, and add the
   release-notes entry as a file under `docs/release-notes/next/`
   ([Release-notes entries](#release-notes-entries)). Read the skill lines
   added since the last tag: a
   command or behaviour that an older kernel the capability still admits does
   not have names the version it starts in. Guidance text alone does not
   raise a capability's `compatibility.oats`.
2. **The tag.** After the PR merges, put the annotated tag
   `oats-framework/v<version>` on its merge commit and push it. No workflow
   runs on this tag.
3. **The pin**, in the kernel release-prep PR: `package-catalog.json`
   (`ref`), `oats-workspace.yaml`, and the version literals in
   `docs/official-catalog.md`, `docs/packages.md`, `docs/workspaces.md`,
   `skills/oats-getting-started/SKILL.md` and
   `test/release-packaging.test.mjs`. The pin does not ride the first PR:
   the tag needs the bumped manifest on `main` first, and CI reads the
   catalog's ref from the remote. Two tests in
   `test/hook-events-forward-tolerant.test.mjs` sync a deployment that takes
   the official catalog's packages, so the pin's CI fails with
   `E_REMOTE_UNREADABLE` until the tag is pushed. (The clean-room smoke does
   not read it: it tags its own copy of `oats-package/`.) A green CI proves
   that the tag exists, not which commit it names: the pin's reviewer
   confirms on the remote that it names the first PR's merge commit.

## Raising the Node version

A pull request that raises the Node version the workflows run
(`node-version` in `.github/workflows/`) also carries a macOS
[named run](named-test-runs.md) of `test/recovery-link-mode.test.mjs` at its
exact head. Every case in that file runs, with none skipped, and the run's
test warnings are read. The copier keeps each symbolic link's own mode with
`fs.lchmodSync`, which only macOS has and which Node lists as deprecated. If
a Node version drops it, the copy of a link whose mode differs from the new
link's must still be refused. Never take the link's mode out of the digest,
and never follow the link or change its target's mode, to make the upgrade
pass.
