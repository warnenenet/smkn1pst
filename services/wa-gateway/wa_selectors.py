"""
Selector WhatsApp Web terpusat dengan fallback berlapis.
Jika WhatsApp Web mengubah DOM, cukup perbarui daftar kandidat di file ini.
"""

QR_CANVAS_SELECTORS = [
    'canvas[aria-label*="Scan"]',
    'canvas[aria-label*="QR"]',
    'div[data-ref] canvas',
    'div[data-testid="qrcode"] canvas',
    'canvas[role="img"]',
    "canvas",
]

QR_CONTAINER_SELECTORS = [
    "div[data-ref]",
    'div[data-testid="qrcode"]',
    'div[aria-label*="Scan"]',
]

QR_RELOAD_SELECTORS = [
    'button[data-testid="refresh-large"]',
    'span[data-icon="refresh-large"]',
    'button[aria-label*="Reload QR"]',
    'button[aria-label*="Muat ulang QR"]',
    "div[data-ref] button",
]

CHAT_LIST_SELECTORS = [
    'div[data-testid="chat-list"]',
    'div[aria-label="Chat list"]',
    'div[aria-label="Daftar chat"]',
    "#pane-side",
    'div[role="grid"][aria-label]',
]

LOGGED_OUT_SELECTORS = [
    'div[data-testid="intro-wrapper"]',
    "div[data-ref]",
    'canvas[aria-label*="Scan"]',
]

PROFILE_MENU_SELECTORS = [
    'button[aria-label*="Profile"]',
    'button[aria-label*="Profil"]',
    'div[data-testid="menu-bar-user"]',
    'header img[draggable="false"]',
]

PROFILE_PHONE_SELECTORS = [
    'div[data-testid="drawer-left"] span[dir="ltr"]',
    'span[data-testid="selectable-text"]',
]

MESSAGE_INPUT_SELECTORS = [
    'footer div[contenteditable="true"][data-tab="10"]',
    'div[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"][role="textbox"]',
    'div[title="Type a message"]',
    'div[title="Ketik pesan"]',
    'footer div[contenteditable="true"]',
]

SEND_BUTTON_SELECTORS = [
    'button[data-testid="compose-btn-send"]',
    'button[aria-label="Send"]',
    'button[aria-label="Kirim"]',
    'span[data-icon="send"]',
    'footer button span[data-icon="wds-ic-send-filled"]',
]

INVALID_NUMBER_POPUP_SELECTORS = [
    'div[data-testid="popup-contents"]',
    'div[role="dialog"]',
]

INVALID_NUMBER_KEYWORDS = (
    "phone number shared via url is invalid",
    "nomor telepon yang dibagikan melalui tautan tidak valid",
    "tidak terdaftar di whatsapp",
    "url is invalid",
)

SENT_TICK_SELECTORS = [
    'span[data-icon="msg-check"]',
    'span[data-icon="msg-dblcheck"]',
    'span[data-icon="msg-time"]',
]

BANNED_KEYWORDS = (
    "temporarily banned",
    "diblokir sementara",
    "account has been banned",
    "akun ini tidak dapat menggunakan whatsapp",
    "this account cannot use whatsapp",
)
