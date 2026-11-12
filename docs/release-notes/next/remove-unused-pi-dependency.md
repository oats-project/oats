- **Installing the kernel no longer installs pi's aweb extension and its
  harness dependencies.** The kernel never imported `@awebai/pi`; the aweb
  capability installs that extension into pi separately. The pi SDK remains
  a development dependency for adapter tests, at its existing version.
