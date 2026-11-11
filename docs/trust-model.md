# Trust model

Everything that runs as one operating-system user is one trust group, the
kernel included. OATS draws no line inside a user, and must never run with
more authority than the agents whose homes it reads.

## The parties

- The **operator**: the person, or the control plane acting for them, who
  decides which agents exist and with what configuration.
- The **kernel**: `oats` commands and `oats host run`. It has no authority of
  its own. It runs as whoever started it.
- An **agent**: a harness process and everything it starts. It can write its
  own home, and anything else its user can write.
- A **capability**: code copied into an agent's home at spawn, which the
  kernel runs as hooks and commands.

## The line

The line is the user boundary and, for a hosted team, the container around
it ([container.md](container.md)). Inside it nothing protects one agent from
another, or the kernel's own state from an agent: an agent can read and write
what the kernel reads and writes.

1. **A trust group is the unit of compromise.** If one agent in it is
   subverted, treat every agent, seat and credential in it as subverted.
2. **One team, one trust group.** Agents that must not be able to read each
   other's identities or affect each other's work do not share a container or
   a user. Nothing in OATS makes that safe. A container holds one team, never
   several.
3. **The kernel takes no authority across the line.** It is never run as
   root, as a different user, or on another machine against a home that an
   agent on the far side of the line could write. A command given
   `--server` runs `oats` on the home's side
   ([servers.md](servers.md)); the Desktop and the TUI start the local `oats`
   and run no kernel code of their own on what a remote home contains.
   One piece of the package does run as root, and it is outside this rule:
   the harness-credential receiver `share/oats-login-receive`
   ([servers.md](servers.md#harness-credentials)). It runs under a forced
   command, reads only its standard input, writes only the credential file
   its root-owned configuration names and touches no home, so it is not the
   kernel acting on a home.
4. **An agent's home is untrusted as data, and trusted as code only inside
   its own group.** The kernel executes what it finds there, such as
   lifecycle hooks and a module's commands, because doing so gives the agent
   nothing it does not already have. What it finds there decides nothing
   about another group.
5. **Inside a group OATS protects the agents' work, not the group's
   secrets.** Locks, claims, recovery copies and the Git hardening at
   retirement exist so that a kill, a race or a hostile repository
   configuration does not lose or corrupt work. They are robustness, not
   access control.

## What OATS does not promise

Inside one trust group, none of these hold:

- That an agent cannot read another agent's seat key, the team's Claude
  token, the launch configurations, the schedule registry or sshd's host
  keys.
- That an agent cannot stop sshd or `oats host run`.
- That a capability is confined to the outputs it declares.
- That a command which reads is one which runs nothing.
  `oats readiness --home <home>` executes the home's module commands, and
  today it gives them the environment of whoever runs the read, without that
  caller's `OATS_`, `OAS_` and `PI_` identity variables. Run it for a home of
  another trust group only from an environment that holds nothing the home's
  agent should not have.
- That a capability the kernel reports as trusted has been judged.
  [Trust is the workspace's declaration](capabilities.md#mental-model) of a
  member repo or a package. The kernel then checks that what it is about to
  run is the copy made at spawn. That copy is in the agent's home, so the
  check is no defence against the agent.
- That a harness's sandbox is a boundary. OATS counts none as one and relies
  on none. Where a harness restricts what its agent can write, that is the
  harness's property and not a promise of OATS.

## Keys outside the group

One part of the line is enforced by something other than OATS: where a
team's keys are kept. A hosted aweb team's controller key is kept by the
service, outside every agent group, and no agent can read it. That holds
today.

The aweb human-assurance design goes further. In it, the keys of a human, of
a namespace and of a team's controller will be held by a protected signer
outside every agent group. The deployment root's agent key will stay inside
the group by design, and what it can do will be bounded by its admission
policy, so that its loss is the loss of that group and of nothing above it.
The signer is not shipped.

No deployment that brings its own team has this yet. Each still holds its
team keys under the agents' user, in `~/.awid/team-keys` and `.aweb-roots`.
Under rule 1 those keys are compromised along with any agent in that group,
until they are moved to the signer.
