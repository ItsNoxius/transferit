/**
 * Low-level crypto primitives shared by every higher-level module.
 * Port of transferit-py `_crypto.py` — AES-128-CTR + CCM-style CBC-MAC.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";

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

// ---------- base64url ----------

export function b64urlEncode(b: Buffer | Uint8Array): string {
  return Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64urlDecode(s: string | Buffer): Buffer {
  const str = typeof s === "string" ? s : s.toString("utf8");
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

// ---------- a32 (big-endian uint32 array) ----------

export function a32ToBytes(a: number[]): Buffer {
  const buf = Buffer.allocUnsafe(a.length * 4);
  for (let i = 0; i < a.length; i++) {
    buf.writeUInt32BE(a[i]! >>> 0, i * 4);
  }
  return buf;
}

export function bytesToA32(b: Buffer | Uint8Array): number[] {
  let buf = Buffer.from(b);
  if (buf.length % 4 !== 0) {
    const pad = Buffer.alloc(4 - (buf.length % 4));
    buf = Buffer.concat([buf, pad]);
  }
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    out.push(buf.readUInt32BE(i));
  }
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

export function encryptKeyEcb(keyBytes: Buffer, dataA32: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dataA32.length; i += 4) {
    const block = a32ToBytes(dataA32.slice(i, i + 4));
    const cipher = createCipheriv("aes-128-ecb", keyBytes, null);
    cipher.setAutoPadding(false);
    const enc = Buffer.concat([cipher.update(block), cipher.final()]);
    out.push(...bytesToA32(enc));
  }
  return out;
}

export function decryptKeyEcb(keyBytes: Buffer, dataA32: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dataA32.length; i += 4) {
    const block = a32ToBytes(dataA32.slice(i, i + 4));
    const decipher = createDecipheriv("aes-128-ecb", keyBytes, null);
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([decipher.update(block), decipher.final()]);
    out.push(...bytesToA32(dec));
  }
  return out;
}

// ---------- node attribute encryption ----------

/** MEGA attr key: [k0^k4, k1^k5, k2^k6, k3^k7]. Folder keys (4 elems) passthrough. */
export function attrKey(keyA32: number[]): Buffer {
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
): Buffer {
  const raw = Buffer.from(
    "MEGA" + JSON.stringify(attrs),
    "utf8",
  );
  const pad = (16 - (raw.length % 16)) % 16;
  const padded = pad ? Buffer.concat([raw, Buffer.alloc(pad)]) : raw;
  const cipher = createCipheriv("aes-128-cbc", attrKey(keyA32), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function decryptAttr(
  encB64: string,
  keyA32: number[],
): Record<string, unknown> | null {
  let raw = b64urlDecode(encB64);
  if (raw.length % 16 !== 0) {
    raw = Buffer.concat([raw, Buffer.alloc(16 - (raw.length % 16))]);
  }
  const decipher = createDecipheriv(
    "aes-128-cbc",
    attrKey(keyA32),
    Buffer.alloc(16),
  );
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
  if (!plain.subarray(0, 4).equals(Buffer.from("MEGA"))) return null;
  let body = plain.subarray(4);
  while (body.length && body[body.length - 1] === 0) {
    body = body.subarray(0, body.length - 1);
  }
  body = Buffer.from(body.toString("utf8").trimEnd());
  const end = body.lastIndexOf("}");
  if (end === -1) return null;
  try {
    return JSON.parse(body.subarray(0, end + 1).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// ---------- AES-CTR + CBC-MAC ----------

function ctrIv(nonce: Buffer, blockOffset: number): Buffer {
  const iv = Buffer.allocUnsafe(16);
  nonce.copy(iv, 0, 0, 8);
  iv.writeBigUInt64BE(BigInt(blockOffset), 8);
  return iv;
}

export function encryptChunkAndMac(
  data: Buffer,
  ulKey: number[],
  byteOffset: number,
): { ciphertext: Buffer; mac: number[] } {
  if (data.length > ONE_MB) {
    throw new Error("caller must split reads into <= 1 MiB pieces");
  }

  const keyBytes = a32ToBytes(ulKey.slice(0, 4));
  const nonce = a32ToBytes(ulKey.slice(4, 6));

  const initialCounter = Math.floor(byteOffset / 16);
  const cipher = createCipheriv(
    "aes-128-ctr",
    keyBytes,
    ctrIv(nonce, initialCounter),
  );
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

  let macBytes: Buffer;
  if (data.length > 0) {
    const padLen = (16 - (data.length % 16)) % 16;
    const padded = padLen ? Buffer.concat([data, Buffer.alloc(padLen)]) : data;
    const macIv = Buffer.concat([nonce, nonce]);
    const cbc = createCipheriv("aes-128-cbc", keyBytes, macIv);
    cbc.setAutoPadding(false);
    const cbcOut = Buffer.concat([cbc.update(padded), cbc.final()]);
    macBytes = cbcOut.subarray(cbcOut.length - 16);
  } else {
    macBytes = Buffer.concat([nonce, nonce]);
  }

  return { ciphertext, mac: bytesToA32(macBytes) };
}

/** Decrypt AES-CTR stream starting at byte offset (usually 0). */
export function createCtrDecipher(keyA32: number[], startByte = 0) {
  const aesKey = attrKey(keyA32);
  const nonce = a32ToBytes(keyA32.slice(4, 6));
  return createDecipheriv(
    "aes-128-ctr",
    aesKey,
    ctrIv(nonce, Math.floor(startByte / 16)),
  );
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
      const cipher = createCipheriv("aes-128-ecb", keyBytes, null);
      cipher.setAutoPadding(false);
      const enc = Buffer.concat([
        cipher.update(a32ToBytes(acc)),
        cipher.final(),
      ]);
      acc = bytesToA32(enc);
    }
  }
  return acc;
}

export function crc32b(data: Buffer | Uint8Array, init = 0): number {
  return crc32(data, init) >>> 0;
}
