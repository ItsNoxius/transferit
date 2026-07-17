/**
 * High-level upload orchestration.
 * Port of transferit-py `_actions/_upload.py`.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import { MegaAPI, SHARE_BASE } from "./api.js";
import { randA32 } from "./crypto.js";
import { MegaAPIError } from "./errors.js";
import { makeUploadResult, type UploadResult } from "./models.js";
import { castExpirySeconds, parseDuration } from "./transfer.js";
import {
  DEFAULT_CONCURRENCY,
  buildRemoteTree,
  walkFolder,
  wsUploadOne,
} from "./upload.js";

export interface UploadOptions {
  title?: string | null;
  message?: string | null;
  password?: string | null;
  sender?: string | null;
  expiry?: number | string | null;
  notifyExpiry?: boolean;
  maxDownloads?: number | null;
  recipients?: string[] | null;
  schedule?: number | null;
  concurrency?: number;
  parallel?: number | null;
  exclude?: Iterable<string> | null;
  onStart?: (totalBytes: number, fileCount: number) => void;
  onProgress?: (sent: number, total: number) => void;
  onFileStart?: (fileno: number, filePath: string, size: number) => void;
  onFileProgress?: (
    fileno: number,
    filePath: string,
    sent: number,
    total: number,
  ) => void;
  onFileDone?: (fileno: number, filePath: string, size: number) => void;
}

export async function doUpload(
  api: MegaAPI,
  filePath: string,
  opts: UploadOptions & { filenoProvider: () => number },
): Promise<UploadResult> {
  let expirySeconds: number | null | undefined =
    typeof opts.expiry === "string"
      ? parseDuration(opts.expiry)
      : opts.expiry;
  expirySeconds = castExpirySeconds(expirySeconds ?? null);

  const p = path.resolve(filePath);
  const st = await stat(p).catch(() => null);
  if (!st) throw new Error(`not a file or directory: ${p}`);

  let rawFiles: string[];
  let dirRelPaths: string[];
  let localRoot: string;
  const isDir = st.isDirectory();

  if (isDir) {
    const walked = await walkFolder(p, {
      exclude: opts.exclude ?? undefined,
    });
    rawFiles = walked.files;
    dirRelPaths = walked.dirRelPaths;
    localRoot = p;
  } else if (st.isFile()) {
    rawFiles = [p];
    dirRelPaths = [];
    localRoot = path.dirname(p);
  } else {
    throw new Error(`not a file or directory: ${p}`);
  }

  if (!rawFiles.length) {
    throw new Error(`${p} contains no files to upload`);
  }

  const title = opts.title ?? path.basename(p);
  const message = opts.message ?? null;
  const password = opts.password ?? null;
  const sender = opts.sender ?? null;
  const notifyExpiry = opts.notifyExpiry ?? false;
  const maxDownloads = opts.maxDownloads ?? null;
  const recipients = opts.recipients ?? null;
  const schedule = opts.schedule ?? null;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const parallel = opts.parallel ?? null;

  if (notifyExpiry && (!expirySeconds || !sender)) {
    throw new MegaAPIError("notify_expiry requires both expiry>0 and sender");
  }
  if (
    (message || password || (expirySeconds && expirySeconds > 0)) &&
    !sender
  ) {
    throw new MegaAPIError(
      "sender email is required when setting message / password / expiry",
    );
  }
  if (recipients?.length && !sender) {
    throw new MegaAPIError("recipients require sender email");
  }

  const sized = await Promise.all(
    rawFiles.map(async (f) => ({ f, size: (await stat(f)).size })),
  );
  sized.sort((a, b) => a.size - b.size);
  const files = sized.map((x) => x.f);
  const sizes = sized.map((x) => x.size);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);

  opts.onStart?.(totalBytes, files.length);

  await api.createEphemeralSession();
  const { xh, rootH } = await api.createTransfer(title);
  const dirHandles = await buildRemoteTree(api, rootH, dirRelPaths);

  const pools = await api.uploadPools();
  const effectiveParallel = parallel ?? Math.max(2, pools.length);

  const pickPool = (sz: number): [string, string] => {
    for (const entry of pools) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const host = String(entry[0]);
      const uri = String(entry[1]);
      const limit = entry.length > 2 ? Number(entry[2]) : 0;
      if (!limit || sz <= limit) return [host, uri];
    }
    throw new MegaAPIError(`no upload pool available: ${JSON.stringify(pools)}`);
  };

  const perFileSent = files.map(() => 0);
  let totalSent = 0;
  const lim = Math.max(1, Math.min(effectiveParallel, files.length));
  let active = 0;
  const waitQueue: (() => void)[] = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < lim) {
        active++;
        resolve();
      } else {
        waitQueue.push(() => {
          active++;
          resolve();
        });
      }
    });
  const release = () => {
    active--;
    waitQueue.shift()?.();
  };

  const relParents = isDir
    ? files.map((f) => {
        const rp = path.relative(localRoot, path.dirname(f)).split(path.sep).join("/");
        return rp === "" || rp === "." ? "" : rp;
      })
    : files.map(() => "");

  await Promise.all(
    files.map(async (f, i) => {
      const fsize = sizes[i]!;
      const relParent = relParents[i]!;
      const [host, uri] = pickPool(fsize);
      const ulKey = randA32(6);
      const idx = opts.filenoProvider();

      await acquire();
      try {
        opts.onFileStart?.(idx, f, fsize);

        const { token, macs } = await wsUploadOne(host, uri, f, ulKey, {
          fileno: idx,
          concurrency,
          size: fsize,
          progress: (sent) => {
            const delta = sent - perFileSent[i]!;
            perFileSent[i] = sent;
            totalSent += delta;
            opts.onProgress?.(Math.min(totalSent, totalBytes), totalBytes);
            opts.onFileProgress?.(idx, f, sent, fsize);
          },
        });

        const delta = fsize - perFileSent[i]!;
        perFileSent[i] = fsize;
        totalSent += delta;
        opts.onProgress?.(Math.min(totalSent, totalBytes), totalBytes);

        const targetH = dirHandles.get(relParent) ?? rootH;
        await api.finaliseFile(targetH, token, ulKey, macs, path.basename(f));
        opts.onFileDone?.(idx, f, fsize);
      } finally {
        release();
      }
    }),
  );

  const extrasSet =
    [message, password, sender, expirySeconds, maxDownloads].some(
      (v) => v != null && v !== "",
    ) || notifyExpiry;

  if (extrasSet) {
    await api.setTransferAttributes(xh, {
      title,
      message,
      password,
      sender,
      expirySeconds,
      notifyBeforeExpirySeconds: notifyExpiry ? 3 * 864_000 : null,
      maxDownloads,
    });
  }

  if (recipients?.length) {
    for (const email of recipients) {
      await api.setTransferRecipient(xh, email, { schedule });
    }
  }

  await api.closeTransfer(xh);

  return makeUploadResult({
    xh,
    url: `${SHARE_BASE}/t/${xh}`,
    title,
    totalBytes,
    fileCount: files.length,
    folderCount: dirRelPaths.length,
  });
}
