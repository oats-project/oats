## Upgrade

- **A deployment of OATS's own workspace takes four hand steps for the renamed and removed souls, in this order.** The names change as follows:

  | Old soul | New soul |
  |---|---|
  | `oats-expert` | `oats-engineering-expert` (renamed) |
  | `market-research-expert` | `oats-product-expert` |
  | `oats-kernel-developer` | `oats-developer` |
  | `oats-integrations-developer` | `oats-developer` |

  1. **`souls.launch`.** For each old name with a key, pin its new soul first, then remove the old key:

     ```sh
     oats soul launch set oats-engineering-expert --harness <harness> --model <model>   # or --launch-config <name>
     oats soul launch remove oats-expert
     ```

     The same goes for `market-research-expert` (pin `oats-product-expert`) and for `oats-kernel-developer` and `oats-integrations-developer` (pin `oats-developer` once). Left in place, an old key stops spawns. `oats doctor` shows `E_LAUNCH_PREFERENCE_UNMATCHED: oats-local.yaml souls.launch names "oats-expert", which is no soul in this machine's last read of the souls this workspace offers`. Every spawn that names no launch, of a soul with no `souls.launch` entry of its own, is refused, and nothing is created or started. A spawn that names its launch (`--harness` or `--launch-config`) still runs.
  2. **`souls.disabled`.** No command writes it. In `oats-local.yaml`, change each old name to its new soul. A stale entry **fails open**: it disables nothing, so the new soul spawns on that machine until the entry is fixed, and the spawn doesn't refuse. `oats doctor` reports each stale entry (`disabled-soul-unmatched`, [launch preferences](../desktop-cli-api.md#launch-preferences)): `oats-local.yaml souls.disabled names "oats-expert", which is no soul in this machine's last read of the souls this workspace offers, so it keeps no soul off this machine`, with the nearest souls the workspace offers when a name is close, and the hand edit that fixes it.
  3. **Team patterns.** They are the workspace's `souls:`, and OATS's has only `"*"`, which covers the new souls. Nothing to change. `oats soul teams oats-engineering-expert` shows the `oats` team, from `"*"`.
  4. **Schedules and triggers.** Find any that spawns an old soul with `oats schedule list` and `oats trigger list`. `oats schedule test <id>` reports the soul as not resolving (`E_SOUL_UNKNOWN`), and the job spawns nothing; `oats trigger test <id>` checks its soul the same way. Change each to the new soul:
     - a host schedule: `oats schedule update <id> --file <spec.json>`, with `"agent": "<new soul>"`;
     - a local trigger: `oats trigger remove <id>`, then `oats trigger add --file <trigger.json>`, with `"soul": "<new soul>"` in its `spawn`;
     - a workspace schedule or trigger: in its file in Git.

  Then run `oats doctor`, and fix what it reports: a stale `souls.launch` key and a stale `souls.disabled` entry each show there.
- **Running homes of the old souls keep working until they are retired.** A home keeps the soul and the modules it was spawned with. It restarts (`oats session start`), its knowledge reads and readiness are unchanged, and `oats status` lists it under its old soul, marked `[soul no longer present]`. Its final harvest still lands in its old node: the knowledge base's owners don't change. A home with a worktree keeps its branch and its worktree, and retiring it treats them as it treats any home's. A spawn of an old soul is refused (`no soul "oats-expert" among the confirmed members, external souls or package souls of this workspace`): new work spawns the new souls.
- **A home retired with a knowledge proposal still pending lands it only by hand.** The proposal stays in the home, and so in its retirement recovery copy, while the home's last harvester is still listed or stuck:
  1. Once that harvester's failure is dealt with, retire it: `oats retire <harvester>`.
  2. Find the recovery copy: `oats doctor` lists it as `retained-recovery`, under `agents/<old soul>/instances/.oats-retirement/recovery/`. The proposal is at `<recovery>/home/proposals/<file>`, or at `<recovery>/after-hooks/home/proposals/<file>` when the copy has an `after-hooks/` folder.
  3. Spawn a harvester on it, with a fresh name (up to 21 characters of the retired instance's name, a dash, a random UUID without dashes, and `-harvester`), preview first:

     ```sh
     oats spawn oats.okf/knowledge-harvester --name <harvester-name> --task-file <recovery>/home/proposals/<file> --relation unrelated --preview
     oats spawn oats.okf/knowledge-harvester --name <harvester-name> --task-file <recovery>/home/proposals/<file> --relation unrelated
     ```

     Its spawn hook captures the proposal and its notes from the recovery copy: `harvest-source/source.json` in the harvester's home says `"from": "recovery"`.
  4. Keep the recovery copy until that capture. Nothing removes it on its own.

## Changed

- **OATS's souls are split by way of working, not by area.** OATS's workspace gains a front door and folds its experts and developers:
  - **`dispatcher`** (new): each person's front door, from the engineering template (template-v2.1.0). It starts a fresh expert of the right soul per effort, introduces its lead and steps aside. Start one standing instance for each person who wants one: `oats spawn dispatcher --name <person>-dispatcher --task-file <who it serves.md>`.
  - **`oats-engineering-expert`** (renamed from `oats-expert`): every engineering effort, in every area (the kernel and the CLI, the Terminal UI, the Desktop, the provider packages, operating a deployment, the docs). It keeps `oats-expert`'s knowledge owner and node, `oats/oats-expert`, and reads each area's node per task. Until the knowledge base is organised by subject, an area lesson goes into its own node, with its area named in the concept.
  - **`oats-product-expert`** (new, taking over `market-research-expert`): vision, direction, users and positioning, research and trials, the README and the concept pages. It writes a brief and hands it to an engineering expert at an exact version. It owns `oats/market-research-expert`, with that soul's knowledge owner, and names each direction decision for the maintainer's node in its hand-back.
  - **`oats-developer`** (new, folding `oats-kernel-developer` and `oats-integrations-developer`): the kernel and the CLI, the Terminal UI, the provider package repositories and the docs. `oats-desktop-developer` keeps the Desktop.
  - **Unchanged:** `oats-maintainer`, `oats-setup-admin`, `oats-desktop-developer` and `oats-public-expert`, whose texts now name the new souls. The area experts (`oats-kernel-expert`, `oats-desktop-expert`, `integrations-expert`, `oats-operator-expert`) stay and still own their knowledge nodes, but no text routes new work to them: the dispatcher and the surfaces table of `oats.workspace-experts` (1.2.0) name `oats-engineering-expert` for every engineering surface.
  - The landing rules' "A PR with no lead here" says the person brings it to their dispatcher, as the template does.
- **oats.framework's texts name the new souls:** the setup inject sends framework questions to `oats-engineering-expert`, and the `oats-souls` naming examples use the current souls. They reach a deployment with the next oats.framework release.

## Removed

- **The souls `oats-expert`, `market-research-expert`, `oats-kernel-developer` and `oats-integrations-developer`,** replaced as the table above says. No knowledge node is renamed or moved, and no node changes owner.
