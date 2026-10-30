# Cloudflare Containers currently require linux/amd64. This is the official
# Python 3.13.16 slim-bookworm amd64 manifest, inspected 2026-10-20.
FROM --platform=linux/amd64 python:3.13-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a AS build
WORKDIR /build
COPY requirements-build.txt requirements.txt ./
RUN python -m pip install --no-cache-dir --no-deps --require-hashes -r requirements-build.txt \
 && python -m pip install --no-cache-dir --no-deps --no-build-isolation --require-hashes --target /opt/python -r requirements.txt
COPY locks.json fetch_assets.py ./
RUN python fetch_assets.py

FROM --platform=linux/amd64 python:3.13-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/opt/python STOCKFISH_PATH=/opt/stockfish/stockfish
COPY --from=build /opt/python /opt/python
COPY --from=build /opt/stockfish /opt/stockfish
COPY --from=build /opt/source /opt/source
WORKDIR /app
COPY runner.py locks.json ./
USER 65532:65532
EXPOSE 8080
CMD ["python", "runner.py"]
