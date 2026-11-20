## Fixed

- **Getting started pushes straight to a free plan's private repository.**
  On a private repository whose plan has no rulesets, GitHub answers the
  `oats-getting-started` skill's rules read with a 403 "Upgrade to GitHub
  Pro". Step 7 read that failure as a guarded branch and opened a pull
  request the person then had to merge. It now counts that 403 as no rules,
  as `oats-workspace-config`'s check already does. The skill still opens a
  pull request when others can push, when the branch is protected, when any
  other read fails, or when the push is refused.
- **Getting started's default workspace name is the repository's.** When a
  project has both a repository and a folder of different names, step 1 now
  proposes the repository's name, and the folder's only when there's no
  repository.
