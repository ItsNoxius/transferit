/**
 * Service worker: stream MEGA ciphertext → AES-CTR plaintext into the
 * browser download manager (no full-file ArrayBuffer).
 *
 * Jobs are queued by the page in IndexedDB before navigating to
 * /__transferit_dl__/<jobId>
 *
 * Ship this file at your site root (or configure serviceWorkerUrl).
 * Built as dist/sw-download.js — also mirrored at examples/sw-download.js.
 */

/// <reference lib="webworker" />

import { createDecryptTransform } from "./decrypt-stream.js";

declare const self: ServiceWorkerGlobalScope;

const DB_NAME = "transferit-dl";
const STORE = "jobs";
const DL_PREFIX = "/__transferit_dl__/";

self.addEventListener("install", (e) => {
  e.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes(DL_PREFIX)) return;

  const id = url.pathname.split(DL_PREFIX).pop()?.replace(/\/$/, "") ?? "";
  if (!id) return;

  event.respondWith(handleDownload(id));
});

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface Job {
  id: string;
  cdnUrl: string;
  keyA32: number[];
  size: number;
  filename: string;
}

async function takeJob(id: string): Promise<Job | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const job = getReq.result as Job | undefined;
      if (job) store.delete(id);
      resolve(job ?? null);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function contentDisposition(filename: string): string {
  const safe = String(filename || "download").replace(/[\r\n"]/g, "_");
  const encoded = encodeURIComponent(safe).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

async function handleDownload(id: string): Promise<Response> {
  const job = await takeJob(id);
  if (!job) {
    return new Response("Download job not found or already used.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const cdn = await fetch(job.cdnUrl);
  if (!cdn.ok || !cdn.body) {
    return new Response(`CDN HTTP ${cdn.status}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const size = Number(job.size) || 0;
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(job.filename),
    "Cache-Control": "no-store",
  });
  if (size > 0) headers.set("Content-Length", String(size));

  const plainStream = cdn.body.pipeThrough(
    createDecryptTransform(job.keyA32, size),
  );

  return new Response(plainStream, { status: 200, headers });
}
