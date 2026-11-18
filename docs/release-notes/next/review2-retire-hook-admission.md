## Changed

- Retiring homes spawned by a kernel from before `capabilityRuntime`, and
  captured homes from before 0.26, now refuses with
  `E_UNIDENTIFIED_INSTANCE_HOME` if their hooks cannot run and the record
  does not prove no cleanup is owed. Both `--plan` (including Desktop Remove)
  and apply refuse before anything is stopped, run or removed, children included.
  Inspect the home, clean up external identities/memberships using the provider's
  tooling, then run `oats retire <instance> --force`. Force keeps the warnings
  that hooks did not run and state was not revoked; it can leave external state
  active after deleting the local credential. Captured homes need positive
  evidence that no capability's spawn hook ran to retire without force.
  Forced self-retirement keeps the force choice in its deferred completion.

- Retire plans for a home that cannot be entered (mode 000), or an
  interrupted spawn's stub without recorded hook bindings, now refuse with
  the same cleanup admission as apply. This is the before-effects plan/apply
  rule; a refusal returns no plan claiming that work is absent. The stub's
  refusal now names missing `capabilityRuntime` and retains the `--force`
  remedy. Homes lacking workspace modules alone are not newly refused:
  the cleanup rule depends on their recorded hook bindings.
