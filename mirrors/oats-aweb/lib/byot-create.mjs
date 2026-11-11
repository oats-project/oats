// `oats aweb setup --create <label> --namespace <domain>` (BYOT) needs more of aw than the
// provider's floor (aw-compat.json `min`):
// - `aw id team set-server` / `show-server`, which publish and verify the team-server record, first
//   ship in aw-v1.36.44 (880ccf5; absent at aw-v1.36.43, c623570);
// - aw's `--json` error envelope (cmd/aw/errors.go:124 cliErrorEnvelope), which setup reads to tell
//   "no team server record is published" and a taken team name from a failure, first ships in
//   aw-v1.36.53 (755f3dc; absent at aw-v1.36.51, a5173f2; there is no 1.36.52 release).
// So the route's floor is 1.36.53. It is a refusal floor only: `--install-aw` installs aw-compat's
// `tested`.
import { AW_TESTED, versionAtLeast } from './aw-floor.mjs';

export const AW_BYOT_CREATE = '1.36.53';

/** The refusal for an installed aw below AW_BYOT_CREATE, or undefined when `version` meets it. */
export function byotCreateAwRefusal(version) {
  if (versionAtLeast(version, AW_BYOT_CREATE)) return undefined;
  return `--create --namespace needs aw >= ${AW_BYOT_CREATE} (this host has ${version || 'an unreadable aw'}): upgrade with npm install -g @awebai/aw@${AW_TESTED}; nothing was created`;
}
