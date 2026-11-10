## Fixed

- **`oats doctor` reports a `souls.disabled` entry that names no soul**
  (oats-project/oats#1772). Spawn matches each entry of `oats-local.yaml`
  `souls.disabled` by its exact name. An entry whose soul was renamed or moved
  (a removed package pin, for example) therefore keeps nothing off this
  machine, and nothing said so. Such an entry fails open: the soul it was
  meant to keep off becomes spawnable again under its new name. A stale
  `souls.launch` key, by contrast, fails closed. Run `oats doctor` after any
  rename or removal.
  - Doctor adds one `disabled-soul-unmatched` problem per such entry, with
    the nearest souls the workspace offers and the hand edit that fixes it:
    replace the entry with the soul it was meant for, or remove it.
  - An entry doctor could not check against this machine's last read, or a
    cache that cannot answer, is a `disabled-soul-unchecked:` information
    line, by the same rules as the `souls.launch` check.
  - Doctor still exits 0. Spawn, `oats souls`, readiness and inspect are
    unchanged
    ([Launch preferences](../desktop-cli-api.md#launch-preferences),
    [`souls.disabled`](../configuration.md)).
