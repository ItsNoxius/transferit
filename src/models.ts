/** Typed containers returned by the high-level Transferit client. */

export interface TransferNode {
  handle: string;
  parent: string;
  /** 0 = file, 1 = folder */
  kind: number;
  name: string | null;
  size: number | null;
  timestamp: number | null;
  /** a32 key — 8 elems for files, 4 for folders */
  key: number[];
  raw: Record<string, unknown>;
  readonly isFile: boolean;
  readonly isFolder: boolean;
  toJSON(): Record<string, unknown>;
}

export function transferNodeFromDict(n: {
  h: string;
  p?: string;
  t: number;
  name?: string | null;
  s?: number | null;
  ts?: number | null;
  k?: number[];
  raw?: Record<string, unknown>;
}): TransferNode {
  const kind = n.t;
  return {
    handle: n.h,
    parent: n.p ?? "",
    kind,
    name: n.name ?? null,
    size: n.s ?? null,
    timestamp: n.ts ?? null,
    key: n.k ?? [],
    raw: n.raw ?? (n as unknown as Record<string, unknown>),
    get isFile() {
      return kind === 0;
    },
    get isFolder() {
      return kind === 1;
    },
    toJSON() {
      return {
        handle: this.handle,
        parent: this.parent,
        kind: this.isFolder ? "folder" : "file",
        name: this.name,
        size: this.size,
        timestamp: this.timestamp,
      };
    },
  };
}

export interface TransferInfo {
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
  toJSON(): Record<string, unknown>;
}

export function transferInfoFromDict(
  xh: string,
  raw: Record<string, unknown>,
  opts: { url: string; rootHandle?: string | null },
): TransferInfo {
  return {
    xh,
    url: opts.url,
    rootHandle: opts.rootHandle ?? null,
    title: (raw.title as string | undefined) ?? null,
    sender: (raw.se as string | undefined) ?? null,
    message: (raw.message as string | undefined) ?? null,
    passwordProtected: Boolean(raw.pw),
    zipHandle: (raw.z as string | undefined) ?? null,
    zipPending: Boolean(raw.zp),
    totalBytes: (raw.total_bytes as number | undefined) ?? 0,
    fileCount: (raw.file_count as number | undefined) ?? 0,
    folderCount: (raw.folder_count as number | undefined) ?? 0,
    raw,
    toJSON() {
      return {
        xh: this.xh,
        url: this.url,
        rootHandle: this.rootHandle,
        title: this.title,
        sender: this.sender,
        message: this.message,
        passwordProtected: this.passwordProtected,
        zipHandle: this.zipHandle,
        zipPending: this.zipPending,
        totalBytes: this.totalBytes,
        fileCount: this.fileCount,
        folderCount: this.folderCount,
      };
    },
  };
}

export interface UploadResult {
  xh: string;
  url: string;
  title: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  toString(): string;
  toJSON(): Record<string, unknown>;
}

export function makeUploadResult(r: {
  xh: string;
  url: string;
  title: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
}): UploadResult {
  return {
    ...r,
    toString() {
      return r.url;
    },
    toJSON() {
      return {
        xh: r.xh,
        url: r.url,
        title: r.title,
        totalBytes: r.totalBytes,
        fileCount: r.fileCount,
        folderCount: r.folderCount,
      };
    },
  };
}

export interface DownloadResult {
  xh: string;
  outputDir: string;
  paths: string[];
  totalBytes: number;
  skipped: string[];
  toJSON(): Record<string, unknown>;
}

export function makeDownloadResult(r: {
  xh: string;
  outputDir: string;
  paths: string[];
  totalBytes: number;
  skipped?: string[];
}): DownloadResult {
  const skipped = r.skipped ?? [];
  return {
    xh: r.xh,
    outputDir: r.outputDir,
    paths: r.paths,
    totalBytes: r.totalBytes,
    skipped,
    toJSON() {
      return {
        xh: r.xh,
        outputDir: r.outputDir,
        paths: r.paths,
        skipped,
        totalBytes: r.totalBytes,
      };
    },
  };
}
