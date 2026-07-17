/**
 * Browser download via Service Worker streaming decrypt.
 *
 * Flow: register SW → put job in IndexedDB → navigate to /__transferit_dl__/<id>
 * → SW fetches CDN ciphertext, AES-CTR decrypts, streams as attachment.
 */

import type { MegaAPI } from "./api.js";
import {
  DL_PREFIX,
  putDownloadJob,
  type DownloadJob,
} from "./dl-job.js";
import type { TransferNode } from "./models.js";

export {
  DL_PREFIX,
  DL_DB_NAME,
  DL_STORE,
  putDownloadJob,
  type DownloadJob,
} from "./dl-job.js";

export interface BrowserDownloadOptions {
  password?: string | null;
  /** Absolute or relative URL to the service worker script (default: `/sw-download.js`). */
  serviceWorkerUrl?: string;
  /** SW registration scope (default: `/`). */
  scope?: string;
  onFileStart?: (node: TransferNode) => void;
  onFileDone?: (node: TransferNode) => void;
}

export async function ensureServiceWorker(
  scriptUrl = "/sw-download.js",
  scope = "/",
): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers required for streaming downloads");
  }
  const reg = await navigator.serviceWorker.register(scriptUrl, { scope });
  await navigator.serviceWorker.ready;

  if (navigator.serviceWorker.controller) return reg;

  // First visit after register: this document isn't controlled until reload.
  if (typeof sessionStorage !== "undefined") {
    if (!sessionStorage.getItem("transferit-sw-reloaded")) {
      sessionStorage.setItem("transferit-sw-reloaded", "1");
      location.reload();
      await new Promise(() => {});
    }
  }
  throw new Error(
    "Service Worker isn’t controlling this page yet — reload and try again",
  );
}

/** Queue one SW download job and trigger the browser download UI. */
export async function triggerServiceWorkerDownload(
  job: Omit<DownloadJob, "id"> & { id?: string },
): Promise<string> {
  const id = job.id ?? crypto.randomUUID();
  await putDownloadJob({ ...job, id });

  const a = document.createElement("a");
  a.href = new URL(`${DL_PREFIX}${id}`, location.href).href;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return id;
}

/**
 * List a transfer and download each file through the service worker.
 * Returns the file count started (browser download shelf handles the rest).
 */
export async function downloadViaServiceWorker(
  api: MegaAPI,
  urlOrXh: string,
  opts: BrowserDownloadOptions = {},
): Promise<{ xh: string; started: number; nodes: TransferNode[] }> {
  const { MegaAPI } = await import("./api.js");
  const { transferNodeFromDict } = await import("./models.js");
  const xh = MegaAPI.parseXh(urlOrXh);

  await ensureServiceWorker(
    opts.serviceWorkerUrl ?? "/sw-download.js",
    opts.scope ?? "/",
  );

  const { nodes: raw, pwToken } = await api.fetchTransfer(xh, {
    password: opts.password,
  });
  const files = raw.map(transferNodeFromDict).filter((n) => n.isFile);

  let started = 0;
  for (const n of files) {
    opts.onFileStart?.(n);
    const dl = await api.getDownloadUrl(xh, n.handle, { pwToken });
    const size = Number(dl.s) || n.size || 0;
    await triggerServiceWorkerDownload({
      cdnUrl: String(dl.g),
      keyA32: n.key,
      size,
      filename: n.name || n.handle,
    });
    opts.onFileDone?.(n);
    started++;
  }

  return { xh, started, nodes: files };
}

/** Download a single already-resolved node (CDN URL + key). */
export async function downloadNodeViaServiceWorker(
  api: MegaAPI,
  xh: string,
  node: TransferNode,
  opts?: {
    pwToken?: string | null;
    serviceWorkerUrl?: string;
    scope?: string;
    /** Skip register when caller already ensured (default true = ensure). */
    ensure?: boolean;
  },
): Promise<void> {
  if (opts?.ensure !== false) {
    await ensureServiceWorker(
      opts?.serviceWorkerUrl ?? "/sw-download.js",
      opts?.scope ?? "/",
    );
  }
  const dl = await api.getDownloadUrl(xh, node.handle, {
    pwToken: opts?.pwToken ?? null,
  });
  const size = Number(dl.s) || node.size || 0;
  await triggerServiceWorkerDownload({
    cdnUrl: String(dl.g),
    keyA32: node.key,
    size,
    filename: node.name || node.handle,
  });
}
