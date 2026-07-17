/**
 * Low-level crypto primitives shared by every higher-level module.
 * Port of transferit-py `_crypto.py` — AES-128-CTR + CCM-style CBC-MAC.
 * Isomorphic (no node:crypto / zlib).
 */

import {
  aesCbcEncrypt,
  aesCbcEncryptZeroIv,
  aesCbcDecryptZeroIv,
  aesCtr,
  aesEcbDecrypt,
  aesEcbEncrypt,
} from "./aes.js";
import { crc32 } from "./crc32.js";

export const ONE_MB = 1_048_576;

function buildChunkmap(): Map<number, number> {
  const res = new Map<number, number>();
  let p = 0;
  let dp = 0;
  while (dp < 1_048_576) {
    dp += 131_072;
    res.set(p, dp);
    p += dp;
  }
  return res;
}

/** First 8 chunks grow 128 KiB → 1 MiB; everything after is 1 MiB. */
export const CHUNKMAP: ReadonlyMap<number, number> = buildChunkmap();

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

// ---------- base64url ----------

export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  const b64 =
    typeof btoa === "function"
      ? btoa(s)
      : Buffer.from(b).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string | Uint8Array): Uint8Array {
  const str = typeof s === "string" ? s : utf8Decode(s);
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------- a32 (big-endian uint32 array) ----------

export function a32ToBytes(a: number[]): Uint8Array {
  const buf = new Uint8Array(a.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < a.length; i++) view.setUint32(i * 4, a[i]! >>> 0, false);
  return buf;
}

export function bytesToA32(b: Uint8Array): number[] {
  let buf = b;
  if (buf.length % 4 !== 0) {
    const pad = new Uint8Array(buf.length + (4 - (buf.length % 4)));
    pad.set(buf);
    buf = pad;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) out.push(view.getUint32(i, false));
  return out;
}

export function a32ToB64(a: number[]): string {
  return b64urlEncode(a32ToBytes(a));
}

export function b64ToA32(s: string): number[] {
  return bytesToA32(b64urlDecode(s));
}

export function randA32(n: number): number[] {
  return bytesToA32(randomBytes(n * 4));
}

// ---------- AES-ECB key wrap ----------

export function encryptKeyEcb(keyBytes: Uint8Array, dataA32: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dataA32.length; i += 4) {
    const block = a32ToBytes(dataA32.slice(i, i + 4));
    out.push(...bytesToA32(aesEcbEncrypt(keyBytes, block)));
  }
  return out;
}

export function decryptKeyEcb(keyBytes: Uint8Array, dataA32: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dataA32.length; i += 4) {
    const block = a32ToBytes(dataA32.slice(i, i + 4));
    out.push(...bytesToA32(aesEcbDecrypt(keyBytes, block)));
  }
  return out;
}

// ---------- node attribute encryption ----------

/** MEGA attr key: [k0^k4, k1^k5, k2^k6, k3^k7]. Folder keys (4 elems) passthrough. */
export function attrKey(keyA32: number[]): Uint8Array {
  const k = [...keyA32];
  while (k.length < 8) k.push(0);
  return a32ToBytes([
    (k[0]! ^ k[4]!) >>> 0,
    (k[1]! ^ k[5]!) >>> 0,
    (k[2]! ^ k[6]!) >>> 0,
    (k[3]! ^ k[7]!) >>> 0,
  ]);
}

export function encryptAttr(
  attrs: Record<string, unknown>,
  keyA32: number[],
): Uint8Array {
  const raw = utf8Encode("MEGA" + JSON.stringify(attrs));
  const pad = (16 - (raw.length % 16)) % 16;
  const padded = pad ? concatBytes(raw, new Uint8Array(pad)) : raw;
  return aesCbcEncryptZeroIv(attrKey(keyA32), padded);
}

export function decryptAttr(
  encB64: string,
  keyA32: number[],
): Record<string, unknown> | null {
  let raw = b64urlDecode(encB64);
  if (raw.length % 16 !== 0) {
    raw = concatBytes(raw, new Uint8Array(16 - (raw.length % 16)));
  }
  const plain = aesCbcDecryptZeroIv(attrKey(keyA32), raw);
  if (utf8Decode(plain.subarray(0, 4)) !== "MEGA") return null;
  let body = plain.subarray(4);
  while (body.length && body[body.length - 1] === 0) {
    body = body.subarray(0, body.length - 1);
  }
  const text = utf8Decode(body).trimEnd();
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(0, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- AES-CTR + CBC-MAC ----------

export function encryptChunkAndMac(
  data: Uint8Array,
  ulKey: number[],
  byteOffset: number,
): { ciphertext: Uint8Array; mac: number[] } {
  if (data.length > ONE_MB) {
    throw new Error("caller must split reads into <= 1 MiB pieces");
  }

  const keyBytes = a32ToBytes(ulKey.slice(0, 4));
  const nonce = a32ToBytes(ulKey.slice(4, 6));
  const ciphertext = aesCtr(keyBytes, nonce, data, byteOffset);

  let macBytes: Uint8Array;
  if (data.length > 0) {
    const padLen = (16 - (data.length % 16)) % 16;
    const padded = padLen ? concatBytes(data, new Uint8Array(padLen)) : data;
    const macIv = concatBytes(nonce, nonce);
    const cbcOut = aesCbcEncrypt(keyBytes, macIv, padded);
    macBytes = cbcOut.subarray(cbcOut.length - 16);
  } else {
    macBytes = concatBytes(nonce, nonce);
  }

  return { ciphertext, mac: bytesToA32(macBytes) };
}

/** Decrypt AES-CTR stream starting at byte offset (usually 0). */
export function createCtrDecipher(keyA32: number[], startByte = 0) {
  const aesKey = attrKey(keyA32);
  const nonce = a32ToBytes(keyA32.slice(4, 6));
  let offset = startByte;
  return {
    update(chunk: Uint8Array): Uint8Array {
      const plain = aesCtr(aesKey, nonce, chunk, offset);
      offset += chunk.length;
      return plain;
    },
    final(): Uint8Array {
      return new Uint8Array(0);
    },
  };
}

export function condenseMacs(macs: number[][], ulKey: number[]): number[] {
  let acc = [0, 0, 0, 0];
  const keyBytes = a32ToBytes(ulKey.slice(0, 4));
  for (const m of macs) {
    for (let j = 0; j < m.length; j += 4) {
      acc = [
        (acc[0]! ^ m[j]!) >>> 0,
        (acc[1]! ^ m[j + 1]!) >>> 0,
        (acc[2]! ^ m[j + 2]!) >>> 0,
        (acc[3]! ^ m[j + 3]!) >>> 0,
      ];
      acc = bytesToA32(aesEcbEncrypt(keyBytes, a32ToBytes(acc)));
    }
  }
  return acc;
}

export function crc32b(data: Uint8Array, init = 0): number {
  return crc32(data, init);
}

/** Web Crypto PBKDF2 — async (SubtleCrypto has no sync API). */
export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const subtle = crypto.subtle;
  const keyMaterial = await subtle.importKey(
    "raw",
    password as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    length * 8,
  );
  return new Uint8Array(bits);
}
