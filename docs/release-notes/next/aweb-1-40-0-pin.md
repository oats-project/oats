## Upgrade

- **Start the wake broker before a broker-delivered home's next start.**
  From oats.aweb 1.40.0, `oats spawn` and every start of a home the host
  wake broker delivers to (Codex, `delivery: session`, or a runtime with no
  aweb channel of its own) refuse while no broker runs, with
  `wake-daemon-not-running`. The message names the start for the host:
  `oats aweb wake install` in your own terminal, or `aw wake run` as a
  supervised process where there is no service manager. Check with
  `oats aweb wake status`. Claude and pi homes under channel delivery are
  not affected.

## Changed

- **The official catalog pins oats.aweb 1.40.0** (from 1.39.1), with its
  mirrors. A broker-delivered home used to spawn even with no broker running,
  and was then never woken. It is now refused at spawn and at each start.
  The aw floor (1.36.33) and the tested aw (1.36.58) are unchanged.
