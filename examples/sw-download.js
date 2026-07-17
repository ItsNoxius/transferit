"use strict";
(() => {
  // src/aes.ts
  var S = Uint8Array.from([
    99,
    124,
    119,
    123,
    242,
    107,
    111,
    197,
    48,
    1,
    103,
    43,
    254,
    215,
    171,
    118,
    202,
    130,
    201,
    125,
    250,
    89,
    71,
    240,
    173,
    212,
    162,
    175,
    156,
    164,
    114,
    192,
    183,
    253,
    147,
    38,
    54,
    63,
    247,
    204,
    52,
    165,
    229,
    241,
    113,
    216,
    49,
    21,
    4,
    199,
    35,
    195,
    24,
    150,
    5,
    154,
    7,
    18,
    128,
    226,
    235,
    39,
    178,
    117,
    9,
    131,
    44,
    26,
    27,
    110,
    90,
    160,
    82,
    59,
    214,
    179,
    41,
    227,
    47,
    132,
    83,
    209,
    0,
    237,
    32,
    252,
    177,
    91,
    106,
    203,
    190,
    57,
    74,
    76,
    88,
    207,
    208,
    239,
    170,
    251,
    67,
    77,
    51,
    133,
    69,
    249,
    2,
    127,
    80,
    60,
    159,
    168,
    81,
    163,
    64,
    143,
    146,
    157,
    56,
    245,
    188,
    182,
    218,
    33,
    16,
    255,
    243,
    210,
    205,
    12,
    19,
    236,
    95,
    151,
    68,
    23,
    196,
    167,
    126,
    61,
    100,
    93,
    25,
    115,
    96,
    129,
    79,
    220,
    34,
    42,
    144,
    136,
    70,
    238,
    184,
    20,
    222,
    94,
    11,
    219,
    224,
    50,
    58,
    10,
    73,
    6,
    36,
    92,
    194,
    211,
    172,
    98,
    145,
    149,
    228,
    121,
    231,
    200,
    55,
    109,
    141,
    213,
    78,
    169,
    108,
    86,
    244,
    234,
    101,
    122,
    174,
    8,
    186,
    120,
    37,
    46,
    28,
    166,
    180,
    198,
    232,
    221,
    116,
    31,
    75,
    189,
    139,
    138,
    112,
    62,
    181,
    102,
    72,
    3,
    246,
    14,
    97,
    53,
    87,
    185,
    134,
    193,
    29,
    158,
    225,
    248,
    152,
    17,
    105,
    217,
    142,
    148,
    155,
    30,
    135,
    233,
    206,
    85,
    40,
    223,
    140,
    161,
    137,
    13,
    191,
    230,
    66,
    104,
    65,
    153,
    45,
    15,
    176,
    84,
    187,
    22
  ]);
  var Si = new Uint8Array(256);
  for (let i = 0; i < 256; i++) Si[S[i]] = i;

  // src/crc32.ts
  var TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  // src/crypto.ts
  function buildChunkmap() {
    const res = /* @__PURE__ */ new Map();
    let p = 0;
    let dp = 0;
    while (dp < 1048576) {
      dp += 131072;
      res.set(p, dp);
      p += dp;
    }
    return res;
  }
  var CHUNKMAP = buildChunkmap();
  function a32ToBytes(a) {
    const buf2 = new Uint8Array(a.length * 4);
    const view = new DataView(buf2.buffer);
    for (let i = 0; i < a.length; i++) view.setUint32(i * 4, a[i] >>> 0, false);
    return buf2;
  }
  function attrKey(keyA32) {
    const k = [...keyA32];
    while (k.length < 8) k.push(0);
    return a32ToBytes([
      (k[0] ^ k[4]) >>> 0,
      (k[1] ^ k[5]) >>> 0,
      (k[2] ^ k[6]) >>> 0,
      (k[3] ^ k[7]) >>> 0
    ]);
  }

  // src/decrypt-stream.ts
  function buf(u) {
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  }
  function ctrCounter(nonce8, blockOffset) {
    const counter = new Uint8Array(16);
    counter.set(nonce8.subarray(0, 8), 0);
    const view = new DataView(counter.buffer);
    view.setUint32(8, Math.floor(blockOffset / 4294967296), false);
    view.setUint32(12, blockOffset >>> 0, false);
    return counter;
  }
  function createDecryptTransform(keyA32, plainLimit = 0) {
    let cryptoKeyPromise = null;
    const nonce = a32ToBytes(keyA32.slice(4, 6));
    let byteOffset = 0;
    let emitted = 0;
    let pending = new Uint8Array(0);
    async function getKey() {
      if (!cryptoKeyPromise) {
        cryptoKeyPromise = crypto.subtle.importKey(
          "raw",
          buf(attrKey(keyA32)),
          { name: "AES-CTR" },
          false,
          ["decrypt"]
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
        const complete = pending.length - pending.length % 16;
        if (complete === 0) return;
        const slice = pending.subarray(0, complete);
        pending = pending.subarray(complete);
        const key = await getKey();
        const plain = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-CTR",
              counter: buf(ctrCounter(nonce, Math.floor(byteOffset / 16))),
              length: 64
            },
            key,
            buf(slice)
          )
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
              counter: buf(ctrCounter(nonce, Math.floor(byteOffset / 16))),
              length: 64
            },
            key,
            buf(pending)
          )
        );
        let out = plain;
        if (plainLimit > 0) {
          const left = plainLimit - emitted;
          if (out.length > left) out = out.subarray(0, left);
        }
        if (out.length) controller.enqueue(out);
      }
    });
  }

  // src/sw-download.ts
  var DB_NAME = "transferit-dl";
  var STORE = "jobs";
  var DL_PREFIX = "/__transferit_dl__/";
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
  function contentDisposition(filename) {
    const safe = String(filename || "download").replace(/[\r\n"]/g, "_");
    const encoded = encodeURIComponent(safe).replace(
      /['()]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
  }
  async function handleDownload(id) {
    const job = await takeJob(id);
    if (!job) {
      return new Response("Download job not found or already used.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    const cdn = await fetch(job.cdnUrl);
    if (!cdn.ok || !cdn.body) {
      return new Response(`CDN HTTP ${cdn.status}`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    const size = Number(job.size) || 0;
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(job.filename),
      "Cache-Control": "no-store"
    });
    if (size > 0) headers.set("Content-Length", String(size));
    const plainStream = cdn.body.pipeThrough(
      createDecryptTransform(job.keyA32, size)
    );
    return new Response(plainStream, { status: 200, headers });
  }
})();
//# sourceMappingURL=sw-download.js.map