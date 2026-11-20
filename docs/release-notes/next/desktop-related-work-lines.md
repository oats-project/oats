## Changed

- **Desktop: the sidebar draws its lines again, for related work only.** Where an instance's host
  reports related work, the sidebar draws the lines it drew before its redesign, closed or open,
  and the command palette draws the same lines by the same rule
  ([the sidebar's instance tree](../desktop.md#the-sidebars-instance-tree)).
  - **A solid line** joins a parent to a child whose work is related to its parent's. Any other
    child keeps its indent with no line.
  - **A dotted line** joins the dots of two top-level instances of one group when the one linked
    as a sibling of the other reports related work. A top-level instance whose work isn't related
    breaks the dotted line, and the order of the rows doesn't change.
  - **No flag, no line, on every host.** On an older OATS (with `instance-same-work` only), a
    child's line follows `--same-work` and siblings get none. An OATS with neither feature reports
    no related work, so its instances get no line (before, the command palette drew every line
    for it).
  - Both lines hold 3:1 contrast on every row fill, in every theme. A screen reader hears
    "related work" after "under <parent>", and after "sibling of <name>" at both ends of a joined
    pair, in place of the words it heard for a child's flag before.
