## Added

- **The setup expert now knows how an organisation's agents should work together.** A new capability in oats.framework, `oats.coordination-setup`, holds OATS's coordination practices (`/coordination-best-practices`) and four skills for shaping them to one organisation:
  - `/adapt-to-the-organisation` runs at onboarding.
  - `/design-the-roster` proposes the souls: an expert per way of working with areas as its knowledge nodes, developer souls by environment, reviewers, maintainers when a lane needs one, a dispatcher per person who wants one, and retire rules.
  - `/set-landing-rules` writes, per lane, who merges on which agreement, who gives the green light to open a PR, and a merge path every lead can reach.
  - `/review-the-setup` proposes the smallest change when a signal says the setup no longer fits.

  The package soul `oats-setup-expert` composes it. Another soul uses it by naming `oats.coordination-setup: { from: package }`.

## Changed

- **Onboarding adapts the coordination template with these practices.** `/oats-tailor-workspace` still starts a workspace's coordination from the engineering package as a template. It now shapes it with `/adapt-to-the-organisation`: the roster of souls (`/design-the-roster`), the landing rules (`/set-landing-rules`) and, with several people, the ownership record. The capability notes the template version it started from.
