## Changed

- **A suggested name now ends in the role the task gives.** `oats spawn
  --suggest-name` (a preview or an apply) and `oats instance suggest-name` ask
  the model for the whole name, `<work>-<role>`, with the role last, as the
  task gives it. The kernel keeps that name: nothing appends the soul's role
  any more. A reply for `oats-engineering-expert` of `pricing-page-lead` names
  the instance `pricing-page-lead`, not `pricing-page-lead-expert`. Over five
  words, or over 64 characters, the descriptive words nearest the role are
  dropped, and the role is always kept. A one-word reply is `invalid-reply`,
  and the instance is numbered as before. The JSON and the reasons are
  unchanged ([The suggested name](../desktop-cli-api.md#the-suggested-name-feature-spawn-suggest-name)).
- **`oats instance suggest-name --soul` no longer affects the name.** It is
  optional now. When given, it is still checked as a soul name's shape
  (`E_BAD_ARGS`), because installed Desktops send it.

## Upgrade

- **A host on an older OATS keeps the old suggestion until it is upgraded:**
  a few words for the work, then the soul's last word. A spawn through
  `--server` with `--suggest-name` is named by the host that runs it, so its
  name follows the host's OATS, not the caller's.
