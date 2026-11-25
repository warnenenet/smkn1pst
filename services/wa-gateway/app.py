import atexit
import hmac
import os
from typing import Optional

from flask import Flask, jsonify, request

import anti_detect
import config
from manager import AccountManager
from sender import send_message_with_guards

logger = config.setup_logger("wa_gateway.app")


def create_app(manager: Optional[AccountManager] = None, internal_token: Optional[str] = None) -> Flask:
    app = Flask(__name__)
    mgr = manager or AccountManager()

    if manager is None:
        atexit.register(mgr.shutdown)

    @app.before_request
    def check_auth():
        if request.path == "/health":
            return None
        expected_token = internal_token if internal_token is not None else config.load_internal_token()
        if expected_token:
            provided = request.headers.get("X-Internal-Token", "")
            if not hmac.compare_digest(provided, expected_token):
                return jsonify({"ok": False, "error": "Unauthorized: X-Internal-Token tidak valid."}), 401
        return None

    @app.errorhandler(Exception)
    def handle_unexpected_error(err: Exception):
        logger.exception("Unhandled Flask error: %s", err)
        return jsonify({"ok": False, "error": str(err)}), 500

    @app.get("/health")
    def health():
        accounts = mgr.db.list_accounts()
        connected = sum(1 for a in accounts if a.get("status") == "CONNECTED")
        return jsonify(
            {
                "ok": True,
                "service": "wa-gateway",
                "active_browsers": mgr.active_browser_count(),
                "max_chrome": config.MAX_CHROME,
                "accounts_total": len(accounts),
                "accounts_connected": connected,
                "chromium_bin": anti_detect.find_chromium_binary(),
                "xvfb_available": anti_detect.is_xvfb_available(),
            }
        )

    @app.post("/accounts")
    def create_account():
        body = request.get_json(silent=True) or {}
        label = str(body.get("label") or "").strip()
        if not label:
            return jsonify({"ok": False, "error": "Field 'label' wajib diisi."}), 400
        phone = body.get("phone_number")
        acc = mgr.create_account(label=label, phone_number=str(phone) if phone else None)
        return (
            jsonify(
                {
                    "ok": True,
                    "id": acc["id"],
                    "label": acc["label"],
                    "status": acc["status"],
                    "phone_number": acc.get("phone_number"),
                    "qr_updated_at": acc.get("qr_updated_at"),
                }
            ),
            201,
        )

    @app.get("/accounts")
    def list_accounts():
        accounts = mgr.db.list_accounts()
        return jsonify({"ok": True, "accounts": accounts})

    @app.get("/accounts/<int:account_id>")
    def get_account(account_id: int):
        acc = mgr.db.get_account(account_id)
        if not acc:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify({"ok": True, "account": acc, "logs": mgr.db.list_logs(account_id, limit=25)})

    @app.get("/accounts/<int:account_id>/qr")
    def get_account_qr(account_id: int):
        payload = mgr.get_qr_payload(account_id)
        if not payload:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify(payload)

    @app.post("/accounts/<int:account_id>/reconnect")
    def reconnect_account(account_id: int):
        acc = mgr.reconnect_account(account_id)
        if not acc:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify({"ok": True, "id": acc["id"], "status": acc["status"]})

    @app.post("/accounts/<int:account_id>/pause")
    def pause_account(account_id: int):
        acc = mgr.pause_account(account_id)
        if not acc:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify({"ok": True, "id": acc["id"], "status": acc["status"]})

    @app.post("/accounts/<int:account_id>/resume")
    def resume_account(account_id: int):
        acc = mgr.resume_account(account_id)
        if not acc:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify({"ok": True, "id": acc["id"], "status": acc["status"]})

    @app.delete("/accounts/<int:account_id>")
    def delete_account(account_id: int):
        deleted = mgr.delete_account(account_id)
        if not deleted:
            return jsonify({"ok": False, "error": "Akun tidak ditemukan."}), 404
        return jsonify({"ok": True, "deleted_id": account_id})

    @app.post("/send")
    def send_message():
        body = request.get_json(silent=True) or {}
        try:
            account_id = int(body.get("account_id") or 0)
        except (TypeError, ValueError):
            account_id = 0
        to_phone = str(body.get("to") or body.get("phone") or "").strip()
        message = str(body.get("message") or "").strip()
        if account_id <= 0 or not to_phone or not message:
            return (
                jsonify({"ok": False, "error": "Field 'account_id', 'to', dan 'message' wajib diisi."}),
                400,
            )
        code, result = send_message_with_guards(mgr, account_id, to_phone, message)
        return jsonify(result), code

    return app


app = None if os.environ.get("WA_GATEWAY_TESTING") == "1" else create_app()


if __name__ == "__main__":
    if app is None:
        app = create_app()
    app.run(host=config.HOST, port=config.PORT, threaded=True)
