- Claude starts check the effective configuration directory for a `/login`
  credential. When OATS also sets `CLAUDE_CODE_OAUTH_TOKEN` (literal, `fromEnv`,
  `fromFile` or a launch hook), the start refuses with
  `E_CLAUDE_LOGIN_CREDENTIAL`; otherwise it warns. Both messages name
  `oats harness token set claude`. Remove the `/login` credential before
  starting on the token route. Inherited pane tokens do not trigger refusal.
