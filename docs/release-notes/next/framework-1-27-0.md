## Changed

- **oats.framework 1.27.0** (`oats.core` 2.15.0, `oats.knowledge-theory` 1.1.2,
  `oats.setup` 2.16.1). `oats.core`'s inject and `/oats-operate` teach the
  agent's board where the kernel lists `instance-board`, with `attention` as
  the fallback (#2002). The `knowledge-capability-authoring` skill, its copied references
  and the `knowledge-theory-expert` soul teach judgment and proposal at the
  working instance's own checkpoints, with a reviewer accepting every
  proposal. An independent harvester is an option a capability may choose
  (#2009). `oats.setup`'s onboarding and package-pins skills name oats.okf
  v6.3.0 in their examples. Guidance text only: no floor moves, and nothing
  changes for a deployment beyond `oats sync` taking the new tag.
