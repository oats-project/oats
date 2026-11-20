---
name: aweb-team-membership
description: This skill should be used when reasoning about which aweb/OATS teams an agent belongs to, checking team certificates and active-team diagnostics, or using the OATS provider's team operations (`oats aweb teams|join|leave`). Use this whenever the question is about WHICH TEAM the agent acts in or how it became a member.
allowed-tools: "Bash(aw workspace status), Bash(aw team list), Bash(aw id cert show), Bash(oats aweb *)"
---

# aweb Team Membership for OATS agents

Use this skill when the question is about teams: current membership, eligible
workspace teams, joined wider teams, team certificates, or why a message/command
is landing in the wrong team. For the day-to-day OATS playbook (roster,
sending as a team, wakes, troubleshooting codes) load `oats-aweb`. For identity
keys, `did:key`/`did:aw`, custody, addressability, inbound mode, contacts, or
key rotation, load `aweb-identity`. For mail/chat policy, load `aweb-messaging`.

## OATS owns agent team changes

For an OATS-managed instance, do **not** manually run native `aw team` mutation
commands to join, switch, invite, or leave teams. The `oats.aweb` provider owns
those lifecycle effects so it can keep per-team identity homes, provider state,
retire cleanup, readiness, and Desktop operations consistent.

Use the provider commands from the instance home (or with `--home <path>`):

```bash
oats aweb teams --json                  # defaultTeam, eligible, joined, unmapped
oats aweb join --labels <label>[,<label>]   # join eligible workspace labels
oats aweb leave --labels <label>[,<label>]  # leave joined wider-team labels
```

- The workspace's default team cannot be left; attempting it with label `default` is `E_TEAM_DEFAULT`.
- A label that is not eligible for this soul/workspace is `E_TEAM_NOT_ELIGIBLE`.
- Joined wider teams use a local identity home such as
  `<home>/.aweb-identity-<label>`. The host aw CLI must be >= 1.36.32. The
  provider creates joined homes with `aw id team accept-invite` under
  `--identity-home`, verifies the root auto-connected, and does not run
  `aw init` inside the per-team home.
- A join records its intent before the accept, so a join killed after aw
  accepted the invite is not lost. A start then warns `unfinished join of
  team <label>`. Run `oats aweb join --labels <label>` to finish it (no second
  invite), or `oats aweb leave --labels <label>` to release it. Retire
  releases it too. Never delete the `.aweb-identity-<label>` home by hand: it
  holds the member key the release needs. If they refuse with `hosted accept
  interrupted`, aw's accept was cut short and the server may hold the
  membership: report it. A person reruns the same `aw id team accept-invite`
  with the original invite, or the team's controller removes the member and
  the `pending-hosted-accept` marker is deleted; then `oats aweb leave`.
- Since oats.aweb 1.15 a joined team receives **live** (`receive: native`) when
  the host wake broker holds its identity: always on session-delivery homes,
  and on Claude/Pi channel homes through aw's mixed mode (the channel keeps the
  primary identity, the broker adds the joined ones). The broker may present a
  waiting-items line or the full mail/chat event; handle what appears. Codex
  homes, a stopped wake daemon or a refused registration leave it `receive: poll`.
- Send as a joined team with exactly:

```bash
aw --identity-home <identityHome> mail|chat ...
```

`oats aweb teams --json` prints each joined entry's `identityHome` and
`receive` mode.

## Readiness checks

Start with read-only diagnostics:

```bash
aw workspace status
oats aweb teams --json
aw team list
aw id cert show
```

Interpret common states:

- `teams.defaultTeam.team` is the primary identity's team, wired to the harness:
  the aweb root's active team (`defaultTeam.source: root`) or a deployment-pinned
  team (`setting`).
- `eligible[]` are labels this soul/workspace may explicitly join; the primary
  label may appear here and is joinable/leavable like any other wider team.
- `joined[]` are provider-created wider-team memberships; each has an
  `identityHome`, `since`, and `receive` (`native` or `poll`).
- `unmapped[]` labels are present on the soul but not mapped by the workspace.
  An unmapped primary falls back to the default/root active team with a
  `team-unmapped` warning; it is not a spawn blocker.
- `teams-unverified` on launch means the kernel supplied recorded/unknown team
  data, so the provider kept memberships instead of leaving anything.

## Team vocabulary

- **Team id**: canonical form `<name>:<namespace>` (for example
  `default:oats.aweb.ai`).
- **Team certificate**: a signed membership statement for an identity; stored in
  `.aw/team-certs/` for native identities.
- **Default team**: the workspace default team for the instance's primary identity:
  the aweb root's active team, or `settings.oats.aweb.team` when the deployment
  pins one.
- **Joined team**: an explicit wider team joined through `oats aweb join`, with a
  separate local identity home.

## Hosted vs BYOT authority (diagnostic context)

Hosted teams are signed by aweb-held team authority; BYOT teams are signed by a
customer-held controller. This matters when diagnosing why a human or provider
cannot mint a certificate, but ordinary OATS agents should still use
`oats aweb join|leave` rather than native membership mutation commands. If a
join reports authorization failure, ask the team's owner/admin for the needed
invite or mapping; do not invent a native workaround.

## Wrong team symptoms

If commands appear to use the wrong team:

1. Run `oats aweb teams --json` and confirm which identity home should send.
2. For the primary identity, run `aw workspace status` and `aw team list`.
3. For a joined team, run `aw --identity-home <identityHome> mail inbox` or
   `aw --identity-home <identityHome> chat pending` and send with the same
   `--identity-home`.
4. If the provider state and native files disagree, report the exact output to a
   coordinator; do not hand-edit `.aw` or `.oats-aweb/teams.json`.

## References

Read only when deeper context is needed:

- <https://aweb.ai/docs/teams/>: team model.
- <https://aweb.ai/docs/agent-guide/>: agent messaging guide.
