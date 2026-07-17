/**
 * Shared IndexedDB job contract for page ↔ service-worker downloads.
 * Both bundles import this so constants/types cannot drift.
 */

export const DL_PREFIX = "/__transferit_dl__/";
export const DL_DB_NAME = "transferit-dl";
export const DL_STORE = "jobs";

export interface DownloadJob {
  id: string;
  cdnUrl: string;
  keyA32: number[];
  size: number;
  filename: string;
}

export function openDlDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DL_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DL_STORE)) db.createObjectStore(DL_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putDownloadJob(job: DownloadJob): Promise<void> {
  const db = await openDlDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DL_STORE, "readwrite");
    tx.objectStore(DL_STORE).put(job, job.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Get-and-delete a job (one-shot download URL). */
export async function takeDownloadJob(id: string): Promise<DownloadJob | null> {
  const db = await openDlDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DL_STORE, "readwrite");
    const store = tx.objectStore(DL_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const job = getReq.result as DownloadJob | undefined;
      if (job) store.delete(id);
      resolve(job ?? null);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}
