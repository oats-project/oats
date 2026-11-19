## Changed

- **The official catalog pins oats.okf 6.2.0** (from 6.0.3, taking 6.1.0's
  changes with it), and OATS's own workspace takes it. A knowledge change
  names the agent that proposed it in Git trailers on its commit, and
  `oats okf propose --apply` checks `gh` before it pushes anything,
  refusing `E_GH_UNAVAILABLE` with the fix (6.1.0). New in 6.2.0: an
  optional, host-only setting `settings.oats.okf.github-token-file` (in
  `oats-local.yaml` only) gives every remote `git` and `gh` call of oats.okf
  the token in that file, for knowledge writes from a container; with it, a
  publication refuses `E_HOST_CREDENTIAL` while the host could answer GitHub
  in the token's place. `oats okf setup --check --soul <soul>` says whether a
  deployment is provisioned for knowledge and names each fix
  ([Bringing up a deployment's knowledge store](https://github.com/oats-project/oats-okf/blob/v6.2.0/README.md#bringing-up-a-deployments-knowledge-store)).
  Without `github-token-file` nothing changes, apart from the `gh` check
  before a push. Three things are not yet proven in a live run: a proposal
  opened through `github-token-file` on a real private repository; GitHub
  refusing that write-role-only credential a direct push and a merge under
  the example ruleset; and what GitHub reports for such a token, which
  `setup --check` reads. A container deployment that relies on
  `github-token-file` waits for that run. The generated mirror under
  `mirrors/oats-okf*` is finalized from the v6.2.0 tag
  ([oats.okf's CHANGELOG](https://github.com/oats-project/oats-okf/blob/v6.2.0/CHANGELOG.md)).
