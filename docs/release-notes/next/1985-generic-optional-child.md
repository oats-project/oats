## Changed

- **The team image's supervisor runs one generic optional child, and knows
  no product.** A derived image declares the child in
  `/etc/agent-child.json` (its command, literal and file-read environment,
  readiness URL, loopback ports, version check and stop budget, in a closed
  grammar), and the deployment switches it on from outside the image with
  one fixed Compose entry, `AGENT_CHILD: "<name>"`. Without the switch the
  supervisor reads no file and runs as on the base image. With it, the
  supervisor refuses the start, before any child, on a missing or malformed
  declaration, a declaration that is not root's own regular file, a name
  that differs from the switch, or a command that resolves under a writable
  mount. The child's order, start timeout, restart backoff and process
  group are fixed in the base image; its stop budget is capped at eight
  seconds, so the ordered stop fits the 50-second grace whatever an image
  declares. A file-read variable must hold its value on one line: a file
  with whitespace inside its value refuses the start, and the value reaches
  only the child. Acceptance with `AGENT_CHILD=<name>` exported reads the
  declaration from the running container and checks the file, the declared
  listeners, that nothing but sshd listens beyond loopback, and the declared
  version. Every agent in the container can reach the child's loopback
  ports. See [An optional child](../container.md#an-optional-child).

## Removed

- **`AGENT_BB`, `container/agent-bb`, `container/agent/compose.agent.bb.yaml`
  and the bb relay have left this repository.** The bb image, its Compose
  fragment, the relay and their operator docs now live in
  [oats-project/oats-bb](https://github.com/oats-project/oats-bb), where the
  image declares bb as its optional child and its fragment sets
  `AGENT_CHILD`. A container that still sets `AGENT_BB`, to any value, is
  refused at start with a line that names `AGENT_CHILD`, and acceptance
  refuses it too. They were experimental and never part of a release, so
  there is no alias.
