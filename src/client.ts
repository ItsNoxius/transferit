/**
 * Transferit — the stateful high-level client.
 * Port of transferit-py `_client.py`.
 */

import { MegaAPI } from "./api.js";
import { doDownload, doInfo, doMetadata, type DownloadOptions } from "./actions-read.js";
import {
  doUpload,
  type UploadOptions,
  type UploadSource,
} from "./actions-upload.js";
import {
  downloadViaServiceWorker,
  type BrowserDownloadOptions,
} from "./browser-download.js";
import type {
  DownloadResult,
  TransferInfo,
  TransferNode,
  UploadResult,
} from "./models.js";
import { DEFAULT_CONCURRENCY } from "./upload.js";

export interface TransferitOptions {
  api?: MegaAPI;
  defaultSender?: string | null;
  defaultExpiry?: number | string | null;
  defaultConcurrency?: number;
  defaultParallel?: number | null;
}

export class Transferit {
  private readonly api_: MegaAPI;
  private readonly ownsApi: boolean;
  private fileno = 0;
  defaultSender: string | null;
  defaultExpiry: number | string | null;
  defaultConcurrency: number;
  defaultParallel: number | null;

  constructor(opts: TransferitOptions = {}) {
    this.ownsApi = opts.api == null;
    this.api_ = opts.api ?? new MegaAPI();
    this.defaultSender = opts.defaultSender ?? null;
    this.defaultExpiry = opts.defaultExpiry ?? null;
    this.defaultConcurrency = opts.defaultConcurrency ?? DEFAULT_CONCURRENCY;
    this.defaultParallel = opts.defaultParallel ?? null;
  }

  get api(): MegaAPI {
    return this.api_;
  }

  close(): void {
    if (this.ownsApi) this.api_.close();
  }

  private nextFileno(): number {
    this.fileno += 1;
    return this.fileno;
  }

  /**
   * Upload a filesystem path (Node), or a File / Blob / FileList / entry list
   * (browser).
   */
  async upload(
    source: UploadSource,
    opts: UploadOptions = {},
  ): Promise<UploadResult> {
    return doUpload(this.api_, source, {
      ...opts,
      sender: opts.sender ?? this.defaultSender,
      expiry: opts.expiry ?? this.defaultExpiry,
      concurrency: opts.concurrency ?? this.defaultConcurrency,
      parallel: opts.parallel ?? this.defaultParallel,
      filenoProvider: () => this.nextFileno(),
    });
  }

  /** Node: decrypt transfer files into `outputDir`. */
  async download(
    urlOrXh: string,
    outputDir: string,
    opts: DownloadOptions = {},
  ): Promise<DownloadResult> {
    return doDownload(this.api_, urlOrXh, outputDir, opts);
  }

  /**
   * Browser: stream each file through a service worker into the download shelf.
   * Register `sw-download.js` (from `@noxius/transferit/sw`) at your origin.
   */
  async downloadBrowser(
    urlOrXh: string,
    opts: BrowserDownloadOptions = {},
  ): Promise<{ xh: string; started: number; nodes: TransferNode[] }> {
    return downloadViaServiceWorker(this.api_, urlOrXh, opts);
  }

  async info(
    urlOrXh: string,
    opts?: { password?: string | null },
  ): Promise<TransferNode[]> {
    return doInfo(this.api_, urlOrXh, opts);
  }

  async metadata(
    urlOrXh: string,
    opts?: { password?: string | null },
  ): Promise<TransferInfo> {
    return doMetadata(this.api_, urlOrXh, opts);
  }
}
