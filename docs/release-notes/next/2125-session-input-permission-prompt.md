## Fixed

- **An input no longer answers a permission prompt** (#2125). On a tmux home
  whose session holds a `permission` claim, a client's or a message's
  `oats session input` is refused with `E_SESSION_PROMPT_OPEN` and types
  nothing, as on a session provider. Before, its Enter chose the prompt's
  first option, so the command ran, the text was lost, and the answer said
  `verified: true`. The person answers the prompt in the agent's terminal
  (`oats session attach`) or through their client's prompt card; there is no
  override. A claim that outlived its dialog (Claude Code leaves it when a
  prompt is refused) refuses the same way until the session's next prompt
  or `oats instance waiting clear`; the refusal prints that command. Feature `session-input-permission-refusal` in
  `oats version --json` tells this refusal from a lost input. An input still
  answers other dialogs: a `question` claim's (AskUserQuestion takes the
  text; pi's confirm takes the Enter as its default option) and a startup
  dialog that raises no claim (Claude's folder trust)
  ([Input](../desktop-cli-api.md#input)).
