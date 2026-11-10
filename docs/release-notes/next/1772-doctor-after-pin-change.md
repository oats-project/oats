## Changed

- **After a pin is removed or renamed, run `oats doctor`.** `/oats-package-pins` ("Change a pin") and [packages](../packages.md) now say: after removing or renaming a pin, or any soul it provided, run `oats doctor` on each deployment and fix what it reports, and check `souls.disabled` by hand. A `souls.disabled` entry that names a soul that no longer exists fails open: it disables nothing, so the soul it was meant to keep off spawns again under its new name.
