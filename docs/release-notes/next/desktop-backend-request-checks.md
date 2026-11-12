## Changed

- **OATS Desktop's backend now requires the app's per-launch credential on
  every request, and listens on a private socket.** The app's main process
  starts its own backend server at every launch, always, on a Unix domain
  socket in a directory of its own (owned by you, closed to group and
  others), and hands it a fresh credential over a private pipe. Every request
  carries that credential; one without it is refused (`401`
  `E_UNAUTHORIZED`). The backend opens no TCP port, and the app never uses a
  server it did not start. The Host and Origin guards stay. See
  [Security posture](../desktop.md#security-posture).
- **The CLI binary is chosen only through the app's own file dialog.**
  **Choose oats…** saves the pick where the backend reads it at each probe;
  `POST /api/cli/reprobe` takes no binary (its body is `{}` or empty,
  anything else is `400` `E_BAD_ARGS`).
- **Starting the backend or the view harness by hand.** A developer starting
  `packages/desktop/server/oats-web.mjs` passes `--socket <path>` (in a
  directory you own with mode 0700) and `--token-file <path>` (a regular
  file you own, mode 0600, holding 43 base64url characters); the server
  refuses to start otherwise, and refuses `--port`. The dev harness
  (`renderer/harness-server.mjs`) takes `--api-socket <path>
  --token-file <path>` in place of `--api <url>` and prints its own URL,
  with a token of its own the page sends; `harness.html`'s `?api=` mode is
  gone. The steps are in `packages/desktop/README.md`.

## Removed

- **`OATS_DESKTOP_PORT`.** The Desktop's backend has no port to choose: it
  listens on the private socket the app makes for it. A launch that still sets
  the variable, to any value, gets one line on stderr saying that it is ignored.
