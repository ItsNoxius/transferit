# @noxius/transferit

TypeScript/Node client for [transfer.it](https://transfer.it) — upload and download via the MEGA backend, no browser required.

Port of [transferit-py](https://github.com/viperadnan-git/transferit-py) (MIT). Not affiliated with MEGA or transfer.it.

```ts
import {
  Transferit,
  MegaAPI,
  MegaAPIError,
  type UploadResult,
  type DownloadResult,
  type TransferInfo,
  type TransferNode,
} from "@noxius/transferit";
```

## Install

```bash
npm install @noxius/transferit
```

Requires Node.js 20+.

---

## Client setup

One `Transferit` instance owns the MEGA `bt7` API client and (lazily) an anonymous ephemeral account reused across uploads.

```ts
const tx = new Transferit({
  defaultSender: "me@example.com",   // used when upload omits sender
  defaultExpiry: "7d",               // seconds or duration string
  defaultConcurrency: 8,             // WebSocket connections per file
  defaultParallel: null,             // files uploaded at once (null = auto)
});

// …use tx…

tx.close();
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `api` | `MegaAPI` | new instance | Inject for tests or a custom API base |
| `defaultSender` | `string \| null` | `null` | Fallback for `upload({ sender })` |
| `defaultExpiry` | `number \| string \| null` | `null` | Fallback for `upload({ expiry })` |
| `defaultConcurrency` | `number` | `8` | Per-file WebSocket fan-out |
| `defaultParallel` | `number \| null` | `null` | Concurrent files; `null` → `max(2, poolCount)` |

`tx.api` exposes the underlying [`MegaAPI`](#low-level-megaapi) for advanced calls.

---

## `upload`

Upload a **file** or **folder** into a new transfer and get a share URL.

```ts
async function upload(
  path: string,
  opts?: UploadOptions,
): Promise<UploadResult>
```

Creates an ephemeral MEGA session on first write, builds a transfer container, streams AES-encrypted chunks over WebSockets, then returns `https://transfer.it/t/<xh>`.

### Minimal

```ts
const tx = new Transferit();
const result = await tx.upload("./report.pdf");

console.log(result.url);         // https://transfer.it/t/xxxxxxxxxxxx
console.log(result.xh);          // xxxxxxxxxxxx
console.log(result.totalBytes);
console.log(result.fileCount);   // 1
tx.close();
```

### Folder

Uploads recursively and recreates the directory tree on the transfer. Empty subfolders are preserved. Symlinks are not followed.

```ts
const result = await tx.upload("./project", {
  title: "project dump",
  exclude: [".git", "node_modules", "*.log"],
});

console.log(result.fileCount, result.folderCount);
```

### Create link (title only)

```ts
await tx.upload("./demo.mp4", {
  title: "Q1 demo",
});
```

### Send files (recipients + schedule)

`sender` is **required** whenever you set message, password, expiry, notify-on-expiry, or recipients.

```ts
await tx.upload("./deck.pdf", {
  title: "Review please",
  message: "Draft for Friday",
  sender: "me@example.com",
  recipients: ["alice@example.com", "bob@example.com"],
  schedule: Math.floor(Date.now() / 1000) + 3600, // unix seconds — delay invite email
  expiry: "7d",
  notifyExpiry: true, // needs expiry + sender
});
```

### Password-protected transfer

```ts
await tx.upload("./secrets.zip", {
  title: "Confidential",
  sender: "me@example.com",
  password: "hunter2",
  expiry: "30d",
  maxDownloads: 10,
});
```

### Progress callbacks

```ts
await tx.upload("./big.bin", {
  onStart(totalBytes, fileCount) {
    console.log(`starting ${fileCount} file(s), ${totalBytes} bytes`);
  },
  onProgress(sent, total) {
    console.log(`${((sent / total) * 100).toFixed(1)}%`);
  },
  onFileStart(fileno, filePath, size) {
    console.log(`#${fileno} ${filePath} (${size})`);
  },
  onFileProgress(fileno, filePath, sent, size) {
    // per-file progress
  },
  onFileDone(fileno, filePath, size) {
    console.log(`done #${fileno}`);
  },
});
```

### Upload options

| Option | Type | Notes |
|--------|------|-------|
| `title` | `string` | Transfer title; defaults to basename of `path` |
| `message` | `string` | Landing-page message (requires `sender`) |
| `password` | `string` | Protects the transfer (requires `sender`) |
| `sender` | `string` | Sender email; required for most extras |
| `expiry` | `number \| string` | Seconds, or duration like `"7d"`, `"2h30m"`, `"1y"` |
| `notifyExpiry` | `boolean` | Expiry reminder; needs `expiry > 0` and `sender` |
| `maxDownloads` | `number` | Cap downloads (API-supported; not on web UI) |
| `recipients` | `string[]` | Invite emails; one API call each (requires `sender`) |
| `schedule` | `number` | Unix timestamp — when to send invite emails |
| `concurrency` | `number` | WebSockets per file (default `8`) |
| `parallel` | `number` | Files uploaded at once |
| `exclude` | `string[]` | Glob patterns (`fnmatch`-style) for folder uploads |

### `UploadResult`

```ts
interface UploadResult {
  xh: string;          // 12-char handle
  url: string;         // https://transfer.it/t/<xh>
  title: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number; // subfolders created (excludes transfer root)
  toString(): string;  // same as url
  toJSON(): object;
}
```

```ts
const result = await tx.upload("./a.pdf");
console.log(String(result));           // share URL
console.log(JSON.stringify(result.toJSON(), null, 2));
```

---

## `download`

Mirror a transfer into a local directory. Recreates folder hierarchy. No session required.

```ts
async function download(
  urlOrXh: string,
  outputDir: string,
  opts?: DownloadOptions,
): Promise<DownloadResult>
```

`urlOrXh` may be a full URL (`https://transfer.it/t/…`) or the bare 12-character handle.

### Minimal

```ts
const dl = await tx.download(
  "https://transfer.it/t/xxxxxxxxxxxx",
  "./downloads",
);

console.log(dl.paths);       // absolute paths written (or skipped)
console.log(dl.skipped);     // already existed, left alone
console.log(dl.totalBytes);
```

### Password-protected

```ts
await tx.download(url, "./out", {
  password: "hunter2",
});
```

### Overwrite existing files

By default, existing files are skipped. Pass `force: true` to replace them.

```ts
await tx.download(url, "./out", { force: true });
```

### Progress callbacks

```ts
await tx.download(url, "./out", {
  onStart(files, totalBytes) {
    console.log(`${files.length} files, ${totalBytes} bytes`);
  },
  onFileStart(node, outPath) {
    console.log(`↓ ${node.name} → ${outPath}`);
  },
  onFileProgress(node, done, total) {
    console.log(`${node.name}: ${done}/${total}`);
  },
  onFileDone(node, outPath) {
    console.log(`✓ ${outPath}`);
  },
  onSkip(node, outPath) {
    console.log(`skip ${outPath}`);
  },
});
```

### Download options

| Option | Type | Notes |
|--------|------|-------|
| `password` | `string` | Plain password for protected transfers |
| `force` | `boolean` | Overwrite existing files (default `false`) |
| `onStart` | `(files, totalBytes) => void` | After listing, before downloads |
| `onFileStart` | `(node, outPath) => void` | |
| `onFileProgress` | `(node, done, total) => void` | |
| `onFileDone` | `(node, outPath) => void` | |
| `onSkip` | `(node, outPath) => void` | Fired when skipping an existing file |

### `DownloadResult`

```ts
interface DownloadResult {
  xh: string;
  outputDir: string;   // absolute
  paths: string[];     // every file path (including skipped)
  skipped: string[];
  totalBytes: number;
  toJSON(): object;
}
```

---

## `info`

List every file and folder node in a transfer. No session required.

```ts
async function info(
  urlOrXh: string,
  opts?: { password?: string | null },
): Promise<TransferNode[]>
```

### List contents

```ts
const nodes = await tx.info("https://transfer.it/t/xxxxxxxxxxxx");

for (const n of nodes) {
  if (n.isFolder) {
    console.log(`[dir]  ${n.name}  (${n.handle})`);
  } else {
    console.log(`[file] ${n.name}  ${n.size} bytes`);
  }
}
```

### Password-protected

```ts
const nodes = await tx.info(url, { password: "hunter2" });
const files = nodes.filter((n) => n.isFile);
```

### Tree-ish print

```ts
const nodes = await tx.info(url);
const byHandle = new Map(nodes.map((n) => [n.handle, n]));

for (const n of nodes.filter((n) => n.isFile)) {
  const parts: string[] = [n.name ?? n.handle];
  let p = n.parent;
  while (p) {
    const parent = byHandle.get(p);
    if (!parent || !parent.parent) break; // stop at transfer root
    parts.unshift(parent.name ?? parent.handle);
    p = parent.parent;
  }
  console.log(parts.join("/") + ` (${n.size})`);
}
```

### `TransferNode`

```ts
interface TransferNode {
  handle: string;
  parent: string;          // "" for transfer root
  kind: number;            // 0 = file, 1 = folder
  name: string | null;
  size: number | null;     // null for folders
  timestamp: number | null;
  key: number[];           // a32 key (for advanced decrypt)
  raw: Record<string, unknown>;
  readonly isFile: boolean;
  readonly isFolder: boolean;
  toJSON(): object;
}
```

---

## `metadata`

Fetch transfer-level metadata (`xi`). No session required.

```ts
async function metadata(
  urlOrXh: string,
  opts?: { password?: string | null },
): Promise<TransferInfo>
```

`password` is accepted for API symmetry with `info` / `download` but is **ignored** — `xi` returns title, sender, size totals, and the password flag even for protected transfers (without unlocking file listing).

### Read panel info

```ts
const meta = await tx.metadata("https://transfer.it/t/xxxxxxxxxxxx");

console.log(meta.title);
console.log(meta.sender);
console.log(meta.message);
console.log(meta.passwordProtected);
console.log(meta.totalBytes, meta.fileCount, meta.folderCount);
console.log(meta.url);
```

### Gate before download

```ts
const meta = await tx.metadata(url);

if (meta.passwordProtected) {
  const password = process.env.TRANSFER_PASSWORD;
  if (!password) throw new Error("password required");
  await tx.download(url, "./out", { password });
} else {
  await tx.download(url, "./out");
}
```

### `TransferInfo`

```ts
interface TransferInfo {
  xh: string;
  url: string;
  rootHandle: string | null;
  title: string | null;
  sender: string | null;
  message: string | null;
  passwordProtected: boolean;
  zipHandle: string | null;
  zipPending: boolean;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  raw: Record<string, unknown>;
  toJSON(): object;
}
```

---

## Errors

API failures throw `MegaAPIError`. Numeric MEGA codes are on `.code`; short labels on `.codeName`.

```ts
import { MegaAPIError } from "@noxius/transferit";

try {
  await tx.info(url, { password: "wrong" });
} catch (err) {
  if (err instanceof MegaAPIError) {
    if (err.code === -14) {
      // EKEY — missing or wrong password
      console.error(err.message, err.codeName);
    } else if (err.code === -9) {
      // ENOENT — deleted / expired / bad handle
      console.error("transfer not found");
    } else {
      console.error(err.code, err.message);
    }
  } else {
    throw err;
  }
}
```

Common codes: `-3` EAGAIN (auto-retried), `-8` EEXPIRED, `-9` ENOENT, `-11` EACCESS, `-14` EKEY, `-15` ESID.

---

## End-to-end example

```ts
import { Transferit } from "@noxius/transferit";

const tx = new Transferit({ defaultSender: "me@example.com" });

const uploaded = await tx.upload("./hello.txt", {
  title: "hello",
  expiry: "7d",
  onProgress: (sent, total) => {
    process.stdout.write(`\r${sent}/${total}`);
  },
});
console.log("\nshare:", uploaded.url);

const meta = await tx.metadata(uploaded.url);
console.log("title:", meta.title, "bytes:", meta.totalBytes);

const nodes = await tx.info(uploaded.url);
console.log(
  "files:",
  nodes.filter((n) => n.isFile).map((n) => n.name),
);

const dl = await tx.download(uploaded.url, "./out");
console.log("wrote:", dl.paths);

tx.close();
```

---

## Low-level `MegaAPI`

Most apps only need `Transferit`. Use `MegaAPI` directly when you need individual bt7 verbs or a custom base URL.

```ts
import { MegaAPI, Transferit } from "@noxius/transferit";

const api = new MegaAPI(); // default https://bt7.api.mega.co.nz/
await api.createEphemeralSession();

const { xh, rootH } = await api.createTransfer("manual");
// …upload chunks yourself, then:
// await api.finaliseFile(rootH, token, ulKey, macs, "file.bin");
await api.closeTransfer(xh);

const xh2 = MegaAPI.parseXh("https://transfer.it/t/xxxxxxxxxxxx");
const pw = MegaAPI.derivePassword(xh2, "hunter2");

// Inject into the high-level client:
const tx = new Transferit({ api });
```

| Method | Purpose |
|--------|---------|
| `MegaAPI.parseXh(urlOrXh)` | Extract 12-char handle |
| `MegaAPI.derivePassword(xh, password)` | PBKDF2 token for protected transfers |
| `api.createEphemeralSession()` | Anonymous `up` + `us` |
| `api.createTransfer(name)` | `xn` → `{ xh, rootH, folderKey }` |
| `api.closeTransfer(xh)` | `xc` |
| `api.fetchTransfer(xh, { password? })` | `f` listing |
| `api.fetchTransferInfo(xh)` | `xi` metadata |
| `api.getDownloadUrl(xh, nodeHandle, { pwToken? })` | `g` |
| `api.uploadPools()` | `usc` WebSocket pool directory |

Protocol internals: [`docs/REVERSE_ENGINEERING.md`](docs/REVERSE_ENGINEERING.md).

---

## Duration strings

`expiry` accepts integers (seconds) or human durations:

| Input | Seconds |
|-------|---------|
| `"30s"` | 30 |
| `"5m"` | 300 |
| `"2h"` | 7200 |
| `"7d"` | 604800 |
| `"1w"` | 604800 |
| `"1y"` | 31536000 |
| `"2h30m"` | 9000 |
| `"3600"` | 3600 |

Valid range: 1 second … 10 years. `0` / omit = no expiry.

---

## Development

```bash
npm install
npm test
npm run build
TRANSFERIT_LIVE=1 npm test   # live upload/download smoke
```

## License

MIT — see [`LICENSE`](LICENSE). Protocol implementation adapted from transferit-py © Adnan Ahmad.

Use of this library must comply with [transfer.it](https://transfer.it/terms) and [MEGA](https://mega.io/terms) terms. Provided as-is, without warranty.
