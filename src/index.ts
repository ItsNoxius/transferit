/**
 * @noxius/transferit — TypeScript client for https://transfer.it (Node + browser).
 *
 * Port of transferit-py (MIT). Independent community project — not affiliated
 * with MEGA Limited or transfer.it.
 */

export { Transferit, type TransferitOptions } from "./client.js";
export { MegaAPI, API_BASE, SHARE_BASE } from "./api.js";
export { MegaAPIError } from "./errors.js";
export type {
  TransferInfo,
  TransferNode,
  UploadResult,
  DownloadResult,
} from "./models.js";
export type {
  UploadOptions,
  UploadSource,
  UploadEntry,
} from "./actions-upload.js";
export type { DownloadOptions } from "./actions-read.js";
export { DEFAULT_CONCURRENCY, blobSource, type ByteSource } from "./upload.js";
export {
  createDecryptTransform,
  streamDecrypt,
  computeFolderPaths,
} from "./download.js";
export {
  downloadViaServiceWorker,
  downloadNodeViaServiceWorker,
  ensureServiceWorker,
  putDownloadJob,
  triggerServiceWorkerDownload,
  DL_PREFIX,
  type BrowserDownloadOptions,
  type DownloadJob,
} from "./browser-download.js";
