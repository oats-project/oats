## Added

- **Sandbox allowances for session providers.** A session provider that runs
  its harness in a sandbox is handed, with every launch, what the instance
  needs from outside it: `sandbox: {domains, write, missing}` in the launch
  input. The kernel builds the list from the deployment's configuration and
  nothing else adds to it.
  - A capability that fills an instance's messaging, knowledge or tasks slot
    may declare `sandboxDomains` in its manifest: `{"setting": "<key>"}`
    (the setting's value is a URL, a bare host, or a map from team id to
    one, of which the instance's own teams' entries are taken; `"optional":
    true` where the session works without the host) or `{"settingFile":
    "<key>", "urls": "<JSON pointer>"}` (the hosts in a JSON file of the
    deployment). On any other capability a provider launch is refused,
    `E_BACKEND_SANDBOX_HOST`; so is a value that gives no plain host, and a
    file that is not the deployment's own.
  - `write` is the deployment's events directory, which the kernel creates
    before the launch.
  - Values come from the deployment's configuration as a spawn preview
    resolves it, never from an instance home. A start and a restart resolve
    it again, for the deployment and the soul the home's path names (its
    `instance.json` decides neither); when that cannot be done the launch input says `sandbox:
    {unavailable}`, and the provider refuses a launch it would sandbox.
  - A provider's `check` is handed the planned launch (`launch: {harness,
    yolo, args, sandbox}`) before every launch.
  - `oats spawn --preview`, a start's answer and `oats readiness --home`
    list each host with who asked for it and each path with its reason;
    `oats capabilities show` lists `sandboxDomains` and its problems.
  - tmux launches are unchanged: no `sandbox`, and `sandboxDomains` is not
    read. A kernel from before session providers ignores the key.
