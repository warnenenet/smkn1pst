import base64
import hashlib
from io import BytesIO
from pathlib import Path
import time
from typing import Any, Optional, Tuple

import config
import selectors


def extract_qr_base64_and_save(
    driver: Any,
    account_id: int,
    qr_dir: Optional[Path] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Mengekstrak QR code dari <canvas> WhatsApp Web, menyimpannya sebagai PNG
    ke storage/wa_qr/<account_id>.png, dan mengembalikan (data_url, sha256_hash).
    """
    target_dir = Path(qr_dir or config.QR_DIR)
    target_dir.mkdir(parents=True, exist_ok=True)
    png_bytes: Optional[bytes] = None

    for css in selectors.QR_CANVAS_SELECTORS:
        try:
            elements = driver.find_elements("css selector", css)
        except Exception:
            continue

        for el in elements:
            try:
                if not el.is_displayed():
                    continue
                size = el.size or {}
                if int(size.get("width", 0)) < 140 or int(size.get("height", 0)) < 140:
                    continue

                data_url = driver.execute_script(
                    "try { return arguments[0].toDataURL('image/png'); } catch(e) { return null; }",
                    el,
                )
                if isinstance(data_url, str) and data_url.startswith("data:image/png;base64,"):
                    b64_part = data_url.split(",", 1)[1]
                    raw = base64.b64decode(b64_part)
                    if len(raw) > 200:
                        png_bytes = raw
                        break

                # Fallback screenshot element jika canvas tainted
                shot = el.screenshot_as_png
                if shot and len(shot) > 200:
                    try:
                        from PIL import Image  # type: ignore

                        img = Image.open(BytesIO(shot)).convert("RGB")
                        buf = BytesIO()
                        img.save(buf, format="PNG")
                        png_bytes = buf.getvalue()
                    except ImportError:
                        png_bytes = shot
                    break
            except Exception:
                continue
        if png_bytes:
            break

    if not png_bytes:
        return None, None

    out_path = target_dir / f"{account_id}.png"
    out_path.write_bytes(png_bytes)
    digest = hashlib.sha256(png_bytes).hexdigest()[:16]
    b64_str = base64.b64encode(png_bytes).decode("ascii")
    return f"data:image/png;base64,{b64_str}", digest


def cleanup_old_qr_files(qr_dir: Optional[Path] = None, max_age_days: int = config.QR_RETENTION_DAYS) -> int:
    target_dir = Path(qr_dir or config.QR_DIR)
    if not target_dir.exists():
        return 0
    cutoff = time.time() - (max_age_days * 86400)
    removed = 0
    for item in target_dir.glob("*.png"):
        try:
            if item.stat().st_mtime < cutoff:
                item.unlink(missing_ok=True)
                removed += 1
        except Exception:
            pass
    return removed
