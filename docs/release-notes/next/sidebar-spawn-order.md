## Changed

- **The Desktop's sidebar lists instances newest first.** The instance tree
  is in spawn order, newest on top, instead of by name, at every level: a
  group of related instances by its first instance, the children under a
  parent the same way. Spawning a child doesn't move its group, and starting
  or stopping an instance still moves nothing. The TUI's list and the command
  palette's never-focused rows follow the same order.
