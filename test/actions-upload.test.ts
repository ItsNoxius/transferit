import { File } from "node:buffer";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MegaAPI } from "../src/api.js";
import { Transferit } from "../src/client.js";
import { wsUploadOne, type ByteSource } from "../src/upload.js";

vi.mock("../src/upload.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/upload.js")>(),
  wsUploadOne: vi.fn(async (_host: string, _uri: string, source: ByteSource) => {
    expect(new TextDecoder().decode(await source.read(0, source.size))).toBe("video");
    await source.close?.();
    return { token: Uint8Array.of(1), macs: [] };
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function uploadClient() {
  const api = new MegaAPI();
  vi.spyOn(api, "createEphemeralSession").mockResolvedValue(undefined);
  vi.spyOn(api, "createTransfer").mockResolvedValue({ xh: "transfer", rootH: "root", folderKey: [] });
  vi.spyOn(api, "createSubfolder").mockResolvedValue("subfolder");
  vi.spyOn(api, "uploadPools").mockResolvedValue([["test.invalid", "upload"]]);
  vi.spyOn(api, "finaliseFile").mockResolvedValue({});
  vi.spyOn(api, "closeTransfer").mockResolvedValue(undefined);
  return { api, tx: new Transferit({ api }) };
}

describe("upload filenames", () => {
  it("adds an extension to a File while keeping its transfer title", async () => {
    vi.stubGlobal("File", File);
    const { api, tx } = uploadClient();
    const file = new File(["video"], "video");
    const result = await tx.upload(file, { filename: "rename.mp4", title: "My video" });

    expect(api.finaliseFile).toHaveBeenCalledWith("root", expect.any(Uint8Array), expect.any(Array), [], "rename.mp4");
    expect(api.createTransfer).toHaveBeenCalledWith("My video");
    expect(result.title).toBe("My video");
    expect(file.name).toBe("video");
    expect(wsUploadOne).toHaveBeenCalledOnce();
  });

  it("renames a filesystem upload without changing the source or callback path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "transferit-filename-"));
    const sourcePath = path.join(dir, "video");
    try {
      await writeFile(sourcePath, "video");
      const { api, tx } = uploadClient();
      const onFileStart = vi.fn();
      const result = await tx.upload(sourcePath, { filename: "rename.mp4", onFileStart });
      expect(vi.mocked(api.finaliseFile).mock.calls[0]![4]).toBe("rename.mp4");
      expect(result.title).toBe("video");
      expect(onFileStart).toHaveBeenCalledWith(1, sourcePath, 5);
      expect(await readFile(sourcePath, "utf8")).toBe("video");
    } finally {
      await unlink(sourcePath);
      await rmdir(dir);
    }
  });

  it("renames a Blob and preserves its existing default title", async () => {
    vi.stubGlobal("File", File);
    const { api, tx } = uploadClient();
    const result = await tx.upload(new Blob(["video"]), { filename: "映像.mp4" });
    expect(vi.mocked(api.finaliseFile).mock.calls[0]![4]).toBe("映像.mp4");
    expect(result.title).toBe("upload.bin");
  });

  it("renames a single entry while preserving its parent folders", async () => {
    const { api, tx } = uploadClient();
    await tx.upload([{ path: "clips/video", blob: new Blob(["video"]) }], { filename: "rename.mp4" });
    expect(api.createSubfolder).toHaveBeenCalledWith("root", "clips");
    expect(api.finaliseFile).toHaveBeenCalledWith("subfolder", expect.any(Uint8Array), expect.any(Array), [], "rename.mp4");
  });

  it("renames a single FileList entry", async () => {
    class TestFileList {
      length = 1;
      item() { return new File(["video"], "video"); }
    }
    vi.stubGlobal("FileList", TestFileList);
    const { api, tx } = uploadClient();
    await tx.upload(new TestFileList() as unknown as FileList, { filename: "rename.mp4" });
    expect(vi.mocked(api.finaliseFile).mock.calls[0]![4]).toBe("rename.mp4");
  });

  it.each([undefined, null])("preserves a File's original name with filename=%s", async (filename) => {
    vi.stubGlobal("File", File);
    const { api, tx } = uploadClient();
    await tx.upload(new File(["video"], "video"), { title: "rename.mp4", filename });
    expect(vi.mocked(api.finaliseFile).mock.calls[0]![4]).toBe("video");
    expect(api.createTransfer).toHaveBeenCalledWith("rename.mp4");
  });

  it("preserves the title fallback for an unnamed Blob", async () => {
    vi.stubGlobal("File", File);
    const { api, tx } = uploadClient();
    await tx.upload(new Blob(["video"]), { title: "video.mp4" });
    expect(vi.mocked(api.finaliseFile).mock.calls[0]![4]).toBe("video.mp4");
  });

  it.each(["", "   ", ".", "..", "clips/video.mp4", "clips\\video.mp4", "video\0.mp4"])("rejects invalid filename %j before creating a transfer", async (filename) => {
    vi.stubGlobal("File", File);
    const { api, tx } = uploadClient();
    await expect(tx.upload(new File(["video"], "video"), { filename })).rejects.toThrow("filename must be a non-empty filename, not a path");
    expect(api.createEphemeralSession).not.toHaveBeenCalled();
    expect(wsUploadOne).not.toHaveBeenCalled();
  });

  it("rejects a filename override for multiple files before creating a transfer", async () => {
    const { api, tx } = uploadClient();
    await expect(tx.upload([
      { path: "a", blob: new Blob(["video"]) },
      { path: "b", blob: new Blob(["video"]) },
    ], { filename: "rename.mp4" })).rejects.toThrow("filename requires exactly one file to upload");
    expect(api.createEphemeralSession).not.toHaveBeenCalled();
    expect(wsUploadOne).not.toHaveBeenCalled();
  });
});
