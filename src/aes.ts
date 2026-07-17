/**
 * Pure AES-128 (ECB / CBC zero-IV / CTR).
 * SubtleCrypto can't do ECB or zero-pad CBC the way MEGA needs.
 */

const S = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);
const Si = new Uint8Array(256);
for (let i = 0; i < 256; i++) Si[S[i]!] = i;
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(a: number): number {
  return ((a << 1) ^ (((a >> 7) & 1) * 0x1b)) & 0xff;
}

function mul(a: number, b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

function expandKey(keyBytes: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(keyBytes.subarray(0, 16));
  for (let i = 16, rc = 0; i < 176; i += 4) {
    let t0 = w[i - 4]!,
      t1 = w[i - 3]!,
      t2 = w[i - 2]!,
      t3 = w[i - 1]!;
    if (i % 16 === 0) {
      const a = t0;
      t0 = S[t1]! ^ RCON[rc++]!;
      t1 = S[t2]!;
      t2 = S[t3]!;
      t3 = S[a]!;
    }
    w[i] = w[i - 16]! ^ t0;
    w[i + 1] = w[i - 15]! ^ t1;
    w[i + 2] = w[i - 14]! ^ t2;
    w[i + 3] = w[i - 13]! ^ t3;
  }
  return w;
}

function encryptBlock(
  w: Uint8Array,
  input: Uint8Array,
  offset: number,
  output: Uint8Array,
  outOff: number,
): void {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[offset + i]! ^ w[i]!;

  for (let round = 1; round <= 9; round++) {
    const t = new Uint8Array(16);
    t[0] = S[s[0]!]!;
    t[1] = S[s[5]!]!;
    t[2] = S[s[10]!]!;
    t[3] = S[s[15]!]!;
    t[4] = S[s[4]!]!;
    t[5] = S[s[9]!]!;
    t[6] = S[s[14]!]!;
    t[7] = S[s[3]!]!;
    t[8] = S[s[8]!]!;
    t[9] = S[s[13]!]!;
    t[10] = S[s[2]!]!;
    t[11] = S[s[7]!]!;
    t[12] = S[s[12]!]!;
    t[13] = S[s[1]!]!;
    t[14] = S[s[6]!]!;
    t[15] = S[s[11]!]!;
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = t[i]!,
        a1 = t[i + 1]!,
        a2 = t[i + 2]!,
        a3 = t[i + 3]!;
      s[i] = (xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3) & 0xff;
      s[i + 1] = (a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3) & 0xff;
      s[i + 2] = (a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3) & 0xff;
      s[i + 3] = (xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3)) & 0xff;
    }
    const rk = round * 16;
    for (let i = 0; i < 16; i++) s[i]! ^= w[rk + i]!;
  }

  const t = new Uint8Array(16);
  t[0] = S[s[0]!]!;
  t[1] = S[s[5]!]!;
  t[2] = S[s[10]!]!;
  t[3] = S[s[15]!]!;
  t[4] = S[s[4]!]!;
  t[5] = S[s[9]!]!;
  t[6] = S[s[14]!]!;
  t[7] = S[s[3]!]!;
  t[8] = S[s[8]!]!;
  t[9] = S[s[13]!]!;
  t[10] = S[s[2]!]!;
  t[11] = S[s[7]!]!;
  t[12] = S[s[12]!]!;
  t[13] = S[s[1]!]!;
  t[14] = S[s[6]!]!;
  t[15] = S[s[11]!]!;
  for (let i = 0; i < 16; i++) output[outOff + i] = t[i]! ^ w[160 + i]!;
}

function decryptBlock(
  w: Uint8Array,
  input: Uint8Array,
  offset: number,
  output: Uint8Array,
  outOff: number,
): void {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[offset + i]! ^ w[160 + i]!;

  for (let round = 9; round >= 1; round--) {
    const t = new Uint8Array(16);
    t[0] = Si[s[0]!]!;
    t[1] = Si[s[13]!]!;
    t[2] = Si[s[10]!]!;
    t[3] = Si[s[7]!]!;
    t[4] = Si[s[4]!]!;
    t[5] = Si[s[1]!]!;
    t[6] = Si[s[14]!]!;
    t[7] = Si[s[11]!]!;
    t[8] = Si[s[8]!]!;
    t[9] = Si[s[5]!]!;
    t[10] = Si[s[2]!]!;
    t[11] = Si[s[15]!]!;
    t[12] = Si[s[12]!]!;
    t[13] = Si[s[9]!]!;
    t[14] = Si[s[6]!]!;
    t[15] = Si[s[3]!]!;
    const rk = round * 16;
    for (let i = 0; i < 16; i++) t[i]! ^= w[rk + i]!;
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = t[i]!,
        a1 = t[i + 1]!,
        a2 = t[i + 2]!,
        a3 = t[i + 3]!;
      s[i] = mul(a0, 0x0e) ^ mul(a1, 0x0b) ^ mul(a2, 0x0d) ^ mul(a3, 0x09);
      s[i + 1] = mul(a0, 0x09) ^ mul(a1, 0x0e) ^ mul(a2, 0x0b) ^ mul(a3, 0x0d);
      s[i + 2] = mul(a0, 0x0d) ^ mul(a1, 0x09) ^ mul(a2, 0x0e) ^ mul(a3, 0x0b);
      s[i + 3] = mul(a0, 0x0b) ^ mul(a1, 0x0d) ^ mul(a2, 0x09) ^ mul(a3, 0x0e);
    }
  }

  const t = new Uint8Array(16);
  t[0] = Si[s[0]!]!;
  t[1] = Si[s[13]!]!;
  t[2] = Si[s[10]!]!;
  t[3] = Si[s[7]!]!;
  t[4] = Si[s[4]!]!;
  t[5] = Si[s[1]!]!;
  t[6] = Si[s[14]!]!;
  t[7] = Si[s[11]!]!;
  t[8] = Si[s[8]!]!;
  t[9] = Si[s[5]!]!;
  t[10] = Si[s[2]!]!;
  t[11] = Si[s[15]!]!;
  t[12] = Si[s[12]!]!;
  t[13] = Si[s[9]!]!;
  t[14] = Si[s[6]!]!;
  t[15] = Si[s[3]!]!;
  for (let i = 0; i < 16; i++) output[outOff + i] = t[i]! ^ w[i]!;
}

export function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) encryptBlock(w, data, i, out, i);
  return out;
}

export function aesEcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) decryptBlock(w, data, i, out, i);
  return out;
}

export function aesCbcEncryptZeroIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = new Uint8Array(16);
  const block = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    for (let j = 0; j < 16; j++) block[j] = data[i + j]! ^ prev[j]!;
    encryptBlock(w, block, 0, out, i);
    prev = out.slice(i, i + 16);
  }
  return out;
}

export function aesCbcDecryptZeroIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    decryptBlock(w, data, i, out, i);
    for (let j = 0; j < 16; j++) out[i + j]! ^= prev[j]!;
    prev = data.subarray(i, i + 16);
  }
  return out;
}

/** AES-CBC with arbitrary IV (for MEGA chunk MAC: IV = nonce||nonce). */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv.slice(0, 16);
  const block = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    for (let j = 0; j < 16; j++) block[j] = data[i + j]! ^ prev[j]!;
    encryptBlock(w, block, 0, out, i);
    prev = out.slice(i, i + 16);
  }
  return out;
}

function ctrCounter(nonce8: Uint8Array, blockOffset: number): Uint8Array {
  const counter = new Uint8Array(16);
  counter.set(nonce8.subarray(0, 8), 0);
  const view = new DataView(counter.buffer);
  view.setUint32(8, Math.floor(blockOffset / 0x100000000), false);
  view.setUint32(12, blockOffset >>> 0, false);
  return counter;
}

/** AES-CTR xor — encrypt and decrypt are identical. */
export function aesCtr(
  key: Uint8Array,
  nonce8: Uint8Array,
  data: Uint8Array,
  byteOffset: number,
): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let off = 0;
  let blockIdx = Math.floor(byteOffset / 16);
  let skip = byteOffset % 16;
  const keystream = new Uint8Array(16);

  while (off < data.length) {
    encryptBlock(w, ctrCounter(nonce8, blockIdx), 0, keystream, 0);
    for (let i = skip; i < 16 && off < data.length; i++, off++) {
      out[off] = data[off]! ^ keystream[i]!;
    }
    skip = 0;
    blockIdx++;
  }
  return out;
}
