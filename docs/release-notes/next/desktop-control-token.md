## Changed

- Desktop's backend requires this launch's token on every route except
  `GET /api/version`, and any supplied browser Origin must match exactly.
  An earlier launch's server is no longer reused unless both launches use
  the same explicitly configured token; it is left running and Desktop
  starts its own on the next free port.
- Starting the server by hand, for development or an SSH forward, now needs
  the same `OATS_DESKTOP_TOKEN` set for the server, the dev harness and Desktop.
  The value must contain at least 32 characters. The token stays in main and
  the server-side processes; renderer pages and child programs receive none.
