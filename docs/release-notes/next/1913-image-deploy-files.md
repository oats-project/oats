## Added

- Agent and egress images carry root-owned deployment fragments and standalone
  probe import closures under `/opt/oats/deploy`, with a schema-1 `manifest.json`
  binding every file's SHA256, source commit and installed CLI versions to the
  image digest. Egress includes the documented `compose.minimal.yaml` input and
  its network preflight. See the [run contract](../container.md#run-contract)
  for extraction, verification and runtime inputs. Committed image pins are
  OATS 0.70.7, aw 1.36.59 and Claude Code 2.1.322; publication stays disabled.

## Upgrade

### What a deployment must change

- Compose boundary plan writers must add integer `"schema": 1`. Missing schema
  now refuses with `E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found none; regenerate the plan with schema: 1 or schema: 2`.
  Unknown numeric schemas substitute their value for `none`; other types report
  `invalid <type>`. No missing-schema fallback exists. This refusal occurs before
  engine access, exits 1 and is printed on stderr (including with `--json`).
- Image builds must pass `--build-arg TEAM_IMAGE_SOURCE_SHA=<full commit SHA>`;
  missing or malformed source pins fail. Build egress from `container/agent`
  with `-f container/agent/egress/Dockerfile`, using its Dockerfile-specific
  allowlist. Extract each image into its own directory and preserve the tree
  hierarchy; egress scripts and fragments live below `egress/`.
- Optional acceptance inputs set to `""` mean unset; include optional mount
  fragments only for non-empty sources. Every deployment creating its own
  agents/services networks must run the extracted `egress/preflight-network.mjs`
  immediately beforehand with all six network inputs and require exit 0 before
  sourcing its output or creating networks; remote contexts refuse.
- Consumers must refuse agent/egress pairs with different manifest source
  commits or different shared-file hashes. Acceptance now checks resolver
  readability and non-empty content as the runtime UID; failure is
  `E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID`.
