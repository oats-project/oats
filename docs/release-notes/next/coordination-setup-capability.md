## Added

- **The setup expert now knows how an organisation's agents should work together.** A new capability in oats.framework, `oats.coordination-setup`, holds OATS's coordination practices (`/coordination-best-practices`) and four skills for shaping them to one organisation:
  - `/adapt-to-the-organisation` runs at onboarding.
  - `/design-the-roster` proposes the souls: an expert per way of working with areas as its knowledge nodes, developer souls by environment, reviewers, maintainers when a lane needs one, a dispatcher per person who wants one, and retire rules.
  - `/set-landing-rules` writes, per lane, who merges on which agreement, who gives the green light to open a PR, and a merge path every lead can reach.
  - `/review-the-setup` proposes the smallest change when a signal says the setup no longer fits.

  The package soul `oats-setup-expert` composes it. Another soul uses it by naming `oats.coordination-setup: { from: package }`.

## Changed

- **Onboarding composes the engineering package instead of copying it.** `/oats-tailor-workspace`'s coordination step now runs `/adapt-to-the-organisation`. It pins the engineering package and authors only the workspace's own parts: its souls, its landing rules and ownership record, and any run-and-test skills its repositories lack. A package skill is copied only to change what it does, with a note of what changed, so a new package release is a small port.
