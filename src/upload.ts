/**
 * WebSocket upload pipeline.
 * Port of transferit-py `_upload.py` — matches MEGA WsPoolMgr / WsUploadMgr.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import WebSocket from "ws";
import type { MegaAPI } from "./api.js";
import { CHUNKMAP, ONE_MB, crc32b, encryptChunkAndMac } from "./crypto.js";
import { MegaAPIError } from "./errors.js";

export { ONE_MB };
export const DEFAULT_CONCURRENCY = 8;
const WS_BUFFER_LIMIT = 1_500_000;
const ACK_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;

const enum MsgType {
  CHUNK_ACK = 1,
  CRC_FAIL = 3,
  COMPLETE = 4,
  SHED = 5,
  CHUNK_ACK_ALT = 7,
}

export function iterChunks(size: number): {
  chunks: [number, number][];
  needEmptyTail: boolean;
} {
  const chunks: [number, number][] = [];
  let pos = 0;
  let truncatedLast = false;
  while (pos < size) {
    const nominal = CHUNKMAP.get(pos) ?? ONE_MB;
    const remaining = size - pos;
    if (remaining < nominal) {
      chunks.push([pos, remaining]);
      pos += remaining;
      truncatedLast = true;
    } else {
      chunks.push([pos, nominal]);
      pos += nominal;
      truncatedLast = false;
    }
  }
  const needEmptyTail = size === 0 || !truncatedLast;
  return { chunks, needEmptyTail };
}

class WsDisconnect extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsDisconnect";
  }
}

export async function wsUploadOne(
  wsHost: string,
  wsUri: string,
  filePath: string,
  ulKey: number[],
  opts: {
    fileno?: number;
    concurrency?: number;
    size?: number;
    progress?: (sent: number, total: number) => void;
  } = {},
): Promise<{ token: Buffer; macs: number[][] }> {
  const url = `wss://${wsHost}/${wsUri}`;
  const fileno = opts.fileno ?? 1;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const size = opts.size ?? (await stat(filePath)).size;
  const progress = opts.progress;

  const { chunks: chunkOffsets, needEmptyTail } = iterChunks(size);
  const workQueue: [number, number][] = [...chunkOffsets];
  if (needEmptyTail) workQueue.push([size, 0]);
  const totalChunks = workQueue.length;

  const unackedLengths = new Map<number, number>(chunkOffsets);
  if (needEmptyTail) unackedLengths.set(size, 0);

  const macsByOffset = new Map<number, number[]>();
  let completionToken: Buffer | null = null;
  let done = false;
  let bytesAcked = 0;
  const failReason: { err: Error | null } = { err: null };

  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };
  const waitDoneOr = (ms: number) =>
    new Promise<void>((resolve) => {
      if (done) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        waiters.delete(onWake);
        resolve();
      }, ms);
      const onWake = () => {
        clearTimeout(t);
        resolve();
      };
      waiters.add(onWake);
    });

  const fh = await open(filePath, "r");
  let fileLock = Promise.resolve();
  const withFileLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = fileLock.then(fn, fn);
    fileLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const takeChunk = (): [number, number] | null => {
    if (workQueue.length) return workQueue.shift()!;
    return null;
  };

  const prepend = (chunks: [number, number][]) => {
    if (chunks.length) workQueue.unshift(...chunks);
  };

  const readAndEncrypt = async (
    pos: number,
    length: number,
  ): Promise<Buffer> =>
    withFileLock(async () => {
      const buf = Buffer.alloc(length);
      if (length > 0) {
        const { bytesRead } = await fh.read(buf, 0, length, pos);
        if (bytesRead !== length) {
          throw new MegaAPIError(
            `short read at ${pos}: got ${bytesRead}, want ${length}`,
          );
        }
      }
      const data = length ? buf : Buffer.alloc(0);
      const { ciphertext, mac } = encryptChunkAndMac(data, ulKey, pos);
      macsByOffset.set(pos, mac);
      return ciphertext;
    });

  const recordAck = (pos: number) => {
    const length = unackedLengths.get(pos);
    if (length === undefined) return;
    unackedLengths.delete(pos);
    bytesAcked += length;
    if (progress) progress(Math.min(bytesAcked, size), size);
  };

  const markDone = () => {
    done = true;
    wake();
  };

  const worker = async (_workerId: number): Promise<void> => {
    const inFlight = new Map<number, { length: number; deadline: number }>();

    const dropInFlight = () => {
      if (inFlight.size) {
        prepend(
          [...inFlight.entries()].map(([p, v]) => [p, v.length] as [number, number]),
        );
        inFlight.clear();
      }
    };

    while (!done) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            try {
              ws.removeAllListeners();
              if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
              }
            } catch {
              /* ignore */
            }
            if (err) reject(err);
            else resolve();
          };

          ws.once("error", (err) => finish(err));
          ws.once("close", () => {
            if (!settled && !done) {
              finish(new WsDisconnect("connection closed"));
            } else if (!settled) {
              finish();
            }
          });

          ws.once("open", () => {
            void (async () => {
              try {
                while (!done) {
                  const now = Date.now();
                  for (const [pos, { deadline }] of inFlight) {
                    if (now > deadline) {
                      throw new WsDisconnect(`ack timeout pos=${pos}`);
                    }
                  }

                  const chunk = takeChunk();
                  if (chunk == null) {
                    if (inFlight.size === 0 && workQueue.length === 0) {
                      await waitDoneOr(100);
                      if (done) break;
                      continue;
                    }
                    await waitDoneOr(100);
                    continue;
                  }

                  const [pos, length] = chunk;

                  while (!done && ws.bufferedAmount >= WS_BUFFER_LIMIT) {
                    await waitDoneOr(10);
                  }
                  if (done) {
                    prepend([chunk]);
                    break;
                  }

                  const ct = await readAndEncrypt(pos, length);
                  const header = Buffer.alloc(20);
                  header.writeUInt32LE(fileno, 0);
                  header.writeBigUInt64LE(BigInt(pos), 4);
                  header.writeUInt32LE(length, 12);
                  const crc = crc32b(ct, crc32b(header.subarray(0, 16)));
                  header.writeUInt32LE(crc, 16);

                  inFlight.set(pos, {
                    length,
                    deadline: Date.now() + ACK_TIMEOUT_MS,
                  });
                  ws.send(header);
                  if (ct.length) ws.send(ct);
                }
                finish();
              } catch (err) {
                finish(err instanceof Error ? err : new Error(String(err)));
              }
            })();
          });

          ws.on("message", (data) => {
            try {
              const mview = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data as ArrayBuffer);
              if (mview.length < 9) return;
              const body = mview.subarray(0, mview.length - 4);
              const mcrc = mview.readUInt32LE(mview.length - 4);
              if (crc32b(body) !== mcrc) {
                throw new MegaAPIError("ws CRC mismatch on server msg");
              }
              const mtype = mview.readInt8(12);
              if (mtype < 0) {
                throw new MegaAPIError(
                  `server signalled upload error type=${mtype}`,
                );
              }
              const mpos = Number(mview.readBigUInt64LE(4));
              if (mtype === MsgType.CHUNK_ACK || mtype === MsgType.CHUNK_ACK_ALT) {
                inFlight.delete(mpos);
                recordAck(mpos);
              } else if (mtype === MsgType.CRC_FAIL) {
                throw new MegaAPIError(
                  `server reports chunk CRC fail at offset ${mpos}`,
                );
              } else if (mtype === MsgType.COMPLETE) {
                const tlen = body[13]!;
                completionToken = Buffer.from(body.subarray(14, 14 + tlen));
                markDone();
                finish();
              } else if (mtype === MsgType.SHED) {
                throw new WsDisconnect("server requested reconnect");
              }
            } catch (err) {
              if (err instanceof WsDisconnect) {
                finish(err);
              } else {
                failReason.err =
                  err instanceof Error ? err : new Error(String(err));
                markDone();
                finish(failReason.err);
              }
            }
          });
        });

        dropInFlight();
        if (done) return;
        await sleep(RECONNECT_DELAY_MS);
      } catch (ex) {
        dropInFlight();
        if (
          ex instanceof WsDisconnect ||
          (ex instanceof Error && /close|ECONN|socket/i.test(ex.message))
        ) {
          if (done) return;
          await sleep(RECONNECT_DELAY_MS);
          continue;
        }
        failReason.err = ex instanceof Error ? ex : new Error(String(ex));
        markDone();
        throw failReason.err;
      }
    }
  };

  const n = Math.max(1, Math.min(concurrency, totalChunks));
  try {
    await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
  } finally {
    await fh.close();
  }

  if (failReason.err) throw failReason.err;
  if (!completionToken) {
    throw new MegaAPIError("upload ended without completion token");
  }

  const orderedMacs = [...macsByOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, mac]) => mac);

  return { token: completionToken, macs: orderedMacs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function matchGlob(name: string, pattern: string): boolean {
  // Minimal fnmatch-style: *, ?, and path separators as literals.
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i").test(name);
}

export async function walkFolder(
  root: string,
  opts?: { exclude?: Iterable<string> },
): Promise<{ files: string[]; dirRelPaths: string[] }> {
  const st = await stat(root);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const patterns = [...(opts?.exclude ?? [])];
  const matches = (name: string, rel: string) =>
    patterns.some((pat) => matchGlob(name, pat) || matchGlob(rel, pat));

  const files: string[] = [];
  const dirSet = new Set<string>();

  async function walk(dir: string, relPosix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      const rel = relPosix ? `${relPosix}/${ent.name}` : ent.name;
      if (patterns.length && matches(ent.name, rel)) continue;

      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        dirSet.add(rel);
        await walk(full, rel);
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
  }

  await walk(root, "");
  const dirRelPaths = [...dirSet].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  return { files, dirRelPaths };
}

export async function buildRemoteTree(
  api: MegaAPI,
  rootHandle: string,
  dirRelPaths: string[],
): Promise<Map<string, string>> {
  const handles = new Map<string, string>([["", rootHandle]]);
  for (const rel of dirRelPaths) {
    const idx = rel.lastIndexOf("/");
    const parentRel = idx === -1 ? "" : rel.slice(0, idx);
    const name = idx === -1 ? rel : rel.slice(idx + 1);
    const parentH = handles.get(parentRel) ?? rootHandle;
    handles.set(rel, await api.createSubfolder(parentH, name));
  }
  return handles;
}
