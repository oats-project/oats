## Added

- **A session provider's check is told the model, and its warnings reach a
  person** (feature `launch-model-and-check-warnings`, #2122). The launch a
  provider's `check` is asked about now carries `model` when the launch names
  one (`--model`, a launch configuration's, the soul's or the host's resolved
  one), and has no `model` key otherwise. A provider can so refuse a model
  its harness cannot resolve in its check, which a `session restart` asks
  before it stops anything: the running agent keeps running, where a refusal
  at the provider's launch left it stopped. What a `ready` check warns of is
  no longer dropped: each warning is one line in the `warnings` of
  `oats spawn --preview`, `oats launch-config preview --home`, `oats spawn`,
  `oats session start` and `oats session restart`, naming the capability and
  the verb, with the provider's code and message. The lines are text for a
  person, never parsed
  ([desktop-cli-api.md](../desktop-cli-api.md#relayed-check-warnings),
  [capabilities.md](../capabilities.md#check-optional)).
