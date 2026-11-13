# Login capture starts with a clean environment; SSH commands use this as BASH_ENV.
# Keep the optional public trust mount's two settings identical on both paths.
if [ -r /etc/agent-trust/ca.pem ]; then
    export SSL_CERT_FILE=/etc/agent-trust/ca.pem
    export NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem
fi

# Read one public selector as data. A bad present file selects a nonempty invalid
# URL so aw refuses configuration instead of silently choosing its public default.
if _agent_registry=$(/usr/local/bin/node /usr/local/lib/agent-registry.mjs --profile 2>/dev/null); then
    if [ -n "$_agent_registry" ]; then
        export AWID_REGISTRY_URL="$_agent_registry"
    else
        unset AWID_REGISTRY_URL
    fi
else
    printf '%s\n' 'agent-trust: AWID_REGISTRY_URL: invalid or unreadable /tmp/agent-registry/registry-url' >&2
    export AWID_REGISTRY_URL=invalid:
fi
unset _agent_registry
