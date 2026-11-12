# Hosts opt in to workspace automations (`automations.trust`)

Status: **DECIDED 2026-09-28 by Juan** (the automation trust decision, recommended by the leads on
2026-09-27). Target: OATS 0.30.

## Context
A workspace trigger or schedule runs on the host whose `host.name` is its `runsOn` and whose `gh`
account is its `owner` (docs/schedules.md "Who runs it"). Both facts can come from a commit. So
anyone who can commit to a member repo can make a machine that matches those names run an
automation. Its operator never said yes to that automation, only to a host name and a login.

## Decision
**A host runs a workspace automation only when its operator has trusted it**, in the local file:
```yaml
# oats-local.yaml (never in oats-workspace.yaml or a member file: the committed schemas refuse it)
automations:
  trust:
    - oats-knowledge/okf-review        # <member>/<id>, as the automations list names it
    # or: trust: "*"                   # every automation the workspace places on this host
```
- **Runs only if** `runsOn` matches, `owner` matches, **and** `trust` admits it. `triggers.disabled` /
  `schedules.disabled` still opt out on top.
- **Absent or empty `trust`:** nothing runs.
- **Matching but untrusted:** it never runs. It's listed with reason `untrusted` (after
  `assigned-elsewhere`, `owner-mismatch` and `host-unnamed`). A readiness/status item says
  "declared for this host, not trusted here", and its remedy names the exact `oats-local.yaml`
  line to add. The automations status row carries the reason, so the Desktop can show it.
- **A trust entry that matches nothing** is a warning, not an error: a member may not have
  synced yet.
- **Personal automations** (`oats trigger add` / `schedule add` in `oats-local.yaml`) are already
  the operator's own choice and need no trust entry.

## Behaviour change
Hosts that ran workspace automations before 0.30 must add their `trust` lines. The 0.30 release
notes say so. No host of ours runs one today, so there's nothing to migrate.

## Unblocks
The okf review trigger on an operator's host: it runs once that host trusts it.
