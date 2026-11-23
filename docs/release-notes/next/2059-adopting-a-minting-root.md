## Documentation

- **Adopting a minting root: optional human attribution, documented**
  ([oats-project/oats#2059](https://github.com/oats-project/oats/pull/2059)).
  With aw 1.36.59 and the oats.aweb release with human attribution, a person can
  adopt one of a deployment's minting roots, and the instances it mints from then
  on trace to them. [Adopting a minting root](../integrations.md#adopting-a-minting-root-oatsaweb-optional)
  gives what it needs, the agent's two `aw id parent` commands and the person's
  three dashboard acts, the check, and its limits: one adoption per root key, no
  un-adopt (the person removes the root's membership themselves, once aweb's Cloud
  release with it is live), and attribution is information only. OATS's adoption
  of hosted roots waits for the contract's gate G2, and for a fresh hosted root
  (it reads `no_human` on aw 1.36.53 or later) also for G3, the Cloud release
  aweb names: aweb Cloud 0.8.80 and earlier refuse to adopt a root that already
  has a creation chain. oats.setup's `/oats-teams` has it as an act card,
  and `/oats-onboarding` routes to it. A deployment that adopts nothing works as
  before.
