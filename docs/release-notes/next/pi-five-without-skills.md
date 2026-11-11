## Documentation

- **The pi skills filter is for @awebai/pi below 0.5.0, and @awebai/claude-skills stays out of OATS pi folders.**
  - **Why:** @awebai/pi 0.5.0 bundles no skills. They now ship on their own in @awebai/claude-skills, which pi would load in every session that uses the folder.
  - **`/oats-host-delivery`** (`oats.framework`): the pi step of channel delivery makes the extension's entry `{"source": "npm:@awebai/pi", "skills": []}` only below 0.5.0.
  - **The getting-started onboarding:** it still sets the filter whatever the version, because it's harmless on 0.5.0.
  - Both now say never to install @awebai/claude-skills in a pi folder that OATS homes use, because a home gets its skills from its capabilities. This matches oats.aweb 1.38.0, whose readiness warns `pi-extension-skills-loaded` only below 0.5.0 and adds `pi-skills-package-loaded`.
