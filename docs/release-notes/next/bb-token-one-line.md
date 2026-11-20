## Changed

- **A team container's bb server refuses a damaged token file.** With the bb
  image's child switched on, a `claude-token` file whose token has whitespace inside it (a
  space, a tab, a line break) now fails the container start, before any child, with one line
  naming the file's rule. Before, bb started and reported ready while every
  model call failed. The bb image's docs also say to spawn bb agents with `--yolo` in a
  team container, where bb's sandboxed modes cannot start. See
  [An optional child](../container.md#envfromfile).
