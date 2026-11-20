Retire the four version-named kernel copies of oats.aweb hook tests after
pinning oats.aweb 1.44.0, which includes the transferred provider regressions.
The released-row audit records every replacement and obsolete assertion in
[the retirement record](../design/2026-11-19-aweb-suite-retirement.md).
The kernel retire-hook contract test remains; provider lifecycle behaviour
is tested in its package rather than duplicated through kernel-side fakes.
