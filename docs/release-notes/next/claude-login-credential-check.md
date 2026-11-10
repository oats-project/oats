- Claude starts check the effective configuration directory for a `/login`
  credential. When OATS also sets `CLAUDE_CODE_OAUTH_TOKEN` (literal, `fromEnv`,
  `fromFile` or a launch hook), the start refuses with
  `E_CLAUDE_LOGIN_CREDENTIAL`; otherwise it warns. Both messages name
  `oats harness token set claude`. Remove the `/login` credential before
  starting on the token route. Inherited pane tokens do not trigger refusal.
- Spawn preview and apply check the predictable launch configuration before
  creating a home, worktree or identity; preview carries the warning too.
  Hook-supplied selectors and tokens are checked once their environment is
  known, and the actual pane is checked again before dispatch.
- The final credential check follows the harness selected for this start,
  including a switch between Claude and another harness. Hook-supplied
  directory selectors are covered at preview, spawn and start.
