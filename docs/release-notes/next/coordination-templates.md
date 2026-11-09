## Changed

- **Onboarding starts coordination from OATS's template repositories.** Coordination ships as templates, not packages. `/adapt-to-the-organisation` and `/oats-tailor-workspace` now start each group from the closest template repository at a `template-v*` tag and follow its `ADAPTING.md`; the first is `oats-project/oats-engineering`. Each copied capability records the template release it came from. `docs/official-catalog.md` lists the templates under "Coordination templates".
- **The package `oats.engineering` is frozen at v1.18.0.** Existing pins keep resolving through its catalog entry and aliases. The repository's later releases are templates, so a pin to one of them finds no package manifest.
