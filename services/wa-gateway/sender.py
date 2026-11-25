import time
from typing import Any, Dict, Tuple

import config
from manager import AccountManager
from worker import clean_phone_digits

logger = config.setup_logger("wa_gateway.sender")


def send_message_with_guards(
    manager: AccountManager,
    account_id: int,
    to_phone: str,
    message: str,
    max_retries: int = 2,
) -> Tuple[int, Dict[str, Any]]:
    """
    Mengirim pesan WhatsApp dengan validasi rate limit (150/jam, 800/hari),
    jeda anti-spam 24 jam per nomor tujuan, serta retry otomatis.
    """
    clean_to = clean_phone_digits(to_phone)
    if len(clean_to) < 9:
        return 400, {"ok": False, "error": "Nomor tujuan tidak valid (minimal 9 digit)."}

    text = str(message or "").strip()
    if not text:
        return 400, {"ok": False, "error": "Isi pesan tidak boleh kosong."}

    acc = manager.db.get_account(account_id)
    if not acc:
        return 404, {"ok": False, "error": f"Akun WhatsApp #{account_id} tidak ditemukan."}

    if acc["status"] == "PAUSED":
        return 409, {"ok": False, "error": "Akun WhatsApp sedang di-PAUSE."}
    if acc["status"] in ("NEW", "QR_READY", "DISCONNECTED", "ERROR"):
        return 409, {
            "ok": False,
            "error": acc.get("last_error") or f"Akun belum CONNECTED (status={acc['status']}).",
        }

    allowed, quota_err = manager.db.check_rate_limit(
        account_id,
        hourly_limit=config.HOURLY_LIMIT,
        daily_limit=config.DAILY_LIMIT,
    )
    if not allowed:
        return 429, {"ok": False, "error": quota_err}

    if manager.db.has_sent_recipient_within_hours(clean_to, hours=config.RECIPIENT_COOLDOWN_HOURS):
        return 429, {
            "ok": False,
            "error": (
                f"Anti-spam 24 jam aktif: nomor tujuan {clean_to} sudah dikirimi pesan "
                f"dalam {config.RECIPIENT_COOLDOWN_HOURS} jam terakhir."
            ),
        }

    last_err: str = "Gagal mengirim pesan."
    for attempt in range(1, max_retries + 1):
        try:
            worker = manager.ensure_worker_connected(account_id)
            worker.send_message(clean_to, text)
            manager.db.increment_counters(account_id)
            manager.db.record_recipient_sent(account_id, clean_to)
            manager.db.log_event(account_id, "SEND_OK", f"Terkirim ke {clean_to}")
            updated = manager.db.get_account(account_id) or acc
            return 200, {
                "ok": True,
                "account_id": account_id,
                "to": clean_to,
                "daily_count": updated.get("daily_count", 0),
                "hourly_count": updated.get("hourly_count", 0),
            }
        except ValueError as non_retryable:
            # Nomor tujuan invalid di WA, jangan retry
            last_err = str(non_retryable)
            manager.db.log_event(account_id, "SEND_FAIL", f"{clean_to}: {last_err}")
            return 422, {"ok": False, "error": last_err}
        except Exception as exc:
            last_err = str(exc)
            logger.warning(
                "[Acc #%s] Gagal kirim ke %s (percobaan %s/%s): %s",
                account_id,
                clean_to,
                attempt,
                max_retries,
                last_err,
            )
            if "logout" in last_err.lower() or "diblokir" in last_err.lower():
                manager.db.update_account(account_id, status="DISCONNECTED", last_error=last_err)
                manager.db.log_event(account_id, "DISCONNECTED", last_err)
                return 503, {"ok": False, "error": last_err}
            if attempt < max_retries:
                time.sleep(2.0)

    manager.db.update_account(account_id, last_error=last_err)
    manager.db.log_event(account_id, "SEND_FAIL", f"{clean_to}: {last_err}")
    return 502, {"ok": False, "error": last_err}
