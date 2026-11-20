## Changed

- The kernel test runner fails when a `real aw` regression skips, naming the
  missing coverage. Three normally skipped provider-owned opt-ins were
  removed; container auth checks now execute acceptance orchestration against
  a strict subprocess boundary. [Test ownership](../design/2026-11-18-kernel-test-ownership.md)
  records the source checks removed or replaced and the documented guidance
  checks retained.
