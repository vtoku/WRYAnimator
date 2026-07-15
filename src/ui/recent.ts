// Recent files via the File System Access API. Only real file handles can be
// reopened later (a plain dropped/<input> File cannot), so this whole feature
// is gated on `supported()` — the File > Recent submenu is hidden without it.
// Handles persist in IndexedDB (structured-cloneable); permission is
// re-requested on use. A "current save handle" lets Ctrl+S re-save a scene.

import { downloadBytes } from "../fbx/export.ts";

export interface RecentEntry {
  name: string;
  kind: "recording" | "scene";
  handle: FileSystemFileHandle;
}

interface FsWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
}
const fsWin = window as unknown as FsWindow;

/** Whether the browser exposes the File System Access API. */
export function supported(): boolean {
  return typeof fsWin.showOpenFilePicker === "function" && typeof fsWin.showSaveFilePicker === "function";
}

// ---- IndexedDB (a tiny store for the recent list) ---------------------------
const DB_NAME = "wanimrecent";
const STORE = "recent";
const LIST_KEY = "list";
const MAX = 8;

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

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const r = t.objectStore(STORE).get(key);
    r.onsuccess = () => { resolve(r.result as T | undefined); db.close(); };
    r.onerror = () => { reject(r.error); db.close(); };
  }));
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then((db) => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => { resolve(); db.close(); };
    t.onerror = () => { reject(t.error); db.close(); };
  }));
}

// In-memory cache so the menu (which builds synchronously) can read the list.
let cache: RecentEntry[] = [];

/** Load the persisted recent list into memory (call once at boot). */
export async function initRecent(): Promise<void> {
  if (!supported()) return;
  try {
    const stored = await idbGet<RecentEntry[]>(LIST_KEY);
    if (Array.isArray(stored)) cache = stored.filter((e) => e && e.handle && typeof e.name === "string");
  } catch { /* blocked storage — no recents */ }
}

/** The current recent list (newest first), synchronous for the menu. */
export function getRecent(): RecentEntry[] {
  return cache;
}

async function addRecent(entry: RecentEntry): Promise<void> {
  // De-dup by name+kind, newest first, capped at MAX.
  cache = [entry, ...cache.filter((e) => !(e.name === entry.name && e.kind === entry.kind))].slice(0, MAX);
  try { await idbPut(LIST_KEY, cache); } catch { /* blocked */ }
}

// ---- open ------------------------------------------------------------------
const RECORDING_TYPES = [{ description: "Warudo recording", accept: { "application/octet-stream": [".wanim"] } }];
const SCENE_TYPES = [{ description: "Scene", accept: { "application/json": [".json"] } }];
const BODY_TYPES = [{ description: "Avatar body", accept: { "model/gltf-binary": [".vrm", ".glb"] } }];

async function verifyPermission(handle: FileSystemFileHandle, write = false): Promise<boolean> {
  const opts = { mode: write ? "readwrite" : "read" } as const;
  const h = handle as unknown as {
    queryPermission?: (o: unknown) => Promise<PermissionState>;
    requestPermission?: (o: unknown) => Promise<PermissionState>;
  };
  if ((await h.queryPermission?.(opts)) === "granted") return true;
  return (await h.requestPermission?.(opts)) === "granted";
}

/**
 * Pick a file with the FS Access API. Records recordings/scenes in Recent.
 * Returns the File (and, for scenes, the handle so Ctrl+S can re-save).
 */
export async function pickOpen(kind: "recording" | "scene" | "body"): Promise<{ file: File; handle: FileSystemFileHandle } | null> {
  if (!supported()) return null;
  const types = kind === "recording" ? RECORDING_TYPES : kind === "scene" ? SCENE_TYPES : BODY_TYPES;
  let handle: FileSystemFileHandle;
  try {
    [handle] = await fsWin.showOpenFilePicker!({ types, multiple: false });
  } catch {
    return null; // user cancelled
  }
  const file = await handle.getFile();
  if (kind !== "body") await addRecent({ name: file.name, kind, handle });
  return { file, handle };
}

/** Reopen a recent entry: re-request permission, then read the file. */
export async function openRecent(entry: RecentEntry): Promise<File | null> {
  if (!(await verifyPermission(entry.handle))) return null;
  try {
    return await entry.handle.getFile();
  } catch {
    // The file moved/was deleted — drop it from the list.
    cache = cache.filter((e) => e !== entry);
    try { await idbPut(LIST_KEY, cache); } catch { /* ignore */ }
    return null;
  }
}

// ---- save (scene) ----------------------------------------------------------
let saveHandle: FileSystemFileHandle | null = null;

/** Whether a scene save target is held (Ctrl+S re-saves to it). */
export function hasSaveHandle(): boolean {
  return !!saveHandle;
}

/** Remember a scene's handle as the save target (e.g. after opening a scene). */
export function setSaveHandle(handle: FileSystemFileHandle | null): void {
  saveHandle = handle;
}

async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const w = await (handle as unknown as { createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }> }).createWritable();
  await w.write(bytes);
  await w.close();
}

/**
 * Save a scene. When supported, writes to the held handle (re-save) or prompts
 * for one; `forcePicker` always prompts (Save scene as...). Falls back to a
 * normal download when the API is unavailable.
 */
export async function saveScene(fileName: string, bytes: Uint8Array, forcePicker = false): Promise<void> {
  if (supported()) {
    try {
      let handle = forcePicker ? null : saveHandle;
      if (handle && !(await verifyPermission(handle, true))) handle = null;
      if (!handle) {
        handle = await fsWin.showSaveFilePicker!({ suggestedName: fileName, types: SCENE_TYPES });
      }
      await writeHandle(handle, bytes);
      saveHandle = handle;
      return;
    } catch (err) {
      // Cancelled picker = do nothing; a real write error falls through.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  downloadBytes(fileName, bytes);
}
