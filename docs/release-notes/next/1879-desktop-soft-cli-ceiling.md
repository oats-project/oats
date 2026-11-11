## Upgrade

- **From this Desktop on, the Desktop and the CLI can be upgraded in either
  order.** A Desktop newer than 0.69.17 accepts an OATS CLI of a later minor
  or major version and holds back what it was not tested with until it is
  updated. A Desktop of 0.69.17 or older still refuses such a CLI: where one
  is installed, install the new Desktop first
  ([Either order works](../upgrading.md#either-order-works)).

## Changed

- **The Desktop accepts a newer CLI and says what it holds back.** Its tested
  bound is the minor of its own version, read from its own manifest; no
  release bumps a ceiling. A released CLI above that bound, with the same
  desktop API, is accepted with `aboveTested` and `testedThrough` on
  `/api/cli`. Reads, terminals, the Spawn preview and apply, Start, Restart,
  the colour and the background stay on. Every other operation, including
  one that does not exist yet, is refused before any CLI process runs, with
  code `cli-above-tested`; the launch resume sweep is skipped with one log
  line naming that code. In the CLI card's place one line says why and what
  is off, and links that version's release:
  `This Desktop was tested with oats CLIs up to <X.Y>; the installed CLI is <version>. Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop <version>.`
  The card's "This Desktop is older than the installed oats CLI" branch is
  now for a CLI of a newer desktop API only. The floor (0.26.0), the
  prerelease rule and the desktop API rule are unchanged
  ([OATS Desktop](../desktop.md), [the probe](../desktop-cli-api.md))
  (oats-project/oats#1879).
- **`oats update`'s line for a CLI of another minor or major version** now
  reads `An OATS Desktop older than <X.Y> holds actions back with this CLI.`,
  then the Desktop's own held-back sentence for that version, then
  `(An OATS Desktop of 0.69.17 or older refuses this CLI until then.)`. It
  replaces `OATS Desktop refuses a CLI newer than its own minor version: if you
  use it, install OATS Desktop <version> first.`
  ([Upgrading](../upgrading.md#either-order-works)) (oats-project/oats#1879).
