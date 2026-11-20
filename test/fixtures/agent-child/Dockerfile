# The team image plus one declared fixture child. Built by team-image CI:
#   docker build --build-arg AGENT_IMAGE=<team image> -t <tag> test/fixtures/agent-child
ARG AGENT_IMAGE
FROM ${AGENT_IMAGE}

USER root
COPY --chown=0:0 --chmod=644 child.mjs version /opt/agent-child/
COPY --chown=0:0 --chmod=644 agent-child.json /etc/agent-child.json

# The team image's entrypoint, HOME and environment stay as they are.
WORKDIR /state
USER agent
