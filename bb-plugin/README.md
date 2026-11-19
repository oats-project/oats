# bb-plugin-oats (staging)

The OATS plugin for bb. This directory is a **staging copy**: it lives on a branch of the oats
repository only until the bb package repository exists, where it becomes `plugin/` with its
history. It is never merged into oats and no pull request is opened for it here.

Tested on bb-app 0.50.1 (plugin SDK 0.6.157). bb, its npm packages and this plugin's dependencies
are installed and run only in containers.

`contract.ts`, `model/types.ts` and `test/fixtures/` are pinned by the spec: a change to them is
agreed with the spec's author first.
