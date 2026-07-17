/**
 * High-level upload orchestration.
 * Port of transferit-py `_actions/_upload.py`.
 * Accepts filesystem paths (Node) or File/Blob/entries (browser).
 */

import { MegaAPI, SHARE_BASE } from "./api.js";
import { randA32 } from "./crypto.js";
import { MegaAPIError } from "./errors.js";
import { makeUploadResult, type UploadResult } from "./models.js";
import { castExpirySeconds, parseDuration } from "./transfer.js";
import {
  DEFAULT_CONCURRENCY,
  blobSource,
  buildRemoteTree,
  wsUploadOne,
  type ByteSource,
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

/** One file in a browser folder upload (`webkitRelativePath` or explicit path). */
export interface UploadEntry {
  /** Posix-ish path relative to the transfer root, e.g. `src/main.ts`. */
  path: string;
  blob: Blob;
}

export type UploadSource =
  | string
  | Blob
  | File
  | UploadEntry[]
  | FileList;

interface PreparedFile {
  label: string;
  relParent: string;
  basename: string;
  size: number;
  open: () => Promise<ByteSource>;
}

function basenamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirnamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function prepareSource(
  source: UploadSource,
  opts: UploadOptions,
): Promise<{
  title: string;
  files: PreparedFile[];
  dirRelPaths: string[];
}> {
  if (typeof source === "string") {
    const { pathSource, walkFolder } = await import("./upload-fs.js");
    const path = await import("node:path");
    const { stat } = await import("node:fs/promises");

    const p = path.resolve(source);
    const st = await stat(p).catch(() => null);
    if (!st) throw new Error(`not a file or directory: ${p}`);

    if (st.isDirectory()) {
      const walked = await walkFolder(p, {
        exclude: opts.exclude ?? undefined,
      });
      if (!walked.files.length) {
        throw new Error(`${p} contains no files to upload`);
      }
      const files: PreparedFile[] = [];
      for (const f of walked.files) {
        const size = (await stat(f)).size;
        const relParent = path
          .relative(p, path.dirname(f))
          .split(path.sep)
          .join("/");
        files.push({
          label: f,
          relParent: relParent === "" || relParent === "." ? "" : relParent,
          basename: path.basename(f),
          size,
          open: () => pathSource(f),
        });
      }
      return {
        title: opts.title ?? path.basename(p),
        files,
        dirRelPaths: walked.dirRelPaths,
      };
    }

    if (st.isFile()) {
      return {
        title: opts.title ?? path.basename(p),
        files: [
          {
            label: p,
            relParent: "",
            basename: path.basename(p),
            size: st.size,
            open: () => pathSource(p),
          },
        ],
        dirRelPaths: [],
      };
    }
    throw new Error(`not a file or directory: ${p}`);
  }

  if (typeof FileList !== "undefined" && source instanceof FileList) {
    const entries: UploadEntry[] = [];
    for (let i = 0; i < source.length; i++) {
      const f = source.item(i)!;
      const rel =
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      entries.push({ path: normalizeRel(rel), blob: f });
    }
    return prepareEntries(entries, opts);
  }

  if (Array.isArray(source)) {
    return prepareEntries(source, opts);
  }

  // Blob / File
  const blob = source as Blob;
  const name =
    blob instanceof File
      ? blob.name
      : opts.title?.trim() || "upload.bin";
  return {
    title: opts.title ?? name,
    files: [
      {
        label: name,
        relParent: "",
        basename: basenamePosix(name),
        size: blob.size,
        open: async () => blobSource(blob, name),
      },
    ],
    dirRelPaths: [],
  };
}

function prepareEntries(
  entries: UploadEntry[],
  opts: UploadOptions,
): {
  title: string;
  files: PreparedFile[];
  dirRelPaths: string[];
} {
  if (!entries.length) throw new Error("no files to upload");

  const dirSet = new Set<string>();
  const files: PreparedFile[] = [];

  for (const e of entries) {
    const rel = normalizeRel(e.path);
    if (!rel || rel.endsWith("/")) continue;
    const parent = dirnamePosix(rel);
    if (parent) {
      const parts = parent.split("/");
      for (let i = 1; i <= parts.length; i++) {
        dirSet.add(parts.slice(0, i).join("/"));
      }
    }
    const name = basenamePosix(rel);
    files.push({
      label: rel,
      relParent: parent,
      basename: name,
      size: e.blob.size,
      open: async () => blobSource(e.blob, name),
    });
  }

  if (!files.length) throw new Error("no files to upload");

  const dirRelPaths = [...dirSet].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );

  return {
    title: opts.title ?? basenamePosix(normalizeRel(entries[0]!.path)),
    files,
    dirRelPaths,
  };
}

export async function doUpload(
  api: MegaAPI,
  source: UploadSource,
  opts: UploadOptions & { filenoProvider: () => number },
): Promise<UploadResult> {
  let expirySeconds: number | null | undefined =
    typeof opts.expiry === "string"
      ? parseDuration(opts.expiry)
      : opts.expiry;
  expirySeconds = castExpirySeconds(expirySeconds ?? null);

  const prepared = await prepareSource(source, opts);
  const { title, dirRelPaths } = prepared;
  const files = [...prepared.files].sort((a, b) => a.size - b.size);

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

  const totalBytes = files.reduce((a, f) => a + f.size, 0);
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

  await Promise.all(
    files.map(async (f, i) => {
      const fsize = f.size;
      const [host, uri] = pickPool(fsize);
      const ulKey = randA32(6);
      const idx = opts.filenoProvider();

      await acquire();
      try {
        opts.onFileStart?.(idx, f.label, fsize);
        const sourceBytes = await f.open();

        const { token, macs } = await wsUploadOne(host, uri, sourceBytes, ulKey, {
          fileno: idx,
          concurrency,
          size: fsize,
          progress: (sent) => {
            const delta = sent - perFileSent[i]!;
            perFileSent[i] = sent;
            totalSent += delta;
            opts.onProgress?.(Math.min(totalSent, totalBytes), totalBytes);
            opts.onFileProgress?.(idx, f.label, sent, fsize);
          },
        });

        const delta = fsize - perFileSent[i]!;
        perFileSent[i] = fsize;
        totalSent += delta;
        opts.onProgress?.(Math.min(totalSent, totalBytes), totalBytes);

        const targetH = dirHandles.get(f.relParent) ?? rootH;
        await api.finaliseFile(targetH, token, ulKey, macs, f.basename);
        opts.onFileDone?.(idx, f.label, fsize);
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
