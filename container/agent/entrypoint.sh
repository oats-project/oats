#!/bin/sh
set -eu
umask 077

runtime_uid=$(id -u)
runtime_gid=$(id -g)
if [ "$runtime_uid" -eq 0 ]; then
    echo 'agent-entrypoint: run as a non-root uid with an owned /state mount' >&2
    exit 1
fi
mkdir -p /state/home /state/ssh /state/deploy
chmod 700 /state/home /state/ssh /state/deploy

# Keep system users (sshd's privilege-separation lookup included), and give
# agent the actual uid/gid. Generate afresh so a remapped volume can restart.
awk -F: -v uid="$runtime_uid" '$1 != "agent" && $3 != uid' /etc/passwd > /state/ssh/passwd
printf 'agent:x:%s:%s:OATS agent:/state/home:/bin/sh\n' "$runtime_uid" "$runtime_gid" >> /state/ssh/passwd
awk -F: -v gid="$runtime_gid" '$1 != "agent" && $3 != gid' /etc/group > /state/ssh/group
printf 'agent:x:%s:\n' "$runtime_gid" >> /state/ssh/group

# Only processes started after the runtime database exists use the wrapper.
# Derived-image RUN steps and entrypoint overrides retain normal system NSS.
export LD_PRELOAD=/usr/local/lib/libnss_wrapper.so
export NSS_WRAPPER_PASSWD=/state/ssh/passwd
export NSS_WRAPPER_GROUP=/state/ssh/group

if [ ! -f /state/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -N '' -f /state/ssh/ssh_host_ed25519_key
fi
exec /usr/sbin/sshd -D -e -f /etc/agent-sshd_config
