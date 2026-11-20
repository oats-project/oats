## Changed

- **A team container's bb server refuses a damaged token file.** With the bb
  fragment, a `claude-token` file whose token has a space or a line break
  inside it now fails the container start, before any child, with one line
  naming the file's rule. Before, bb started and reported ready while every
  model call failed. The docs also say to spawn bb agents with `--yolo` in a
  team container, where bb's sandboxed modes cannot start. See
  [A bb server for the team](../container.md#a-bb-server-for-the-team).
