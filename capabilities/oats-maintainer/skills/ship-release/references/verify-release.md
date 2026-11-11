# Verify a release: the checklist

Check each item that applies and record what you observed. Mark an item "not applicable"
or "not checked, because ..."; never leave it silently out.

## The run
- [ ] The release run for this tag finished, every job, not only the first green one.
- [ ] The tag points at the planned SHA (an annotated tag peels to it), and that SHA is on
      the default branch.

## Each published artifact (a registry package, a binary, an image)
- [ ] The version exists where it was meant to be published.
- [ ] Its recorded source is the tagged commit (a registry's source commit field, an image
      label, a build-provenance record).
- [ ] Its integrity value (digest or checksum) matches what the publish step logged.
- [ ] Its contents equal the tagged tree, apart from generated fields (version numbers,
      build metadata). Unpack and compare; don't infer it from the file list.

## Release assets (downloads attached to a release page)
- [ ] Each asset matches its entry in the published checksums file.
- [ ] The checksums file covers every asset, and nothing else is attached.

## Channels
- [ ] The channel tags (`latest`, `next`, a stable channel) point where the plan says, and
      no other channel moved by accident.

## The notes
- [ ] The release page and the repository's notes say the same thing, and cover every
      change in the plan.

## A real install
- [ ] A clean install of the published version, from the public channel, runs and reports
      the new version.

## Record
The version, the tag and its SHA, each artifact's identity and integrity, what was not
checked and why, and when you checked. Run your project's verification script if it has
one, and still record the items above. A checklist stable over two releases is a candidate
for a script in your project.
