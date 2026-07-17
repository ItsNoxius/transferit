/**
 * Pure helpers for the download flow.
 * Port of transferit-py `_download.py`.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createCtrDecipher } from "./crypto.js";

export async function streamDecryptToFile(
  url: string,
  outPath: string,
  keyA32: number[],
  size: number,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
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
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const plain = Buffer.concat([decipher.update(buf)]);
        written += plain.length;
        if (onProgress) onProgress(written, size);
        cb(null, plain);
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
          this.push(rest);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  // Node 20+: Readable.fromWeb
  const { Readable } = await import("node:stream");
  const nodeReadable = Readable.fromWeb(
    resp.body as import("node:stream/web").ReadableStream,
  );
  await pipeline(nodeReadable, decrypt, createWriteStream(outPath));
}

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
