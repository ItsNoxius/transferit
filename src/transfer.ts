/** Duration parsing and expiry-range constants. Port of `_transfer.py`. */

export const MIN_EXPIRY_SECONDS = 1;
export const MAX_EXPIRY_SECONDS = 3650 * 86400; // 10 years

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 86400 * 7,
  y: 86400 * 365,
};

const DURATION_TOKEN_RE = /(?:(\d+)\s*([smhdwy]))/gi;

export function parseDuration(text: string): number {
  if (text == null) throw new Error("empty duration");
  const s = String(text).trim().toLowerCase().replace(/ /g, "");
  if (!s) throw new Error("empty duration");
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);

  let total = 0;
  let consumed = 0;
  DURATION_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DURATION_TOKEN_RE.exec(s)) !== null) {
    const unit = m[2]!.toLowerCase();
    total += Number.parseInt(m[1]!, 10) * DURATION_UNITS[unit]!;
    consumed += m[0].length;
  }
  if (consumed !== s.length) {
    throw new Error(
      `can't parse duration ${JSON.stringify(text)}; use e.g. 30s, 5m, 2h, 7d, 1w, 1y`,
    );
  }
  return total;
}

export function castExpirySeconds(seconds: number | null | undefined): number | null {
  if (seconds == null || seconds === 0) return null;
  if (seconds < MIN_EXPIRY_SECONDS || seconds > MAX_EXPIRY_SECONDS) {
    throw new Error(
      `expiry ${seconds}s out of range [${MIN_EXPIRY_SECONDS}s .. ${MAX_EXPIRY_SECONDS}s (${MAX_EXPIRY_SECONDS / 86400} days)]`,
    );
  }
  return seconds;
}
