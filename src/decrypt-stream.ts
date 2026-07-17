/**
 * Streaming AES-CTR decrypt (Web Streams) — shared by SW + browser download.
 */

import { attrKey, a32ToBytes } from "./crypto.js";

/** TS 5.7+ BufferSource vs Uint8Array<ArrayBufferLike> friction. */
function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function ctrCounter(nonce8: Uint8Array, blockOffset: number): Uint8Array {
  const counter = new Uint8Array(16);
  counter.set(nonce8.subarray(0, 8), 0);
  const view = new DataView(counter.buffer);
  view.setUint32(8, Math.floor(blockOffset / 0x100000000), false);
  view.setUint32(12, blockOffset >>> 0, false);
  return counter;
}

/**
 * Streaming AES-CTR decrypt TransformStream.
 * Keeps at most one incoming chunk + <16 bytes of alignment remainder.
 */
export function createDecryptTransform(
  keyA32: number[],
  plainLimit = 0,
): TransformStream<Uint8Array, Uint8Array> {
  let cryptoKeyPromise: Promise<CryptoKey> | null = null;
  const nonce = a32ToBytes(keyA32.slice(4, 6));
  let byteOffset = 0;
  let emitted = 0;
  let pending: Uint8Array = new Uint8Array(0);

  async function getKey() {
    if (!cryptoKeyPromise) {
      cryptoKeyPromise = crypto.subtle.importKey(
        "raw",
        buf(attrKey(keyA32)),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
    }
    return cryptoKeyPromise;
  }

  function concat(a: Uint8Array, b: Uint8Array) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  return new TransformStream({
    async transform(chunk, controller) {
      if (plainLimit > 0 && emitted >= plainLimit) return;

      const data: Uint8Array =
        chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      pending = pending.length ? concat(pending, data) : data;

      const complete = pending.length - (pending.length % 16);
      if (complete === 0) return;

      const slice = pending.subarray(0, complete);
      pending = pending.subarray(complete);

      const key = await getKey();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-CTR",
            counter: buf(ctrCounter(nonce, Math.floor(byteOffset / 16))),
            length: 64,
          },
          key,
          buf(slice),
        ),
      );
      byteOffset += complete;

      let out: Uint8Array = plain;
      if (plainLimit > 0) {
        const left = plainLimit - emitted;
        if (out.length > left) out = out.subarray(0, left);
      }
      if (out.length) {
        emitted += out.length;
        controller.enqueue(out);
      }
    },

    async flush(controller) {
      if (!pending.length) return;
      if (plainLimit > 0 && emitted >= plainLimit) return;

      const key = await getKey();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-CTR",
            counter: buf(ctrCounter(nonce, Math.floor(byteOffset / 16))),
            length: 64,
          },
          key,
          buf(pending),
        ),
      );
      let out: Uint8Array = plain;
      if (plainLimit > 0) {
        const left = plainLimit - emitted;
        if (out.length > left) out = out.subarray(0, left);
      }
      if (out.length) controller.enqueue(out);
    },
  });
}
