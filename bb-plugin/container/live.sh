#!/bin/bash
# Runs inside the container, as node: bb-app at the pinned version, the plugin installed from the
# checkout, a fake `oats` that prints the fixtures (container/fake-oats.mjs). The backend's live
# checks; the app's (A13, A14: screenshots at two widths) are container/live-ui.mjs, run from here
# when it is there.
#   L1  the installed plugin reads the deployment through the host entry
#   L2  a line appended to the deployment's event log, with the poll off, makes the server reread (watch -> signal -> reread)
#   L3  a status slower than the kernel's limit is the typed OATS_TIMEOUT, not a lost host call
#   A14 (backend) with the fake oats removed, the snapshot says what is missing and bb answers as usual
#   A15 `bb plugin reload oats` during a slow oats leaves no oats process
#   A15b stopping bb during a slow oats leaves none either
set -euo pipefail
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=/home/node
LIVE=$HOME_DIR/live
DEPLOYMENT=$HOME_DIR/deployment
OATS=$HOME_DIR/.local/bin/oats
FAKE_CONFIG=$HOME_DIR/.local/bin/fake-oats.json
FAKE_LOG=$HOME_DIR/fake-oats.log
OUT=${OUT:-$HOME_DIR/out}
mkdir -p "$OUT"
failures=0

say() { printf '%s\n' "$*"; }
pass() { say "PASS $1"; }
fail() { say "FAIL $1"; failures=$((failures + 1)); }
fake() { printf '{"fixtures":"%s/test/fixtures","log":"%s","verbs":%s}' "$PLUGIN" "$FAKE_LOG" "${1:-{\}}" > "$FAKE_CONFIG"; }
rpc() { # rpc <method> [json input] -> the result's JSON on stdout
  local input=$OUT/input.json
  printf '%s' "${2:-null}" > "$input"
  bb plugin rpc call oats "$1" --input-file "$input" --json
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
# The fake oats processes that are running now (their own pids and the children they started).
oats_processes() { ps -eo pid=,args= | grep -E "$OATS|sleep 600" | grep -v grep || true; }
wait_until() { # wait_until <seconds> <command...>
  local deadline=$((SECONDS + $1)); shift
  until "$@"; do [ $SECONDS -lt $deadline ] || return 1; sleep 0.25; done
}
start_bb() {
  # The way a service with a bare PATH would start it: no user PATH, no account, loopback only.
  env -i HOME=$HOME_DIR USER=node BB_TELEMETRY=false PATH=/usr/local/bin:/usr/bin:/bin \
    setsid "$HOME_DIR/.npm-global/bin/bb-app" --data-dir "$HOME_DIR/bbdata" --server-bind-host 127.0.0.1 --no-in-app-updates \
    > "$OUT/bb.out" 2>&1 < /dev/null &
  echo $! > "$OUT/bb.pid"
  wait_until 90 bb machine list --json > /dev/null 2>&1 || { say "bb did not start"; tail -20 "$OUT/bb.out"; exit 1; }
  wait_until 60 sh -c 'bb machine list 2>/dev/null | grep -q connected' || { say "no machine connected"; exit 1; }
}

say "== bb $(bb --version), plugin from $PLUGIN"
bb machine list > /dev/null 2>&1 || start_bb

# A deployment (a directory with oats-local.yaml) and one bb project inside it.
mkdir -p "$DEPLOYMENT/agents/oats-maintainer/instances/release-070-maintainer" "$DEPLOYMENT/.agents/events" "$(dirname "$OATS")"
[ -f "$DEPLOYMENT/oats-local.yaml" ] || echo "# the live tests' deployment" > "$DEPLOYMENT/oats-local.yaml"
bb project list --json | grep -q "$DEPLOYMENT/agents" || bb project create --name release --root "$DEPLOYMENT/agents/oats-maintainer/instances/release-070-maintainer" --json > /dev/null
install -m 0755 "$PLUGIN/container/fake-oats.mjs" "$OATS"
: > "$FAKE_LOG"
fake

# The plugin, installed from a copy of the checkout (bb builds it in place).
rm -rf "$LIVE"
mkdir -p "$LIVE"
(cd "$PLUGIN" && tar -c --exclude ./dist --exclude ./.git .) | tar -x -C "$LIVE"
if [ ! -f "$LIVE/app.tsx" ]; then
  say "note: app.tsx is not in this tree; installing the backend alone (bb.app removed from the copy's manifest)"
  node -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f));delete p.bb.app;fs.writeFileSync(f,JSON.stringify(p,null,2))' "$LIVE/package.json"
fi
(cd "$LIVE" && bb plugin install . --yes) > "$OUT/install.txt" 2>&1 || { cat "$OUT/install.txt"; exit 1; }
bb plugin list | grep -q '^oats@.* running' && pass "the plugin is installed and running" || { fail "the plugin is not running"; bb plugin list; }

# ---- L1
snapshot=$(rpc snapshot)
if [ "$(field ok <<<"$snapshot")" = true ] && [ "$(field agents.length <<<"$snapshot")" = 8 ] && [ "$(field deployment.root <<<"$snapshot")" = "$DEPLOYMENT" ]; then
  pass "L1 snapshot: 8 agents of $DEPLOYMENT, read through the host entry"
else
  fail "L1 snapshot"; say "$snapshot" | head -c 600
fi
grep -q '"cwd":"'"$DEPLOYMENT"'"' "$FAKE_LOG" && pass "L1 oats ran with the deployment as its cwd" || fail "L1 cwd"

# ---- L2: the watch alone. The server polls only while a client is connected, and counts one as
# connected for 45 s after a snapshot call: so no RPC for 50 s, then one line in the event log, and
# the proof is the fake's own log: a status call that nothing but the watch can have caused.
say "L2 waiting 50 s with no RPC, so that the 15 s poll is off"
sleep 50
: > "$FAKE_LOG"
sleep 16 # a poll tick, had the poll been on
if grep -q '"verb":"status"' "$FAKE_LOG"; then fail "L2 precondition: the poll still runs with no client"; fi
fake '{"status":{"stdout":"{\"root\":\"/abs/deployment\",\"agents\":[]}"}}'
echo '{"kind":"spawned"}' >> "$DEPLOYMENT/.agents/events/oats-maintainer--release-070-maintainer.jsonl"
if wait_until 8 grep -q '"verb":"status"' "$FAKE_LOG"; then
  pass "L2 a line in .agents/events made the server run oats status (no poll, no RPC)"
else
  fail "L2 the event log's change caused no reread"
fi
sleep 1
[ "$(field agents.length <<<"$(rpc snapshot)")" = 0 ] && pass "L2 the cached snapshot is the new roster" || fail "L2 the snapshot is not the new roster"
fake
sleep 5.5 # past the floor between two reads
rpc refresh > /dev/null

# ---- L3: a status slower than the kernel's 20 s limit. bb sends a retryable host call again at half
# its transport timeout: the limit must be reached before that, in one process.
fake '{"status":{"sleepMs":600000}}'
: > "$FAKE_LOG"
l3_start=$SECONDS
rpc refresh > /dev/null
l3_took=$((SECONDS - l3_start))
slow=$(rpc snapshot)
first_two=$(grep -c '"verb":"status"' "$FAKE_LOG" || true)
if [ "$(field code <<<"$slow")" = OATS_TIMEOUT ] && [ "$l3_took" -ge 19 ] && [ "$l3_took" -le 27 ]; then
  pass "L3 a status that never answers is OATS_TIMEOUT after ${l3_took} s ($first_two status process(es) logged by then)"
else
  fail "L3 slow status: code $(field code <<<"$slow") after ${l3_took} s"; say "$slow" | head -c 300
fi
fake
sleep 5.5
rpc refresh > /dev/null
none_yet() { [ -z "$(oats_processes)" ]; }
wait_until 10 none_yet || { fail "L3 a slow oats is still running"; oats_processes; }

# ---- A14, the backend's part: no oats.
mv "$OATS" "$OATS.away"
missing=$(rpc snapshot >/dev/null; rpc refresh >/dev/null; rpc snapshot)
if [ "$(field ok <<<"$missing")" = false ] && [ "$(field code <<<"$missing")" = OATS_NOT_FOUND ]; then
  pass "A14 with oats removed the snapshot says: $(field message <<<"$missing" | head -1)"
else
  fail "A14 snapshot with oats removed"; say "$missing" | head -c 400
fi
bb thread list --json > /dev/null && bb project list --json > /dev/null && pass "A14 bb answers as usual with oats removed" || fail "A14 bb's own lists"
mv "$OATS.away" "$OATS"
rpc refresh > /dev/null
[ "$(field ok <<<"$(rpc snapshot)")" = true ] && pass "A14 the snapshot is back once oats is back" || fail "A14 recovery"

# ---- A15: a reload in the middle of a slow oats.
[ -z "$(oats_processes)" ] || { fail "A15 precondition: oats processes before the test"; oats_processes; }
fake '{"status":{"sleepMs":600000,"grandchild":true}}'
: > "$FAKE_LOG"
(rpc refresh > "$OUT/a15-refresh.txt" 2>&1 || true) &
refresh=$!
wait_until 15 grep -q '"verb":"status"' "$FAKE_LOG" || fail "A15 the slow oats did not start"
oats_processes > "$OUT/a15-before.txt"
say "A15 running before the reload:"; sed 's/^/    /' "$OUT/a15-before.txt"
[ "$(wc -l < "$OUT/a15-before.txt")" -ge 2 ] || fail "A15 expected the slow oats and its child to be running"
# The snapshot service of the reloaded plugin starts a read of its own: let it answer at once.
fake
bb plugin reload oats > "$OUT/a15-reload.txt" 2>&1 || { fail "A15 bb plugin reload"; cat "$OUT/a15-reload.txt"; }
none_left() { [ -z "$(oats_processes)" ]; }
if wait_until 10 none_left; then pass "A15 no oats process is left after bb plugin reload oats"; else fail "A15 left running:"; oats_processes; fi
wait "$refresh" || true
bb plugin list | grep -q '^oats@.* running' && pass "A15 the plugin runs again after the reload" || fail "A15 plugin state after the reload"
[ "$(field ok <<<"$(rpc snapshot)")" = true ] && pass "A15 the snapshot answers after the reload" || fail "A15 snapshot after the reload"

# ---- the app's live checks, when the app is in the tree
if [ -f "$PLUGIN/container/live-ui.mjs" ] && [ -f "$LIVE/app.tsx" ]; then
  say "== container/live-ui.mjs"
  OUT=$OUT node "$PLUGIN/container/live-ui.mjs" || fail "live-ui.mjs"
fi

# ---- A15b: bb itself stops in the middle of a slow oats. Last: it ends the server.
if [ -f "$OUT/bb.pid" ]; then
  sleep 5.5
  fake '{"status":{"sleepMs":600000,"grandchild":true}}'
  : > "$FAKE_LOG"
  (rpc refresh > "$OUT/a15b-refresh.txt" 2>&1 || true) &
refresh=$!
  wait_until 15 grep -q '"verb":"status"' "$FAKE_LOG" || fail "A15b the slow oats did not start"
  oats_processes > "$OUT/a15b-before.txt"
  [ "$(wc -l < "$OUT/a15b-before.txt")" -ge 2 ] || fail "A15b expected the slow oats and its child to be running"
  kill -TERM "$(cat "$OUT/bb.pid")"
  if wait_until 20 none_left; then pass "A15b no oats process is left after bb stops"; else fail "A15b left running:"; oats_processes; fi
  wait "$refresh" || true
  rm -f "$OUT/bb.pid"
else
  say "note: A15b skipped: this run did not start bb itself, so it does not stop it"
fi

cp "$FAKE_LOG" "$OUT/fake-oats.log" 2>/dev/null || true
if [ "$failures" -eq 0 ]; then say "== live: all checks passed"; else say "== live: $failures check(s) failed"; exit 1; fi
