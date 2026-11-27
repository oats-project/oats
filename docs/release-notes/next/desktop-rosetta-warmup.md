## Fixed

- Desktop installer verification warms Rosetta in a separate phase before the
  packaged node-pty ABI probe on the macOS x64 cross-build. First-start
  translation has its own 240-second budget and elapsed-time log; the ABI
  probe keeps its 90-second budget.
