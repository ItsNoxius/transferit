/**
 * Raised when the MEGA API returns a numeric error or malformed data.
 * Port of transferit-py `MegaAPIError`.
 */
export class MegaAPIError extends Error {
  static readonly CODES: Record<number, [string, string]> = {
    [-1]: ["EINTERNAL", "server internal error"],
    [-2]: ["EARGS", "invalid arguments"],
    [-3]: ["EAGAIN", "server is busy — try again shortly"],
    [-4]: ["ERATELIMIT", "rate-limited by the server"],
    [-5]: ["EFAILED", "operation failed"],
    [-6]: ["ETOOMANY", "too many requests"],
    [-7]: ["ERANGE", "out of range"],
    [-8]: ["EEXPIRED", "transfer has expired"],
    [-9]: [
      "ENOENT",
      "transfer not found (wrong handle, or it was deleted / expired)",
    ],
    [-10]: ["ECIRCULAR", "circular reference"],
    [-11]: ["EACCESS", "access denied"],
    [-12]: ["EEXIST", "already exists"],
    [-13]: ["EINCOMPLETE", "incomplete request"],
    [-14]: [
      "EKEY",
      "this transfer is password-protected — pass a password",
    ],
    [-15]: [
      "ESID",
      "invalid session — the ephemeral account may have been evicted",
    ],
    [-16]: ["EBLOCKED", "transfer was blocked (abuse report)"],
    [-17]: ["EOVERQUOTA", "quota exceeded"],
    [-18]: ["ETEMPUNAVAIL", "temporarily unavailable"],
    [-19]: ["ETOOMANYCONNECTIONS", "too many connections"],
  };

  readonly code: number | null;
  /** Canonical short label (EKEY, ENOENT, …) when a numeric code is set. */
  readonly codeName: string;

  constructor(message?: string | null, opts?: { code?: number | null }) {
    const code = opts?.code ?? null;
    const entry = code != null ? MegaAPIError.CODES[code] : undefined;
    let msg = message ?? undefined;
    if (msg == null) {
      if (entry) msg = entry[1];
      else if (code != null) msg = `API error ${code}`;
      else msg = "MEGA API error";
    }
    super(msg);
    this.code = code;
    this.codeName = entry?.[0] ?? "";
    this.name = "MegaAPIError";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static fromCode(code: number): MegaAPIError {
    return new MegaAPIError(null, { code });
  }
}
