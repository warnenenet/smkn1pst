export function cleanPhoneDigits(raw: string | null | undefined): string {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('08')) {
    digits = `62${digits.slice(1)}`;
  } else if (digits.startsWith('8') && digits.length >= 9) {
    digits = `62${digits}`;
  }
  return digits;
}

export function extractPhoneFromWaJid(jid: string | null | undefined): string | null {
  if (!jid || typeof jid !== 'string') return null;
  const userPart = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = userPart.replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 16 ? digits : null;
}

export function isTransientGatewayFetchError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const lower = msg.trim().toLowerCase();
  return (
    lower === 'fetch failed' ||
    lower.includes('econnrefused') ||
    lower.includes('python wa gateway') ||
    lower.includes('timeout menghubungi layanan python')
  );
}
