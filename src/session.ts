// Last-session persistence: the most recent recording's raw bytes, so the
// app reopens like a DCC reopens its last project. IndexedDB because
// recordings are multi-MB (localStorage caps out around 5 MB); the per-
// recording EDITS already live in localStorage (wanimrig:<name>:<frames>),
// so restoring the bytes rehydrates the whole session through that path.
// Everything stays local — consistent with the "nothing is uploaded" promise.

const DB_NAME = "wanimxfbx";
const STORE = "session";
const KEY = "last";

export interface LastSession {
  name: string;
  bytes: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Remember this recording as the last session (fire-and-forget from callers). */
export async function saveLastSession(name: string, bytes: ArrayBuffer): Promise<void> {
  touchLastSession();
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.put({ name, bytes }, KEY));
    db.close();
  } catch { /* private mode / blocked storage — the app just boots empty */ }
}

/** The last session's recording, or null on first run / blocked storage. */
export async function loadLastSession(): Promise<LastSession | null> {
  try {
    const db = await openDb();
    const got = (await tx(db, "readonly", (s) => s.get(KEY))) as LastSession | undefined;
    db.close();
    return got && typeof got.name === "string" && got.bytes instanceof ArrayBuffer ? got : null;
  } catch {
    return null;
  }
}

/** Forget the last session (the user explicitly closed it). */
export async function clearLastSession(): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.delete(KEY));
    db.close();
  } catch { /* nothing to clear */ }
  try { localStorage.removeItem(AT_KEY); } catch { /* blocked storage */ }
}

// "Was this session live moments ago?" — cheap localStorage timestamp, kept
// OUTSIDE the multi-MB IndexedDB record so touching it costs nothing. The
// boot flow auto-restores only recent sessions (refresh / accidental close);
// older ones are offered, not forced.
const AT_KEY = "wanim:lastSessionAt";

/** Mark the last session as live right now (load + tab close). */
export function touchLastSession(): void {
  try { localStorage.setItem(AT_KEY, String(Date.now())); } catch { /* blocked */ }
}

/** Milliseconds since the last session was live; Infinity when unknown. */
export function lastSessionAgeMs(): number {
  try {
    const t = Number(localStorage.getItem(AT_KEY));
    return Number.isFinite(t) && t > 0 ? Date.now() - t : Infinity;
  } catch {
    return Infinity;
  }
}
