## Changed

- **The official catalog pins oats.okf 6.0.3** (from 6.0.2), and OATS's own
  workspace takes it. A lock that a recreated container left in a host
  cache can now be released by hand with `oats okf unlock --lock PATH
  --token TOKEN --host-gone HOST`, naming the owner's host exactly; nothing
  releases it on its own or by age. A concept merged without its id under an
  old node no longer refuses every proposal on its base (`W_ID_MISSING`), and
  the subject verbs warn `W_BASE_INVALID` on a base that fails validation
  instead of saying nothing. The generated mirror under `mirrors/oats-okf*`
  is finalized from the v6.0.3 tag
  ([oats.okf's CHANGELOG](https://github.com/oats-project/oats-okf/blob/v6.0.3/CHANGELOG.md)).
