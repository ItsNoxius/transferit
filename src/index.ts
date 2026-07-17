/**
 * @noxius/transferit — TypeScript/Node client for https://transfer.it.
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
export type { UploadOptions } from "./actions-upload.js";
export type { DownloadOptions } from "./actions-read.js";
export { DEFAULT_CONCURRENCY } from "./upload.js";
