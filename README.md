# @noxius/transferit

TypeScript/Node client for [transfer.it](https://transfer.it) — upload and download files via the MEGA backend, no browser required.

Port of [transferit-py](https://github.com/viperadnan-git/transferit-py) (MIT). Independent community project — **not** affiliated with MEGA Limited or transfer.it.

```ts
import { Transferit } from "@noxius/transferit";

const tx = new Transferit();
const result = await tx.upload("./report.pdf");
console.log(result.url); // https://transfer.it/t/…
await tx.close();
```

## Install

```bash
npm install @noxius/transferit
```

Requires **Node.js 20+**.

## Library API

| Method | Returns | Needs session? |
|--------|---------|----------------|
| `tx.upload(path, opts?)` | `UploadResult` | yes (lazy ephemeral account) |
| `tx.download(url, dir, opts?)` | `DownloadResult` | no |
| `tx.info(url, opts?)` | `TransferNode[]` | no |
| `tx.metadata(url, opts?)` | `TransferInfo` | no |

### Upload options

Mirrors the web form: `title`, `message`, `password`, `sender`, `expiry` (seconds or `"7d"`), `notifyExpiry`, `maxDownloads`, `recipients`, `schedule`, `concurrency` (default 8), `parallel`, `exclude`, plus progress callbacks.

```ts
await tx.upload("./project", {
  title: "Q1 demo",
  sender: "me@example.com",
  expiry: "7d",
  password: "hunter2",
  recipients: ["alice@example.com"],
  onProgress: (sent, total) => console.log(`${sent}/${total}`),
});
```

### Defaults

```ts
new Transferit({
  defaultSender: "me@example.com",
  defaultExpiry: "7d",
  defaultConcurrency: 8,
});
```

### Low-level

`MegaAPI` exposes every bt7 command (`createEphemeralSession`, `createTransfer`, `finaliseFile`, …). Inject via `new Transferit({ api })` for testing.

Protocol details: [`docs/REVERSE_ENGINEERING.md`](docs/REVERSE_ENGINEERING.md).

## Development

```bash
npm install
npm test
npm run build
TRANSFERIT_LIVE=1 npm test   # optional live upload/download smoke
```

## Publish

### Trusted publishing (recommended)

1. Publish the package once (or create it on npmjs.com), then open **Package settings → Trusted Publisher**.
2. Set:
   - **Organization or user:** `ItsNoxius`
   - **Repository:** `transferit`
   - **Workflow filename:** `publish.yml`
3. Release by tagging:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The [publish workflow](.github/workflows/publish.yml) builds, tests, and runs `npm publish` via OIDC (no `NPM_TOKEN`).

### Manual

```bash
npm login
npm publish
```

Scoped package uses `"publishConfig": { "access": "public" }`.

## License

MIT — see [`LICENSE`](LICENSE). Crypto/protocol implementation adapted from transferit-py © Adnan Ahmad.

## Disclaimer

Before using this library, ensure your usage complies with [transfer.it's terms](https://transfer.it/terms), [MEGA's terms](https://mega.io/terms), and applicable law. You are responsible for content you upload. Software is provided “as is”, without warranty.
