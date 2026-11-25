## Added

- **`oats settings set` and `oats settings unset` record a host setting
  without a hand edit** (#2122, KP-17). `oats settings set <capability>
  <key> <value>` writes `settings.<capability>.<key>` in the deployment's
  `oats-local.yaml` through the kernel's one writer of that file (its
  comments, its other entries and their order are kept; a JSON file stays
  JSON), after the resolver's own checks: a declared key, a declared value,
  never a `committedOnly` key. It answers `{capability, key, previous,
  value, effective, changed, file}` and takes effect at the next spawn,
  start, restart or readiness read. It is an operator's command: a process
  that carries an instance's identity is refused with the new code
  `E_SETTINGS_OPERATOR_ONLY`, a guard against an agent doing it by
  accident and not a security boundary. A credential-shaped key is never
  recorded. Each change leaves a line in
  `<deployment>/.agents/events/settings.jsonl`, private and bounded.
  Feature `settings-set`
  ([desktop-cli-api.md](../desktop-cli-api.md#oats-settings)).
