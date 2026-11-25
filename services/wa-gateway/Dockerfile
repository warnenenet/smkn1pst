FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jakarta \
    PYTHONUNBUFFERED=1 \
    WA_GATEWAY_HOST=0.0.0.0 \
    WA_STORAGE_DIR=/app/storage \
    CHROME_BIN=/usr/bin/chromium \
    CHROMEDRIVER_BIN=/usr/bin/chromedriver \
    ENABLE_XVFB_FALLBACK=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium chromium-driver xvfb \
      fonts-liberation fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2 \
      curl openssl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/storage/secrets /app/storage/wa_sessions /app/storage/wa_qr

VOLUME ["/app/storage"]
EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8003/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8003", "--workers", "1", "--threads", "4", "--timeout", "120", "app:app"]
