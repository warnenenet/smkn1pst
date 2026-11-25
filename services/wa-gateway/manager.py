from pathlib import Path
import shutil
import threading
import time
from typing import Any, Dict, List, Optional

import config
from db import GatewayDB, now_wib_str
import qr_extractor
from worker import SeleniumWorker

logger = config.setup_logger("wa_gateway.manager")


class AccountManager:
    """Mengelola lifecycle proses Chrome per akun (maks MAX_CHROME aktif bersamaan)."""

    def __init__(self, db: Optional[GatewayDB] = None, start_monitor: bool = True):
        config.ensure_storage_dirs()
        self.db = db or GatewayDB()
        self._lock = threading.RLock()
        self._workers: Dict[int, SeleniumWorker] = {}
        self._last_used: Dict[int, float] = {}
        self._starting: set[int] = set()
        self._stop_event = threading.Event()
        self._last_cleanup_at = 0.0
        self._monitor_thread: Optional[threading.Thread] = None

        if start_monitor:
            self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
            self._monitor_thread.start()

    def _evict_lru_if_full(self, exclude_account_id: int) -> None:
        with self._lock:
            # Bersihkan worker mati dulu
            dead_ids = [aid for aid, w in self._workers.items() if not w.is_alive()]
            for aid in dead_ids:
                w = self._workers.pop(aid, None)
                if w:
                    w.stop()

            while len(self._workers) >= config.MAX_CHROME:
                # Prioritaskan evict akun yang sudah CONNECTED (sesi aman di disk), baru LRU lainnya
                candidates = [aid for aid in self._workers.keys() if aid != exclude_account_id]
                if not candidates:
                    break

                acc_map = {a["id"]: a for a in self.db.list_accounts()}
                candidates.sort(
                    key=lambda aid: (
                        0 if acc_map.get(aid, {}).get("status") == "CONNECTED" else 1,
                        self._last_used.get(aid, 0.0),
                    )
                )
                victim_id = candidates[0]
                victim = self._workers.pop(victim_id, None)
                if victim:
                    logger.info(
                        "[Acc #%s] Batas MAX_CHROME=%s tercapai; mematikan Chrome idle (sesi disk tetap aman).",
                        victim_id,
                        config.MAX_CHROME,
                    )
                    victim.stop()

    def _run_login_flow(self, account_id: int) -> None:
        with self._lock:
            if account_id in self._starting:
                return
            acc = self.db.get_account(account_id)
            if not acc:
                return
            self._starting.add(account_id)

        try:
            self._evict_lru_if_full(exclude_account_id=account_id)
            worker = SeleniumWorker(account_id=account_id, user_data_dir=acc["user_data_dir"])
            with self._lock:
                old = self._workers.pop(account_id, None)
                if old:
                    old.stop()
                self._workers[account_id] = worker
                self._last_used[account_id] = time.time()

            status, phone = worker.start(wait_timeout=config.QR_WAIT_TIMEOUT_SEC)
            now_str = now_wib_str()
            if status == "CONNECTED":
                self.db.update_account(
                    account_id,
                    status="CONNECTED",
                    phone_number=phone or acc.get("phone_number"),
                    last_connected_at=now_str,
                    last_error=None,
                )
                self.db.log_event(account_id, "CONNECTED", f"Terhubung ({phone or '-'})")
                logger.info("[Acc #%s] Terhubung ke WhatsApp Web (%s)", account_id, phone or "-")
            elif status == "QR_READY":
                self.db.update_account(account_id, status="QR_READY", last_error=None)
                self.db.log_event(account_id, "QR_GENERATED", "QR WhatsApp Web siap di-scan.")
                logger.info("[Acc #%s] QR siap di-scan.", account_id)
        except Exception as exc:
            msg = str(exc)
            logger.error("[Acc #%s] Gagal memulai sesi Chrome WA: %s", account_id, msg)
            self.db.update_account(account_id, status="ERROR", last_error=msg)
            self.db.log_event(account_id, "ERROR", msg)
            with self._lock:
                w = self._workers.pop(account_id, None)
                if w:
                    w.stop()
        finally:
            with self._lock:
                self._starting.discard(account_id)

    def start_account_async(self, account_id: int) -> None:
        t = threading.Thread(target=self._run_login_flow, args=(account_id,), daemon=True)
        t.start()

    def create_account(self, label: str, phone_number: Optional[str] = None) -> Dict[str, Any]:
        acc = self.db.create_account(label=label, phone_number=phone_number)
        self.start_account_async(acc["id"])
        # Tunggu sebentar maks 1.2 detik agar status langsung update jika cepat
        deadline = time.time() + 1.2
        while time.time() < deadline:
            cur = self.db.get_account(acc["id"])
            if cur and cur["status"] in ("QR_READY", "CONNECTED", "ERROR"):
                acc = cur
                break
            time.sleep(0.2)
        acc["qr_updated_at"] = self._get_qr_updated_at(acc["id"])
        return acc

    def _get_qr_updated_at(self, account_id: int) -> Optional[str]:
        with self._lock:
            w = self._workers.get(account_id)
            if w and w.last_qr_updated_at:
                return w.last_qr_updated_at
        qr_path = config.QR_DIR / f"{account_id}.png"
        if qr_path.exists():
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(qr_path.stat().st_mtime))
        return None

    def get_qr_payload(self, account_id: int) -> Optional[Dict[str, Any]]:
        acc = self.db.get_account(account_id)
        if not acc:
            return None

        with self._lock:
            worker = self._workers.get(account_id)
            starting = account_id in self._starting

        # Jika belum aktif dan belum terhubung, otomatis mulai Chrome untuk generate QR
        if worker is None and not starting and acc["status"] in ("NEW", "DISCONNECTED", "ERROR"):
            self.start_account_async(account_id)
            acc = self.db.get_account(account_id) or acc

        if worker is not None and worker.is_alive():
            try:
                status, qr_b64, phone = worker.poll_state()
                if status == "CONNECTED" and acc["status"] != "CONNECTED":
                    self.db.update_account(
                        account_id,
                        status="CONNECTED",
                        phone_number=phone or acc.get("phone_number"),
                        last_connected_at=now_wib_str(),
                        last_error=None,
                    )
                    self.db.log_event(account_id, "CONNECTED", f"Terhubung ({phone or '-'})")
                    acc = self.db.get_account(account_id) or acc
                elif status == "QR_READY":
                    if acc["status"] != "QR_READY":
                        self.db.update_account(account_id, status="QR_READY", last_error=None)
                        acc = self.db.get_account(account_id) or acc
                    return {
                        "ok": True,
                        "id": account_id,
                        "status": "QR_READY",
                        "qr_base64": qr_b64,
                        "phone_number": acc.get("phone_number"),
                        "last_error": acc.get("last_error"),
                        "updated_at": worker.last_qr_updated_at or now_wib_str(),
                    }
            except Exception as exc:
                self.db.update_account(account_id, status="ERROR", last_error=str(exc))
                acc = self.db.get_account(account_id) or acc

        qr_base64: Optional[str] = None
        if acc["status"] == "QR_READY" and worker and worker.last_qr_base64:
            qr_base64 = worker.last_qr_base64

        return {
            "ok": True,
            "id": account_id,
            "status": acc["status"],
            "qr_base64": qr_base64,
            "phone_number": acc.get("phone_number"),
            "last_error": acc.get("last_error"),
            "updated_at": self._get_qr_updated_at(account_id) or acc.get("last_connected_at") or acc.get("created_at"),
        }

    def reconnect_account(self, account_id: int) -> Optional[Dict[str, Any]]:
        acc = self.db.get_account(account_id)
        if not acc:
            return None
        self.db.update_account(account_id, status="NEW", last_error=None)
        self.start_account_async(account_id)
        return self.db.get_account(account_id)

    def pause_account(self, account_id: int) -> Optional[Dict[str, Any]]:
        acc = self.db.get_account(account_id)
        if not acc:
            return None
        with self._lock:
            w = self._workers.pop(account_id, None)
            if w:
                w.stop()
        return self.db.update_account(account_id, status="PAUSED")

    def resume_account(self, account_id: int) -> Optional[Dict[str, Any]]:
        acc = self.db.get_account(account_id)
        if not acc:
            return None
        updated = self.db.update_account(account_id, status="NEW", last_error=None)
        self.start_account_async(account_id)
        return updated

    def delete_account(self, account_id: int) -> bool:
        acc = self.db.get_account(account_id)
        if not acc:
            return False
        with self._lock:
            w = self._workers.pop(account_id, None)
            if w:
                w.stop()
            self._last_used.pop(account_id, None)

        user_dir = Path(acc["user_data_dir"])
        if user_dir.exists() and str(config.SESSIONS_DIR) in str(user_dir.resolve()):
            shutil.rmtree(user_dir, ignore_errors=True)
        (config.QR_DIR / f"{account_id}.png").unlink(missing_ok=True)
        return self.db.delete_account(account_id)

    def ensure_worker_connected(self, account_id: int) -> SeleniumWorker:
        acc = self.db.get_account(account_id)
        if not acc:
            raise ValueError("Akun WhatsApp tidak ditemukan.")
        if acc["status"] == "PAUSED":
            raise RuntimeError("Akun WhatsApp sedang di-PAUSE.")
        if acc["status"] in ("ERROR", "DISCONNECTED"):
            raise RuntimeError(acc.get("last_error") or f"Akun berstatus {acc['status']}.")

        with self._lock:
            worker = self._workers.get(account_id)
            if worker is None or not worker.is_alive():
                self._evict_lru_if_full(exclude_account_id=account_id)
                worker = SeleniumWorker(account_id=account_id, user_data_dir=acc["user_data_dir"])
                self._workers[account_id] = worker
            self._last_used[account_id] = time.time()

        phone = worker.ensure_connected(config.CHAT_LOAD_TIMEOUT_SEC)
        if acc["status"] != "CONNECTED" or (phone and not acc.get("phone_number")):
            self.db.update_account(
                account_id,
                status="CONNECTED",
                phone_number=phone or acc.get("phone_number"),
                last_connected_at=now_wib_str(),
                last_error=None,
            )
        return worker

    def active_browser_count(self) -> int:
        with self._lock:
            return sum(1 for w in self._workers.values() if w.is_alive())

    def shutdown(self) -> None:
        self._stop_event.set()
        with self._lock:
            for w in list(self._workers.values()):
                w.stop()
            self._workers.clear()

    def _monitor_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                now = time.time()
                if now - self._last_cleanup_at > 3600:
                    qr_extractor.cleanup_old_qr_files()
                    self._last_cleanup_at = now

                with self._lock:
                    items = list(self._workers.items())

                for acc_id, worker in items:
                    if self._stop_event.is_set():
                        break
                    acc = self.db.get_account(acc_id)
                    if not acc:
                        continue
                    # Hanya polling rutin akun yang masih menunggu scan QR, atau evict yang idle terlalu lama
                    if acc["status"] in ("NEW", "QR_READY"):
                        try:
                            status, _qr, phone = worker.poll_state()
                            if status == "CONNECTED":
                                self.db.update_account(
                                    acc_id,
                                    status="CONNECTED",
                                    phone_number=phone or acc.get("phone_number"),
                                    last_connected_at=now_wib_str(),
                                    last_error=None,
                                )
                                self.db.log_event(acc_id, "CONNECTED", f"Terhubung ({phone or '-'})")
                            elif status == "QR_READY" and acc["status"] != "QR_READY":
                                self.db.update_account(acc_id, status="QR_READY", last_error=None)
                        except Exception as exc:
                            self.db.update_account(acc_id, status="ERROR", last_error=str(exc))
                            self.db.log_event(acc_id, "ERROR", str(exc))
                    elif acc["status"] == "CONNECTED":
                        idle_sec = now - self._last_used.get(acc_id, now)
                        if idle_sec > config.CHROME_IDLE_EVICT_SEC:
                            logger.info(
                                "[Acc #%s] Idle > %ss; menutup Chrome sementara (sesi tetap tersimpan).",
                                acc_id,
                                config.CHROME_IDLE_EVICT_SEC,
                            )
                            with self._lock:
                                w = self._workers.pop(acc_id, None)
                                if w:
                                    w.stop()
            except Exception as loop_err:
                logger.error("Monitor loop error: %s", loop_err)

            self._stop_event.wait(config.QR_POLL_INTERVAL_SEC)
