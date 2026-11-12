## Upgrade

- **An older Desktop keeps appending the soul's role to a typed name until
  it is upgraded.** A Desktop of 0.69.17 or older still sends a typed
  `pricing-page` for `oats-desktop-expert` as `pricing-page-expert`,
  whatever OATS CLI it runs with: the CLI can't tell an appended word from
  one you typed. Upgrade the Desktop to get the name exactly as you type it.

## Changed

- **The Desktop no longer appends the soul's role to a name you type.** In
  the spawn dialog, a typed name goes to OATS as typed, in lowercase:
  `desktop-improvements` stays `desktop-improvements`, and
  `Pricing-Page-Lead` becomes `pricing-page-lead`. The soul is shown beside
  the instance. What to name an instance is oats.core's rule (oats-souls,
  "Name the instance"): `<descriptive>-<role>`, the role being the
  instance's role in your coordination. The Name field's example now reads
  "e.g. pricing-page-lead". The 64-character limit applies to the typed name
  itself. A spawn on a server takes the typed name the same way. With an
  OATS older than 0.26.0 on either side, what you type is still a purpose,
  named `<soul>-<purpose>` ([Desktop](../desktop.md)).
