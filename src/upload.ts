/**
 * WebSocket upload pipeline.
 * Port of transferit-py `_upload.py` — matches MEGA WsPoolMgr / WsUploadMgr.
 * Isomorphic: pass a ByteSource (path/Blob/File adapters live elsewhere).
 */

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

/** Random-access bytes for the upload pipeline (file path, Blob, etc.). */
export interface ByteSource {
  readonly size: number;
  read(pos: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void> | void;
}

export function blobSource(blob: Blob, name?: string): ByteSource & { name: string } {
  return {
    size: blob.size,
    name: name ?? (blob instanceof File ? blob.name : "upload.bin"),
    async read(pos, length) {
      if (length === 0) return new Uint8Array(0);
      const buf = await blob.slice(pos, pos + length).arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (u8.length !== length) {
        throw new MegaAPIError(
          `short read at ${pos}: got ${u8.length}, want ${length}`,
        );
      }
      return u8;
    },
  };
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

interface WsHandle {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

async function openWs(url: string): Promise<WsHandle> {
  if (typeof WebSocket !== "undefined") {
    return openBrowserWs(url);
  }
  const { default: WS } = await import("ws");
  return openNodeWs(url, WS);
}

function openBrowserWs(url: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let opened = false;
    const handle: WsHandle = {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send(data) {
        ws.send(data);
      },
      close() {
        ws.close();
      },
      onOpen(cb) {
        if (opened) cb();
        else ws.addEventListener("open", () => cb(), { once: true });
      },
      onMessage(cb) {
        ws.addEventListener("message", (ev) => {
          const d = ev.data;
          cb(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as ArrayBuffer));
        });
      },
      onError(cb) {
        ws.addEventListener("error", () => cb(new Error("WebSocket error")));
      },
      onClose(cb) {
        ws.addEventListener("close", () => cb());
      },
    };
    ws.addEventListener(
      "open",
      () => {
        opened = true;
        resolve(handle);
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        if (!opened) reject(new Error("WebSocket connect failed"));
      },
      { once: true },
    );
  });
}

function openNodeWs(
  url: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WS: any,
): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    let opened = false;
    const handle: WsHandle = {
      get bufferedAmount() {
        return ws.bufferedAmount as number;
      },
      send(data) {
        ws.send(data);
      },
      close() {
        ws.close();
      },
      onOpen(cb) {
        if (opened) cb();
        else ws.once("open", cb);
      },
      onMessage(cb) {
        ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          if (Buffer.isBuffer(data)) cb(new Uint8Array(data));
          else if (data instanceof ArrayBuffer) cb(new Uint8Array(data));
          else cb(new Uint8Array(Buffer.concat(data as Buffer[])));
        });
      },
      onError(cb) {
        ws.on("error", (err: Error) => cb(err));
      },
      onClose(cb) {
        ws.on("close", cb);
      },
    };
    ws.once("open", () => {
      opened = true;
      resolve(handle);
    });
    ws.once("error", (err: Error) => {
      if (!opened) reject(err);
    });
  });
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
  buf[offset + 2] = (v >>> 16) & 0xff;
  buf[offset + 3] = (v >>> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x100000000) >>> 0;
  writeU32LE(buf, offset, lo);
  writeU32LE(buf, offset + 4, hi);
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

function readI8(buf: Uint8Array, offset: number): number {
  const v = buf[offset]!;
  return v > 127 ? v - 256 : v;
}

function readU64LE(buf: Uint8Array, offset: number): number {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

export async function wsUploadOne(
  wsHost: string,
  wsUri: string,
  source: ByteSource,
  ulKey: number[],
  opts: {
    fileno?: number;
    concurrency?: number;
    size?: number;
    progress?: (sent: number, total: number) => void;
  } = {},
): Promise<{ token: Uint8Array; macs: number[][] }> {
  const url = `wss://${wsHost}/${wsUri}`;
  const fileno = opts.fileno ?? 1;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const size = opts.size ?? source.size;
  const progress = opts.progress;

  const { chunks: chunkOffsets, needEmptyTail } = iterChunks(size);
  const workQueue: [number, number][] = [...chunkOffsets];
  if (needEmptyTail) workQueue.push([size, 0]);
  const totalChunks = workQueue.length;

  const unackedLengths = new Map<number, number>(chunkOffsets);
  if (needEmptyTail) unackedLengths.set(size, 0);

  const macsByOffset = new Map<number, number[]>();
  let completionToken: Uint8Array | null = null;
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

  const readAndEncrypt = async (pos: number, length: number): Promise<Uint8Array> =>
    withFileLock(async () => {
      const data = length ? await source.read(pos, length) : new Uint8Array(0);
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
          let settled = false;
          let ws: WsHandle | null = null;

          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            if (err) reject(err);
            else resolve();
          };

          void (async () => {
            try {
              ws = await openWs(url);
              ws.onError((err) => finish(err));
              ws.onClose(() => {
                if (!settled && !done) finish(new WsDisconnect("connection closed"));
                else if (!settled) finish();
              });

              ws.onMessage((mview) => {
                try {
                  if (mview.length < 9) return;
                  const body = mview.subarray(0, mview.length - 4);
                  const mcrc = readU32LE(mview, mview.length - 4);
                  if (crc32b(body) !== mcrc) {
                    throw new MegaAPIError("ws CRC mismatch on server msg");
                  }
                  const mtype = readI8(mview, 12);
                  if (mtype < 0) {
                    throw new MegaAPIError(
                      `server signalled upload error type=${mtype}`,
                    );
                  }
                  const mpos = readU64LE(mview, 4);
                  if (mtype === MsgType.CHUNK_ACK || mtype === MsgType.CHUNK_ACK_ALT) {
                    inFlight.delete(mpos);
                    recordAck(mpos);
                  } else if (mtype === MsgType.CRC_FAIL) {
                    throw new MegaAPIError(
                      `server reports chunk CRC fail at offset ${mpos}`,
                    );
                  } else if (mtype === MsgType.COMPLETE) {
                    const tlen = body[13]!;
                    completionToken = body.subarray(14, 14 + tlen).slice();
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
                const header = new Uint8Array(20);
                writeU32LE(header, 0, fileno);
                writeU64LE(header, 4, pos);
                writeU32LE(header, 12, length);
                const crc = crc32b(ct, crc32b(header.subarray(0, 16)));
                writeU32LE(header, 16, crc);

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
    await source.close?.();
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
