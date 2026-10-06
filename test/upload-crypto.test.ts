import { createCipheriv, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a32ToBytes, bytesToA32, createChunkEncryptor, encryptChunkAndMac, ONE_MB } from "../src/crypto.js";

const ulKey = [0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210, 0x12345678, 0xabcdef01];

function reference(data: Uint8Array, offset: number) {
  const key = a32ToBytes(ulKey.slice(0, 4));
  const nonce = a32ToBytes(ulKey.slice(4, 6));
  const counter = Buffer.alloc(16);
  counter.set(nonce);
  counter.writeBigUInt64BE(BigInt(offset / 16), 8);
  const ctr = createCipheriv("aes-128-ctr", key, counter);
  const ciphertext = new Uint8Array(Buffer.concat([ctr.update(data), ctr.final()]));
  const iv = Buffer.concat([nonce, nonce]);
  let mac = iv;
  if (data.length) {
    const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16);
    padded.set(data);
    const cbc = createCipheriv("aes-128-cbc", key, iv);
    cbc.setAutoPadding(false);
    mac = Buffer.concat([cbc.update(padded), cbc.final()]).subarray(-16);
  }
  return { ciphertext, mac: bytesToA32(mac) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native upload encryption", () => {
  it.each([0, 1, 15, 16, 17, 131072, ONE_MB - 1, ONE_MB])(
    "matches independent AES for %i-byte chunks and large offsets",
    async (length) => {
      const encrypt = await createChunkEncryptor(ulKey);
      const data = Uint8Array.from({ length }, (_, i) => (i * 17 + 11) & 255);
      for (const offset of [0, 131072, 2 ** 36]) {
        expect(await encrypt(data, offset)).toEqual(reference(data, offset));
      }
    },
  );

  it("imports keys once per file and uses native AES for every nonempty aligned chunk", async () => {
    const imports = vi.spyOn(webcrypto.subtle, "importKey");
    const operations = vi.spyOn(webcrypto.subtle, "encrypt");
    vi.stubGlobal("crypto", webcrypto);
    const encrypt = await createChunkEncryptor(ulKey);
    expect(imports).toHaveBeenCalledTimes(2);
    const data = new Uint8Array(17).fill(0x5a);
    const results = await Promise.all([encrypt(data, 0), encrypt(data, 131072)]);
    expect(results).toEqual([reference(data, 0), reference(data, 131072)]);
    expect(imports).toHaveBeenCalledTimes(2);
    expect(operations).toHaveBeenCalledTimes(4);
  });

  it("preserves the synchronous fallback without WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    const encrypt = await createChunkEncryptor(ulKey);
    const data = new Uint8Array(17).fill(0x5a);
    expect(await encrypt(data, 131072)).toEqual(encryptChunkAndMac(data, ulKey, 131072));
  });

  it("preserves non-block-aligned offsets", async () => {
    const encrypt = await createChunkEncryptor(ulKey);
    const data = new Uint8Array(17).fill(0x5a);
    expect(await encrypt(data, 7)).toEqual(encryptChunkAndMac(data, ulKey, 7));
  });

  it("rejects chunks larger than the protocol limit", async () => {
    const encrypt = await createChunkEncryptor(ulKey);
    await expect(encrypt(new Uint8Array(ONE_MB + 1), 0)).rejects.toThrow("split reads");
  });
});
