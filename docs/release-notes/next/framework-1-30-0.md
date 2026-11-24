## Changed

- **oats.framework 1.30.0** (`oats.setup` 2.17.0, `oats.knowledge-theory`
  1.1.5).
  - `oats.setup`'s `/oats-teams` explains how to adopt a minting root (human
    attribution, optional; #2082), and that the adopting person's namespace
    must verify (human IDs contract r3 §2; #2110). It names what it needs: aw
    1.36.59 or later on every host that uses the root, and oats.aweb 1.49.0
    or later. Adopting a root on a hosted team is not open yet.
    `/oats-onboarding` lists the adoption as an optional card.
  - `oats.knowledge-theory`'s capability-authoring reference shows the
    current `oats.framework` pin in its example.
  - Guidance text only. Nothing changes for a deployment beyond `oats sync`
    taking the new tag; existing homes take the new skills through
    `oats instance upgrade` or a new spawn.
