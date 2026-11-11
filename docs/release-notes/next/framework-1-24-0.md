## Changed

- **`oats.framework` 1.24.0 carries OATS's texts for oats.okf 6 and the pi
  folder steps for @awebai/pi 0.5.0.**
  - `oats.setup` 2.15.0:
    - `/oats-onboarding`, `/oats-automations` and `/oats-agent-permissions`
      describe oats.okf 6.0.1: an instance proposes its own knowledge with
      `oats okf propose`, the `oats.okf:proposal-review` trigger reviews it,
      and there is no harvester to set up.
    - `/oats-host-delivery`'s pi step asks for the skills filter only below
      @awebai/pi 0.5.0, and keeps @awebai/claude-skills out of OATS pi
      folders.
  - `oats.coordination-setup` 1.0.1's `/coordination-best-practices` says
    knowledge is proposed at checkpoints, not harvested.

  The commands these name come from oats.okf 6, which the catalog pins. None
  needs a newer OATS than each capability already admits.
