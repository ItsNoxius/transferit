import { useCallback, useRef, useState } from "react";
import {
  MegaAPI,
  downloadNodeViaServiceWorker,
  ensureServiceWorker,
  type TransferInfo,
  type TransferNode,
} from "@noxius/transferit";
import { useTransferit } from "./context.js";

export interface UseTransferOptions {
  password?: string | null;
  /** Service worker script URL (default `/sw-download.js`). */
  serviceWorkerUrl?: string;
  /** SW registration scope (default `/`). */
  scope?: string;
}

export interface UseTransferResult {
  status: "idle" | "loading" | "ready" | "downloading" | "done" | "error";
  nodes: TransferNode[];
  info: TransferInfo | null;
  xh: string | null;
  error: Error | null;
  /** Load nodes + metadata (no service worker). Call before download. */
  begin: () => Promise<void>;
  /** Re-fetch nodes + metadata. */
  refresh: () => Promise<void>;
  /** Download every file, or a single node, via the service worker. */
  download: {
    (): Promise<{ xh: string; started: number; nodes: TransferNode[] }>;
    (node: TransferNode): Promise<void>;
  };
  reset: () => void;
}

/**
 * Headless transfer handle: list a share, then stream downloads through the SW.
 *
 * Listing does not register a service worker. Download ensures once.
 *
 * ```ts
 * const transfer = useTransfer(url, { password });
 * await transfer.begin();
 * await transfer.download();       // all files
 * await transfer.download(node);   // one file
 * ```
 */
export function useTransfer(
  urlOrXh: string | null | undefined,
  opts: UseTransferOptions = {},
): UseTransferResult {
  const client = useTransferit();
  const [status, setStatus] = useState<UseTransferResult["status"]>("idle");
  const [nodes, setNodes] = useState<TransferNode[]>([]);
  const [info, setInfo] = useState<TransferInfo | null>(null);
  const [xh, setXh] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const password = opts.password ?? null;
  const swUrl = opts.serviceWorkerUrl ?? "/sw-download.js";
  const swScope = opts.scope ?? "/";

  const busy = useRef(false);
  const gen = useRef(0);
  const urlRef = useRef(urlOrXh);
  urlRef.current = urlOrXh;
  const nodesRef = useRef<TransferNode[]>([]);
  const xhRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const target = urlRef.current?.trim() || null;
    if (!target) {
      nodesRef.current = [];
      xhRef.current = null;
      setStatus("idle");
      setNodes([]);
      setInfo(null);
      setXh(null);
      setError(null);
      return;
    }

    const id = ++gen.current;
    setStatus("loading");
    setError(null);

    try {
      const [listed, meta] = await Promise.all([
        client.info(target, { password }),
        client.metadata(target, { password }),
      ]);
      if (id !== gen.current) return;
      nodesRef.current = listed;
      xhRef.current = meta.xh;
      setNodes(listed);
      setInfo(meta);
      setXh(meta.xh);
      setStatus("ready");
    } catch (err) {
      if (id !== gen.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      nodesRef.current = [];
      xhRef.current = null;
      setError(e);
      setNodes([]);
      setInfo(null);
      setXh(null);
      setStatus("error");
      throw e;
    }
  }, [client, password]);

  const refresh = useCallback(async () => {
    if (busy.current) throw new Error("transfer already in progress");
    busy.current = true;
    try {
      await load();
    } finally {
      busy.current = false;
    }
  }, [load]);

  const begin = refresh;

  const download = useCallback(
    (async (node?: TransferNode) => {
      const currentXh = xhRef.current;
      if (!currentXh) {
        throw new Error("call begin() before download()");
      }
      if (busy.current) throw new Error("transfer already in progress");

      busy.current = true;
      setStatus("downloading");
      setError(null);

      try {
        await ensureServiceWorker(swUrl, swScope);
        const pwToken = password
          ? await MegaAPI.derivePassword(currentXh, password)
          : null;
        const swOpts = {
          pwToken,
          serviceWorkerUrl: swUrl,
          scope: swScope,
          ensure: false as const,
        };

        if (node) {
          await downloadNodeViaServiceWorker(
            client.api,
            currentXh,
            node,
            swOpts,
          );
          setStatus("done");
          return;
        }

        const files = nodesRef.current.filter((n) => n.isFile);
        let started = 0;
        for (const n of files) {
          await downloadNodeViaServiceWorker(
            client.api,
            currentXh,
            n,
            swOpts,
          );
          started++;
        }
        setStatus("done");
        return { xh: currentXh, started, nodes: files };
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus("error");
        throw e;
      } finally {
        busy.current = false;
      }
    }) as UseTransferResult["download"],
    [client, password, swUrl, swScope],
  );

  const reset = useCallback(() => {
    if (busy.current) return;
    gen.current += 1;
    nodesRef.current = [];
    xhRef.current = null;
    setStatus("idle");
    setNodes([]);
    setInfo(null);
    setXh(null);
    setError(null);
  }, []);

  return { status, nodes, info, xh, error, begin, refresh, download, reset };
}
