#!/bin/sh
# The kernel writes only quoted exports to this private, per-start file.
# Do not enable tracing: the environment can contain credentials.
. "$1" || exit 1
/bin/rm -f -- "$1" || exit 1
shift
exec "$@"
