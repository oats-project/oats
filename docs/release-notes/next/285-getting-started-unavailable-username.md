## Changed

- **Getting started names an unavailable aweb username.** With an oats.aweb
  that answers `E_SETUP_USERNAME_UNAVAILABLE` (awebai/oats-aweb#286), the
  `oats-getting-started` skill's signup step knows that nothing was created:
  it asks the person for another `N`, or, on a machine found-list, tells
  them why and stops. `E_SETUP_NATIVE` no longer reads as "most likely
  taken"; on an older oats.aweb a taken `N` still fails that way.
