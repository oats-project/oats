## Changed

- **oats.framework 1.29.0** (`oats.core` 2.16.1, `oats.knowledge-theory`
  1.1.4).
  - `oats.core`'s `/oats-operate` says a pi home's extension dialogs raise
    needs-input, and that the claim holds a scheduled wake while one is open,
    from `@awebai/oats-pi` 0.70.2 (#2071). A pi home's `wakeHold` still reads
    `unknown`: a screen of pi's own has no claim.
  - `oats.knowledge-theory`'s capability-authoring reference shows the
    current `oats.framework` pin in its example.
  - Guidance text only. Nothing changes for a deployment beyond `oats sync`
    taking the new tag; existing homes take the new skills through
    `oats instance upgrade` or a new spawn.
