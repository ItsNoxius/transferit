/* Service worker: stream MEGA ciphertext → AES-CTR plaintext into the
 * browser download manager (no full-file ArrayBuffer).
 *
 * Jobs are queued by the page in IndexedDB before navigating to
 * /__transferit_dl__/<jobId>
 */

const DB_NAME = "transferit-dl";
const STORE = "jobs";
const DL_PREFIX = "/__transferit_dl__/";

self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes(DL_PREFIX)) return;

  const id = url.pathname.split(DL_PREFIX).pop().replace(/\/$/, "");
  if (!id) return;

  event.respondWith(handleDownload(id));
});

function openDb() {
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

async function takeJob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const job = getReq.result;
      if (job) store.delete(id);
      resolve(job ?? null);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function a32ToBytes(a) {
  const buf = new Uint8Array(a.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < a.length; i++) view.setUint32(i * 4, a[i] >>> 0, false);
  return buf;
}

function attrKey(keyA32) {
  const k = [...keyA32];
  while (k.length < 8) k.push(0);
  return a32ToBytes([
    (k[0] ^ k[4]) >>> 0,
    (k[1] ^ k[5]) >>> 0,
    (k[2] ^ k[6]) >>> 0,
    (k[3] ^ k[7]) >>> 0,
  ]);
}

function ctrCounter(nonce8, blockOffset) {
  const counter = new Uint8Array(16);
  counter.set(nonce8.subarray(0, 8), 0);
  const view = new DataView(counter.buffer);
  // low 64 bits = block index (big-endian), matches Node aes-128-ctr + MEGA
  view.setUint32(8, Math.floor(blockOffset / 0x100000000), false);
  view.setUint32(12, blockOffset >>> 0, false);
  return counter;
}

function contentDisposition(filename) {
  const safe = String(filename || "download").replace(/[\r\n"]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()]/g, escape);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streaming AES-CTR decrypt. Keeps at most one incoming chunk + <16 bytes
 * of alignment remainder in memory — not the whole file.
 */
function decryptTransform(keyA32, plainLimit) {
  let cryptoKeyPromise = null;
  const nonce = a32ToBytes(keyA32.slice(4, 6));
  let byteOffset = 0;
  let emitted = 0;
  let pending = new Uint8Array(0);

  async function getKey() {
    if (!cryptoKeyPromise) {
      cryptoKeyPromise = crypto.subtle.importKey(
        "raw",
        attrKey(keyA32),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
    }
    return cryptoKeyPromise;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  return new TransformStream({
    async transform(chunk, controller) {
      if (plainLimit > 0 && emitted >= plainLimit) return;

      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      pending = pending.length ? concat(pending, data) : data;

      // Decrypt complete 16-byte blocks; hold remainder for next chunk.
      const complete = pending.length - (pending.length % 16);
      if (complete === 0) return;

      const slice = pending.subarray(0, complete);
      pending = pending.subarray(complete);

      const key = await getKey();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-CTR",
            counter: ctrCounter(nonce, Math.floor(byteOffset / 16)),
            length: 64,
          },
          key,
          slice,
        ),
      );
      byteOffset += complete;

      let out = plain;
      if (plainLimit > 0) {
        const left = plainLimit - emitted;
        if (out.length > left) out = out.subarray(0, left);
      }
      if (out.length) {
        emitted += out.length;
        controller.enqueue(out);
      }
    },

    async flush(controller) {
      if (!pending.length) return;
      if (plainLimit > 0 && emitted >= plainLimit) return;

      const key = await getKey();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-CTR",
            counter: ctrCounter(nonce, Math.floor(byteOffset / 16)),
            length: 64,
          },
          key,
          pending,
        ),
      );
      let out = plain;
      if (plainLimit > 0) {
        const left = plainLimit - emitted;
        if (out.length > left) out = out.subarray(0, left);
      }
      if (out.length) controller.enqueue(out);
    },
  });
}

async function handleDownload(id) {
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
    // Hint to the download UI; body is still streamed.
    "Cache-Control": "no-store",
  });
  if (size > 0) headers.set("Content-Length", String(size));

  const plainStream = cdn.body.pipeThrough(decryptTransform(job.keyA32, size));

  return new Response(plainStream, { status: 200, headers });
}
