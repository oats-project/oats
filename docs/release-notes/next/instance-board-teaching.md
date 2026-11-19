## Changed

- **`oats.core` teaches the agent's board.** Its inject and `/oats-operate`
  say that, from OATS 0.69.22, an agent asks a decision between 2 and 4
  options on its board (`oats instance board ask`, with the summary, context,
  next step and links in `--context-file`, and an option for each choice
  saying what it does). The answer arrives typed as `<id>: <text>`, and the
  agent closes the question with `oats instance board ask --clear <id>` once
  it has read it. The agent keeps only what its person must keep in view as
  board facts (`oats instance board set`). Where `oats instance board` is
  refused, it uses `oats instance attention`.
