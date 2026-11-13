FROM coredns/coredns:1.15.0@sha256:0a9d8c8ddf34347eb59aad9a8784f0710de88d6d112726d11d271f9bc6daca26 AS dns
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx libnginx-mod-stream tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin egress \
    && nginx -V 2>&1 | grep -q stream_ssl_preread
COPY --from=dns --chmod=755 /coredns /usr/local/bin/coredns
# The upstream binary carries cap_net_bind_service. Remove its file capability:
# exec otherwise fails under our empty capability bounding set (EPERM).
RUN cp --no-preserve=xattr /usr/local/bin/coredns /usr/local/bin/coredns.clean \
    && mv /usr/local/bin/coredns.clean /usr/local/bin/coredns
WORKDIR /opt/egress
COPY --chmod=644 policy.mjs supervisor.mjs health.mjs probe-ingress.mjs ./
ENV GOMAXPROCS=2
USER 10001:10001
EXPOSE 53/udp 53/tcp 443/tcp
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/egress/supervisor.mjs"]
