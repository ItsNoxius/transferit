/** Port of transferit-py download / info / metadata actions. */

import path from "node:path";
import { access } from "node:fs/promises";
import { MegaAPI, SHARE_BASE } from "./api.js";
import { computeFolderPaths, streamDecryptToFile } from "./download.js";
import {
  makeDownloadResult,
  transferInfoFromDict,
  transferNodeFromDict,
  type DownloadResult,
  type TransferInfo,
  type TransferNode,
} from "./models.js";

export interface DownloadOptions {
  password?: string | null;
  force?: boolean;
  onStart?: (files: TransferNode[], totalBytes: number) => void;
  onFileStart?: (node: TransferNode, outPath: string) => void;
  onFileProgress?: (node: TransferNode, done: number, total: number) => void;
  onFileDone?: (node: TransferNode, outPath: string) => void;
  onSkip?: (node: TransferNode, outPath: string) => void;
}

export async function doDownload(
  api: MegaAPI,
  urlOrXh: string,
  outputDir: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const xh = MegaAPI.parseXh(urlOrXh);
  const outRoot = path.resolve(outputDir);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outRoot, { recursive: true });

  const { nodes: nodeDicts, pwToken } = await api.fetchTransfer(xh, {
    password: opts.password,
  });
  const nodes = nodeDicts.map(transferNodeFromDict);

  const root =
    nodes.find((n) => n.isFolder && !n.parent)?.handle ?? null;
  const folderPaths = root
    ? computeFolderPaths(
        nodeDicts.map((n) => ({
          h: n.h,
          p: n.p,
          t: n.t,
          name: n.name,
        })),
        root,
      )
    : new Map<string, string>();

  const files = nodes.filter((n) => n.isFile);
  const totalBytes = files.reduce((a, n) => a + (n.size ?? 0), 0);
  opts.onStart?.(files, totalBytes);

  const paths: string[] = [];
  const skipped: string[] = [];
  const force = opts.force ?? false;

  for (const n of files) {
    const rel = folderPaths.get(n.parent) ?? "";
    const outPath = path.join(outRoot, rel, n.name || n.handle);
    paths.push(outPath);

    const exists = await access(outPath).then(
      () => true,
      () => false,
    );
    if (exists && !force) {
      skipped.push(outPath);
      opts.onSkip?.(n, outPath);
      continue;
    }

    const dl = await api.getDownloadUrl(xh, n.handle, { pwToken });
    const size = Number(dl.s);
    opts.onFileStart?.(n, outPath);

    await streamDecryptToFile(
      String(dl.g),
      outPath,
      n.key,
      size,
      (d, t) => opts.onFileProgress?.(n, d, t),
    );

    opts.onFileDone?.(n, outPath);
  }

  return makeDownloadResult({
    xh,
    outputDir: outRoot,
    paths,
    skipped,
    totalBytes,
  });
}

export async function doInfo(
  api: MegaAPI,
  urlOrXh: string,
  opts?: { password?: string | null },
): Promise<TransferNode[]> {
  const xh = MegaAPI.parseXh(urlOrXh);
  const { nodes } = await api.fetchTransfer(xh, { password: opts?.password });
  return nodes.map(transferNodeFromDict);
}

export async function doMetadata(
  api: MegaAPI,
  urlOrXh: string,
  _opts?: { password?: string | null },
): Promise<TransferInfo> {
  const xh = MegaAPI.parseXh(urlOrXh);
  const raw = await api.fetchTransferInfo(xh);
  return transferInfoFromDict(xh, raw, { url: `${SHARE_BASE}/t/${xh}` });
}
