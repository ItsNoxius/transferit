/** Minimal self-check: pure AES-CTR + CRC match Node. */
import { createCipheriv, randomBytes } from "node:crypto";
import { crc32 as zlibCrc } from "node:zlib";
import { aesCtr } from "../src/aes.js";
import { crc32 } from "../src/crc32.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const key = randomBytes(16);
const nonce = randomBytes(8);
const data = randomBytes(64);
const iv = Buffer.alloc(16);
nonce.copy(iv, 0, 0, 8);
iv.writeBigUInt64BE(0n, 8);

const cipher = createCipheriv("aes-128-ctr", key, iv);
const nodeCt = Buffer.concat([cipher.update(data), cipher.final()]);
const ours = aesCtr(key, nonce, data, 0);
assert(Buffer.from(ours).equals(nodeCt), "aesCtr must match node aes-128-ctr");

assert(
  crc32(Buffer.from("hello")) === (zlibCrc(Buffer.from("hello")) >>> 0),
  "crc32 must match zlib",
);

console.log("ok: aes + crc32 self-check");
