## Added

- **Credential groups: one person's credential, readable by one container
  group.** `oats-login-receive --credential <entry-id>` installs a credential
  sent from the person's own machine with a dedicated key, which decides the
  destination: the entry's `group`, `path` and `access: "read-only"` in the
  new optional `credentials` object of `/etc/oats-login/receiver.json`. The
  file is root:group 0440 in a root:group 0750 `credentials` directory, and
  the value is opaque, at most 65,536 bytes. An entry whose path or
  directory another entry or a `teams` destination also names is refused. Without `--credential` the
  receiver is unchanged, except that it refuses a destination a personal
  credential owns; a host that wants the mode reinstalls it
  ([servers.md](../servers.md#personal-credentials)). The team image ships
  `compose.agent.credentials.yaml`, which binds `TEAM_CREDENTIALS_DIR`
  read-only at `/etc/agent-credentials`. Acceptance admits that mount only
  when `TEAM_CREDENTIALS_DIR` is set and checks its ownership and modes. It
  now also reports `credentials: absent without the optional fragment` for
  every other container. Team-image CI proves four container groups isolate
  each other's credentials, state, network and writable mounts, and that
  four mutant legs fail it ([container.md](../container.md#credential-groups)).
  Root and the docker group can still read every group: the operator is
  trusted at rest.
