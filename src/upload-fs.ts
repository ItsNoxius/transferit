/**
 * Node filesystem helpers for uploads (path walk + random-access reads).
 */

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ByteSource } from "./upload.js";
import { MegaAPIError } from "./errors.js";

export async function pathSource(filePath: string): Promise<ByteSource> {
  const st = await stat(filePath);
  const fh = await open(filePath, "r");
  return {
    size: st.size,
    async read(pos, length) {
      if (length === 0) return new Uint8Array(0);
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, pos);
      if (bytesRead !== length) {
        throw new MegaAPIError(
          `short read at ${pos}: got ${bytesRead}, want ${length}`,
        );
      }
      return buf;
    },
    async close() {
      await fh.close();
    },
  };
}

function matchGlob(name: string, pattern: string): boolean {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i").test(name);
}

export async function walkFolder(
  root: string,
  opts?: { exclude?: Iterable<string> },
): Promise<{ files: string[]; dirRelPaths: string[] }> {
  const st = await stat(root);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const patterns = [...(opts?.exclude ?? [])];
  const matches = (name: string, rel: string) =>
    patterns.some((pat) => matchGlob(name, pat) || matchGlob(rel, pat));

  const files: string[] = [];
  const dirSet = new Set<string>();

  async function walk(dir: string, relPosix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      const rel = relPosix ? `${relPosix}/${ent.name}` : ent.name;
      if (patterns.length && matches(ent.name, rel)) continue;

      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        dirSet.add(rel);
        await walk(full, rel);
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
  }

  await walk(root, "");
  const dirRelPaths = [...dirSet].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  return { files, dirRelPaths };
}
