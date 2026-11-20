## Added

- **A team container can run a bb server.** Opt-in: build the bb image of
  [oats-project/oats-bb](https://github.com/oats-project/oats-bb) on a team
  image, select it with `AGENT_IMAGE` and include that repository's Compose
  fragment. The supervisor then starts
  one [bb](https://github.com/get-bb/bb) server on the container's loopback,
  after the wake broker and before sshd and `oats host run`, restarts it if
  it ends, and stops it after host run has stopped the agents. The service
  still publishes no port; the operator reaches bb over the SSH route with
  that repository's relay. A container that does not opt in runs as
  before, and the team image holds no bb. The server is unused until agents
  are spawned with the bb session provider, which arrives with a later
  kernel. The bb image, its fragment and the relay are in the bb package
  repository, not in this one: the team image runs bb as the optional child
  that image declares. See
  [An optional child](../container.md#an-optional-child).
