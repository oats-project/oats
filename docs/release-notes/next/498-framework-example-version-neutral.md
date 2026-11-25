## Documentation

- **The `oats.knowledge-theory` curriculum no longer names a framework
  version** ([#498](https://github.com/oats-project/oats/issues/498)). The
  example in [knowledge capability authoring](../knowledge-capability-authoring.md)
  pins `oats.framework: vX.Y.Z` and points to the `oats.framework` entry of
  `package-catalog.json` for the release to pin. The page ships inside the
  framework, so a concrete version went out of date at every framework
  release, and each pin round changed the capability after its tag.
  `scripts/check-knowledge-theory-package.mjs` now refuses a concrete
  framework version anywhere in the curriculum. A deployment changes
  nothing.
