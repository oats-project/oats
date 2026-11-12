## Changed

- **A Codex or session-delivery machine starts its wake broker before the
  setup expert is spawned.** The getting-started skill's step 9 has a new
  last item: when the setup expert is woken by the host wake broker (Codex,
  or `delivery: session`), the person runs `oats aweb wake install` in
  their own terminal, or `aw wake run` as a supervised process where there
  is no service manager, and the agent goes on to the spawn only once
  `oats aweb wake status` reports the daemon running. oats.aweb refuses to
  spawn or start such a home while no broker runs, so the broker can no
  longer be left for the setup expert to install. `/oats-host-delivery`
  Choice 2 now says the same: a broker-delivered home is refused with
  `wake-daemon-not-running`, not left unwoken.
