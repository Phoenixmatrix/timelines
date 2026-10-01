# The image CI jobs run in on Cloudflare Sandbox (see worker/ci/sandbox.ts).
# The Durable Object drives it with exec(), so it only needs to stay alive.
FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*

# JS toolchain: pnpm (via corepack) and Vite+.
ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm/bin:/usr/local/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate \
  && pnpm add -g vite-plus

# Rust, for the gm CLI.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && chmod -R a+w $RUSTUP_HOME $CARGO_HOME

WORKDIR /workspace
CMD ["sleep", "infinity"]
