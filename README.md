# @noxius/transferit

TypeScript/Node client for [transfer.it](https://transfer.it) — upload and download via the MEGA backend, no browser required.

Port of [transferit-py](https://github.com/viperadnan-git/transferit-py) (MIT). Not affiliated with MEGA or transfer.it.

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

Requires Node.js 20+.

## API

| Method | Returns | Session? |
|--------|---------|----------|
| `upload(path, opts?)` | `UploadResult` | yes (lazy) |
| `download(url, dir, opts?)` | `DownloadResult` | no |
| `info(url, opts?)` | `TransferNode[]` | no |
| `metadata(url, opts?)` | `TransferInfo` | no |

Upload options match the web form: `title`, `message`, `password`, `sender`, `expiry` (`7d` or seconds), `notifyExpiry`, `maxDownloads`, `recipients`, `schedule`, `concurrency`, `parallel`, `exclude`, and progress callbacks.

```ts
const tx = new Transferit({
  defaultSender: "me@example.com",
  defaultExpiry: "7d",
});

await tx.upload("./project", {
  title: "Q1 demo",
  password: "hunter2",
  recipients: ["alice@example.com"],
  onProgress: (sent, total) => console.log(`${sent}/${total}`),
});
```

Low-level `MegaAPI` is available via `tx.api` or `new Transferit({ api })`. Protocol notes: [`docs/REVERSE_ENGINEERING.md`](docs/REVERSE_ENGINEERING.md).

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
