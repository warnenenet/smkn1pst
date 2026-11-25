import random
import re
import threading
import time
from typing import Any, Optional, Tuple
from urllib.parse import quote

import anti_detect
import config
import qr_extractor
import wa_selectors as selectors

logger = config.setup_logger("wa_gateway.worker")


def clean_phone_digits(raw: str) -> str:
    digits = re.sub(r"[^0-9]", "", str(raw or ""))
    if digits.startswith("08"):
        digits = "62" + digits[1:]
    elif digits.startswith("8") and len(digits) >= 9:
        digits = "62" + digits
    return digits


class SeleniumWorker:
    """Mengelola satu proses Chromium + profil user-data-dir untuk 1 akun WA."""

    def __init__(self, account_id: int, user_data_dir: str):
        self.account_id = account_id
        self.user_data_dir = user_data_dir
        self.driver: Any = None
        self.xvfb: Optional[anti_detect.XvfbDisplay] = None
        self.engine_mode: str = "uninitialized"
        self.lock = threading.RLock()
        self.last_qr_hash: Optional[str] = None
        self.last_qr_base64: Optional[str] = None
        self.last_qr_updated_at: Optional[str] = None

    def is_alive(self) -> bool:
        if self.driver is None:
            return False
        try:
            _ = self.driver.current_url
            return True
        except Exception:
            return False

    def _find_visible(self, css_list: list[str]) -> Optional[Any]:
        for css in css_list:
            try:
                els = self.driver.find_elements("css selector", css)
                for el in els:
                    if el.is_displayed():
                        return el
            except Exception:
                continue
        return None

    def _is_logged_in(self) -> bool:
        return self._find_visible(selectors.CHAT_LIST_SELECTORS) is not None

    def _detect_ban_message(self) -> Optional[str]:
        try:
            body_text = (self.driver.execute_script("return document.body ? document.body.innerText : '';") or "").lower()
            for kw in selectors.BANNED_KEYWORDS:
                if kw in body_text:
                    return f"Akun terdeteksi diblokir/dibatasi WhatsApp ({kw})."
        except Exception:
            pass
        return None

    def _click_qr_reload_if_present(self) -> bool:
        btn = self._find_visible(selectors.QR_RELOAD_SELECTORS)
        if btn is not None:
            try:
                btn.click()
                return True
            except Exception:
                pass
        return False

    def extract_connected_phone(self) -> Optional[str]:
        if not self.driver:
            return None
        try:
            wid = self.driver.execute_script(
                """
                try {
                    const keys = ['last-wid-md', 'last-wid', 'WAWebUserJid'];
                    for (const k of keys) {
                        const v = window.localStorage.getItem(k);
                        if (v) return v;
                    }
                } catch (e) {}
                return null;
                """
            )
            if isinstance(wid, str):
                m = re.search(r"(\d{8,15})", wid)
                if m:
                    return m.group(1)
        except Exception:
            pass
        return None

    def start(self, wait_timeout: int = config.QR_WAIT_TIMEOUT_SEC) -> Tuple[str, Optional[str]]:
        """
        Membuka web.whatsapp.com dan menunggu hingga status 'CONNECTED' atau 'QR_READY'.
        Jika headless gagal memunculkan QR/chat, otomatis fallback ke Xvfb non-headless.
        """
        with self.lock:
            self.stop()
            try:
                return self._launch_and_detect(headless=True, wait_timeout=wait_timeout)
            except Exception as headless_err:
                logger.warning(
                    "[Acc #%s] Mode headless gagal (%s); memeriksa fallback Xvfb...",
                    self.account_id,
                    headless_err,
                )
                self.stop()
                if config.ENABLE_XVFB_FALLBACK and anti_detect.is_xvfb_available():
                    return self._launch_and_detect(headless=False, wait_timeout=wait_timeout)
                raise

    def _launch_and_detect(self, headless: bool, wait_timeout: int) -> Tuple[str, Optional[str]]:
        display_env: Optional[str] = None
        if not headless:
            self.xvfb = anti_detect.XvfbDisplay()
            display_env = self.xvfb.start()
            if not display_env:
                raise RuntimeError("Xvfb tidak dapat dijalankan untuk mode non-headless.")

        self.driver, self.engine_mode = anti_detect.create_stealth_driver(
            user_data_dir=self.user_data_dir,
            headless=headless,
            display_env=display_env,
        )
        self.driver.set_page_load_timeout(max(30, wait_timeout + 10))
        self.driver.get(config.WHATSAPP_WEB_URL)

        deadline = time.time() + wait_timeout
        while time.time() < deadline:
            ban_msg = self._detect_ban_message()
            if ban_msg:
                raise RuntimeError(ban_msg)

            if self._is_logged_in():
                phone = self.extract_connected_phone()
                return "CONNECTED", phone

            self._click_qr_reload_if_present()
            data_url, digest = qr_extractor.extract_qr_base64_and_save(self.driver, self.account_id)
            if data_url:
                self.last_qr_base64 = data_url
                self.last_qr_hash = digest
                self.last_qr_updated_at = time.strftime("%Y-%m-%d %H:%M:%S")
                return "QR_READY", None

            time.sleep(1.0)

        raise RuntimeError(
            "Timeout menunggu QR atau sesi WhatsApp Web. "
            "Periksa koneksi internet server atau perubahan selector DOM di wa_selectors.py."
        )

    def poll_state(self) -> Tuple[str, Optional[str], Optional[str]]:
        """
        Memeriksa status terkini tanpa memblokir lama.
        Return: (status, qr_base64_or_None, phone_or_None)
        """
        with self.lock:
            if not self.is_alive():
                return "DISCONNECTED", None, None

            ban_msg = self._detect_ban_message()
            if ban_msg:
                raise RuntimeError(ban_msg)

            if self._is_logged_in():
                phone = self.extract_connected_phone()
                return "CONNECTED", None, phone

            self._click_qr_reload_if_present()
            data_url, digest = qr_extractor.extract_qr_base64_and_save(self.driver, self.account_id)
            if data_url:
                if digest != self.last_qr_hash:
                    self.last_qr_hash = digest
                    self.last_qr_updated_at = time.strftime("%Y-%m-%d %H:%M:%S")
                self.last_qr_base64 = data_url
                return "QR_READY", data_url, None

            return "NEW", self.last_qr_base64, None

    def ensure_connected(self, timeout_sec: int = config.CHAT_LOAD_TIMEOUT_SEC) -> Optional[str]:
        with self.lock:
            if not self.is_alive():
                status, phone = self.start(wait_timeout=timeout_sec)
                if status != "CONNECTED":
                    raise RuntimeError("Sesi WhatsApp belum login (QR perlu di-scan ulang).")
                return phone

            if self._is_logged_in():
                return self.extract_connected_phone()

            deadline = time.time() + timeout_sec
            while time.time() < deadline:
                if self._is_logged_in():
                    return self.extract_connected_phone()
                data_url, _ = qr_extractor.extract_qr_base64_and_save(self.driver, self.account_id)
                if data_url:
                    raise RuntimeError("Sesi WhatsApp Web logout dan meminta scan ulang QR.")
                time.sleep(1.0)

            raise RuntimeError("Timeout menunggu chat list WhatsApp Web termuat.")

    def send_message(self, to_phone: str, message: str) -> None:
        clean_to = clean_phone_digits(to_phone)
        if len(clean_to) < 9:
            raise ValueError("Nomor tujuan tidak valid.")

        with self.lock:
            self.ensure_connected(config.CHAT_LOAD_TIMEOUT_SEC)
            encoded_text = quote(message, safe="")
            target_url = f"https://web.whatsapp.com/send?phone={clean_to}&text={encoded_text}"
            self.driver.get(target_url)

            deadline = time.time() + config.SEND_TIMEOUT_SEC
            send_btn = None
            input_box = None

            while time.time() < deadline:
                # Cek popup nomor tidak terdaftar
                for css in selectors.INVALID_NUMBER_POPUP_SELECTORS:
                    try:
                        popups = self.driver.find_elements("css selector", css)
                        for p in popups:
                            if not p.is_displayed():
                                continue
                            txt = (p.text or "").lower()
                            if any(kw in txt for kw in selectors.INVALID_NUMBER_KEYWORDS):
                                raise ValueError(f"Nomor tujuan {clean_to} tidak terdaftar di WhatsApp.")
                    except ValueError:
                        raise
                    except Exception:
                        pass

                send_btn = self._find_visible(selectors.SEND_BUTTON_SELECTORS)
                input_box = self._find_visible(selectors.MESSAGE_INPUT_SELECTORS)
                if send_btn is not None or input_box is not None:
                    break
                time.sleep(0.7)

            if send_btn is None and input_box is None:
                raise RuntimeError(
                    "Elemen input/tombol kirim WhatsApp Web tidak muncul (timeout 20 dtk)."
                )

            # Delay manusiawi acak 3-8 detik sebelum klik Kirim
            human_delay = random.uniform(config.HUMAN_DELAY_MIN_SEC, config.HUMAN_DELAY_MAX_SEC)
            time.sleep(human_delay)

            sent_clicked = False
            send_btn = self._find_visible(selectors.SEND_BUTTON_SELECTORS)
            if send_btn is not None:
                try:
                    send_btn.click()
                    sent_clicked = True
                except Exception:
                    sent_clicked = False

            if not sent_clicked and input_box is not None:
                from selenium.webdriver.common.keys import Keys  # type: ignore

                input_box.send_keys(Keys.ENTER)
                sent_clicked = True

            if not sent_clicked:
                raise RuntimeError("Gagal menekan tombol kirim maupun Enter pada kotak pesan.")

            # Tunggu sejenak agar request WebSocket WA keluar sebelum pindah URL
            time.sleep(1.5)

    def stop(self) -> None:
        with self.lock:
            if self.driver is not None:
                try:
                    self.driver.quit()
                except Exception:
                    pass
                self.driver = None
            if self.xvfb is not None:
                self.xvfb.stop()
                self.xvfb = None
