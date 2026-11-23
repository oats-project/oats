## Documentation

- **Adopting a minting root: optional human attribution, documented for when it
  opens** ([oats-project/oats#2059](https://github.com/oats-project/oats/pull/2059)).
  OATS's adoption of hosted roots stays closed until the human IDs contract's
  gates G2 (aweb's Cloud journey run) and G1's adopted evidence are met, although
  aweb Cloud 0.8.81 already offers the dashboard steps. When it opens, with aw
  1.36.59 and the oats.aweb release with human attribution, a person can adopt
  one of a deployment's minting roots, and the instances it mints from then on
  trace to them. [Adopting a minting root](../integrations.md#adopting-a-minting-root-oatsaweb-optional)
  gives which roots, what it needs in aweb Cloud and who can adopt, the agent's
  two `aw id parent` commands and the person's dashboard acts, the check, and
  its limits: one adoption per root, and no un-adopt (a team admin, or an owner
  or admin of the owning organisation in the team, removes the root's
  membership from their own terminal with a dashboard setup key). Attribution
  grants no access. oats.setup's `/oats-teams` has it as an act card, and
  `/oats-onboarding` routes to it. A deployment that adopts nothing works as
  before.
