#!/bin/sh
# oats.core: Claude Code waiting emitter.
#   claude-waiting.sh set <permission|question|attention|failed-turn> <node> <cli> <marker> <home>
#   claude-waiting.sh set-late <permission> <node> <cli> <marker> <home>   (a Notification where PermissionRequest is written: a second chance, not a second set)
#   claude-waiting.sh clear <node> <cli> <marker> <home>        (a turn boundary: UserPromptSubmit, Stop, SessionEnd; not debounced)
#   claude-waiting.sh clear-tool <node> <cli> <marker> <home>   (a PreToolUse/PostToolUse clear: debounced; skipped for a subagent's tool call)
#   claude-waiting.sh turn <turn-start|turn-end|turn-end-idle> <node> <cli> <marker> <home>   (a turn boundary for the status row: see "The turn record" below)
# <marker> is the debounce marker's path, from the launch hook, or '' for none.
# <home> is the instance home these hooks were written for, as its real path, from the
# launch hook too: the script acts for that home and no other.
# Run by the Claude Code hooks oats-core.mjs writes into <home>/.claude/settings.json.
# It reports through `oats instance waiting set|clear --producer oats.core` that the
# session waits on the human, and never touches producer `agent` (the agent's own claim).
# A set carries the text of what the session waits on, as claude-waiting-message.mjs (beside
# this script) reads it from the hook's input: an AskUserQuestion's question, a PermissionRequest's
# tool, a Notification's own words, or the error of a turn that failed. `failed-turn` (StopFailure)
# is no reason of its own: it reads as question, and the reader can make it attention, for an error
# class known to open no dialog. No text (none in the input, or the reader failed) sets the claim
# without one.
#
# It can NEVER hurt the Claude session: Claude reads a hook's stdout and exit code as
# decisions, so this script writes nothing anywhere visible, always exits 0, never waits
# for another hook, and stays well under Claude's 5 s hook timeout: no CLI call starts once
# 2 s have passed since it began its work (an input read counts), and each call is killed
# at 2 s, so the worst case is about 4 s. The hook's JSON input stays on fd 3 for the bounded
# reads that need it (from_subagent for a tool clear, message_of for a set); nothing else reads
# stdin.
#
# The protocol (with a marker; without one every event just calls the CLI):
#   <marker>          the INTENT: the latest event's wish, "permission", "question",
#                     "attention", "failed-turn" or "clear", on its first line; a set's event id
#                     ("<pid>-<began>") on the second. Every hook writes it first, before it
#                     reads anything.
#   <marker>.text-<event>  the text of the set whose event id that is, written once the set has
#                     read it. Only the intent's own event's text is ever applied, so a set
#                     still reading its text when a later event comes can never apply it. A failed
#                     turn's reason is the second line, under the same rule.
#   <marker>.applied  what the CLI last RECORDED: the reason, and the text on a second line when
#                     it had one; also "unknown" while a call is under way
#                     or after one failed (it may have written the claim). Absent is clear
#                     (the launch hook removes it with the session's claims). Only the lock
#                     holder writes it.
#   <marker>.lock     a directory: one RECONCILER at a time, its pid file the holder's
#                     token "<pid> <began>".
#   <marker>.lock.reap  a directory: one REAPER of a stale lock at a time.
#   <marker>.force    present: the next reconciliation calls the CLI even where intent and
#                     applied agree. Every turn boundary (`clear`) writes it, and the call
#                     that applies the intent consumes it.
# A hook writes its intent, then takes the lock if it is free (never waiting) and
# reconciles: while intent and applied differ, it records applied as unknown, calls the CLI
# for the intent and, on success, records the intent as applied, re-reading the intent
# after each call. A hook that finds the lock held just exits: the holder re-reads the
# intent after each call, and once more after letting go of the lock, so a newer intent is
# applied by it, in event order. A failed call, the call cap or the time budget leaves the
# two apart, for the next event to finish. A lock whose holder is gone (pid dead, or taken
# over 5 s ago, past Claude's timeout) is broken by a reaper, which judges it again under
# the reap lock first. A holder acknowledges a call and releases the lock only while the
# lock still holds its token.
# The kernel write itself is not fenced (issue #568), so a holder suspended past 5 s, or a
# reaper killed at a precise instant, can leave the claim wrong while intent and applied
# agree. The forced call at every turn boundary bounds that: a wrongly shown claim lasts
# until the end of the turn, or, if the turn's last hook found a reconciliation out of
# time, until the next event; a hidden question lasts until the human answers it.
#
# The turn record. `turn` is no claim and touches none of the protocol above: it hands the
# boundary to claude-turn.mjs (beside this script), which replaces <home>/.oats/turn.json, what
# the kernel reads to show the instance as working or idle. UserPromptSubmit gives turn-start;
# Stop and StopFailure turn-end; the idle_prompt Notification turn-end-idle, whose input the
# writer checks, and nothing for a subagent's event (an input that carries agent_id). It runs
# behind the same home check as every other action, reads the input once (at most 64 KiB, for at
# most 1 s) and is killed at 2 s. An oats.core from
# before it has no such action here, and exits 0 on one.
exec >/dev/null 2>&1
# A closed stdin is never redirected from (a failed redirection ends sh itself); without
# /dev/fd the input reads as empty, which means the main thread.
if [ -e /dev/fd/0 ]; then exec 3<&0; else exec 3</dev/null; fi
exec </dev/null

action=$1
late=
case "$action" in
  set|set-late)
    [ "$action" = set ] || late=1
    action=set
    reason=$2; node=$3; cli=$4; marker=${5:-}; home=${6:-}
    case "$reason" in permission|question|attention|failed-turn) ;; *) exit 0 ;; esac
    ;;
  clear|clear-tool)
    node=$2; cli=$3; marker=${4:-}; home=${5:-}
    ;;
  turn)
    event=$2; node=$3; cli=$4; marker=${5:-}; home=${6:-}
    case "$event" in turn-start|turn-end|turn-end-idle) ;; *) exit 0 ;; esac
    ;;
  *) exit 0 ;;
esac

# Whose claim this is. The settings.json that runs this script belongs to ONE home, the
# one the launch hook baked into the command; the environment is ambient and only
# confirms it. A Claude process can load this home's settings while carrying another
# instance's environment (a nested `claude -p`, a `claude -p` started with its cwd here, a
# pane that inherited the variables): acting on $OATS_INSTANCE_HOME there would set and
# clear the OTHER instance's claim, and its Stop and SessionEnd clears would erase a real
# one. So unless $OATS_INSTANCE_HOME names the baked home, nothing is done at all: no CLI
# call, no marker write. Any spelling of the home counts (a symlinked deployment): cd -P
# leaves its real path in PWD, which is what the launch hook baked. That cd also means
# the CLI resolves nothing from the cwd Claude ran the hook in.
case "$home" in /*) ;; *) exit 0 ;; esac
case "${OATS_INSTANCE_HOME:-}" in /*) ;; *) exit 0 ;; esac
cd -P "$OATS_INSTANCE_HOME" || exit 0
[ "$PWD" = "$home" ] || exit 0
[ -f "$home/instance.json" ] && [ ! -L "$home/instance.json" ] || exit 0
case "$node" in /*) ;; *) exit 0 ;; esac
case "$cli" in /*) ;; *) exit 0 ;; esac
[ -x "$node" ] && [ -f "$cli" ] || exit 0

# Emitter-private debounce marker, outside the home (it is not the instance's state): a
# per-user temp file keyed by the home holding the latest intent (permission, question or
# clear), beside what the CLI last recorded, so a clear on every tool call starts no node
# process unless there is a claim to clear. The launch
# hook computed its path and vetted its directory once (per user, created 0700, owned by
# us, mode exactly 0700, not a symlink, no ACL); the hot path only re-checks that the
# directory is still a real directory we own, which only we could have changed. Anything
# else means "no debounce": set and clear then always call the CLI (it is idempotent).
# Losing it (reboot, tmp cleanup) is harmless: the session boundary voids the claim.
case "$marker" in /*/*.claude) ;; *) marker= ;; esac
# test -O (owned by us) is not in POSIX but every sh we run under has it (dash, bash, ash,
# zsh); where it is missing the test fails and the marker is simply not used.
# shellcheck disable=SC3067
if [ -n "$marker" ] && ! { [ -d "${marker%/*}" ] && [ ! -L "${marker%/*}" ] && [ -O "${marker%/*}" ]; }; then marker=; fi
# Beside the marker (the intent): <marker>.applied (what the CLI last recorded) and
# <marker>.lock (a directory: one reconciler at a time). A path that exists as anything
# else (a symlink, a file where the lock goes) makes the marker unusable too.
applied=$marker.applied
lock=$marker.lock
reaper=$marker.lock.reap
force=$marker.force
for f in "$marker" "$applied" "$force"; do
  if [ -n "$marker" ] && { [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; }; then marker=; fi
done
for d in "$lock" "$reaper"; do
  if [ -n "$marker" ] && { [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; }; then marker=; fi
done

# Kill process $1 after $2 seconds (macOS has no timeout(1)), unless this watchdog is
# killed first: its TERM trap then ends its sleep too, so nothing is left behind. A TERM
# that lands before the sleep's pid is known is caught by `killed`. Sets $watchdog.
start_watchdog() {
  (
    timer='' killed=''
    trap 'killed=1; [ -z "$timer" ] || kill "$timer"' TERM
    sleep "$2" &
    timer=$!
    [ -z "$killed" ] || { kill "$timer"; exit 0; }
    wait "$timer" && kill -9 "$1"
  ) >/dev/null &
  watchdog=$!
}

# The hook's input, once, into $input: at most 64 KiB, for at most 1 s.
read_input() {
  input=$(
    head -c 65536 <&3 &
    reader=$!
    start_watchdog "$reader" 1
    wait "$reader"
    kill "$watchdog"
  )
}

# A turn boundary (see "The turn record" above): claude-turn.mjs writes it, under a 2 s
# watchdog. The hook's input is read once, bounded, and handed to the writer on its stdin: a
# subagent's event (one that carries agent_id) writes nothing, and the idle notice names its type.
if [ "$action" = turn ]; then
  writer=${0%/*}/claude-turn.mjs
  [ -f "$writer" ] || exit 0
  read_input
  printf '%s' "$input" | "$node" "$writer" "$event" "$home" &
  pid=$!
  start_watchdog "$pid" 2
  wait "$pid"
  kill "$watchdog"
  exit 0
fi

# The text of a set, from the hook's input, into $message: what claude-waiting-message.mjs
# prints, under a 1 s watchdog; empty when it prints nothing, fails or is killed. Its output is
# one line the kernel accepts as a --message. Its arguments go to the reader.
message_of() {
  message=
  read_input
  [ -n "$input" ] && [ -f "$helper" ] || return 0
  message=$(
    printf '%s' "$input" | "$node" "$helper" "$@" &
    pid=$!
    start_watchdog "$pid" 1
    wait "$pid"
    status=$?
    kill "$watchdog"
    exit "$status"
  ) || message=
}

# A failed turn's reason and text, from the hook's input, into $resolved and $message.
failed_turn_of() {
  message_of failed-turn
  resolved=question
  [ "${message%% *}" = attention ] && resolved=attention
  message=${message#* }
}

# Whether this hook's input is a subagent's tool event (a background or parallel subagent
# in the same session), from Claude Code 2.1.288's payload: compact one-line JSON whose
# top-level keys put "agent_id" (subagents only) before "hook_event_name". Only the text
# before the first "hook_event_name" is looked at: a string value escapes its quotes, so
# that text holds top-level keys only. Read at most 64 KiB, for at most 1 s. No match
# (no key, another order, an input cut short before "hook_event_name", nothing read)
# means the main thread: the clear goes ahead.
from_subagent() {
  read_input
  prefix=${input%%\"hook_event_name\"*}
  [ "$prefix" != "$input" ] || return 1
  case "$prefix" in *'"agent_id":"'[A-Za-z0-9_-]*|*'"agent_id": "'[A-Za-z0-9_-]*) return 0 ;; esac
  return 1
}

# Run the CLI in the background under a 2 s watchdog. Its status is the CLI's: non-zero
# when it failed or the watchdog killed it.
run_cli() {
  "$node" "$cli" instance waiting "$@" --home "$home" --json &
  pid=$!
  start_watchdog "$pid" 2
  wait "$pid"
  status=$?
  kill "$watchdog"
  return "$status"
}

# The intent: "permission", "question", "attention", "failed-turn" or "clear"; absent or anything
# else is clear.
state_of() {
  line=
  [ -f "$1" ] && IFS= read -r line < "$1"
  case "$line" in permission|question|attention|failed-turn) printf '%s' "$line" ;; *) printf clear ;; esac
}

# What the CLI last recorded as the claim's text: the second line of the applied file, or empty.
applied_text() {
  line=
  [ -f "$applied" ] && { IFS= read -r line; IFS= read -r line; } < "$applied"
  printf '%s' "$line"
}

# The intent, read once into $want (as state_of) and $text: the text of the intent's own set,
# from the file of its event id, or empty (a clear, a set with no text, or one still reading it).
read_intent() {
  want=clear text='' line='' event='' resolved=''
  [ -f "$marker" ] && { IFS= read -r line; IFS= read -r event; } < "$marker"
  case "$line" in permission|question|attention) want=$line ;; failed-turn) want=question ;; *) return 0 ;; esac
  case "$event" in ''|*[!0-9-]*) return 0 ;; esac
  [ -f "$marker.text-$event" ] && [ ! -L "$marker.text-$event" ] && { IFS= read -r text; IFS= read -r resolved; } < "$marker.text-$event"
  [ "$line" = failed-turn ] && [ "$resolved" = attention ] && want=attention
  return 0
}

# Whether the intent is what the CLI last recorded, its text included.
intent_applied() {
  read_intent
  [ "$want" = "$(applied_of)" ] && [ "$text" = "$(applied_text)" ]
}

# Record what the CLI recorded: the reason (or clear) $1 and, on a second line, the text $2
# when there is one.
write_applied() {
  if [ -n "$2" ]; then printf '%s\n%s\n' "$1" "$2" > "$applied"; else printf '%s\n' "$1" > "$applied"; fi
}

# What the CLI last recorded: absent is clear (nothing recorded this session); anything
# but "permission", "question", "attention" or "clear" (an "unknown", a torn write) is unknown, which
# matches no intent, so the next event calls the CLI.
applied_of() {
  [ -e "$applied" ] || { printf clear; return; }
  line=
  IFS= read -r line < "$applied"
  case "$line" in permission|question|attention|clear) printf '%s' "$line" ;; *) printf unknown ;; esac
}

# Whether the lock still holds this hook's token.
owns() {
  line=
  [ -f "$lock/pid" ] && IFS= read -r line < "$lock/pid"
  [ "$line" = "$token" ]
}

# Take the reconciler's lock if it is free, or held by a holder that is gone; never wait.
take_lock() {
  if mkdir "$lock" 2>/dev/null; then
    stamp "$lock" && return 0
    return 1
  fi
  reap
}

# Write this hook's token into a lock directory it just made. If the write fails, the
# directory is removed again, never left token-less (that would hold everyone off for a
# minute).
stamp() {
  printf '%s\n' "$token" > "$1/pid" && return 0
  rm -f "$1/pid"
  rmdir "$1" 2>/dev/null
  return 1
}

# Remove a lock directory only while it holds this hook's token.
release() {
  line=
  [ -f "$1/pid" ] && IFS= read -r line < "$1/pid"
  [ "$line" = "$token" ] || return 0
  rm -f "$1/pid"
  rmdir "$1" 2>/dev/null
}

# Break a stale lock and take it. Reapers take turns under the reap lock (one that finds it
# held exits), and each judges the lock again there: a judgement made before can never
# remove the lock a faster reaper has just taken. The new lock gets its token before the
# reap lock is let go. A reap lock left by a reaper killed in that instant is removed once
# it is a minute old.
reap() {
  if ! mkdir "$reaper" 2>/dev/null; then
    [ -n "$(find "$reaper" -prune -mmin +1 2>/dev/null)" ] || return 1
    rm -f "$reaper/pid"
    rmdir "$reaper" 2>/dev/null
    mkdir "$reaper" 2>/dev/null || return 1
  fi
  stamp "$reaper" || return 1
  took=''
  if stale_lock; then
    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null
    if mkdir "$lock" 2>/dev/null && stamp "$lock"; then took=1; fi
  fi
  # Only our own reap lock: one a minute-old removal replaced is another reaper's.
  release "$reaper"
  [ -n "$took" ]
}

# Whether the lock's holder is gone: its pid is dead, or it took the lock over 5 s ago
# (Claude has killed it by then, or the machine slept; a reused pid looks alive), or "in
# the future" (the clock was set back, which would otherwise hold the lock that long). A lock
# with no readable pid file yet is its holder's first instant, unless it is a minute old (a
# holder killed in that instant).
stale_lock() {
  holder='' since=''
  [ -f "$lock/pid" ] && read -r holder since < "$lock/pid"
  case "$holder$since" in
    ''|*[!0-9]*) [ -n "$(find "$lock" -prune -mmin +1 2>/dev/null)" ]; return ;;
  esac
  kill -0 "$holder" 2>/dev/null || return 0
  age=$(( $(date +%s) - since ))
  [ "$age" -gt 5 ] || [ "$age" -lt 0 ]
}

# Bring the recorded claim to the latest intent, under the lock (see the protocol above).
# At most 3 calls, and none once 2 s (whole seconds, so under 2 s in fact) have passed since
# $began; each is killed at 2 s: the worst case is about 4 s.
reconcile() {
  token="$$ $began"
  calls=0
  while take_lock; do
    settled=''
    while :; do
      if intent_applied && [ ! -e "$force" ]; then settled=1; break; fi
      [ "$calls" -lt 3 ] && [ $(( $(date +%s) - began )) -lt 2 ] || break
      # This call applies the latest intent, so it answers every forced call asked so far;
      # one asked during it leaves the flag again for the next round.
      rm -f "$force"
      # Until the call is known to have landed, the recorded claim is unknown: one that
      # fails or is killed may still have written it.
      printf 'unknown\n' > "$applied"
      calls=$((calls + 1))
      if [ "$want" = clear ]; then
        run_cli clear --producer oats.core || break
      else
        if [ -n "$text" ]; then run_cli set --producer oats.core --reason "$want" "--message=$text" || break
        else run_cli set --producer oats.core --reason "$want" || break; fi
      fi
      # A holder whose lock was broken under it (it ran past 5 s: the machine slept)
      # acknowledges nothing and leaves the successor's lock alone.
      owns || return 0
      write_applied "$want" "$text"
    done
    owns || return 0
    release "$lock"
    # A hook that found the lock held between our last read and here left its intent to us.
    [ -n "$settled" ] && { [ -e "$force" ] || ! intent_applied; } || return 0
  done
}

# A subagent's tool call resolves nothing the human was asked by the main thread, so a
# tool clear (clear-tool) from one is skipped (a permission Notification never says who
# asked: see docs). It reads the input only when there is a claim to clear.
helper=${0%/*}/claude-waiting-message.mjs
if [ -z "$marker" ]; then
  if [ "$action" = set ]; then
    if [ "$reason" = failed-turn ]; then failed_turn_of; reason=$resolved; else message_of; fi
    if [ -n "$message" ]; then run_cli set --producer oats.core --reason "$reason" "--message=$message"
    else run_cli set --producer oats.core --reason "$reason"; fi
  else
    [ "$action" = clear-tool ] && from_subagent && exit 0
    run_cli clear --producer oats.core
  fi
  exit 0
fi

# This event yields to the open claim, and is still an event: if that claim's own set failed, this
# is a chance to apply it, and with nothing recorded a wake would type.
yield_to_intent() {
  began=$(date +%s)
  reconcile
  exit 0
}

intent=$(state_of "$marker")
if [ "$action" = set ]; then
  # An open AskUserQuestion is shown through Claude's permission dialog, so its own
  # permission_prompt follows the question's set: a permission prompt never relabels an
  # open question.
  [ "$reason" = permission ] && [ "$intent" = question ] && yield_to_intent
  # A turn that failed with a dialog open (a background subagent's) leaves that dialog's claim:
  # an `attention` in its place would let a wake type into the dialog.
  [ "$reason" = failed-turn ] && { [ "$intent" = permission ] || [ "$intent" = question ]; } && yield_to_intent
  # PermissionRequest named the tool and its claim landed: a Notification seconds later, whose own
  # words may name none, adds nothing. If it didn't land, this is the set that puts it right.
  [ -n "$late" ] && [ "$intent" = permission ] && [ "$(applied_of)" = permission ] && exit 0
  began=$(date +%s)
  # The intent first, so this event is ordered before anything later; its text after. A failed
  # turn's reason goes beside its text, so a later event always wins.
  event="$$-$began"
  printf '%s\n%s\n' "$reason" "$event" > "$marker"
  if [ "$reason" = failed-turn ]; then
    failed_turn_of
    printf '%s\n%s\n' "$message" "$resolved" > "$marker.text-$event"
  else
    message_of
    [ -n "$message" ] && printf '%s\n' "$message" > "$marker.text-$event"
  fi
elif [ "$action" = clear-tool ]; then
  # Nothing to clear (cleared and recorded so, no forced call due): no node process, no
  # input read. This is the hot path: every tool call runs it twice.
  [ "$intent" = clear ] && [ "$(applied_of)" = clear ] && [ ! -e "$force" ] && exit 0
  began=$(date +%s)
  from_subagent && exit 0
  printf 'clear\n' > "$marker"
else
  # A turn boundary gets a CLI call whatever the cache says, to repair a claim a late
  # write left wrong: from this hook or, if another hook holds the lock, from that holder
  # if it still has time (the flag); otherwise from the next event.
  began=$(date +%s)
  printf 'clear\n' > "$marker"
  : > "$force"
fi
reconcile
# The texts of earlier sets, a minute old, but never the intent's own.
if [ "$action" = set ]; then
  read_intent
  find "${marker%/*}" -name "${marker##*/}.text-*" -mmin +1 2>/dev/null | while IFS= read -r old; do
    [ "$old" = "$marker.text-$event" ] || rm -f "$old"
  done
fi
exit 0
