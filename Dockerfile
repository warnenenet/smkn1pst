# ==============================================================================
# Stage 1: Build Rust Static Acceleration Binary (Cosine Similarity 1:N)
# ==============================================================================
FROM rust:1.83-slim-bookworm AS rust-builder
WORKDIR /build
COPY services/rust-accel ./
RUN cargo test --release && cargo build --release

# ==============================================================================
# Stage 2: Build Frontend React + Vite Bundle
# ==============================================================================
FROM node:22-slim AS web-builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

# ==============================================================================
# Stage 3: All-in-One Production Image (Node 22 + Python InsightFace + Rust + Piper + Supervisord)
# Target Hardware: linux/amd64 (40-core Intel CPU, 60 GB RAM)
# ==============================================================================
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jakarta \
    NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/app/data \
    WA_STORAGE_DIR=/app/storage \
    FACE_SERVICE_URL=http://127.0.0.1:8001 \
    CHROME_BIN=/usr/bin/chromium \
    CHROMEDRIVER_BIN=/usr/bin/chromedriver \
    ENABLE_XVFB_FALLBACK=1 \
    INSIGHTFACE_HOME=/app/models/insightface \
    RUST_ACCEL_BIN=/app/bin/face_accel \
    PIPER_BIN=/usr/local/piper/piper \
    PIPER_MODEL=/app/models/piper/id_ID-news_tts-medium.onnx \
    OMP_NUM_THREADS=4 \
    OPENBLAS_NUM_THREADS=4 \
    ORT_INTRA_OP_NUM_THREADS=4 \
    ORT_INTER_OP_NUM_THREADS=2

WORKDIR /app

# 1. Install runtime dependencies (Python, FFmpeg RTSP, Chromium + Xvfb WA Gateway, Supervisor, OpenSSL, tzdata)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev g++ \
      ffmpeg libgl1 libglib2.0-0 libgomp1 \
      chromium chromium-driver xvfb \
      fonts-liberation fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2 \
      supervisor curl openssl ca-certificates tar tzdata \
    && rm -rf /var/lib/apt/lists/*

# 2. Setup Python virtualenvs (Face Service + WA Gateway)
COPY services/face-service/requirements.txt /app/services/face-service/requirements.txt
COPY services/wa-gateway/requirements.txt /app/services/wa-gateway/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir numpy==1.26.4 cython \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/services/face-service/requirements.txt \
    && python3 -m venv /app/services/wa-gateway/.venv \
    && /app/services/wa-gateway/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/services/wa-gateway/.venv/bin/pip install --no-cache-dir -r /app/services/wa-gateway/requirements.txt \
    && apt-get purge -y --auto-remove g++ python3-dev \
    && rm -rf /var/lib/apt/lists/*

# 3. Pre-download InsightFace buffalo_l model into image (100% offline runtime)
RUN mkdir -p /app/models/insightface /app/models/piper /app/bin /app/data/snapshots /app/data/tts_cache /app/data/backups /app/storage/secrets /app/storage/wa_sessions /app/storage/wa_qr /var/log/supervisor \
    && /opt/venv/bin/python -c "from insightface.app import FaceAnalysis; app = FaceAnalysis(name='buffalo_l', root='/app/models/insightface', providers=['CPUExecutionProvider']); app.prepare(ctx_id=-1, det_size=(640, 640))"

# 4. Pre-download Piper TTS binary & Indonesian voice model (100% offline runtime)
RUN curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
      | tar -xz -C /usr/local \
    && chmod +x /usr/local/piper/piper \
    && curl -fsSL -o /app/models/piper/id_ID-news_tts-medium.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx \
    && curl -fsSL -o /app/models/piper/id_ID-news_tts-medium.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json

# 5. Install Node.js production dependencies (Express, ws, xlsx)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 6. Copy built artifacts, server code, Python services, Rust binary, Supervisord, and Entrypoint
COPY --from=rust-builder /build/target/release/face_accel /app/bin/face_accel
COPY --from=web-builder /app/dist /app/dist
COPY server.ts ./server.ts
COPY src ./src
COPY services/face-service ./services/face-service
COPY services/wa-gateway/*.py services/wa-gateway/requirements.txt services/wa-gateway/README.md /app/services/wa-gateway/
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

VOLUME ["/app/data", "/app/storage"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://127.0.0.1:80/api/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
