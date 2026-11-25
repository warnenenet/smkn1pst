from datetime import datetime, timedelta
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock

os.environ["WA_GATEWAY_TESTING"] = "1"

import config  # noqa: E402
from db import GatewayDB, WIB  # noqa: E402
from manager import AccountManager  # noqa: E402
import selectors  # noqa: E402
from sender import send_message_with_guards  # noqa: E402
from worker import clean_phone_digits  # noqa: E402


class TestWaGatewayCore(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        root = Path(self.tmpdir.name)
        self.db_path = root / "wa_gateway.db"
        self.sessions_dir = root / "wa_sessions"
        self.qr_dir = root / "wa_qr"
        config.SESSIONS_DIR = self.sessions_dir
        config.QR_DIR = self.qr_dir
        self.db = GatewayDB(db_path=self.db_path, sessions_dir=self.sessions_dir)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_phone_cleaning(self):
        self.assertEqual(clean_phone_digits("0812-3456-7890"), "6281234567890")
        self.assertEqual(clean_phone_digits("+62 813 9988 7766"), "6281399887766")
        self.assertEqual(clean_phone_digits("8123456789"), "628123456789")

    def test_account_crud_and_rate_limits(self):
        acc = self.db.create_account("WA Utama", "628111111111")
        self.assertEqual(acc["status"], "NEW")
        self.assertTrue(Path(acc["user_data_dir"]).exists())

        allowed, err = self.db.check_rate_limit(acc["id"], hourly_limit=2, daily_limit=5)
        self.assertTrue(allowed)
        self.assertIsNone(err)

        self.db.increment_counters(acc["id"])
        self.db.increment_counters(acc["id"])

        allowed2, err2 = self.db.check_rate_limit(acc["id"], hourly_limit=2, daily_limit=5)
        self.assertFalse(allowed2)
        self.assertIn("Batas per jam", err2 or "")

        # Simulasi pergantian jam -> hourly reset, daily bertahan
        next_hour = (datetime.now(WIB) + timedelta(hours=1)).strftime("%Y-%m-%d %H:00:00")
        self.db.update_account(acc["id"], last_reset_at=(datetime.now(WIB) - timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S"))
        reset_acc = self.db.reset_quotas_if_due(
            acc["id"],
            ref_now=datetime.strptime(next_hour, "%Y-%m-%d %H:%M:%S").replace(tzinfo=WIB),
        )
        self.assertEqual(reset_acc["hourly_count"], 0)
        self.assertEqual(reset_acc["daily_count"], 2)

        self.assertTrue(self.db.delete_account(acc["id"]))
        self.assertIsNone(self.db.get_account(acc["id"]))

    def test_24h_recipient_cooldown(self):
        acc = self.db.create_account("WA Cadangan")
        now = datetime.now(WIB)
        self.assertFalse(self.db.has_sent_recipient_within_hours("628999000111", hours=24, ref_now=now))
        self.db.record_recipient_sent(acc["id"], "628999000111", ref_now=now)
        self.assertTrue(self.db.has_sent_recipient_within_hours("628999000111", hours=24, ref_now=now + timedelta(hours=3)))
        self.assertFalse(self.db.has_sent_recipient_within_hours("628999000111", hours=24, ref_now=now + timedelta(hours=25)))

    def test_selectors_have_fallbacks(self):
        self.assertGreaterEqual(len(selectors.QR_CANVAS_SELECTORS), 3)
        self.assertGreaterEqual(len(selectors.CHAT_LIST_SELECTORS), 3)
        self.assertGreaterEqual(len(selectors.MESSAGE_INPUT_SELECTORS), 3)
        self.assertGreaterEqual(len(selectors.SEND_BUTTON_SELECTORS), 3)
        self.assertGreater(config.MAX_CHROME, 0)

    def test_sender_guards_and_eviction(self):
        mgr = AccountManager(db=self.db, start_monitor=False)
        acc = self.db.create_account("WA Guru Piket", "62855112233")
        self.db.update_account(acc["id"], status="CONNECTED")

        fake_worker = MagicMock()
        fake_worker.is_alive.return_value = True
        mgr.ensure_worker_connected = MagicMock(return_value=fake_worker)

        code1, res1 = send_message_with_guards(mgr, acc["id"], "0812-8888-9999", "Halo wali murid")
        self.assertEqual(code1, 200)
        self.assertTrue(res1["ok"])
        self.assertEqual(res1["to"], "6281288889999")
        fake_worker.send_message.assert_called_once_with("6281288889999", "Halo wali murid")

        # Kirim ke nomor tujuan yang sama dalam 24 jam -> ditolak HTTP 429 anti-spam
        code2, res2 = send_message_with_guards(mgr, acc["id"], "6281288889999", "Pesan duplikat")
        self.assertEqual(code2, 429)
        self.assertFalse(res2["ok"])
        self.assertIn("Anti-spam 24 jam", res2["error"])

        # Pause akun -> ditolak HTTP 409
        mgr.pause_account(acc["id"])
        code3, res3 = send_message_with_guards(mgr, acc["id"], "6281300001111", "Tes paused")
        self.assertEqual(code3, 409)
        self.assertIn("PAUSE", res3["error"])

        # Delete akun menghapus folder sesi
        user_dir = Path(acc["user_data_dir"])
        self.assertTrue(user_dir.exists())
        self.assertTrue(mgr.delete_account(acc["id"]))
        self.assertFalse(user_dir.exists())

    def test_hardcoded_defaults_and_file_token(self):
        import importlib.util

        self.assertEqual(config.DEFAULT_PORT, 8003)
        self.assertEqual(config.PORT, 8003)
        self.assertEqual(config.DEFAULT_MAX_CHROME, 3)
        self.assertEqual(config.MAX_CHROME, 3)

        root = Path(self.tmpdir.name)
        secrets_dir = root / "secrets"
        secrets_dir.mkdir(parents=True, exist_ok=True)
        token_file = secrets_dir / "internal_token"
        token_file.write_text("file-secret-token-xyz\n", encoding="utf-8")

        prev_storage = config.STORAGE_DIR
        prev_container = config.CONTAINER_INTERNAL_TOKEN_FILE
        prev_env_token = os.environ.get("INTERNAL_TOKEN")
        os.environ["INTERNAL_TOKEN"] = "env-must-be-ignored"
        try:
            config.STORAGE_DIR = root
            config.CONTAINER_INTERNAL_TOKEN_FILE = root / "missing" / "internal_token"
            self.assertEqual(config.load_internal_token(), "file-secret-token-xyz")

            if importlib.util.find_spec("flask") is not None:
                from app import create_app

                mgr = AccountManager(db=self.db, start_monitor=False)
                flask_app = create_app(manager=mgr)
                client = flask_app.test_client()

                resp_unauth = client.get("/accounts")
                self.assertEqual(resp_unauth.status_code, 401)

                resp_bad = client.get("/accounts", headers={"X-Internal-Token": "env-must-be-ignored"})
                self.assertEqual(resp_bad.status_code, 401)

                resp_ok = client.get("/accounts", headers={"X-Internal-Token": "file-secret-token-xyz"})
                self.assertEqual(resp_ok.status_code, 200)
                self.assertTrue(resp_ok.get_json()["ok"])
        finally:
            config.STORAGE_DIR = prev_storage
            config.CONTAINER_INTERNAL_TOKEN_FILE = prev_container
            if prev_env_token is None:
                os.environ.pop("INTERNAL_TOKEN", None)
            else:
                os.environ["INTERNAL_TOKEN"] = prev_env_token


if __name__ == "__main__":
    unittest.main()
