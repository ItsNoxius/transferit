/**
 * MegaAPI — low-level client for the MEGA bt7 API used by transfer.it.
 * Port of transferit-py `_api.py`. Isomorphic (browser + Node).
 */

import {
  a32ToB64,
  a32ToBytes,
  b64urlDecode,
  b64urlEncode,
  bytesEqual,
  bytesToA32,
  condenseMacs,
  concatBytes,
  decryptAttr,
  encryptAttr,
  encryptKeyEcb,
  pbkdf2Sha256,
  randA32,
  utf8Encode,
  utf8Decode,
} from "./crypto.js";
import { MegaAPIError } from "./errors.js";

export const API_BASE = "https://bt7.api.mega.co.nz/";
export const SHARE_BASE = "https://transfer.it";

const VERSION = "0.1.0";
const USER_AGENT = `@noxius/transferit/${VERSION} (+https://github.com/ItsNoxius/transferit)`;

const XH_RE = /(?:\/t\/|^)([A-Za-z0-9_-]{12})(?:[/?#]|$)/;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApiPayload = Record<string, JsonValue>;

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

export class MegaAPI {
  base: string;
  seqno: number;
  sid: string | null = null;
  private masterKey: number[] | null = null;
  private sessionPromise: Promise<number[]> | null = null;
  private readonly timeoutMs: number;

  constructor(base = API_BASE, opts?: { timeout?: number }) {
    this.base = base;
    this.seqno = randomInt(1_000_000_000);
    this.timeoutMs = (opts?.timeout ?? 60) * 1000;
  }

  close(): void {
    // fetch has no persistent client to close
  }

  private nextSeqno(): number {
    this.seqno += 1;
    return this.seqno;
  }

  async req(
    payload: ApiPayload | ApiPayload[],
    opts?: { x?: string | null; pw?: string | null },
  ): Promise<JsonValue> {
    const params = new URLSearchParams({ id: String(this.nextSeqno()) });
    if (opts?.x != null) {
      params.set("x", opts.x);
      if (opts.pw != null) params.set("pw", opts.pw);
    } else if (this.sid) {
      params.set("sid", this.sid);
    }

    const body = Array.isArray(payload) ? payload : [payload];
    let data: JsonValue = null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Browsers forbid setting User-Agent; Node fetch accepts it.
    if (typeof document === "undefined") {
      headers["User-Agent"] = USER_AGENT;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const ctrl = AbortSignal.timeout(this.timeoutMs);
      const r = await fetch(`${this.base}cs?${params}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl,
      });
      if (!r.ok) {
        throw new MegaAPIError(`HTTP ${r.status} ${r.statusText}`);
      }
      data = (await r.json()) as JsonValue;

      let code: number | null = null;
      if (typeof data === "number") code = data;
      else if (
        Array.isArray(data) &&
        data.length === 1 &&
        typeof data[0] === "number"
      ) {
        code = data[0];
      }

      if (code != null && code < 0) {
        if (code === -3 && attempt < 4) {
          await sleep(1000 + attempt * 1000);
          continue;
        }
        throw MegaAPIError.fromCode(code);
      }
      break;
    }

    return Array.isArray(payload) ? data : (data as JsonValue[])[0]!;
  }

  async createEphemeralSession(): Promise<number[]> {
    if (this.sid != null && this.masterKey) return this.masterKey;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = this.doCreateSession();
    try {
      return await this.sessionPromise;
    } finally {
      this.sessionPromise = null;
    }
  }

  private async doCreateSession(): Promise<number[]> {
    if (this.sid != null && this.masterKey) return this.masterKey;

    const masterKey = randA32(4);
    const pwKey = randA32(4);
    const ssc = randA32(4);

    const kEnc = encryptKeyEcb(a32ToBytes(pwKey), masterKey);
    const sscEnc = encryptKeyEcb(a32ToBytes(masterKey), ssc);
    const ts = concatBytes(a32ToBytes(ssc), a32ToBytes(sscEnc));

    const userHandle = await this.req({
      a: "up",
      k: a32ToB64(kEnc),
      ts: b64urlEncode(ts),
    });
    if (typeof userHandle !== "string") {
      throw new MegaAPIError(`up returned unexpected: ${JSON.stringify(userHandle)}`);
    }

    const res = await this.req({ a: "us", user: userHandle });
    if (
      typeof res !== "object" ||
      res === null ||
      Array.isArray(res) ||
      !("tsid" in res)
    ) {
      throw new MegaAPIError(`us returned unexpected: ${JSON.stringify(res)}`);
    }

    const tsid = b64urlDecode(String(res.tsid));
    const checkEnc = encryptKeyEcb(
      a32ToBytes(masterKey),
      bytesToA32(tsid.subarray(0, 16)),
    );
    if (!bytesEqual(a32ToBytes(checkEnc), tsid.subarray(tsid.length - 16))) {
      throw new MegaAPIError("tsid verification failed");
    }

    this.sid = String(res.tsid);
    this.masterKey = masterKey;
    return masterKey;
  }

  async createTransfer(
    name: string,
  ): Promise<{ xh: string; rootH: string; folderKey: number[] }> {
    const folderKey = randA32(4);
    const attrs = { name, mtime: Math.floor(Date.now() / 1000) };
    const at = b64urlEncode(encryptAttr(attrs, folderKey));
    const k = a32ToB64(folderKey);

    const res = await this.req({ a: "xn", at, k });
    if (
      !Array.isArray(res) ||
      res.length !== 2 ||
      typeof res[0] !== "string" ||
      typeof res[1] !== "string"
    ) {
      throw new MegaAPIError(`xn returned unexpected: ${JSON.stringify(res)}`);
    }
    return { xh: res[0], rootH: res[1], folderKey };
  }

  async closeTransfer(xh: string): Promise<void> {
    await this.req({ a: "xc", xh });
  }

  async deleteTransfer(xh: string): Promise<void> {
    await this.req({ a: "xd", xh });
  }

  async createSubfolder(parentHandle: string, name: string): Promise<string> {
    const folderKey = randA32(4);
    const attrs = { n: name };
    const at = b64urlEncode(encryptAttr(attrs, folderKey));
    const k = a32ToB64(folderKey);
    const res = await this.req({
      a: "xp",
      t: parentHandle,
      n: [{ t: 1, h: "xxxxxxxx", a: at, k }],
    });
    if (
      typeof res !== "object" ||
      res === null ||
      Array.isArray(res) ||
      !("f" in res)
    ) {
      throw new MegaAPIError(`mkdir failed: ${JSON.stringify(res)}`);
    }
    const f = res.f as { h: string }[];
    return f[0]!.h;
  }

  async finaliseFile(
    transferRoot: string,
    completionToken: Uint8Array,
    ulKey: number[],
    macsOrdered: number[][],
    filename: string,
  ): Promise<Record<string, unknown>> {
    const mac = condenseMacs(macsOrdered, ulKey);
    const filekey = [
      (ulKey[0]! ^ ulKey[4]!) >>> 0,
      (ulKey[1]! ^ ulKey[5]!) >>> 0,
      (ulKey[2]! ^ mac[0]! ^ mac[1]!) >>> 0,
      (ulKey[3]! ^ mac[2]! ^ mac[3]!) >>> 0,
      ulKey[4]!,
      ulKey[5]!,
      (mac[0]! ^ mac[1]!) >>> 0,
      (mac[2]! ^ mac[3]!) >>> 0,
    ];

    const at = b64urlEncode(encryptAttr({ n: filename }, filekey));
    const k = a32ToB64(filekey);
    const h = b64urlEncode(completionToken);

    const res = await this.req({
      a: "xp",
      t: transferRoot,
      n: [{ t: 0, h, a: at, k }],
    });
    if (
      typeof res !== "object" ||
      res === null ||
      Array.isArray(res) ||
      !("f" in res)
    ) {
      throw new MegaAPIError(`xp returned unexpected: ${JSON.stringify(res)}`);
    }
    return res as Record<string, unknown>;
  }

  async setTransferAttributes(
    xh: string,
    opts: {
      title?: string | null;
      message?: string | null;
      password?: string | null;
      sender?: string | null;
      expirySeconds?: number | null;
      notifyBeforeExpirySeconds?: number | null;
      maxDownloads?: number | null;
    },
  ): Promise<JsonValue> {
    const payload: ApiPayload = { a: "xm", xh };

    if (opts.title != null) {
      payload.t = b64urlEncode(utf8Encode(opts.title.trim()));
    }
    if (opts.message != null) {
      payload.m = b64urlEncode(utf8Encode(opts.message.trim()));
    }
    if (opts.sender != null) {
      const se = opts.sender.trim();
      if (se) payload.se = se;
    }
    if (opts.password != null) {
      const pw = opts.password.trim();
      if (pw) payload.pw = await MegaAPI.derivePassword(xh, pw);
    }
    if (opts.expirySeconds != null && opts.expirySeconds > 0) {
      payload.e = Math.trunc(opts.expirySeconds);
    }
    if (opts.notifyBeforeExpirySeconds != null) {
      payload.en =
        opts.notifyBeforeExpirySeconds > 1
          ? opts.notifyBeforeExpirySeconds
          : 3 * 864_000;
    }
    if (opts.maxDownloads != null && opts.maxDownloads > 0) {
      payload.mc = Math.trunc(opts.maxDownloads);
    }

    return this.req(payload);
  }

  async setTransferRecipient(
    xh: string,
    email: string,
    opts?: {
      schedule?: number | null;
      execution?: number | null;
      recipientHandle?: string | null;
    },
  ): Promise<JsonValue> {
    const payload: ApiPayload = { a: "xr", xh, e: email.trim() };
    if (opts?.recipientHandle) payload.rh = opts.recipientHandle;
    if (opts?.schedule != null) payload.s = Math.trunc(opts.schedule);
    if (opts?.execution != null) payload.ex = Math.trunc(opts.execution);
    return this.req(payload);
  }

  async validatePassword(xh: string, pwToken: string): Promise<boolean> {
    return (await this.req({ a: "xv", xh, pw: pwToken })) === 1;
  }

  async fetchTransfer(
    xh: string,
    opts?: { password?: string | null },
  ): Promise<{ nodes: FetchedNode[]; pwToken: string | null }> {
    const pwToken = await this.resolvePw(xh, opts?.password ?? null);
    let data: JsonValue;
    try {
      data = await this.req({ a: "f", c: 1, r: 1 }, { x: xh, pw: pwToken });
    } catch (ex) {
      throw this.translateProtected(ex, pwToken);
    }

    const resp = unwrapDict(data, "fetch");
    const nodes: FetchedNode[] = [];
    const list = (resp.f as Record<string, unknown>[]) ?? [];
    for (const n of list) {
      const kA32 = n.k ? bytesToA32(b64urlDecode(String(n.k))) : [];
      const attrs = n.a && kA32.length ? decryptAttr(String(n.a), kA32) : null;
      nodes.push({
        h: String(n.h),
        p: String(n.p ?? ""),
        t: Number(n.t),
        s: n.s != null ? Number(n.s) : null,
        ts: n.ts != null ? Number(n.ts) : null,
        k: kA32,
        name:
          (attrs?.n as string | undefined) ??
          (attrs?.name as string | undefined) ??
          null,
        raw: n,
      });
    }
    return { nodes, pwToken };
  }

  async fetchTransferInfo(xh: string): Promise<Record<string, unknown>> {
    const data = await this.req({ a: "xi", xh });
    const resp = unwrapDict(data, "xi");
    const info: Record<string, unknown> = { ...resp };

    if (typeof info.t === "string") {
      try {
        info.title = utf8Decode(b64urlDecode(info.t));
      } catch {
        info.title = null;
      }
    }
    if (typeof info.m === "string") {
      try {
        info.message = utf8Decode(b64urlDecode(info.m));
      } catch {
        info.message = null;
      }
    }

    const rawSize = (info.size as unknown[]) ?? [0, 0, 0, 0, 0];
    info.total_bytes = Number(rawSize[0] ?? 0);
    info.file_count = Number(rawSize[1] ?? 0);
    info.folder_count = Number(rawSize[2] ?? 0);
    info.password_protected = Boolean(info.pw);
    info.zip_handle = info.z ?? null;
    info.zip_pending = Boolean(info.zp);
    return info;
  }

  async getDownloadUrl(
    xh: string,
    nodeHandle: string,
    opts?: { pwToken?: string | null },
  ): Promise<Record<string, unknown>> {
    let data: JsonValue;
    try {
      data = await this.req(
        { a: "g", n: nodeHandle, g: 1, ssl: 1 },
        { x: xh, pw: opts?.pwToken ?? null },
      );
    } catch (ex) {
      throw this.translateProtected(ex, opts?.pwToken ?? null);
    }

    const resp = unwrapDict(data, "g");
    if (!("g" in resp)) {
      throw new MegaAPIError(`g error: ${JSON.stringify(resp)}`);
    }
    return resp;
  }

  async uploadPools(): Promise<unknown[]> {
    const data = await this.req({ a: "usc" });
    if (!Array.isArray(data)) {
      throw new MegaAPIError(`usc returned unexpected: ${JSON.stringify(data)}`);
    }
    return data;
  }

  static parseXh(urlOrXh: string): string {
    const s = urlOrXh.trim();
    const m = XH_RE.exec(s);
    if (m) return m[1]!;
    if (/^[A-Za-z0-9_-]{12}$/.test(s)) return s;
    throw new Error(`can't extract transfer handle from ${JSON.stringify(urlOrXh)}`);
  }

  static async derivePassword(xh: string, password: string): Promise<string> {
    const xhBytes = b64urlDecode(xh);
    const tail = xhBytes.subarray(xhBytes.length - 6);
    const salt = concatBytes(tail, tail, tail);
    const dk = await pbkdf2Sha256(utf8Encode(password.trim()), salt, 100_000, 32);
    return b64urlEncode(dk);
  }

  private async resolvePw(
    xh: string,
    password: string | null,
  ): Promise<string | null> {
    if (password == null) return null;
    return MegaAPI.derivePassword(xh, password);
  }

  private translateProtected(
    ex: unknown,
    pwToken: string | null,
  ): MegaAPIError {
    if (ex instanceof MegaAPIError && ex.code === -14) {
      if (pwToken != null) {
        return new MegaAPIError("wrong transfer password", { code: -14 });
      }
      return ex;
    }
    if (ex instanceof MegaAPIError) return ex;
    throw ex;
  }
}

export interface FetchedNode {
  h: string;
  p: string;
  t: number;
  s: number | null;
  ts: number | null;
  k: number[];
  name: string | null;
  raw: Record<string, unknown>;
}

function unwrapDict(data: JsonValue, label: string): Record<string, unknown> {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0]) {
    return data[0] as Record<string, unknown>;
  }
  throw new MegaAPIError(`${label} returned unexpected: ${JSON.stringify(data)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
