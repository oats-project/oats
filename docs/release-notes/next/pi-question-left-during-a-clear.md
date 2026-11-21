## Fixed

- **pi bridge: a question left by a pi that died while another pi's clear was
  under way no longer stands unseen**
  ([oats-project/oats#2076](https://github.com/oats-project/oats/issues/2076)).
  When a second pi in a home (a nested one, a subagent's session) opened a
  dialog and died in the moment the live pi's bridge was clearing its own
  claim, that bridge removed the dead pi's mark and left its `question` claim.
  With no mark, the live pi never cleared it: the instance showed as needing
  input and its scheduled wakes were held until the home's next pi ran, or
  `oats instance waiting clear --producer oats.pi --home <home>`. The bridge
  now removes only the mark its clear answered, and clears such a question in
  the same step ([Whose claim it is](../capabilities.md#oatscore-needs-input)).
  It reaches each pi folder with the bridge's next update
  ([upgrading](../upgrading.md)).
