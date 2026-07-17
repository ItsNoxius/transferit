/**
 * Pure helpers for the download flow.
 * Port of transferit-py `_download.py`.
 */

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

/** Node: decrypt CDN stream to a local file path (same CTR path as browser/SW). */
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

  const plain = await streamDecrypt(url, keyA32, size);
  const nodeReadable = Readable.fromWeb(
    plain as import("node:stream/web").ReadableStream,
  );
  const dest = createWriteStream(outPath);

  if (!onProgress) {
    await pipeline(nodeReadable, dest);
    return;
  }

  let written = 0;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      onProgress(written, size);
      cb(null, chunk);
    },
  });
  await pipeline(nodeReadable, progress, dest);
}
