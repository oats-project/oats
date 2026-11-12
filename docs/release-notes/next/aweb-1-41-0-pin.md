## Changed

- **The official catalog pins oats.aweb 1.41.0** (from 1.40.0), and OATS's
  own workspace takes it. The aw floor stays 1.36.33 and the tested aw
  1.36.58.
  - **An interrupted join is settled.** A join killed after aw accepted its
    invite no longer leaves a membership the home doesn't know about: the
    join writes its intent ahead, and the next `oats aweb join`, `leave` or
    retire finishes or releases it. A start warns.
  - **The roster marks retired certificates.** `oats aweb roster` marks the
    certificates a retire on this host had to leave in a team whose
    controller key people hold, and prints the command the team's
    controller removes them with.
  - **A refused wake stream is named.** Readiness names a stream aw 1.36.58
    reports as `refused`, with aw's cause and the next attempt.

  Nothing a deployment must change. The mirrors under `mirrors/oats-aweb*`
  are copied from the v1.41.0 tag
  ([oats.aweb's CHANGELOG](https://github.com/awebai/oats-aweb/blob/v1.41.0/CHANGELOG.md)).
