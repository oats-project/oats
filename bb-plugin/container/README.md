# The plugin's test container

bb, its npm packages and this plugin's dependencies are installed and run only in a container:
never `npm install` on the host. One command does everything:

```sh
container/ci.sh            # image, installs, typecheck, unit tests, build, live tests
container/ci.sh unit       # typecheck, unit tests and the build
container/ci.sh live       # the live tests
```

The container gets `--cpus 2 --memory 6g`, no mount, no port, no Docker socket and nothing of the
host's home; the checkout goes in through `tar` and the artefacts come out to `container/out/`
(ignored by git). bb runs sovereign: no account, `BB_TELEMETRY=false`, bound to loopback.

| File | Runs | Does |
|---|---|---|
| `Dockerfile` | `docker build` | node 22, chromium (the live tests' browser) and procps; no bb and no npm package |
| `ci.sh` | on the host | builds the image, starts the container, copies the checkout in, runs the scripts below, copies `out/` back, removes the container |
| `setup.sh` | in the container | `npm install -g bb-app@<the version package.json pins>`, `npm ci` |
| `unit.sh` | in the container | `tsc --noEmit`, `vitest run`, `bb plugin build` |
| `live.sh` | in the container | starts bb-app, makes a deployment and a bb project in it, installs the fake `oats` and the plugin, and checks L1, L2, L3, A14 (backend), A15 and A15b (below); runs `live-ui.mjs` when the app is in the tree |
| `fake-oats.mjs` | as `oats` | prints the recorded answer of the verb it is asked (`test/fixtures/`) and logs each call; a JSON file beside it sets a verb's output, exit code, delay, or makes it start a child of its own |
| `workflow.yml` | - | the CI job, to move to `.github/workflows/` in the bb package repository |

The live checks of the backend:

- **L1** the installed plugin reads the deployment through the host entry (`bb plugin rpc call oats snapshot`).
- **L2** with the poll off (no RPC for 50 s), one line appended to `<deployment>/.agents/events/` makes the server run `oats status`: the host watch, the `changed` signal, the reread. The proof is the fake's call log.
- **L3** an `oats status` slower than the kernel's 20 s limit is the typed `OATS_TIMEOUT` in the snapshot, after one process and about 20 s: bb's retry of a retryable host call does not cut it short.
- **A14** (the backend's part) with `oats` removed, the snapshot says what is missing and bb's own lists answer; with `oats` back, the snapshot is back.
- **A15** `bb plugin reload oats` while a fake `oats` sleeps and holds a child of its own: neither process is left.
- **A15b** the same when bb itself is stopped.

To work in a container for a while:

```sh
KEEP=1 NAME=bb-plugin-dev container/ci.sh unit
# after an edit: copy the tree in again, then run what you need
tar -c --exclude ./node_modules --exclude ./dist --exclude ./container/out . | docker exec -i -u node bb-plugin-dev tar -x -C /home/node/plugin
docker exec -u node -w /home/node/plugin bb-plugin-dev npx vitest run test/kernel
docker exec -u node -w /home/node/plugin bb-plugin-dev bash container/live.sh
docker rm -f bb-plugin-dev
```

Where the host's Docker DNS forwarder is unreliable, pass a resolver:
`DOCKER_RUN_ARGS="--dns 1.1.1.1" container/ci.sh`.
