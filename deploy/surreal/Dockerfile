# syntax=docker/dockerfile:1.12
FROM surrealdb/surrealdb:v3.2.1@sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1 AS surreal
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 surreal \
  && useradd --uid 10001 --gid surreal --no-create-home --shell /usr/sbin/nologin surreal \
  && mkdir -p /data \
  && chown surreal:surreal /data
COPY --from=surreal /surreal /usr/local/bin/surreal
COPY --chmod=0555 deploy/surreal/entrypoint.sh /usr/local/bin/massion-surreal-entrypoint
USER surreal
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/massion-surreal-entrypoint"]
