## Upgrade

- **`oats tui`: `p` is a new default key (pin).** A `tui.json` that binds `p`
  to another action is refused at the start, with a line that names the key
  and both actions. A tui.json that binds p to another action must move that
  action, or bind `pin` to another key (or to none, `"pin": []`). See
  [Pinning](../tui.md#pinning).

## Added

- **Pinned instances in the Desktop and the TUI** (feature `instance-pin`).
  A pinned instance is listed at the top of its machine's list, in the
  Desktop's sidebar, the TUI's list and the command palettes' rows you have
  not focused. Pinned instances come first at every level of the tree. An
  instance counts as pinned when it or one below it is, so pinning a child
  lifts its whole group and the path down to it. Among pinned instances the
  order is spawn time, newest first, as for the rest.
  - The Desktop: a row's context menu offers **Pin to top**, or **Unpin** on
    a pinned instance, and the command palette offers **Instance: Pin to
    top** / **Instance: Unpin** for the instance the leader keys act on. A
    pinned row shows a pin after its name, which a screen reader hears as
    "Pinned". A group with a pinned instance under its top instance doesn't
    start collapsed, so the pin is seen; closed by hand, it stays closed.
  - The TUI: `p` pins or unpins the selected instance at once, and the line
    under the sidebar's title says what it did, or why it did nothing.
  - Both run `oats instance pin <name> on|off`. The pin is the instance's
    home's, so everyone who views that machine sees the same pins. Without
    `instance-pin` on this computer, or on an instance's server, the order
    and the menus stay as they were.

  See [Pinned instances](../desktop.md#pinned-instances) and
  [Pinning](../tui.md#pinning).
