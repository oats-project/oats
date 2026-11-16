# The reviewer's model, and history-only findings

## Contents
- The floor comes first
- Then a different model
- History-only findings

## The floor comes first
Check the model the reviewer would launch on against the floor your landing rules set
(their house rules; `/landing-rules-detail`, "The model floor"), before anything below:
the effective one from the preview as much as one you pick, and a native reviewer's too.
A smaller, faster or cheaper model is not a different one, and an effective model below
the floor is not used, even where it differs from yours.

## Then a different model
A reviewer on your model shares your blind spots. Before you spawn it, compare:
- **yours:** `launch.harness` and `launch.model` in your `instance.json`;
- **the reviewer's:** `oats spawn code-reviewer --preview --json`, where
  `launch.declared` is the soul's default and `launch.effective` what this machine will
  launch. When `launch.from` is `local`, the machine's `oats-local.yaml` entry named by
  `launch.at` overrides the default.

Compare model families, not harnesses or versions: OATS's machines launch Claude models and
models of other families (GPT's among them) through more than one harness. A provider
prefix names a route to a model, not another model, so one model reached through two
harnesses is one model, and two versions of one family share its blind spots. Each
machine's `souls.launch` in `oats-local.yaml` picks the model a soul runs on there, so the
soul's own `launch:` is only its default. Every model you pick is one this workspace
allows.

| The comparison | Do |
|---|---|
| The effective model is known, at or above the floor, and of another family than yours | Spawn without `--harness` or `--model`, so the machine's choice applies. Don't force the soul's default over it. |
| It would run in your family, on any harness | Spawn it on a state-of-the-art model of another family that this workspace allows, on another harness when you can: a launch configuration this host defines (`oats launch-config list`), or `--harness` and `--model`. |
| Either model is unknown (`null`, absent, a harness's native default) | The comparison proves nothing. Spawn it with `--harness` and `--model` on a model of another family than yours that this workspace allows; your harness reports your own. |
| No other family has a model at or above the floor, or you can't establish a difference | Spawn it on your own model where that meets the floor, otherwise on a model of your own family that does and that this workspace allows, and say in your hand-back that diversity was lost. Where no allowed model at or above the floor is available, spawn no reviewer: tell your person. |
<!-- OATS: the floor is absolute here, so your own model is the fallback only where it meets the floor (the last row). -->

## History-only findings
A secret or personal data in an intermediate commit or a commit message, absent from
`target_sha`: only a history rewrite fixes it, and only if nothing offending is
published.
1. Fetch every remote and tag, and check that no remote branch or tag contains an
   offending commit (`git for-each-ref --contains <sha> refs/remotes refs/tags` prints
   nothing for each). Otherwise stop and tell your expert: a published secret is
   rotated, and a force-push is a person's call.
2. Rewrite from `base_sha` with no editor, keeping the repository's commit rules
   (sign-off, signing) on every rewritten commit.
3. Check that the material is gone from every commit and message.

The rewrite is not a review round.
