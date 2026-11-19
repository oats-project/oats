## Added

- **The agent's board** (feature `instance-board`, `boardApi: 1`). An agent
  keeps facts in its person's view and asks them questions, from its own
  session:
  - `oats instance board set <key> --label <text> --value <text> [--unit
    <text>] [--link <https-url>]` and `oats instance board unset <key>`. At
    most 12 facts. The kernel keeps each fact's last 20 values. Facts last as
    long as the home.
  - `oats instance board ask <question> --option <text> --option <text>
    [--option <text>]… [--id <id>] [--context-file <f>]` and `oats instance
    board ask --clear <id>`. Each question has 2 to 4 options. At most 9 are
    open, with ids `q1`, `q2`… (never reused) unless `--id` names one. A
    question belongs to the session it was asked in.
  - While a question is open, the kernel holds a needs-input claim of
    producer `oats.board`, reason `attention`, with the oldest question as its
    message. The waiting dot and the waiting row show it as they show any
    claim. It holds no scheduled wake.
  - `board` on `oats status --json` and `oats server roster --json` instance
    rows: the facts and the open questions, at most 8 KiB per row
    (`E_BOARD_FULL` refuses a write past it), or `null` with no board.
    `oats inspect --home <h> --board` adds each fact's history and each
    question's context.
  - The board is the home's `.oats-board.json`. It is kernel-owned: a
    capability can't declare it, and a retire counts it as no work.
  - The kernel routes no answer. A client types the person's answer in the
    agent's terminal as `<id>: <text>`.

  See [The agent's board](../desktop-cli-api.md#the-agents-board-oats-instance-board).
