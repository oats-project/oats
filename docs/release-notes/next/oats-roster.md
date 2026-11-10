## Added

- **OATS's souls are split by way of working, not by area.** OATS's workspace gains a front door, two experts and one developer:
  - **`dispatcher`**: each person's front door, from the engineering template (template-v2.1.0). It starts a fresh expert of the right soul per effort, introduces its lead and steps aside. Start one standing instance for each person who wants one: `oats spawn dispatcher --name <person>-dispatcher --task-file <who it serves.md>`.
  - **`oats-engineering-expert`** (succeeding `oats-expert`): every engineering effort, in every area (the kernel and the CLI, the Terminal UI, the Desktop, the provider packages, operating a deployment, the docs). It shares `oats-expert`'s knowledge owner and node, `oats/oats-expert`, and reads each area's node per task. Until the knowledge base is organised by subject, an area lesson goes into its own node, with its area named in the concept.
  - **`oats-product-expert`** (succeeding `market-research-expert`): vision, direction, users and positioning, research and trials, the README and the concept pages. It writes a brief and hands it to an engineering expert at an exact version. It shares `market-research-expert`'s knowledge owner and node, `oats/market-research-expert`, and names each direction decision for the maintainer's node in its hand-back.
  - **`oats-developer`** (succeeding `oats-kernel-developer` and `oats-integrations-developer`): the kernel and the CLI, the Terminal UI, the provider package repositories and the docs. `oats-desktop-developer` keeps the Desktop.

## Changed

- **`oats-expert`, `market-research-expert`, `oats-kernel-developer` and `oats-integrations-developer` are deprecated.** Each still resolves and composes as before, and its description says it is deprecated. New work spawns its successor:

  | Deprecated soul | Successor |
  |---|---|
  | `oats-expert` | `oats-engineering-expert` |
  | `market-research-expert` | `oats-product-expert` |
  | `oats-kernel-developer` | `oats-developer` |
  | `oats-integrations-developer` | `oats-developer` |

  - **Nothing to change in a deployment now.** `souls.launch`, `souls.disabled`, team patterns, schedules and triggers that name a deprecated soul keep working. The souls' removal comes later, in a change of its own, with the steps it takes.
  - **Two souls share each of two knowledge owners:** `oats-expert` and `oats-engineering-expert` own `oats/oats-expert`, and `market-research-expert` and `oats-product-expert` own `oats/market-research-expert`. Homes of either soul spawn, read and harvest into that node. No node changes owner.
  - **A new home of a deprecated soul gets the current texts of the capabilities it shares with the new souls.** A new `oats-expert` home's coordinate-developers skill and surfaces table name `oats-developer` and `oats-engineering-expert`, so it launches `oats-developer`, not `oats-kernel-developer`. A running home keeps the texts it was spawned with.
- **Unchanged:** `oats-maintainer`, `oats-setup-admin`, `oats-desktop-developer` and `oats-public-expert`, whose texts now name the new souls. The area experts (`oats-kernel-expert`, `oats-desktop-expert`, `integrations-expert`, `oats-operator-expert`) stay and still own their knowledge nodes, but no text routes new work to them: the dispatcher and the surfaces table of `oats.workspace-experts` (1.2.0) name `oats-engineering-expert` for every engineering surface.
- The landing rules' "A PR with no lead here" says the person brings it to their dispatcher, as the template does.
- **oats.framework's texts name the new souls:** the setup inject sends framework questions to `oats-engineering-expert`, and the `oats-souls` naming examples use the current souls. They reach a deployment with the next oats.framework release.
