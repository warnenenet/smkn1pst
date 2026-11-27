# ==============================================================================
# Stage 1: Build Pure Rust Face Engine (SCRFD + LMEDS + ArcFace + ffmpeg-next + HDBSCAN)
# ==============================================================================
FROM rust:1.86-slim-bookworm AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config \
      libavcodec-dev \
      libavformat-dev \
      libavutil-dev \
      libswscale-dev \
      clang \
      libclang-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY services/face-engine ./

# Vendor crates once, enforce pure offline build & run all Rust unit tests inside Docker build
RUN cargo vendor /build/vendor \
    && mkdir -p /build/.cargo \
    && printf '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "/build/vendor"\n' > /build/.cargo/config.toml \
    && cargo test --release --offline \
    && cargo build --release --offline

# ==============================================================================
# Stage 2: Build Frontend React + Vite Bundle
# ==============================================================================
FROM node:24-slim AS web-builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

# ==============================================================================
# Stage 3: Fetch & Verify Binary Assets (s6-overlay, ONNX Runtime, SCRFD/ArcFace, Piper)
# ==============================================================================
FROM debian:bookworm-slim AS asset-fetcher

ARG S6_OVERLAY_VERSION=3.2.3.2
ARG ORT_VERSION=1.22.0
ARG ORT_TAR_SHA256=ed1716de95974bf47ab0223ca33734a0b5a5d09a181225d0e8ed62d070aea893

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tar xz-utils unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /assets

# 1. s6-overlay v3.2.3.2 (PID 1 supervisor)
RUN mkdir -p /assets/s6-root \
    && curl -fsSL --retry 5 -o /tmp/s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && curl -fsSL --retry 5 -o /tmp/s6-x86_64.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz" \
    && tar -C /assets/s6-root -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C /assets/s6-root -Jxpf /tmp/s6-x86_64.tar.xz \
    && rm -f /tmp/s6-*.tar.xz

# 2. ONNX Runtime 1.22.0 dynamic library (SHA256 verified against ort 2.0.0-rc.10 dist manifest)
RUN mkdir -p /assets/ort /assets/lib /assets/models \
    && curl -fsSL --retry 5 -o /tmp/ort.tgz \
      "https://cdn.pyke.io/0/pyke:ort-rs/ms@${ORT_VERSION}/x86_64-unknown-linux-gnu.tgz" \
    && echo "${ORT_TAR_SHA256}  /tmp/ort.tgz" | sha256sum -c - \
    && tar -xzf /tmp/ort.tgz -C /assets/ort \
    && SO_PATH="$(find /assets/ort -type f -name 'libonnxruntime.so*' | head -n1)" \
    && cp -f "$SO_PATH" /assets/lib/libonnxruntime.so \
    && chmod 755 /assets/lib/libonnxruntime.so \
    && sha256sum /assets/lib/libonnxruntime.so > /assets/models/ort_dylib.sha256 \
    && rm -rf /tmp/ort.tgz /assets/ort

# 3. InsightFace buffalo_l SCRFD (det_10g.onnx) + ArcFace (w600k_r50.onnx) ONLY
RUN mkdir -p /assets/models/insightface/models/buffalo_l \
    && curl -fsSL --retry 5 -o /tmp/buffalo_l.zip \
      "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip" \
    && unzip -j -o /tmp/buffalo_l.zip det_10g.onnx w600k_r50.onnx -d /assets/models/insightface/models/buffalo_l \
    && sha256sum /assets/models/insightface/models/buffalo_l/det_10g.onnx > /assets/models/det_10g.sha256 \
    && sha256sum /assets/models/insightface/models/buffalo_l/w600k_r50.onnx > /assets/models/w600k_r50.sha256 \
    && rm -f /tmp/buffalo_l.zip

# 4. Piper TTS binary + Indonesian voice model
RUN mkdir -p /assets/piper-bin /assets/models/piper \
    && curl -fsSL --retry 5 "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" \
      | tar -xz -C /assets/piper-bin \
    && chmod +x /assets/piper-bin/piper/piper \
    && curl -fsSL --retry 5 -o /assets/models/piper/id_ID-news_tts-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx" \
    && curl -fsSL --retry 5 -o /assets/models/piper/id_ID-news_tts-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json"

# ==============================================================================
# Stage 4: Final Pure Rust + Node.js All-in-One Image (Zero Python/Chromium/WASM)
# ==============================================================================
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jakarta \
    NODE_ENV=production \
    PORT=80 \
    APP_ROOT=/app \
    DATA_DIR=/app/data \
    WA_STORAGE_DIR=/app/storage \
    INTERNAL_TOKEN_FILE=/app/storage/secrets/internal_token \
    FACE_SERVICE_URL=http://127.0.0.1:8001 \
    FACE_PORT=8001 \
    WEB_BACKEND_URL=http://127.0.0.1:80 \
    WA_GATEWAY_PORT=8003 \
    WA_GATEWAY_AUTO_SPAWN=0 \
    INSIGHTFACE_HOME=/app/models/insightface \
    ORT_DYLIB_PATH=/usr/local/lib/libonnxruntime.so \
    ORT_INTRA_THREADS=2 \
    MAX_CAMERA_WORKERS=8 \
    PROCESS_EVERY_N_FRAMES=2 \
    DEBUG_TMP_DIR=/tmp/face-engine-debug \
    PIPER_BIN=/usr/local/piper/piper \
    PIPER_MODEL=/app/models/piper/id_ID-news_tts-medium.onnx \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2

WORKDIR /app

# Runtime libs ONLY (ffmpeg runtime for preview + ffmpeg-next shared libs, NO Python, NO Chromium, NO Supervisord)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libavcodec59 libavformat59 libavutil57 libswscale6 \
      libgomp1 curl openssl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay, ORT shared lib, ONNX models, and Piper TTS
COPY --from=asset-fetcher /assets/s6-root /
COPY --from=asset-fetcher /assets/lib/libonnxruntime.so /usr/local/lib/libonnxruntime.so
COPY --from=asset-fetcher /assets/models /app/models
COPY --from=asset-fetcher /assets/piper-bin/piper /usr/local/piper
RUN ldconfig \
    && mkdir -p /app/bin /app/data/snapshots /app/data/tts_cache /app/data/backups \
       /app/storage/secrets /app/storage/wa_gateway/baileys_auth /app/storage/debug /tmp/face-engine-debug

# Install Node.js production dependencies (Express, ws, xlsx, Baileys, qrcode)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy Rust binary, built frontend, Node backend, standalone Baileys gateway, and s6 service tree
COPY --from=rust-builder /build/target/release/face-engine /app/bin/face-engine
COPY --from=web-builder /app/dist /app/dist
COPY server.ts favicon.ico ./
COPY src ./src
COPY services/wa-gateway-node ./services/wa-gateway-node
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/s6-rc.d /etc/s6-overlay/s6-rc.d

RUN chmod +x /app/bin/face-engine /app/docker/entrypoint.sh \
      /etc/s6-overlay/s6-rc.d/face-engine/run \
      /etc/s6-overlay/s6-rc.d/face-engine/finish \
      /etc/s6-overlay/s6-rc.d/node-web/run \
      /etc/s6-overlay/s6-rc.d/wa-gateway/run

VOLUME ["/app/data", "/app/storage"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=35s --retries=3 \
  CMD curl -sf http://127.0.0.1:80/api/health && curl -sf http://127.0.0.1:8001/health && curl -sf http://127.0.0.1:8003/health || exit 1

ENTRYPOINT ["/init"]
