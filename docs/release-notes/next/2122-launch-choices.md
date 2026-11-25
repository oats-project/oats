## Added

- **Provider-declared launch choices** (feature `launch-choices`, #2122
  KP-14). A session provider can now take choices of one launch that only
  it understands, such as a reasoning level or a service tier. It declares
  their names in its manifest (`sessionProviders.<name>.launchChoices`, each
  with a one-line description), and `oats spawn`, `oats session start` and
  `oats session restart` take `--launch-choice <name>=<value>`, any number
  of times. The kernel knows no choice's meaning: it checks that the home's
  provider declares the name, records the value for the home's later
  starts, and hands the provider `choices` in its check and its launch. A
  choice is refused or it reaches the launch, never dropped: `E_BAD_ARGS`
  for a name the provider does not declare, for a tmux home, and for a
  recorded choice the provider no longer declares (`--launch-choice
  <name>=default` clears one). No answer gains a key, so a client cannot
  show a recorded choice yet. Launch configurations, souls, host defaults,
  schedules and triggers carry none yet. A kernel from before the feature
  reads a provider that declares `launchChoices` as malformed
  (`E_BACKEND_UNKNOWN`), so such a package raises its `compatibility.oats`
  to this release
  ([capabilities.md](../capabilities.md#launch-choices-launchchoices),
  [desktop-cli-api.md](../desktop-cli-api.md#launch-choices-feature-launch-choices)).
