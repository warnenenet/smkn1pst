import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# Konstanta default tertanam di kode (ubah langsung di sini jika perlu disesuaikan)
DEFAULT_HOST: str = "127.0.0.1"
DEFAULT_PORT: int = 8003
DEFAULT_MAX_CHROME: int = 3
CONTAINER_INTERNAL_TOKEN_FILE: Path = Path("/app/storage/secrets/internal_token")

HOST: str = os.environ.get("WA_GATEWAY_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
PORT: int = DEFAULT_PORT

STORAGE_DIR: Path = Path(os.environ.get("WA_STORAGE_DIR", "/app/storage")).resolve()
SESSIONS_DIR: Path = STORAGE_DIR / "wa_sessions"
QR_DIR: Path = STORAGE_DIR / "wa_qr"
DB_PATH: Path = Path(os.environ.get("WA_DB_PATH") or str(STORAGE_DIR / "wa_gateway.db")).resolve()
LOG_PATH: Path = Path(os.environ.get("WA_LOG_PATH") or str(STORAGE_DIR / "wa_gateway.log")).resolve()


def resolve_internal_token_file() -> Path:
    candidates = [
        CONTAINER_INTERNAL_TOKEN_FILE,
        STORAGE_DIR / "secrets" / "internal_token",
        STORAGE_DIR.parent / "secrets" / "internal_token",
    ]
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    return CONTAINER_INTERNAL_TOKEN_FILE


def load_internal_token() -> str:
    token_file = resolve_internal_token_file()
    try:
        if token_file.exists():
            return token_file.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return ""


INTERNAL_TOKEN: str = load_internal_token()

MAX_CHROME: int = DEFAULT_MAX_CHROME
HOURLY_LIMIT: int = max(1, _env_int("WA_HOURLY_LIMIT", 150))
DAILY_LIMIT: int = max(1, _env_int("WA_DAILY_LIMIT", 800))
RECIPIENT_COOLDOWN_HOURS: int = max(1, _env_int("WA_RECIPIENT_COOLDOWN_HOURS", 24))

QR_WAIT_TIMEOUT_SEC: int = max(5, _env_int("WA_QR_WAIT_TIMEOUT_SEC", 30))
CHAT_LOAD_TIMEOUT_SEC: int = max(5, _env_int("WA_CHAT_LOAD_TIMEOUT_SEC", 30))
SEND_TIMEOUT_SEC: int = max(5, _env_int("WA_SEND_TIMEOUT_SEC", 20))
QR_POLL_INTERVAL_SEC: float = max(1.0, _env_float("WA_QR_POLL_INTERVAL_SEC", 3.0))
QR_RETENTION_DAYS: int = max(1, _env_int("WA_QR_RETENTION_DAYS", 7))
CHROME_IDLE_EVICT_SEC: int = max(60, _env_int("WA_CHROME_IDLE_EVICT_SEC", 600))

HUMAN_DELAY_MIN_SEC: float = max(0.5, _env_float("WA_HUMAN_DELAY_MIN_SEC", 3.0))
HUMAN_DELAY_MAX_SEC: float = max(HUMAN_DELAY_MIN_SEC, _env_float("WA_HUMAN_DELAY_MAX_SEC", 8.0))

LOG_MAX_BYTES: int = 10 * 1024 * 1024  # 10 MB
CHROME_BIN: str = os.environ.get("CHROME_BIN", "").strip()
CHROMEDRIVER_BIN: str = os.environ.get("CHROMEDRIVER_BIN", "").strip()
ENABLE_XVFB_FALLBACK: bool = os.environ.get("ENABLE_XVFB_FALLBACK", "1").strip().lower() in ("1", "true", "yes")
WHATSAPP_WEB_URL: str = "https://web.whatsapp.com/"


def ensure_storage_dirs() -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    QR_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


def setup_logger(name: str = "wa_gateway") -> logging.Logger:
    ensure_storage_dirs()
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    file_handler = RotatingFileHandler(
        str(LOG_PATH),
        maxBytes=LOG_MAX_BYTES,
        backupCount=1,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)
    return logger
