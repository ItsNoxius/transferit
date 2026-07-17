import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CHUNKMAP,
  ONE_MB,
  a32ToB64,
  a32ToBytes,
  attrKey,
  b64ToA32,
  b64urlDecode,
  b64urlEncode,
  bytesToA32,
  condenseMacs,
  crc32b,
  decryptAttr,
  decryptKeyEcb,
  encryptAttr,
  encryptChunkAndMac,
  encryptKeyEcb,
  randA32,
} from "../src/crypto.js";

describe("base64url", () => {
  it.each([[Buffer.alloc(0)], [Buffer.from([0])], [Buffer.from("hello")], [Buffer.alloc(32, 0xff)]])(
    "roundtrips",
    (data) => {
      expect(b64urlDecode(b64urlEncode(data))).toEqual(new Uint8Array(data));
    },
  );

  it("omits padding", () => {
    expect(b64urlEncode(Buffer.from("hi"))).not.toContain("=");
  });

  it("uses urlsafe alphabet", () => {
    const enc = b64urlEncode(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
  });
});

describe("a32", () => {
  it("bytes roundtrip", () => {
    const data = [0xdeadbeef, 0x01020304, 0, 0xffffffff];
    expect(bytesToA32(a32ToBytes(data))).toEqual(data);
  });

  it("is big-endian", () => {
    expect(a32ToBytes([0x12345678])).toEqual(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
  });

  it("b64 roundtrip", () => {
    expect(b64ToA32(a32ToB64([1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
  });

  it("pads non-aligned length", () => {
    expect(bytesToA32(Buffer.from([0x01]))).toEqual([0x01000000]);
  });

  it("randA32 length", () => {
    expect(randA32(6)).toHaveLength(6);
    expect(randA32(10).every((x) => x >= 0 && x <= 0xffffffff)).toBe(true);
  });

  it("randA32 is non-deterministic", () => {
    expect(randA32(4)).not.toEqual(randA32(4));
  });
});

describe("key wrap", () => {
  it("encrypt/decrypt roundtrip", () => {
    const key = randomBytes(16);
    const plain = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(decryptKeyEcb(key, encryptKeyEcb(key, plain))).toEqual(plain);
  });

  it("block size", () => {
    const key = randomBytes(16);
    expect(encryptKeyEcb(key, Array(8).fill(0))).toHaveLength(8);
  });
});

describe("attrKey", () => {
  it("folder key passthrough for 4 elements", () => {
    const k = [0xaaaaaaaa, 0xbbbbbbbb, 0xcccccccc, 0xdddddddd];
    expect(attrKey(k)).toEqual(a32ToBytes(k));
  });

  it("file key xor reduction", () => {
    const k = [
      0x11111111, 0x22222222, 0x33333333, 0x44444444, 0xaaaaaaaa, 0xbbbbbbbb,
      0xcccccccc, 0xdddddddd,
    ];
    const expected = a32ToBytes([
      k[0]! ^ k[4]!,
      k[1]! ^ k[5]!,
      k[2]! ^ k[6]!,
      k[3]! ^ k[7]!,
    ]);
    expect(attrKey(k)).toEqual(expected);
  });
});

describe("attrs", () => {
  it("encrypt/decrypt roundtrip", () => {
    const key = [1, 2, 3, 4];
    const attrs = { n: "hello.txt" };
    const blob = encryptAttr(attrs, key);
    expect(decryptAttr(b64urlEncode(blob), key)).toEqual(attrs);
  });

  it("rejects wrong key", () => {
    const blob = encryptAttr({ n: "secret.txt" }, [1, 2, 3, 4]);
    expect(decryptAttr(b64urlEncode(blob), [9, 9, 9, 9])).toBeNull();
  });

  it("AES block aligned", () => {
    expect(encryptAttr({ n: "a" }, [1, 2, 3, 4]).length % 16).toBe(0);
  });
});

describe("chunk encryption", () => {
  it("CTR is deterministic", () => {
    const ulKey = [0, 1, 2, 3, 4, 5];
    const data = randomBytes(4096);
    const a = encryptChunkAndMac(data, ulKey, 0);
    const b = encryptChunkAndMac(data, ulKey, 0);
    expect(a.ciphertext).toEqual(b.ciphertext);
    expect(a.mac).toEqual(b.mac);
  });

  it("offset changes ciphertext", () => {
    const ulKey = [0, 1, 2, 3, 4, 5];
    const data = randomBytes(4096);
    const a = encryptChunkAndMac(data, ulKey, 0);
    const b = encryptChunkAndMac(data, ulKey, 16);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(
      false,
    );
  });

  it("empty chunk MAC is nonce doubled", () => {
    const ulKey = [1, 2, 3, 4, 0xaaaaaaaa, 0xbbbbbbbb];
    const { ciphertext, mac } = encryptChunkAndMac(Buffer.alloc(0), ulKey, 0);
    expect(ciphertext.length).toBe(0);
    expect(mac).toEqual([0xaaaaaaaa, 0xbbbbbbbb, 0xaaaaaaaa, 0xbbbbbbbb]);
  });

  it("rejects oversize chunk", () => {
    expect(() =>
      encryptChunkAndMac(Buffer.alloc(ONE_MB + 1), [0, 1, 2, 3, 4, 5], 0),
    ).toThrow();
  });

  it("condense empty", () => {
    expect(condenseMacs([], [0, 1, 2, 3, 4, 5])).toEqual([0, 0, 0, 0]);
  });

  it("condense produces 4 elements", () => {
    expect(condenseMacs([[1, 2, 3, 4], [5, 6, 7, 8]], [0, 1, 2, 3, 4, 5])).toHaveLength(
      4,
    );
  });
});

describe("chunkmap", () => {
  it("has eight pre-1MB entries", () => {
    expect(CHUNKMAP.size).toBe(8);
  });

  it("first chunk is 128 KiB", () => {
    expect(CHUNKMAP.get(0)).toBe(128 * 1024);
  });

  it("last entry is 1 MiB", () => {
    const last = Math.max(...CHUNKMAP.keys());
    expect(CHUNKMAP.get(last)).toBe(ONE_MB);
  });

  it("cumulative positions match keys", () => {
    let cumulative = 0;
    for (const pos of [...CHUNKMAP.keys()].sort((a, b) => a - b)) {
      expect(pos).toBe(cumulative);
      cumulative += CHUNKMAP.get(pos)!;
    }
  });
});

describe("crc32", () => {
  it("matches zlib", () => {
    expect(crc32b(Buffer.from("hello"))).toBe(crc32(Buffer.from("hello")) >>> 0);
  });

  it("is seedable", () => {
    const mid = crc32b(Buffer.from("hel"));
    expect(crc32b(Buffer.from("lo"), mid)).toBe(crc32b(Buffer.from("hello")));
  });
});
