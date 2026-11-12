## Changed

- The team container starts a persistent wake broker before opening SSH or
  resuming agents. Its supervisor reports broker exits and stops host run
  before the broker, keeping delivery available while agents drain.
- Host-run shutdown gives active launches 10 seconds to finish, then fences
  new admissions and cancels owned work within a further 5-second phase
  before stopping agents. Interrupted launches retain their conservative
  unknown/reconcile accounting. The container still needs a 45-second stop
  window; the runtime's final kill is a failure boundary, not a clean stop.
