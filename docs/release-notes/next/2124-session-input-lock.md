## Fixed

- **Two inputs to one agent no longer merge into one message** (#2124).
  `oats session input` to a tmux home is serialized per home: each input
  holds the home's input lock from its paste to the end of its Enter's
  observation, so two inputs sent at the same moment are two messages, each
  with its own Enter. Before, the second paste could land ahead of the first
  Enter, the agent got both texts run together, and both callers read
  `verified: true`; a scheduled wake delivers through the same path. An input
  that waits more than 8 seconds for another is refused
  `E_SESSION_INPUT_FAILED`, nothing sent. A lock whose holder died is taken
  over, and text that holder pasted and never submitted is submitted on its
  own before the next input's text. The lock covers the kernel's inputs
  only: not keys typed in an attached terminal, nor a session provider's
  home ([Input](../desktop-cli-api.md#input)).
