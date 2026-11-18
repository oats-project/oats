## Fixed

- Desktop's Remove refusal now explains when OATS cannot tell what a home's
  capabilities created or cannot run their cleanup. The headline points to
  Details and gives manual cleanup and terminal removal with
  `oats retire <instance> --force`, using the selected instance name and
  adding `--server <server-id>` for a routed home. Stop keeps its existing
  refusal text. Details keeps the kernel's cause and
  remedy, including unreadable records that force cannot bypass.
