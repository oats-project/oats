## Changed

- **The official catalog pins oats.okf 6.3.0** (from 6.2.0), and OATS's own
  workspace takes it. Knowledge proposals are lighter (oats-project/oats-okf#164):
  `oats okf propose` refuses only what protects against real harm (secrets and
  personal data leaving the host, a base that would be invalid, forged
  provenance, unsafe files, the soul's consent, credentials, one attempt per
  proposal). What the knowledge maintainer judges at review anyway (a claim
  outside the proposer's nodes, a missing subject, a broken link, an unfilled
  `proposal.md`) becomes a `W_*` warning, listed under `## Check warnings` in
  the PR body, which the maintainer resolves before merging. `--slug` and
  `--digest` are optional: `--plan`, then `--apply` (it prints the outgoing
  diff and stops), then `--apply` again publishes exactly what it printed.
  Every 6.2 invocation still works with the same result. **What a deployment
  must change:** nothing; the floor stays OATS >=0.69.2. Running instances
  keep the module they were spawned with: respawn them, or move a stopped one
  with `oats instance upgrade`, to take 6.3.0. The generated mirror under
  `mirrors/oats-okf*` is finalized from the v6.3.0 tag
  ([oats.okf's CHANGELOG](https://github.com/oats-project/oats-okf/blob/v6.3.0/CHANGELOG.md)).
