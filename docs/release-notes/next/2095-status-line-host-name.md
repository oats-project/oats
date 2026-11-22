## Fixed

- **The Desktop's status line shows this computer's name by the same rule
  as the sidebar.** A host name with a line break now shows on one line,
  an unprintable character as �, and a name with a terminal control
  character or a secret-like value shows nothing, as the sidebar already
  did for another machine's name
  ([#2095](https://github.com/oats-project/oats/issues/2095)).
