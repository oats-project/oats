## Changed

- The team agent image pins the released OATS 0.69.18 dependency closure,
  removing the unused pi extension subtree from the image lock. The other
  committed CLI packages and their integrity pins remain unchanged.

- The agent supervisor lets the wake broker finish its five-second channel
  delivery drain before escalation. Broker cleanup allows six seconds and
  sshd cleanup keeps three seconds; container acceptance requires a 50-second
  stop grace for the kernel and supervisor phases. The runtime deadline is a
  final failure boundary for stuck OS work; wake delivery and model activity
  require separate evidence.
