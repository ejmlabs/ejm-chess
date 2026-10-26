# Official per-platform manifests. Only runtime linux/amd64 is a provider target.
FROM --platform=linux/amd64 python:3.13-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a AS sources
WORKDIR /inputs
COPY pins.json Cargo.lock verify_assets.py ./
COPY vendor ./vendor
RUN python verify_assets.py

FROM --platform=linux/amd64 rust:1.85.0-slim-bookworm@sha256:c842cc0357b91bb15ad2bb89934513d0d226f711fac7f7fedb176d3311714d47 AS native
ENV RUSTUP_TOOLCHAIN=1.85.0 CARGO_BUILD_JOBS=2
WORKDIR /build/chasolver
COPY --from=sources /opt/source/chasolver ./
COPY Cargo.lock ./Cargo.lock
RUN cargo build --locked --release --example analyzer \
 && strip target/release/examples/analyzer \
 && mkdir -p /retained/cargo /retained/rust \
 && cp /usr/local/cargo/registry/cache/*/*.crate /retained/cargo/ \
 && cp /usr/local/rustup/toolchains/1.85.0-x86_64-unknown-linux-gnu/share/doc/rust/COPYRIGHT \
       /usr/local/rustup/toolchains/1.85.0-x86_64-unknown-linux-gnu/share/doc/rust/LICENSE-APACHE \
       /usr/local/rustup/toolchains/1.85.0-x86_64-unknown-linux-gnu/share/doc/rust/LICENSE-MIT /retained/rust/

FROM --platform=linux/amd64 python:3.13-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a AS runtime-base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/opt/python
COPY --from=sources /opt/source /opt/source
COPY --from=sources /opt/source/chess-1.11.2/chess /opt/python/chess
COPY --from=native /build/chasolver/target/release/examples/analyzer /opt/cha/analyzer
COPY --from=native /retained /opt/source/dependencies
WORKDIR /app
COPY contract.py validate.py runner.py pins.json NOTICES ./
# Retain bytecode only for the import chain this adapter uses. Read-only jobs
# avoid reparsing these modules and never write runtime caches.
RUN PYTHONDONTWRITEBYTECODE= python -c 'import runner, validate; assert validate.chess.__version__ == "1.11.2"'
USER 65532:65532
EXPOSE 8080
CMD ["python", "runner.py"]

FROM runtime-base AS qualification
COPY test_runner.py corpus.json CORPUS-LICENSE measure.py ./
CMD ["python", "-m", "unittest", "-v", "test_runner"]

# The default build is the private server, never the test entry point.
FROM runtime-base AS runtime
