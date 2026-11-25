from datetime import datetime, timedelta
from pathlib import Path
import sqlite3
import threading
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import config

WIB = ZoneInfo("Asia/Jakarta")
_DB_LOCK = threading.RLock()


def now_wib() -> datetime:
    return datetime.now(WIB)


def now_wib_str() -> str:
    return now_wib().strftime("%Y-%m-%d %H:%M:%S")


class GatewayDB:
    def __init__(self, db_path: Optional[Path] = None, sessions_dir: Optional[Path] = None):
        self.db_path = Path(db_path or config.DB_PATH)
        self.sessions_dir = Path(sessions_dir or config.SESSIONS_DIR)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA journal_size_limit=4194304")
        return conn

    def init_db(self) -> None:
        with _DB_LOCK:
            with self._connect() as conn:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS wa_accounts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        label TEXT NOT NULL,
                        phone_number TEXT,
                        status TEXT NOT NULL DEFAULT 'NEW',
                        user_data_dir TEXT NOT NULL,
                        created_at DATETIME NOT NULL,
                        last_connected_at DATETIME,
                        last_error TEXT,
                        daily_count INTEGER NOT NULL DEFAULT 0,
                        hourly_count INTEGER NOT NULL DEFAULT 0,
                        last_reset_at DATETIME
                    );

                    CREATE TABLE IF NOT EXISTS wa_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_id INTEGER NOT NULL,
                        event TEXT NOT NULL,
                        message TEXT NOT NULL,
                        created_at DATETIME NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_wa_logs_acc ON wa_logs(account_id, created_at DESC);

                    CREATE TABLE IF NOT EXISTS wa_sent_recipients (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_id INTEGER NOT NULL,
                        recipient TEXT NOT NULL,
                        sent_at DATETIME NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_wa_sent_recipient ON wa_sent_recipients(recipient, sent_at DESC);
                    """
                )
                conn.commit()

    def _row_to_dict(self, row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        return dict(row)

    def create_account(self, label: str, phone_number: Optional[str] = None) -> Dict[str, Any]:
        ts = now_wib_str()
        clean_label = (label or "WA Sekolah").strip()[:80]
        clean_phone = (phone_number or "").strip() or None
        with _DB_LOCK:
            with self._connect() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO wa_accounts (label, phone_number, status, user_data_dir, created_at, last_reset_at)
                    VALUES (?, ?, 'NEW', '', ?, ?)
                    """,
                    (clean_label, clean_phone, ts, ts),
                )
                acc_id = int(cur.lastrowid)
                user_dir = str((self.sessions_dir / f"acc_{acc_id}").resolve())
                Path(user_dir).mkdir(parents=True, exist_ok=True)
                conn.execute(
                    "UPDATE wa_accounts SET user_data_dir = ? WHERE id = ?",
                    (user_dir, acc_id),
                )
                conn.commit()
                row = conn.execute("SELECT * FROM wa_accounts WHERE id = ?", (acc_id,)).fetchone()
                return dict(row)

    def get_account(self, account_id: int) -> Optional[Dict[str, Any]]:
        with _DB_LOCK:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM wa_accounts WHERE id = ?", (account_id,)).fetchone()
                return self._row_to_dict(row)

    def list_accounts(self) -> List[Dict[str, Any]]:
        with _DB_LOCK:
            with self._connect() as conn:
                rows = conn.execute("SELECT * FROM wa_accounts ORDER BY id ASC").fetchall()
                return [dict(r) for r in rows]

    def update_account(self, account_id: int, **fields: Any) -> Optional[Dict[str, Any]]:
        allowed = {
            "label",
            "phone_number",
            "status",
            "user_data_dir",
            "last_connected_at",
            "last_error",
            "daily_count",
            "hourly_count",
            "last_reset_at",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return self.get_account(account_id)
        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values()) + [account_id]
        with _DB_LOCK:
            with self._connect() as conn:
                conn.execute(f"UPDATE wa_accounts SET {set_clause} WHERE id = ?", values)
                conn.commit()
                row = conn.execute("SELECT * FROM wa_accounts WHERE id = ?", (account_id,)).fetchone()
                return self._row_to_dict(row)

    def delete_account(self, account_id: int) -> bool:
        with _DB_LOCK:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM wa_accounts WHERE id = ?", (account_id,))
                conn.execute("DELETE FROM wa_logs WHERE account_id = ?", (account_id,))
                conn.execute("DELETE FROM wa_sent_recipients WHERE account_id = ?", (account_id,))
                conn.commit()
                return cur.rowcount > 0

    def log_event(self, account_id: int, event: str, message: str) -> None:
        ts = now_wib_str()
        with _DB_LOCK:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO wa_logs (account_id, event, message, created_at) VALUES (?, ?, ?, ?)",
                    (account_id, event[:40], str(message)[:500], ts),
                )
                conn.execute(
                    """
                    DELETE FROM wa_logs
                    WHERE id NOT IN (SELECT id FROM wa_logs ORDER BY id DESC LIMIT 10000)
                    """
                )
                conn.commit()

    def list_logs(self, account_id: Optional[int] = None, limit: int = 100) -> List[Dict[str, Any]]:
        safe_limit = max(1, min(500, int(limit)))
        with _DB_LOCK:
            with self._connect() as conn:
                if account_id is not None:
                    rows = conn.execute(
                        "SELECT * FROM wa_logs WHERE account_id = ? ORDER BY id DESC LIMIT ?",
                        (account_id, safe_limit),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM wa_logs ORDER BY id DESC LIMIT ?",
                        (safe_limit,),
                    ).fetchall()
                return [dict(r) for r in rows]

    def reset_quotas_if_due(self, account_id: int, ref_now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
        current = ref_now or now_wib()
        now_str = current.strftime("%Y-%m-%d %H:%M:%S")
        cur_date = now_str[:10]
        cur_hour = now_str[:13]
        with _DB_LOCK:
            acc = self.get_account(account_id)
            if not acc:
                return None
            prev = str(acc.get("last_reset_at") or "")
            if not prev or prev[:10] != cur_date:
                return self.update_account(account_id, daily_count=0, hourly_count=0, last_reset_at=now_str)
            if prev[:13] != cur_hour:
                return self.update_account(account_id, hourly_count=0, last_reset_at=now_str)
            return acc

    def check_rate_limit(
        self,
        account_id: int,
        hourly_limit: int = config.HOURLY_LIMIT,
        daily_limit: int = config.DAILY_LIMIT,
    ) -> Tuple[bool, Optional[str]]:
        acc = self.reset_quotas_if_due(account_id)
        if not acc:
            return False, "Akun WhatsApp tidak ditemukan."
        if int(acc.get("hourly_count") or 0) >= hourly_limit:
            return False, f"Batas per jam tercapai ({acc['hourly_count']}/{hourly_limit})."
        if int(acc.get("daily_count") or 0) >= daily_limit:
            return False, f"Batas harian tercapai ({acc['daily_count']}/{daily_limit})."
        return True, None

    def increment_counters(self, account_id: int) -> None:
        with _DB_LOCK:
            self.reset_quotas_if_due(account_id)
            with self._connect() as conn:
                conn.execute(
                    """
                    UPDATE wa_accounts
                    SET daily_count = daily_count + 1,
                        hourly_count = hourly_count + 1
                    WHERE id = ?
                    """,
                    (account_id,),
                )
                conn.commit()

    def has_sent_recipient_within_hours(
        self,
        recipient: str,
        hours: int = config.RECIPIENT_COOLDOWN_HOURS,
        ref_now: Optional[datetime] = None,
    ) -> bool:
        current = ref_now or now_wib()
        cutoff = (current - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        with _DB_LOCK:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id FROM wa_sent_recipients WHERE recipient = ? AND sent_at >= ? LIMIT 1",
                    (recipient, cutoff),
                ).fetchone()
                return row is not None

    def record_recipient_sent(self, account_id: int, recipient: str, ref_now: Optional[datetime] = None) -> None:
        current = ref_now or now_wib()
        ts = current.strftime("%Y-%m-%d %H:%M:%S")
        prune_cutoff = (current - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
        with _DB_LOCK:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO wa_sent_recipients (account_id, recipient, sent_at) VALUES (?, ?, ?)",
                    (account_id, recipient, ts),
                )
                conn.execute("DELETE FROM wa_sent_recipients WHERE sent_at < ?", (prune_cutoff,))
                conn.commit()
