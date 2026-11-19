## Added

- Team-agent containers can mount one operator-provisioned input directory
  read-only at `/inputs`, using `TEAM_INPUT_DIR` and the optional
  `compose.agent.inputs.yaml` fragment. Acceptance checks the running mount,
  readability and write refusal; CI also checks the base has no input folder
  and missing sources fail without host-path creation. An optional
  `compose.agent.outbox.yaml` fragment adds a writable export queue with a
  dedicated supplementary group and setgid ownership. Acceptance checks group
  inheritance and private state. Every agent can read the inputs and read/write
  the queue; the publisher, its ledger and credentials stay outside OATS. See [agent team container](../container.md).
