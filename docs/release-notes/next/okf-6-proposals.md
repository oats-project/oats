## Upgrade

- **A deployment that takes oats.okf 6.0.1 does these by hand**, from its
  deployment directory (oats.okf's
  [Upgrading to 6.0](https://github.com/oats-project/oats-okf/blob/v6.0.1/README.md#upgrading-to-60)
  has each step's commands; [knowledge.md](../knowledge.md#pin-and-select-the-package)
  the summary):
  1. Delete the harvester's launch preference, if any:
     `oats soul launch remove oats.okf/knowledge-harvester --plan`, then
     without `--plan`.
  2. Delete every `--provider oats.okf harvest=…` spawn flag from the
     scripts and briefs that spawn instances. Remove a leftover host
     `harvest` key with `oats okf setup --remove-legacy-settings --soul
     <soul>` (`--plan` first).
  3. Add the `proposal-review` trigger beside `harvest-review`: an existing
     `harvest-review` watches only the 5.x label `okf-harvest`, so it never
     reviews a 6.0 proposal. For a workspace file, copy it under the template
     `oats.okf:proposal-review` and the id `okf-proposal-review`, keeping its
     `set:`, `runsOn` and `owner`. On its review host, if `oats-local.yaml`
     lists named `automations: trust:` entries, add
     `- <member>/okf-proposal-review` beside the old one, then check that
     `oats trigger show <member>/okf-proposal-review --json` answers
     `runsHere: true`. For a local trigger, read its values with `oats
     trigger show <id> --json` and repeat them as `--set` values on `oats
     trigger add --from oats.okf:proposal-review`. Remove `harvest-review`
     (and its trust line) once no 5.x harvester can open an `okf-harvest`
     PR.
  4. Protect every Git base's accepted branch (pull requests only, merged by
     the knowledge maintainer's account), and give each proposing host's
     account branch-create access on the knowledge repository, never
     accepted-branch push; optionally set `screen-terms-file`
     ([Settings](../knowledge.md#settings)).
  5. Retire the harvesters `oats status` still lists, once they have handed
     over. A retired source's claims are proposed with the operator form,
     `oats okf propose --home <retirement recovery directory> --soul <soul>`
     (`--plan`, `--check`, `--apply`).
- **OATS's own workspace** adds `oats-triggers/okf-proposal-review.yaml`
  beside `okf-harvest-review.yaml`. On the host it names, add its trust line
  as in step 3 unless that host trusts `"*"`.

## Changed

- **OATS's texts follow oats.okf 6: an instance proposes its own knowledge.**
  The docs, the souls and the `oats.framework` skills no longer name a
  harvester to launch, wait for or retire: at each knowledge checkpoint an
  instance with a duty to propose runs `oats okf propose` itself, and the
  knowledge maintainer's review gates the pull request
  ([knowledge.md](../knowledge.md#the-flow),
  [schedules.md](../schedules.md#knowledge-proposal-review)). A finished
  instance's done line is one of "done, proposed: <PR URLs>", "done, nothing
  to propose: <reason>" or "done, no duty to propose"; "done, proposal
  pending: <slug and why>" means it is not finished yet.
- **OATS's copy of the engineering template moves to template-v3.0.2**, which
  makes the same change in the coordination skills and injects.
