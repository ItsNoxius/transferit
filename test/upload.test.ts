import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32b, encryptChunkAndMac } from "../src/crypto.js";
import { iterChunks, wsUploadOne } from "../src/upload.js";

const ulKey = [0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210, 0x12345678, 0xabcdef01];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("socket upload encryption", () => {
  it.each([0, 131072, 8 * 1048576])("uploads %i bytes with compatible chunks and MACs", async (size) => {
    const uploaded = new Map<number, Buffer>();
    const { needEmptyTail } = iterChunks(size);
    let bytesReceived = 0;
    let emptyTailReceived = false;
    let completed = false;

    class UploadSocket extends EventTarget {
      bufferedAmount = 0;
      header: Buffer | null = null;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() { this.dispatchEvent(new Event("close")); }
      reply(offset: number, type: number, token = new Uint8Array(0)) {
        const body = Buffer.alloc(14 + token.length);
        body.writeUInt32LE(1, 0);
        body.writeBigUInt64LE(BigInt(offset), 4);
        body[12] = type;
        body[13] = token.length;
        body.set(token, 14);
        const message = Buffer.alloc(body.length + 4);
        message.set(body);
        message.writeUInt32LE(crc32b(body), body.length);
        this.dispatchEvent(new MessageEvent("message", { data: message }));
      }
      accept(ciphertext: Uint8Array) {
        const header = this.header!;
        this.header = null;
        const offset = Number(header.readBigUInt64LE(4));
        const length = header.readUInt32LE(12);
        expect(ciphertext.length).toBe(length);
        expect(header.readUInt32LE(16)).toBe(crc32b(ciphertext, crc32b(header.subarray(0, 16))));
        expect(uploaded.has(offset)).toBe(false);
        uploaded.set(offset, Buffer.from(ciphertext));
        bytesReceived += length;
        if (length === 0) emptyTailReceived = true;
        queueMicrotask(() => {
          this.reply(offset, 1);
          if (!completed && bytesReceived === size && (!needEmptyTail || emptyTailReceived)) {
            completed = true;
            this.reply(offset, 4, Uint8Array.of(1, 2, 3, 4));
          }
        });
      }
      send(message: Uint8Array) {
        if (!this.header) {
          this.header = Buffer.from(message);
          if (this.header.readUInt32LE(12) === 0) this.accept(new Uint8Array(0));
        } else {
          this.accept(message);
        }
      }
    }

    vi.stubGlobal("WebSocket", UploadSocket);
    vi.stubGlobal("crypto", webcrypto);
    const operations = vi.spyOn(webcrypto.subtle, "encrypt");
    const imports = vi.spyOn(webcrypto.subtle, "importKey");
    const close = vi.fn();
    let lastSent = 0;
    const result = await wsUploadOne("test.invalid", "upload", {
      size,
      async read(_offset, length) { return new Uint8Array(length).fill(0x5a); },
      close,
    }, ulKey, { progress(sent, total) {
      expect(total).toBe(size);
      expect(sent).toBeGreaterThanOrEqual(lastSent);
      expect(sent).toBeLessThanOrEqual(total);
      lastSent = sent;
    } });

    expect(result.token).toEqual(Uint8Array.of(1, 2, 3, 4));
    const macs = [];
    for (const [offset, ciphertext] of [...uploaded].sort((a, b) => a[0] - b[0])) {
      const expected = encryptChunkAndMac(new Uint8Array(ciphertext.length).fill(0x5a), ulKey, offset);
      expect(ciphertext.equals(Buffer.from(expected.ciphertext))).toBe(true);
      macs.push(expected.mac);
    }
    expect(result.macs).toEqual(macs);
    expect(imports).toHaveBeenCalledTimes(2);
    expect(operations).toHaveBeenCalledTimes(iterChunks(size).chunks.length * 2);
    expect(lastSent).toBe(size);
    expect(close).toHaveBeenCalledTimes(1);
  }, 5000);

  it("closes the source if WebCrypto key import fails", async () => {
    vi.stubGlobal("crypto", { subtle: { importKey: vi.fn().mockRejectedValue(new Error("key import failure")) } });
    const close = vi.fn();
    await expect(wsUploadOne("test.invalid", "upload", {
      size: 0,
      read: vi.fn(),
      close,
    }, ulKey)).rejects.toThrow("key import failure");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
