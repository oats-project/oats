## Fixed

- Conversation capture stops before sealed aw client-log entries, preserves
  the cursor, and reports them as sealed instead of failed projections.
  Command capture sets the input aside as “sealed, not readable by this recorder”.

## Removed

- Removed the recorder's unused signature-verification helpers
  `base58Decode`, `publicKeyFromDidKey`, `base64DecodeLoose`,
  `verifyDidKeySignature` and `verifyTurnSig` from the public `@awebai/turn-record/canonical` export.
  External importers must remove those imports or use a signature-verification
  library. No in-repository production callers used them. Source signatures are still preserved.
