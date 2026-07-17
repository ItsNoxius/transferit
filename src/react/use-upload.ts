import { useCallback, useRef, useState } from "react";
import type {
  UploadOptions,
  UploadResult,
  UploadSource,
} from "@noxius/transferit";
import { useTransferit } from "./context.js";

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UseUploadResult {
  status: "idle" | "uploading" | "done" | "error";
  progress: UploadProgress | null;
  result: UploadResult | null;
  error: Error | null;
  /** Start an upload. Rejects if one is already in flight. */
  upload: (
    source: UploadSource,
    opts?: UploadOptions,
  ) => Promise<UploadResult>;
  reset: () => void;
}

export function useUpload(): UseUploadResult {
  const client = useTransferit();
  const [status, setStatus] = useState<UseUploadResult["status"]>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const busy = useRef(false);

  const reset = useCallback(() => {
    if (busy.current) return;
    setStatus("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }, []);

  const upload = useCallback(
    async (source: UploadSource, opts: UploadOptions = {}) => {
      if (busy.current) {
        throw new Error("upload already in progress");
      }
      busy.current = true;
      setStatus("uploading");
      setProgress(null);
      setResult(null);
      setError(null);

      try {
        const res = await client.upload(source, {
          ...opts,
          onProgress: (sent, total) => {
            setProgress({ sent, total });
            opts.onProgress?.(sent, total);
          },
        });
        setResult(res);
        setStatus("done");
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus("error");
        throw e;
      } finally {
        busy.current = false;
      }
    },
    [client],
  );

  return { status, progress, result, error, upload, reset };
}
