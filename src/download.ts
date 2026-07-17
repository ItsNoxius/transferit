/**
 * Pure helpers for the download flow.
 * Port of transferit-py `_download.py`.
 */

import { createCtrDecipher } from "./crypto.js";
import { createDecryptTransform } from "./decrypt-stream.js";

export { createDecryptTransform } from "./decrypt-stream.js";

export function computeFolderPaths(
  nodes: { h: string; p: string; t: number; name: string | null }[],
  rootHandle: string,
): Map<string, string> {
  const paths = new Map<string, string>([[rootHandle, ""]]);
  const pending = nodes.filter((n) => n.t === 1 && n.h !== rootHandle);
  while (pending.length) {
    let made = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const n = pending[i]!;
      if (paths.has(n.p)) {
        const parent = paths.get(n.p)!;
        paths.set(n.h, (parent ? `${parent}/` : "") + (n.name || n.h));
        pending.splice(i, 1);
        made = true;
      }
    }
    if (!made) break;
  }
  return paths;
}

/** Fetch CDN ciphertext and return a decrypted ReadableStream. */
export async function streamDecrypt(
  url: string,
  keyA32: number[],
  size: number,
): Promise<ReadableStream<Uint8Array>> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`download HTTP ${resp.status} ${resp.statusText}`);
  }
  return resp.body.pipeThrough(createDecryptTransform(keyA32, size));
}

/** Node: decrypt CDN stream to a local file path. */
export async function streamDecryptToFile(
  url: string,
  outPath: string,
  keyA32: number[],
  size: number,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const { mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { pipeline } = await import("node:stream/promises");
  const { Transform, Readable } = await import("node:stream");

  await mkdir(path.dirname(outPath), { recursive: true });

  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`download HTTP ${resp.status} ${resp.statusText}`);
  }

  const decipher = createCtrDecipher(keyA32, 0);
  let written = 0;

  const decrypt = new Transform({
    transform(chunk, _enc, cb) {
      try {
        const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const plain = decipher.update(buf);
        written += plain.length;
        if (onProgress) onProgress(written, size);
        cb(null, Buffer.from(plain));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        const rest = decipher.final();
        if (rest.length) {
          written += rest.length;
          if (onProgress) onProgress(written, size);
          this.push(Buffer.from(rest));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  const nodeReadable = Readable.fromWeb(
    resp.body as import("node:stream/web").ReadableStream,
  );
  await pipeline(nodeReadable, decrypt, createWriteStream(outPath));
}
