## Added

- **A team container can run a bb server.** Opt-in: build the derived image
  `container/agent-bb` on a team image, select it with `AGENT_IMAGE` and
  include `container/agent/compose.agent.bb.yaml`. The supervisor then starts
  one [bb](https://github.com/get-bb/bb) server on the container's loopback,
  after the wake broker and before sshd and `oats host run`, restarts it if
  it ends, and stops it after host run has stopped the agents. The service
  still publishes no port; the operator reaches bb over the SSH route with
  `container/agent-bb/relay.mjs`. A container that does not opt in runs as
  before, and the team image holds no bb. The server is unused until agents
  are spawned with the bb session provider, which arrives with a later
  kernel. This is experimental: the bb image, `compose.agent.bb.yaml` and
  the relay will move to the bb package repository once it exists, with no
  compatibility promise on those paths, on `AGENT_BB` or on the image's
  recipe, so that move will not be a breaking change. See
  [A bb server for the team](../container.md#a-bb-server-for-the-team).
