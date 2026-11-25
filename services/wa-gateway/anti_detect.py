import os
from pathlib import Path
import random
import shutil
import subprocess
import time
from typing import Any, Optional, Tuple

import config

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def find_chromium_binary() -> Optional[str]:
    if config.CHROME_BIN and Path(config.CHROME_BIN).exists():
        return config.CHROME_BIN
    for name in (
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ):
        found = shutil.which(name) or (name if Path(name).exists() else None)
        if found:
            return found
    return None


def find_chromedriver_binary() -> Optional[str]:
    if config.CHROMEDRIVER_BIN and Path(config.CHROMEDRIVER_BIN).exists():
        return config.CHROMEDRIVER_BIN
    for name in ("chromedriver", "/usr/bin/chromedriver", "/usr/local/bin/chromedriver"):
        found = shutil.which(name) or (name if Path(name).exists() else None)
        if found:
            return found
    return None


def is_xvfb_available() -> bool:
    return shutil.which("Xvfb") is not None or shutil.which("xvfb-run") is not None


class XvfbDisplay:
    """Mengelola virtual display Xvfb untuk fallback mode non-headless."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self.display: Optional[str] = None

    def start(self) -> Optional[str]:
        if os.environ.get("DISPLAY"):
            self.display = os.environ["DISPLAY"]
            return self.display
        xvfb_bin = shutil.which("Xvfb")
        if not xvfb_bin:
            return None
        display_num = random.randint(90, 199)
        disp = f":{display_num}"
        self._proc = subprocess.Popen(
            [xvfb_bin, disp, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.6)
        if self._proc.poll() is not None:
            self._proc = None
            return None
        self.display = disp
        return disp

    def stop(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None


def build_common_chrome_args(user_data_dir: str, headless: bool = True) -> list[str]:
    w = 1280 + random.randint(-20, 20)
    h = 800 + random.randint(-20, 20)
    args = [
        f"--user-data-dir={user_data_dir}",
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        f"--window-size={w},{h}",
        "--lang=id-ID,id,en-US",
        "--disable-infobars",
        "--disable-notifications",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        # Batasi disk cache per Chrome profile agar hemat SSD (<10 GB budget)
        "--disk-cache-size=33554432",
        f"--user-agent={USER_AGENT}",
    ]
    if headless:
        args.append("--headless=new")
    return args


def apply_cdp_stealth(driver: Any) -> None:
    stealth_js = """
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', {
        get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ]
    });
    window.chrome = window.chrome || { runtime: {} };
    """
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": stealth_js},
        )
    except Exception:
        pass


def create_stealth_driver(
    user_data_dir: str,
    headless: bool = True,
    display_env: Optional[str] = None,
) -> Tuple[Any, str]:
    """
    Membuat instance browser Chromium anti-deteksi.
    Urutan prioritas: undetected_chromedriver -> Selenium 4 + CDP spoofing.
    """
    Path(user_data_dir).mkdir(parents=True, exist_ok=True)
    chrome_bin = find_chromium_binary()
    driver_bin = find_chromedriver_binary()

    if not chrome_bin:
        raise RuntimeError(
            "Binary Chromium/Chrome tidak ditemukan di sistem. "
            "Jalankan: sudo apt-get install -y chromium chromium-driver"
        )

    prev_display = os.environ.get("DISPLAY")
    if display_env:
        os.environ["DISPLAY"] = display_env

    try:
        try:
            import undetected_chromedriver as uc  # type: ignore

            uc_opts = uc.ChromeOptions()
            for arg in build_common_chrome_args(user_data_dir, headless=headless):
                uc_opts.add_argument(arg)
            uc_opts.binary_location = chrome_bin

            kwargs = {
                "options": uc_opts,
                "headless": headless,
                "use_subprocess": True,
                "browser_executable_path": chrome_bin,
            }
            if driver_bin:
                kwargs["driver_executable_path"] = driver_bin

            driver = uc.Chrome(**kwargs)
            apply_cdp_stealth(driver)
            return driver, "undetected-chromedriver"
        except Exception:
            # Fallback: Selenium 4 standar + CDP spoofing penuh
            from selenium import webdriver  # type: ignore
            from selenium.webdriver.chrome.options import Options  # type: ignore
            from selenium.webdriver.chrome.service import Service  # type: ignore

            opts = Options()
            opts.binary_location = chrome_bin
            for arg in build_common_chrome_args(user_data_dir, headless=headless):
                opts.add_argument(arg)
            opts.add_experimental_option("excludeSwitches", ["enable-automation"])
            opts.add_experimental_option("useAutomationExtension", False)

            service = Service(executable_path=driver_bin) if driver_bin else Service()
            driver = webdriver.Chrome(service=service, options=opts)
            apply_cdp_stealth(driver)
            return driver, "selenium-stealth"
    finally:
        if display_env:
            if prev_display is None:
                os.environ.pop("DISPLAY", None)
            else:
                os.environ["DISPLAY"] = prev_display
