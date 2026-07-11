# syntax=docker/dockerfile:1.12
FROM surrealdb/surrealdb:v3.2.0 AS surreal
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
