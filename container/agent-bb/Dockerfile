# The team image plus one pinned bb server. Build it FROM a reviewed team image:
#   docker build --build-arg AGENT_IMAGE=<team image> -t <tag> container/agent-bb
ARG AGENT_IMAGE
FROM ${AGENT_IMAGE}

USER root
WORKDIR /opt/agent-bb
COPY package.json package-lock.json ./
# No lifecycle script runs and nothing is rebuilt: bb's native modules are the
# prebuilds in its locked packages. The npm cache stays out of the image's HOME.
RUN npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/agent-bb-npm \
    && ln -s /opt/agent-bb/node_modules/.bin/bb /usr/local/bin/bb \
    && ln -s /opt/agent-bb/node_modules/.bin/bb-app /usr/local/bin/bb-app \
    && test "$(bb --version)" = "$(node -p 'require("./package.json").dependencies["bb-app"]')" \
    && rm -rf /tmp/agent-bb-npm /tmp/node-compile-cache

# The team image's entrypoint, HOME and environment stay as they are.
WORKDIR /state
USER agent
