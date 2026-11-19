## Added

- **Pin an instance at the top of its machine's list** (feature `instance-pin`).
  `oats instance pin <instance> on|off` records or removes the pin, locally or
  with `--server`. Its answer is `{ instancePinApi: 1, instance, home, pinned,
  changed }`; `home` names the home it resolved, so a routed or `--home` pin
  says which one it pinned.
  - The pin is shared. It is kept in the instance's home, so everyone who views
    that machine sees it: the Desktop, the TUI and another machine's routed
    view. There is no per-viewer pin.
  - The home keeps it in `.oats-pinned.json` through restart, stop, resume and
    `oats instance upgrade`, and a retire removes it with the home. Retire never
    counts the file as work, and a capability cannot declare it.
  - `pinned: true` appears on `oats status --json` rows, on `oats server roster
    --json` rows (only when the host's row says exactly `true`) and on
    `oats inspect --home`. The key is absent when the instance is not pinned.
  - No spawn flag or `soul.yaml` key pins an instance: a pin is a person's
    choice about the view. A routed pin needs a host that lists `instance-pin`.

  See
  [Pinned instances](../desktop-cli-api.md#pinned-instances-oats-instance-pin).
