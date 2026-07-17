import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_MB, iterChunks, walkFolder } from "../src/upload.js";
import { MegaAPI } from "../src/api.js";
import { parseDuration, castExpirySeconds } from "../src/transfer.js";

describe("iterChunks", () => {
  it("empty file needs empty tail", () => {
    const { chunks, needEmptyTail } = iterChunks(0);
    expect(chunks).toEqual([]);
    expect(needEmptyTail).toBe(true);
  });

  it("short file has one short chunk, no tail", () => {
    const { chunks, needEmptyTail } = iterChunks(100);
    expect(chunks).toEqual([[0, 100]]);
    expect(needEmptyTail).toBe(false);
  });

  it("exact 128k boundary needs tail", () => {
    const { chunks, needEmptyTail } = iterChunks(128 * 1024);
    expect(chunks).toEqual([[0, 128 * 1024]]);
    expect(needEmptyTail).toBe(true);
  });

  it("just over 128k", () => {
    const { chunks, needEmptyTail } = iterChunks(128 * 1024 + 1);
    expect(chunks).toEqual([
      [0, 128 * 1024],
      [128 * 1024, 1],
    ]);
    expect(needEmptyTail).toBe(false);
  });

  it("multi-MB uses 1MiB after ramp", () => {
    const size = 10 * ONE_MB;
    const { chunks } = iterChunks(size);
    expect(chunks.reduce((a, [, l]) => a + l, 0)).toBe(size);
    expect(chunks.filter(([, l]) => l === ONE_MB).length).toBeGreaterThanOrEqual(5);
  });

  it("offsets are contiguous", () => {
    const { chunks } = iterChunks(2_500_000);
    let cursor = 0;
    for (const [pos, length] of chunks) {
      expect(pos).toBe(cursor);
      cursor += length;
    }
    expect(cursor).toBe(2_500_000);
  });
});

describe("walkFolder", () => {
  it("flat files", async () => {
    const root = path.join(process.cwd(), ".tmp-walk-flat");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "b.txt"), "b");
    const { files, dirRelPaths } = await walkFolder(root);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["a.txt", "b.txt"]);
    expect(dirRelPaths).toEqual([]);
  });

  it("nested + empty dirs + exclude", async () => {
    const root = path.join(process.cwd(), ".tmp-walk-nested");
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "empty-sub"), { recursive: true });
    await writeFile(path.join(root, "src", "kept.py"), "k");
    await writeFile(path.join(root, "src", "generated", "x.py"), "g");
    await writeFile(path.join(root, ".git", "HEAD"), "ref");
    await writeFile(path.join(root, "README.md"), "r");

    const { files, dirRelPaths } = await walkFolder(root, {
      exclude: [".git", "src/generated", "*.pyc"],
    });
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      "README.md",
      "kept.py",
    ]);
    expect(dirRelPaths).toContain("empty-sub");
    expect(dirRelPaths).toContain("src");
    expect(dirRelPaths).not.toContain("src/generated");
    expect(dirRelPaths).not.toContain(".git");
  });
});

describe("parseXh / duration", () => {
  it("parses share URLs", () => {
    expect(MegaAPI.parseXh("https://transfer.it/t/abcdefghijkl")).toBe(
      "abcdefghijkl",
    );
    expect(MegaAPI.parseXh("abcdefghijkl")).toBe("abcdefghijkl");
  });

  it("parses durations", () => {
    expect(parseDuration("7d")).toBe(7 * 86400);
    expect(parseDuration("2h30m")).toBe(2 * 3600 + 30 * 60);
    expect(parseDuration("3600")).toBe(3600);
    expect(castExpirySeconds(0)).toBeNull();
    expect(castExpirySeconds(86400)).toBe(86400);
  });
});
