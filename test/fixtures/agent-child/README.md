# Fixture: a derived team image with one declared child

Team-image CI builds this on the base image it has just accepted, to prove the
supervisor's optional child ([docs/container.md](../../../docs/container.md#an-optional-child))
without any real product in it. It is test data: never a base for a deployment,
and never part of `container/agent`'s build context.

- `child.mjs`: a dependency-free Node HTTP server on `127.0.0.1:39111`. It
  answers `{"ok":true}`, and `--version` prints its version.
- `agent-child.json`: its declaration, installed as `/etc/agent-child.json`.
- `version`: what `child.mjs --version` must print; acceptance compares them.
- `compose.agent.child.yaml`: the switch, `AGENT_CHILD: "fixture"`.
