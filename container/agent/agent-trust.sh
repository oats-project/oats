# Login capture starts with a clean environment; SSH commands use this as BASH_ENV.
# Keep the optional public trust mount's two settings identical on both paths.
if [ -r /etc/agent-trust/ca.pem ]; then
    export SSL_CERT_FILE=/etc/agent-trust/ca.pem
    export NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem
fi
