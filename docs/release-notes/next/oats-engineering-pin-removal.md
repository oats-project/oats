## Upgrade

- **A deployment of OATS's own workspace takes four hand steps, in this order.** Names written for the package's reviewer, `oats.engineering/code-reviewer`, now name the workspace's `code-reviewer` soul.
  1. **`souls.launch`.** Remove the old key:

     ```sh
     oats soul launch remove oats.engineering/code-reviewer
     ```

     The soul's own launch, pi with `github-copilot/gpt-6.1-sol`, then applies, unless the machine has a `souls.launch."*"` entry: that one wins over the soul's own launch, for the reviewer as for every soul without an entry of its own. Check what the reviewer will run on with `oats spawn code-reviewer --preview`. A reviewer runs on a model family other than its developers'. Where the `"*"` entry, or any other choice, would put it on theirs, give the reviewer its own key: `oats soul launch set code-reviewer --harness <harness> --model <model>` (or `--launch-config <name>`).

     Left in place, the old key stops spawns. `oats doctor` shows `E_LAUNCH_PREFERENCE_UNMATCHED: oats-local.yaml souls.launch names "oats.engineering/code-reviewer" (nearest: code-reviewer)`. Its fix line pins a soul first, then removes the key; here removing the key is enough. Every spawn that names no launch, of a soul with no `souls.launch` entry of its own, is refused with that code, and nothing is created or started. A spawn that names its launch (`--harness` or `--launch-config`) still runs.
  2. **`souls.disabled`.** No command writes it. In `oats-local.yaml`, change `oats.engineering/code-reviewer` to `code-reviewer`. A stale entry **fails open**: it disables nothing, so the renamed `code-reviewer` spawns again on that machine, and nothing warns. `oats doctor` and the spawn are silent.
  3. **Team patterns.** They are the workspace's `souls:`, and OATS's has only `"*"`, which covers `code-reviewer`. Nothing to change. `oats soul teams code-reviewer` shows the `oats` team, from `"*"`.
  4. **Schedules and triggers.** Find any that spawns the old soul with `oats schedule list` and `oats trigger list`. `oats schedule test <id>` reports `soul oats.engineering/code-reviewer does NOT resolve (E_SOUL_UNKNOWN)`, and the job spawns nothing; `oats trigger test <id>` checks its soul the same way. Change each to `code-reviewer`:
     - a host schedule: `oats schedule update <id> --file <spec.json>`, with `"agent": "code-reviewer"`;
     - a local trigger: `oats trigger remove <id>`, then `oats trigger add --file <trigger.json>`, with `"soul": "code-reviewer"` in its `spawn`;
     - a workspace schedule or trigger: in its file in Git.

     A new schedule that names the old soul is refused when it is added.

  Then run `oats doctor`, after this or any soul rename or removal, and fix what it reports. Once [oats#1772](https://github.com/oats-project/oats/issues/1772) ships, doctor also reports a `souls.disabled` entry that names no soul. Until then, check `souls.disabled` by hand.
- **Running instances keep their copies.** An instance spawned before this change, the package's `code-reviewer` included, keeps v1.18.0's modules until it is retired and respawned. A respawn picks up the member copies.

## Changed

- **OATS's workspace stops pinning `oats.engineering`.** Its souls already compose the `oats` repository's copy of the engineering template, and the template's `code-reviewer` soul joins them in `souls/`. Each of the ids the package shared with the copy (`oats.engineering-expert`, `oats.developer`, `oats.code-review`, `oats.maintainer`) now has one source here, the member copy, so `oats capabilities show <id>` needs no `--member` or `--package`. The package is frozen, not retired: its catalog entry and its four aliases stay, so another workspace's pin keeps resolving ([official catalog](../official-catalog.md#coordination-templates)). No kernel or oats.framework release is needed.

## Removed

- **The `mirrors/` copies of `oats.engineering` v1.18.0** (`oats-engineering-expert`, `oats-developer`, `oats-code-review`, `oats-maintainer`). The repository mirrors only the packages its workspace pins, as it already does for `oats.cloning`. The checks that read them now read the member copy, or check that the frozen catalog entry stays.
