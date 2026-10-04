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

# Rust, for the gm CLI; check runs cargo fmt and clippy, which minimal leaves out.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    --component rustfmt,clippy \
  && chmod -R a+w $RUSTUP_HOME $CARGO_HOME

# Cached `vp run` tasks don't pass RUSTUP_HOME or CARGO_HOME through, so rustup
# must also find its toolchains at the default ~/.rustup.
RUN ln -s $RUSTUP_HOME /root/.rustup && ln -s $CARGO_HOME /root/.cargo

# Chromium's headless shell for apps/website's browser-mode tests, with its
# system libraries, at the repository's Playwright version
# (tools/agent/ci-image.test.ts keeps this ARG equal to the lockfile's). The
# test job's Chromium step then finds both and does nothing; after a Playwright
# upgrade it fetches the new revision until this image is redeployed. Browsers
# live at a fixed path, not under $HOME; ~/.cache/ms-playwright points there
# for processes that don't get the variable. The marker file names the version
# whose system libraries are installed.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm dlx playwright@$PLAYWRIGHT_VERSION install --with-deps --only-shell chromium \
  && mkdir -p /usr/local/share/playwright-deps /root/.cache \
  && touch /usr/local/share/playwright-deps/$PLAYWRIGHT_VERSION \
  && ln -s $PLAYWRIGHT_BROWSERS_PATH /root/.cache/ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.cache/pnpm \
  && pnpm store prune

WORKDIR /workspace
CMD ["sleep", "infinity"]
