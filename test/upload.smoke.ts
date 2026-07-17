import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Transferit } from "../src/index.js";

const live = process.env.TRANSFERIT_LIVE === "1";

describe.skipIf(!live)("live upload smoke", () => {
  it(
    "uploads a tiny file and downloads it back",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "transferit-"));
      const src = path.join(dir, "hello.txt");
      const payload = `hello transfer.it ${Date.now()}\n`;
      await writeFile(src, payload);

      const tx = new Transferit();
      const result = await tx.upload(src, { title: "smoke-test" });
      expect(result.url).toMatch(/^https:\/\/transfer\.it\/t\/[A-Za-z0-9_-]{12}$/);

      const meta = await tx.metadata(result.url);
      expect(meta.xh).toBe(result.xh);
      expect(meta.fileCount).toBeGreaterThanOrEqual(1);

      const outDir = path.join(dir, "out");
      await mkdir(outDir);
      const dl = await tx.download(result.url, outDir);
      expect(dl.paths.length).toBe(1);
      const got = await readFile(dl.paths[0]!, "utf8");
      expect(got).toBe(payload);

      tx.close();
    },
    120_000,
  );
});
