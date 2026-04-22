# syntax=docker/dockerfile:1.7

# ---- Stage 1: build the web bundle with Bun ------------------------------
FROM oven/bun:1-debian AS webbuilder
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

# ---- Stage 2: build the Rust binary --------------------------------------
FROM rust:1-bookworm AS rustbuilder
WORKDIR /app
# Prime the dependency cache.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && \
    cargo build --release --locked && \
    rm -rf src target/release/deps/novachat*

# Now copy the real sources and the prebuilt web assets.
# NOTE: we do NOT copy web/package.json into the rust build context — this
# makes build.rs short-circuit and skip its embedded `bun run build` call.
COPY src ./src
COPY migrations ./migrations
COPY build.rs ./
COPY --from=webbuilder /app/web/dist ./web/dist

RUN cargo build --release --locked && \
    strip target/release/novachat || true

# ---- Stage 3: minimal runtime image --------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini gosu \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/sbin/gosu /usr/local/bin/su-exec

RUN useradd --system --uid 10001 --home /data novachat \
    && mkdir -p /data \
    && chown -R novachat:novachat /data

COPY --from=rustbuilder /app/target/release/novachat /usr/local/bin/novachat
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /data
VOLUME ["/data"]

ENV NOVACHAT_BIND=0.0.0.0:3000 \
    NOVACHAT_DATA_DIR=/data

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
