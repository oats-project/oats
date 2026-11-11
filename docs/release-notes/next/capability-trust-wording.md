## Documentation

- **What the capability trust check checks.** [Capabilities](../capabilities.md#mental-model)
  and the kernel's own comment now say that trust is decided where the
  workspace declares a member or a package, and that the kernel's later check
  only confirms that what it runs is the copy made at spawn. The
  [trust model](../trust-model.md#the-line) names the one piece of the package
  that runs as root, the harness-credential receiver, and why rule 3 does not
  cover it. No behaviour changes.
