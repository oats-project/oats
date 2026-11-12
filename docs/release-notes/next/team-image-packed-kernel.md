## Added

- Manual verification of an image built with its selected commit's own packed
  kernel, with exact installed-file paths, sizes, modes and hashes checked
  against HEAD. A separate proof compares the default installed payload with
  and without the read-only build-context mount. Packed mode remains manual
  until the compatible image baseline lands; publication stays disabled.
  With the committed baseline, the packed job refuses; positive real
  packed-image acceptance is **NOT RUN** until that compatible baseline lands.
