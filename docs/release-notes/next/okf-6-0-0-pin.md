## Changed

- **The official catalog pins oats.okf 6.0.0** (from 5.8.0), and OATS's own
  workspace takes it. 6.0 removes the knowledge harvester: an instance
  proposes its knowledge by pull request at its checkpoints (`oats okf
  propose`), and the knowledge maintainer reviews it. `oats.okf-harvest`
  and `oats.okf/knowledge-harvester` stay as refusing stubs until 7.0. It
  also reads a bridged knowledge base by subject (`okf.json` version 2, and
  the `subjects`, `subject`, `claims` and `verdicts` verbs); a base that is
  not bridged, and a version-1 soul, are served as before. The generated
  mirror under `mirrors/oats-okf*` is finalized from the v6.0.0 tag
  ([oats.okf's CHANGELOG](https://github.com/oats-project/oats-okf/blob/v6.0.0/CHANGELOG.md)).
