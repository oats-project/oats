FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# nss-wrapper resolves agent to the runtime uid without a writable /etc/passwd.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux git openssh-server ca-certificates tini libnss-wrapper \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt /etc/ssh/ssh_host_* \
    && mkdir -p /run/sshd /state /opt/agent \
    && useradd --create-home --home-dir /state/home --shell /bin/sh agent \
    && ln -s /usr/lib/*/libnss_wrapper.so /usr/local/lib/libnss_wrapper.so

WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN --mount=type=bind,source=.,target=/opt/oats-build-inputs,readonly npm ci --ignore-scripts --no-audit --no-fund \
    && node -e 'require.resolve("@awebai/aw-linux-" + process.arch + "/bin/aw")'
# No lifecycle script except aw's may run. No unlocked download fallback.
RUN --network=none npm rebuild @awebai/aw --ignore-scripts=false --offline \
    && node -e 'const fs = require("node:fs"); const path = require("node:path"); const pkg = "@anthropic-ai/claude-code-linux-" + process.arch; const dir = path.dirname(require.resolve(pkg + "/package.json")); fs.symlinkSync(path.join(dir, "claude"), "/usr/local/bin/claude")' \
    && ln -s /opt/agent/node_modules/.bin/oats /usr/local/bin/oats \
    && ln -s /opt/agent/node_modules/.bin/aw /usr/local/bin/aw \
    && oats version --json && aw version && claude --version \
    && npm cache clean --force

COPY --chmod=755 entrypoint.sh /usr/local/bin/agent-entrypoint
COPY --chmod=644 supervisor.mjs /usr/local/lib/agent-supervisor.mjs
COPY --chmod=644 sshd_config /etc/agent-sshd_config
ENV HOME=/state/home
ENV AWEB_DELIVERY=session
# A child WORKDIR would be created by Docker as root inside a fresh mount.
WORKDIR /state
USER agent
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-entrypoint"]
